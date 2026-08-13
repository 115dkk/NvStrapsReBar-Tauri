use std::fmt;

mod efi_compression;
mod firmware;
mod legacy_patch;

pub use efi_compression::{EfiCompression, EfiCompressionError, efi_compress, efi_decompress};
pub use firmware::{
    FirmwareEnvelope, FirmwareInjection, InjectionError, LegacyFirmwarePatch,
    LegacyFirmwarePatchApplication, LegacyFirmwarePatchChange, LegacyFirmwarePatchError,
    LegacyFirmwarePatchPath, LegacyPatchSelection, UefiCapsuleHeader, inject_ffs,
    inspect_firmware_envelope, patch_legacy_firmware,
};
pub use legacy_patch::{
    LegacyPatchApplication, LegacyPatchCatalog, LegacyPatchChange, LegacyPatchError,
    LegacyPatchRule, PatchRuleId,
};

pub const DRIVER_NAME: &str = "NvStrapsReBar";
pub const FFS_FILE_GUID: &str = "90d10790-bbfa-404b-873b-5bdb3ada3c56";
pub const FFS_FILE_GUID_BYTES: [u8; 16] = [
    0x90, 0x07, 0xd1, 0x90, 0xfa, 0xbb, 0x4b, 0x40, 0x87, 0x3b, 0x5b, 0xdb, 0x3a, 0xda, 0x3c, 0x56,
];

const DOS_MAGIC: &[u8; 2] = b"MZ";
const PE_MAGIC: &[u8; 4] = b"PE\0\0";
const PE32_PLUS_MAGIC: u16 = 0x20b;
const IMAGE_FILE_MACHINE_AMD64: u16 = 0x8664;
const IMAGE_SUBSYSTEM_EFI_BOOT_SERVICE_DRIVER: u16 = 11;
const IMAGE_DLLCHARACTERISTICS_NX_COMPAT: u16 = 0x0100;

