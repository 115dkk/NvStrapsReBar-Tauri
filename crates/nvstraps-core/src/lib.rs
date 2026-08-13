#![cfg_attr(not(feature = "std"), no_std)]
#![forbid(unsafe_code)]

extern crate alloc;

pub mod config;
pub mod pci;
pub mod registry;
pub mod setup_crc;
pub mod status;
pub mod straps;

pub const VARIABLE_VENDOR_GUID: u128 = 0xe3ee_4a27_e2a2_4435_bba3_184c_cad9_35a8;
pub const VARIABLE_VENDOR_GUID_STRING: &str = "{e3ee4a27-e2a2-4435-bba3-184ccad935a8}";
pub const CONFIG_VARIABLE_NAME: &str = "NvStrapsReBar";
pub const STATUS_VARIABLE_NAME: &str = "NvStrapsReBarStatus";

pub const EFI_VARIABLE_NON_VOLATILE: u32 = 0x0000_0001;
pub const EFI_VARIABLE_BOOTSERVICE_ACCESS: u32 = 0x0000_0002;
pub const EFI_VARIABLE_RUNTIME_ACCESS: u32 = 0x0000_0004;
pub const CONFIG_VARIABLE_ATTRIBUTES: u32 =
    EFI_VARIABLE_NON_VOLATILE | EFI_VARIABLE_BOOTSERVICE_ACCESS | EFI_VARIABLE_RUNTIME_ACCESS;
pub const STATUS_VARIABLE_ATTRIBUTES: u32 =
    EFI_VARIABLE_BOOTSERVICE_ACCESS | EFI_VARIABLE_RUNTIME_ACCESS;
