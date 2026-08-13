#![cfg_attr(target_os = "uefi", no_main)]
#![cfg_attr(target_os = "uefi", no_std)]

#[cfg(target_os = "uefi")]
use uefi::prelude::*;

#[cfg(target_os = "uefi")]
#[entry]
fn main() -> Status {
    if uefi::helpers::init().is_err() {
        return Status::ABORTED;
    }

    // The functional entry sequence is enabled only after each hardware adapter
    // has its parity gate. Linking the library here keeps every landed adapter
    // in the validated PE/FFS image while the original C driver remains live.
    let _status_writer = nvstraps_uefi::status_writer::StatusWriter::new();

    Status::SUCCESS
}

#[cfg(not(target_os = "uefi"))]
fn main() {
    eprintln!("NvStrapsReBar is a UEFI boot-service driver; build for x86_64-unknown-uefi");
}
