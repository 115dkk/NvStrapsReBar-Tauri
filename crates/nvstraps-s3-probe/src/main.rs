#![cfg_attr(target_os = "uefi", no_main)]
#![cfg_attr(target_os = "uefi", no_std)]
#![deny(unsafe_code)]

#[cfg(target_os = "uefi")]
use uefi::prelude::*;

#[cfg(target_os = "uefi")]
#[allow(
    unsafe_code,
    reason = "panic recovery uses raw UEFI tables without allocation"
)]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    loop {
        // SAFETY: HLT avoids consuming CPU after an unrecoverable test-tool panic.
        unsafe { core::arch::asm!("hlt", options(nomem, nostack)) }
    }
}

#[cfg(target_os = "uefi")]
#[entry]
fn main() -> Status {
    if uefi::helpers::init().is_err() {
        return Status::ABORTED;
    }
    uefi::println!("S3-PROBE: start (QEMU/OVMF test tool)");

    let mut status_buffer = [0_u8; 8];
    let vendor = uefi::runtime::VariableVendor(uefi::guid!("e3ee4a27-e2a2-4435-bba3-184ccad935a8"));
    match uefi::runtime::get_variable(
        uefi::cstr16!("NvStrapsReBarStatus"),
        &vendor,
        &mut status_buffer,
    ) {
        Ok((bytes, _)) if bytes.len() == 8 => {
            let raw = u64::from_le_bytes(bytes.try_into().expect("status length checked"));
            uefi::println!("S3-PROBE: status=0x{raw:016X}");
        }
        Err(error) if error.status() == Status::NOT_FOUND => {
            uefi::println!("S3-PROBE: status=missing");
        }
        _ => {
            uefi::println!("S3-PROBE: error status variable read failed");
            return Status::ABORTED;
        }
    }

    let platform = match nvstraps_s3_probe::uefi_platform::discover() {
        Ok(platform) => platform,
        Err(message) => {
            uefi::println!("S3-PROBE: error {message}");
            return Status::ABORTED;
        }
    };
    uefi::println!(
        "S3-PROBE: facs=0x{:X}, pm1a_cnt=0x{:X}, slp_typ_s3={}, slp_typ_s5={}",
        platform.facs,
        platform.pm1a_cnt,
        platform.slp_typ_s3,
        platform.slp_typ_s5
    );

    let stub = match nvstraps_s3_probe::stub::build(platform.pm1a_cnt, platform.slp_typ_s5) {
        Ok(stub) => stub,
        Err(message) => {
            uefi::println!("S3-PROBE: error {message}");
            return Status::ABORTED;
        }
    };
    let (vector, legacy_vector, extended_vector) =
        match nvstraps_s3_probe::uefi_platform::install_waking_stub(platform.facs, &stub) {
            Ok(vectors) => vectors,
            Err(message) => {
                uefi::println!("S3-PROBE: error {message}");
                return Status::ABORTED;
            }
        };
    if legacy_vector != 0 || extended_vector != u64::from(vector) {
        uefi::println!("S3-PROBE: error FACS waking vector readback failed");
        return Status::ABORTED;
    }
    uefi::println!("S3-PROBE: x_waking_vector=0x{extended_vector:X} (32-bit protected mode stub)");

    uefi::println!("S3-PROBE: entering S3");
    if let Err(message) =
        nvstraps_s3_probe::uefi_platform::enter_sleep(platform.pm1a_cnt, platform.slp_typ_s3)
    {
        uefi::println!("S3-PROBE: error {message}");
        return Status::ABORTED;
    }
    uefi::println!("S3-PROBE: S3 request was ignored");
    Status::ABORTED
}

#[cfg(not(target_os = "uefi"))]
fn main() {
    println!("NvStrapsS3Probe is a QEMU/OVMF UEFI test application");
}
