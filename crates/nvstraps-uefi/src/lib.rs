#![cfg_attr(target_os = "uefi", no_std)]

extern crate alloc;

pub mod execution;
pub mod mmio;

#[cfg(not(target_os = "uefi"))]
pub mod simulation;

#[cfg(target_os = "uefi")]
pub mod driver;
#[cfg(target_os = "uefi")]
pub mod engine;
#[cfg(target_os = "uefi")]
pub mod host_bridge;
#[cfg(target_os = "uefi")]
pub mod pci;
#[cfg(target_os = "uefi")]
pub mod s3;
#[cfg(target_os = "uefi")]
pub mod setup_variable;
#[cfg(target_os = "uefi")]
pub mod status_writer;
#[cfg(target_os = "uefi")]
pub mod straps;
#[cfg(target_os = "uefi")]
pub mod uefi_adapter;
#[cfg(target_os = "uefi")]
pub mod variables;
