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

    // Link the exact no_std contract used by the Windows configuration shell.
    // The full protocol hook is layered on this verified image/packaging seam.
    let _contract_guid = nvstraps_core::VARIABLE_VENDOR_GUID;
    let _unconfigured = nvstraps_core::status::DecodedStatus::decode(0);

    Status::SUCCESS
}

#[cfg(not(target_os = "uefi"))]
fn main() {
    eprintln!("NvStrapsReBar is a UEFI boot-service driver; build for x86_64-unknown-uefi");
}
