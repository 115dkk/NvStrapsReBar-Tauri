#![allow(
    unsafe_code,
    reason = "the QEMU/OVMF probe must read ACPI physical memory, patch FACS and execute port I/O"
)]

use core::arch::asm;
use core::ptr::{read_volatile, write_volatile};
use core::slice;

use uefi::boot::{self, AllocateType, MemoryType};
use uefi::table::cfg::ConfigTableEntry;

use crate::acpi::{self, FadtInfo, RootTable};

const SDT_HEADER_LEN: usize = 36;
const FACS_MIN_LEN: usize = 16;

pub struct PlatformInfo {
    pub facs: u64,
    pub pm1a_cnt: u16,
    pub slp_typ_s3: u8,
    pub slp_typ_s5: u8,
}

pub fn discover() -> Result<PlatformInfo, &'static str> {
    let rsdp_address = find_rsdp().ok_or("ACPI RSDP was not found")?;
    // SAFETY: The UEFI configuration table supplied this ACPI RSDP pointer. ACPI 2 RSDPs are at
    // least 36 bytes and ACPI 1 RSDPs are read only through their first 20 bytes by the parser.
    let rsdp = unsafe { slice::from_raw_parts(rsdp_address, 36) };
    let root = acpi::parse_rsdp(rsdp).map_err(|_| "RSDP validation failed")?;

    let (root_address, signature) = match root {
        RootTable::Xsdt(address) => (address, b"XSDT"),
        RootTable::Rsdt(address) => (u64::from(address), b"RSDT"),
    };
    let root_table = read_sdt(root_address, signature)?;
    let entries =
        acpi::root_entries(root_table, signature).map_err(|_| "XSDT/RSDT validation failed")?;
    let mut fadt = None;
    for address in entries {
        if address == 0 {
            continue;
        }
        // SAFETY: Each root-table entry is an ACPI physical address and four signature bytes are
        // the mandatory prefix of every SDT referenced by XSDT/RSDT.
        let candidate_signature = unsafe { slice::from_raw_parts(address as *const u8, 4) };
        if candidate_signature == b"FACP" {
            fadt = Some(read_sdt(address, b"FACP")?);
            break;
        }
    }
    let fadt = fadt.ok_or("FADT was not found in the ACPI root table")?;
    let fields = acpi::parse_fadt(fadt).map_err(|_| "FADT validation failed")?;
    let dsdt = read_sdt(fields.dsdt, b"DSDT")?;
    acpi::table_checksum(dsdt, b"DSDT").map_err(|_| "DSDT validation failed")?;
    let aml = &dsdt[SDT_HEADER_LEN..];
    let slp_typ_s3 = crate::aml::sleep_type(aml, b"_S3_").map_err(|_| "_S3_ parse failed")?;
    let slp_typ_s5 = crate::aml::sleep_type(aml, b"_S5_").map_err(|_| "_S5_ parse failed")?;

    validate_facs(fields)?;
    Ok(PlatformInfo {
        facs: fields.facs,
        pm1a_cnt: fields.pm1a_cnt,
        slp_typ_s3,
        slp_typ_s5,
    })
}