const FFS_HEADER_SIZE: usize = 24;
const SECTION_HEADER_SIZE: usize = 4;
const MAX_STANDARD_SIZE: usize = 0x00ff_ffff;
const FFS_FILE_TYPE_DRIVER: u8 = 0x07;
const FFS_ATTRIBUTE_CHECKSUM: u8 = 0x40;
const FFS_FILE_STATE_VALID: u8 = 0x07;
const SECTION_TYPE_PE32: u8 = 0x10;
const SECTION_TYPE_DXE_DEPEX: u8 = 0x13;
const SECTION_TYPE_USER_INTERFACE: u8 = 0x15;
const DEPEX_PUSH: u8 = 0x02;
const DEPEX_END: u8 = 0x08;
const PCI_ROOT_BRIDGE_IO_PROTOCOL_GUID_BYTES: [u8; 16] = [
    0xbb, 0x7e, 0x70, 0x2f, 0x1a, 0x4a, 0xd4, 0x11, 0x9a, 0x38, 0x00, 0x90, 0x27, 0x3f, 0xc1, 0x4d,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PeInspection {
    pub machine: u16,
    pub subsystem: u16,
    pub dll_characteristics: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FfsInspection {
    pub file_guid: [u8; 16],
    pub file_type: u8,
    pub section_types: Vec<u8>,
    pub ui_name: String,
    pub pe: PeInspection,
}

#[derive(Debug)]
pub enum PackError {
    InvalidPe(&'static str),
    InvalidFfs(&'static str),
}

impl fmt::Display for PackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPe(reason) => write!(formatter, "invalid UEFI PE image: {reason}"),
            Self::InvalidFfs(reason) => write!(formatter, "invalid FFS file: {reason}"),
        }
    }
}

impl std::error::Error for PackError {}

pub fn inspect_driver_image(image: &[u8]) -> Result<PeInspection, PackError> {
    if image.get(..DOS_MAGIC.len()) != Some(DOS_MAGIC) {
        return Err(PackError::InvalidPe("missing DOS signature"));
    }

    let pe_offset = read_u32(image, 0x3c, PackError::InvalidPe("missing PE offset"))? as usize;
    if image.get(pe_offset..pe_offset.saturating_add(PE_MAGIC.len())) != Some(PE_MAGIC) {
        return Err(PackError::InvalidPe("missing PE signature"));
    }

    let coff_offset = pe_offset
        .checked_add(PE_MAGIC.len())
        .ok_or(PackError::InvalidPe("PE offset overflow"))?;
    let optional_offset = coff_offset
        .checked_add(20)
        .ok_or(PackError::InvalidPe("optional-header offset overflow"))?;
    let machine = read_u16(
        image,
        coff_offset,
        PackError::InvalidPe("missing COFF header"),
    )?;
    let optional_size = read_u16(
        image,
        coff_offset + 16,
        PackError::InvalidPe("missing optional-header size"),
    )? as usize;

    if machine != IMAGE_FILE_MACHINE_AMD64 {
        return Err(PackError::InvalidPe("image is not AMD64"));
    }
    if optional_size < 72 {
        return Err(PackError::InvalidPe("optional header is too short"));
    }
    if read_u16(
        image,
        optional_offset,
        PackError::InvalidPe("missing optional header"),
    )? != PE32_PLUS_MAGIC
    {
        return Err(PackError::InvalidPe("image is not PE32+"));
    }

    let subsystem = read_u16(
        image,
        optional_offset + 68,
        PackError::InvalidPe("missing subsystem"),
    )?;
    let dll_characteristics = read_u16(
        image,
        optional_offset + 70,
        PackError::InvalidPe("missing DLL characteristics"),
    )?;
    if subsystem != IMAGE_SUBSYSTEM_EFI_BOOT_SERVICE_DRIVER {
        return Err(PackError::InvalidPe(
            "subsystem is not EFI_BOOT_SERVICE_DRIVER",
        ));
    }
    if dll_characteristics & IMAGE_DLLCHARACTERISTICS_NX_COMPAT == 0 {
        return Err(PackError::InvalidPe("NX_COMPAT is not set"));
    }

    Ok(PeInspection {
        machine,
        subsystem,
        dll_characteristics,
    })
}

pub fn build_ffs(driver_image: &[u8]) -> Result<Vec<u8>, PackError> {
    inspect_driver_image(driver_image)?;

    let mut depex = Vec::with_capacity(PCI_ROOT_BRIDGE_IO_PROTOCOL_GUID_BYTES.len() + 2);
    depex.push(DEPEX_PUSH);
    depex.extend_from_slice(&PCI_ROOT_BRIDGE_IO_PROTOCOL_GUID_BYTES);
    depex.push(DEPEX_END);
    let mut body = encode_section(SECTION_TYPE_DXE_DEPEX, &depex)?;
    body.resize(
        align_up_4(body.len()).ok_or(PackError::InvalidFfs("section alignment overflow"))?,
        0,
    );
    body.extend(encode_section(SECTION_TYPE_PE32, driver_image)?);
    body.resize(
        align_up_4(body.len()).ok_or(PackError::InvalidFfs("section alignment overflow"))?,
        0,
    );
    body.extend(encode_section(
        SECTION_TYPE_USER_INTERFACE,
        &encode_ui_name(DRIVER_NAME),
    )?);

    let file_size = FFS_HEADER_SIZE
        .checked_add(body.len())
        .ok_or(PackError::InvalidFfs("file size overflow"))?;
    if file_size >= MAX_STANDARD_SIZE {
        return Err(PackError::InvalidFfs("driver requires a large-file header"));
    }

    let mut serialized = vec![0_u8; FFS_HEADER_SIZE];
    serialized[..FFS_FILE_GUID_BYTES.len()].copy_from_slice(&FFS_FILE_GUID_BYTES);
    serialized[18] = FFS_FILE_TYPE_DRIVER;
    serialized[19] = FFS_ATTRIBUTE_CHECKSUM;
    write_u24(&mut serialized[20..23], file_size as u32);

    // Match EDK2 GenFfs: header checksum, file checksum, and state are zero
    // while calculating the header checksum. The latter two are then filled.
    serialized[16] = checksum8(&serialized);
    serialized[17] = checksum8(&body);
    serialized[23] = FFS_FILE_STATE_VALID;
    serialized.extend(body);

    // The decoder does not share the encoder's section-construction path.
    // Never emit an artifact that cannot make that round trip.
    inspect_ffs(&serialized)?;
    Ok(serialized)
}

pub fn inspect_ffs(bytes: &[u8]) -> Result<FfsInspection, PackError> {
    let header = bytes
        .get(..FFS_HEADER_SIZE)
        .ok_or(PackError::InvalidFfs("truncated file header"))?;
    if header.get(..16) != Some(FFS_FILE_GUID_BYTES.as_slice()) {
        return Err(PackError::InvalidFfs("unexpected file GUID"));
    }
    if header[18] != FFS_FILE_TYPE_DRIVER {
        return Err(PackError::InvalidFfs("file type is not DRIVER"));
    }
    if header[19] != FFS_ATTRIBUTE_CHECKSUM {
        return Err(PackError::InvalidFfs("unexpected file attributes"));
    }
    if header[23] != FFS_FILE_STATE_VALID {
        return Err(PackError::InvalidFfs("file state is not DATA_VALID"));
    }

    verify_checksums(bytes)?;
    let sections = parse_sections(bytes)?;
    if sections.len() != 3
        || sections[0].section_type != SECTION_TYPE_DXE_DEPEX
        || sections[1].section_type != SECTION_TYPE_PE32
        || sections[2].section_type != SECTION_TYPE_USER_INTERFACE
    {
        return Err(PackError::InvalidFfs(
            "expected the PCI root-bridge dependency, PE32, and UI sections",
        ));
    }
    let expected_depex = [
        &[DEPEX_PUSH][..],
        &PCI_ROOT_BRIDGE_IO_PROTOCOL_GUID_BYTES,
        &[DEPEX_END],
    ]
    .concat();
    if sections[0].content != expected_depex {
        return Err(PackError::InvalidFfs(
            "unexpected DXE dependency expression",
        ));
    }

    let pe = inspect_driver_image(sections[1].content)?;
    let ui_name = decode_ui_name(sections[2].content)?;
    if ui_name != DRIVER_NAME {
        return Err(PackError::InvalidFfs("unexpected UI section name"));
    }

    Ok(FfsInspection {
        file_guid: FFS_FILE_GUID_BYTES,
        file_type: header[18],
        section_types: sections
            .iter()
            .map(|section| section.section_type)
            .collect(),
        ui_name,
        pe,
    })
}

#[derive(Clone, Copy)]
struct RawSection<'a> {
    section_type: u8,
    content: &'a [u8],
}

