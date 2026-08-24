#![cfg_attr(target_os = "uefi", no_std)]
#![deny(unsafe_code)]

#[cfg(any(target_os = "uefi", test))]
#[allow(unsafe_code, reason = "serializes reentrant firmware callback state")]
mod exclusive;
pub mod execution;
#[cfg(any(target_os = "uefi", test))]
#[allow(unsafe_code, reason = "owns the volatile MMIO seam")]
pub(crate) mod mmio;

#[cfg(not(target_os = "uefi"))]
pub mod simulation;

#[cfg(target_os = "uefi")]
pub mod driver;
#[cfg(target_os = "uefi")]
pub mod engine;
#[cfg(target_os = "uefi")]
#[allow(unsafe_code, reason = "adapts the PI host-bridge callback ABI")]
pub mod host_bridge;
#[cfg(target_os = "uefi")]
#[allow(unsafe_code, reason = "adapts the UEFI PCI protocol and mapping proof")]
pub mod pci;
#[cfg(target_os = "uefi")]
#[allow(unsafe_code, reason = "owns initialized UEFI pool allocations")]
mod pool;
#[cfg(target_os = "uefi")]
#[allow(unsafe_code, reason = "adapts the PI variadic S3 protocol ABI")]
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
