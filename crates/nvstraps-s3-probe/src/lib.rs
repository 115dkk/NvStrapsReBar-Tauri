#![cfg_attr(target_os = "uefi", no_std)]
#![deny(unsafe_code)]

pub mod acpi;
pub mod aml;
pub mod stub;

#[cfg(target_os = "uefi")]
pub mod uefi_platform;