/// Copies the stub into a page below 1 MiB and publishes it as the 32-bit waking vector.
///
/// Returns the vector written, the legacy and extended vectors read back from the FACS.
pub fn install_waking_stub(
    facs_address: u64,
    stub: &[u8],
) -> Result<(u32, u32, u64), &'static str> {
    if stub.len() > 4096 {
        return Err("waking stub exceeds one page");
    }
    let page = boot::allocate_pages(
        AllocateType::MaxAddress(0x9ffff),
        MemoryType::ACPI_NON_VOLATILE,
        1,
    )
    .map_err(|_| "low ACPI NVS page allocation failed")?;

    // SAFETY: allocate_pages returned a writable 4096-byte page and stub fits in that page.
    unsafe { core::ptr::copy_nonoverlapping(stub.as_ptr(), page.as_ptr(), stub.len()) };
    let page_address = page.as_ptr() as usize;
    let vector = u32::try_from(page_address).map_err(|_| "waking vector exceeds 32 bits")?;
    let facs = facs_address as *mut u8;

    // SAFETY: The FACS length field is a naturally aligned u32 at offset 4 of the table that
    // validate_facs checked.
    let facs_length = unsafe { read_volatile(facs.add(4).cast::<u32>()) };
    if facs_length < 32 {
        return Err("FACS has no XFirmwareWakingVector field");
    }
    // The legacy real-mode vector stays zero: the stub is 32-bit protected-mode code, and EDK2
    // prefers XFirmwareWakingVector whenever it is set.
    // SAFETY: validate_facs checked the signature and minimum size. Offset 12 is the aligned
    // FirmwareWakingVector u32 field in the FACS table.
    unsafe { write_volatile(facs.add(12).cast::<u32>(), 0) };
    // SAFETY: A FACS of at least 32 bytes contains the aligned XFirmwareWakingVector at 24.
    unsafe { write_volatile(facs.add(24).cast::<u64>(), u64::from(vector)) };
    // SAFETY: Same validated FACS fields as above; volatile reads confirm firmware-visible state.
    let read_legacy = unsafe { read_volatile(facs.add(12).cast::<u32>()) };
    // SAFETY: Same validated extended waking-vector field as above.
    let read_extended = unsafe { read_volatile(facs.add(24).cast::<u64>()) };

    Ok((vector, read_legacy, read_extended))
}

pub fn enter_sleep(pm1a_cnt: u16, slp_typ: u8) -> Result<(), &'static str> {
    if slp_typ > 7 {
        return Err("S3 sleep type does not fit the PM1 control field");
    }
    let value = (u16::from(slp_typ) << 10) | 0x2000;
    // SAFETY: QEMU's FADT identified this System I/O PM1a control port. Writing the ACPI-defined
    // SLP_TYP and SLP_EN fields requests the test VM's sleep transition.
    unsafe {
        asm!(
            "out dx, ax",
            in("dx") pm1a_cnt,
            in("ax") value,
            options(nomem, nostack, preserves_flags)
        )
    };
    Ok(())
}

fn find_rsdp() -> Option<*const u8> {
    uefi::system::with_config_table(|entries| {
        entries
            .iter()
            .find(|entry| entry.guid == ConfigTableEntry::ACPI2_GUID)
            .or_else(|| {
                entries
                    .iter()
                    .find(|entry| entry.guid == ConfigTableEntry::ACPI_GUID)
            })
            .map(|entry| entry.address.cast())
    })
}

fn read_sdt(address: u64, signature: &[u8; 4]) -> Result<&'static [u8], &'static str> {
    if address == 0 || address > usize::MAX as u64 {
        return Err("ACPI table address is invalid");
    }
    // SAFETY: The address came from validated ACPI linkage. Every SDT has a 36-byte header.
    let header = unsafe { slice::from_raw_parts(address as *const u8, SDT_HEADER_LEN) };
    let length = acpi::sdt_length(header, signature).map_err(|_| "ACPI table header is invalid")?;
    // SAFETY: The ACPI header advertises the complete table length at this firmware-owned address.
    Ok(unsafe { slice::from_raw_parts(address as *const u8, length) })
}

fn validate_facs(fields: FadtInfo) -> Result<(), &'static str> {
    if fields.facs == 0 || fields.facs > usize::MAX as u64 {
        return Err("FACS address is invalid");
    }
    // SAFETY: FADT supplied the FACS physical address; signature and length are its first 8 bytes.
    let header = unsafe { slice::from_raw_parts(fields.facs as *const u8, 8) };
    if &header[..4] != b"FACS" {
        return Err("FACS signature is invalid");
    }
    let length = u32::from_le_bytes(header[4..8].try_into().expect("fixed FACS length field"));
    if length < FACS_MIN_LEN as u32 {
        return Err("FACS is truncated");
    }
    Ok(())
}