fn parse_sections(bytes: &[u8]) -> Result<Vec<RawSection<'_>>, PackError> {
    let file_size = read_u24(bytes, 20, PackError::InvalidFfs("missing file size"))? as usize;
    if file_size != bytes.len() {
        return Err(PackError::InvalidFfs(
            "file size field does not match input",
        ));
    }

    let mut offset = FFS_HEADER_SIZE;
    let mut sections = Vec::new();
    while offset < file_size {
        let section_size = read_u24(
            bytes,
            offset,
            PackError::InvalidFfs("truncated section header"),
        )? as usize;
        let section_type = *bytes
            .get(offset + 3)
            .ok_or(PackError::InvalidFfs("truncated section type"))?;
        if section_size < SECTION_HEADER_SIZE {
            return Err(PackError::InvalidFfs("section is smaller than its header"));
        }
        let end = offset
            .checked_add(section_size)
            .ok_or(PackError::InvalidFfs("section size overflow"))?;
        let content = bytes
            .get(offset + SECTION_HEADER_SIZE..end)
            .ok_or(PackError::InvalidFfs("section extends beyond file"))?;
        sections.push(RawSection {
            section_type,
            content,
        });
        if end == file_size {
            offset = end;
        } else {
            let aligned =
                align_up_4(end).ok_or(PackError::InvalidFfs("section alignment overflow"))?;
            let padding = bytes
                .get(end..aligned)
                .ok_or(PackError::InvalidFfs("section padding extends beyond file"))?;
            if padding.iter().any(|byte| *byte != 0) {
                return Err(PackError::InvalidFfs("section padding is not zero"));
            }
            if aligned > file_size {
                return Err(PackError::InvalidFfs("section padding extends beyond file"));
            }
            offset = aligned;
        }
    }
    Ok(sections)
}

