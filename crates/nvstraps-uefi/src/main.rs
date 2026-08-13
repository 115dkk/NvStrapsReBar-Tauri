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

    nvstraps_uefi::driver::initialize()
}

#[cfg(not(target_os = "uefi"))]
fn main() {
    eprintln!("NvStrapsReBar is a UEFI boot-service driver; build for x86_64-unknown-uefi");
}
