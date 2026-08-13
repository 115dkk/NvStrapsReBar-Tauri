#![cfg(target_os = "uefi")]
#![no_std]

extern crate alloc;

pub mod pci;
pub mod s3;
pub mod setup_variable;
pub mod status_writer;
pub mod straps;
pub mod variables;