fn verify_checksums(bytes: &[u8]) -> Result<(), PackError> {
    let header = bytes
        .get(..FFS_HEADER_SIZE)
        .ok_or(PackError::InvalidFfs("truncated file header"))?;
    let state = header[23];
    let file_checksum = header[17];
    let header_sum = header
        .iter()
        .fold(0_u8, |sum, byte| sum.wrapping_add(*byte))
        .wrapping_sub(state)
        .wrapping_sub(file_checksum);
    if header_sum != 0 {
        return Err(PackError::InvalidFfs("header checksum mismatch"));
    }

    let body_sum = bytes[FFS_HEADER_SIZE..]
        .iter()
        .fold(0_u8, |sum, byte| sum.wrapping_add(*byte));
    if body_sum.wrapping_add(file_checksum) != 0 {
        return Err(PackError::InvalidFfs("file checksum mismatch"));
    }
    Ok(())
}

fn encode_section(section_type: u8, content: &[u8]) -> Result<Vec<u8>, PackError> {
    let section_size = SECTION_HEADER_SIZE
        .checked_add(content.len())
        .ok_or(PackError::InvalidFfs("section size overflow"))?;
    if section_size >= MAX_STANDARD_SIZE {
        return Err(PackError::InvalidFfs("section requires an extended header"));
    }

    let mut section = vec![0_u8; SECTION_HEADER_SIZE];
    write_u24(&mut section[..3], section_size as u32);
    section[3] = section_type;
    section.extend_from_slice(content);
    Ok(section)
}

fn encode_ui_name(name: &str) -> Vec<u8> {
    name.encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect()
}

fn decode_ui_name(bytes: &[u8]) -> Result<String, PackError> {
    if !bytes.len().is_multiple_of(2) {
        return Err(PackError::InvalidFfs("UI name is not UTF-16LE"));
    }
    let unit_count = bytes.len() / 2;
    let mut units = Vec::with_capacity(unit_count);
    for (index, pair) in bytes.chunks_exact(2).enumerate() {
        let unit = u16::from_le_bytes([pair[0], pair[1]]);
        if unit == 0 {
            if index + 1 != unit_count {
                return Err(PackError::InvalidFfs("UI name has data after NUL"));
            }
            return String::from_utf16(&units)
                .map_err(|_| PackError::InvalidFfs("UI name is invalid UTF-16"));
        }
        units.push(unit);
    }
    Err(PackError::InvalidFfs("UI name is not NUL terminated"))
}

fn read_u16(bytes: &[u8], offset: usize, error: PackError) -> Result<u16, PackError> {
    let raw = bytes.get(offset..offset.saturating_add(2)).ok_or(error)?;
    Ok(u16::from_le_bytes([raw[0], raw[1]]))
}

fn read_u24(bytes: &[u8], offset: usize, error: PackError) -> Result<u32, PackError> {
    let raw = bytes.get(offset..offset.saturating_add(3)).ok_or(error)?;
    Ok(u32::from_le_bytes([raw[0], raw[1], raw[2], 0]))
}

fn read_u32(bytes: &[u8], offset: usize, error: PackError) -> Result<u32, PackError> {
    let raw = bytes.get(offset..offset.saturating_add(4)).ok_or(error)?;
    Ok(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]))
}

fn write_u24(output: &mut [u8], value: u32) {
    output.copy_from_slice(&value.to_le_bytes()[..3]);
}

fn checksum8(bytes: &[u8]) -> u8 {
    0_u8.wrapping_sub(bytes.iter().fold(0_u8, |sum, byte| sum.wrapping_add(*byte)))
}

