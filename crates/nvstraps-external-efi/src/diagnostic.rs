#![cfg_attr(target_os = "uefi", no_main)]
#![cfg_attr(target_os = "uefi", no_std)]
#![forbid(unsafe_code)]
#[cfg(target_os = "uefi")]
#[uefi::entry]
fn main() -> uefi::Status {
    nvstraps_external_efi::app::diagnostic()
}
#[cfg(not(target_os = "uefi"))]
fn main() {
    eprintln!("Build NvStrapsDiagnostic for x86_64-unknown-uefi");
}
