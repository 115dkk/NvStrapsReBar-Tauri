#![no_std]
#![deny(unsafe_code)]
extern crate alloc;

#[cfg(target_os = "uefi")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    uefi::println!("EXTERNAL-EFI: panic; halted");
    loop {
        core::hint::spin_loop();
    }
}

#[cfg(all(feature = "qemu-model", not(debug_assertions)))]
compile_error!("qemu-model must never enter a release build");

#[cfg(target_os = "uefi")]
pub mod app;
#[cfg(target_os = "uefi")]
#[allow(
    unsafe_code,
    reason = "UEFI wide-string compiler intrinsic, no host CRT"
)]
mod crt;
#[cfg(all(target_os = "uefi", feature = "qemu-model"))]
pub mod model;
#[cfg(target_os = "uefi")]
#[allow(
    unsafe_code,
    reason = "bounded adapters for firmware-owned PCI and DXE service protocols"
)]
pub mod native;