fn align_up_4(value: usize) -> Option<usize> {
    value.checked_add(3).map(|value| value & !3)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_driver_and_non_nx_images() {
        let mut image = synthetic_driver_image();
        let optional_offset = 0x80 + 4 + 20;

        image[optional_offset + 68..optional_offset + 70].copy_from_slice(&10_u16.to_le_bytes());
        assert!(inspect_driver_image(&image).is_err());

        image[optional_offset + 68..optional_offset + 70]
            .copy_from_slice(&IMAGE_SUBSYSTEM_EFI_BOOT_SERVICE_DRIVER.to_le_bytes());
        image[optional_offset + 70..optional_offset + 72].copy_from_slice(&0_u16.to_le_bytes());
        assert!(inspect_driver_image(&image).is_err());
    }

    #[test]
    fn builds_a_round_trip_verified_driver_ffs() {
        let image = synthetic_driver_image();
        let ffs = build_ffs(&image).expect("FFS build");
        let inspection = inspect_ffs(&ffs).expect("FFS inspect");

        assert_eq!(inspection.file_guid, FFS_FILE_GUID_BYTES);
        assert_eq!(inspection.file_type, FFS_FILE_TYPE_DRIVER);
        assert_eq!(
            inspection.section_types,
            [
                SECTION_TYPE_DXE_DEPEX,
                SECTION_TYPE_PE32,
                SECTION_TYPE_USER_INTERFACE
            ]
        );
        assert_eq!(inspection.ui_name, DRIVER_NAME);
        assert_eq!(
            inspection.pe.subsystem,
            IMAGE_SUBSYSTEM_EFI_BOOT_SERVICE_DRIVER
        );
    }

    #[test]
    fn matches_the_edk2_standard_header_layout() {
        let ffs = build_ffs(&synthetic_driver_image()).expect("FFS build");

        assert_eq!(&ffs[..16], &FFS_FILE_GUID_BYTES);
        assert_eq!(ffs[18], 0x07);
        assert_eq!(ffs[19], 0x40);
        assert_eq!(&ffs[20..23], &[0x54, 0x02, 0x00]);
        assert_eq!(ffs[23], 0x07);
        assert_eq!(&ffs[24..28], &[0x16, 0x00, 0x00, 0x13]);
        assert_eq!(ffs[28], DEPEX_PUSH);
        assert_eq!(&ffs[29..45], &PCI_ROOT_BRIDGE_IO_PROTOCOL_GUID_BYTES);
        assert_eq!(ffs[45], DEPEX_END);
        assert_eq!(&ffs[48..52], &[0x04, 0x02, 0x00, 0x10]);
        assert_eq!(&ffs[564..568], &[0x20, 0x00, 0x00, 0x15]);
    }

    #[test]
    fn rejects_corrupted_ffs_data() {
        let mut ffs = build_ffs(&synthetic_driver_image()).expect("FFS build");
        ffs[FFS_HEADER_SIZE + SECTION_HEADER_SIZE + 0x20] ^= 0xff;
        assert!(inspect_ffs(&ffs).is_err());
    }

    pub(crate) fn synthetic_driver_image() -> Vec<u8> {
        let mut image = vec![0_u8; 0x200];
        image[..2].copy_from_slice(DOS_MAGIC);
        image[0x3c..0x40].copy_from_slice(&0x80_u32.to_le_bytes());
        image[0x80..0x84].copy_from_slice(PE_MAGIC);
        let coff_offset = 0x84;
        image[coff_offset..coff_offset + 2]
            .copy_from_slice(&IMAGE_FILE_MACHINE_AMD64.to_le_bytes());
        image[coff_offset + 16..coff_offset + 18].copy_from_slice(&0xf0_u16.to_le_bytes());
        let optional_offset = coff_offset + 20;
        image[optional_offset..optional_offset + 2].copy_from_slice(&PE32_PLUS_MAGIC.to_le_bytes());
        image[optional_offset + 68..optional_offset + 70]
            .copy_from_slice(&IMAGE_SUBSYSTEM_EFI_BOOT_SERVICE_DRIVER.to_le_bytes());
        image[optional_offset + 70..optional_offset + 72]
            .copy_from_slice(&IMAGE_DLLCHARACTERISTICS_NX_COMPAT.to_le_bytes());
        image
    }
}
