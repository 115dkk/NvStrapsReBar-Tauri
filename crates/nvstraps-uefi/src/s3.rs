use core::ffi::c_void;

use nvstraps_core::pci::{PciAddress, boot_script_register_address};
use nvstraps_core::status::EfiErrorLocation;
use uefi::boot::{self, OpenProtocolAttributes, OpenProtocolParams, ScopedProtocol};
use uefi::proto::unsafe_protocol;
use uefi::{Status, StatusExt};

use crate::straps::S3Recorder;

const MEM_READ_WRITE_OPCODE: usize = 0x03;
const PCI_CONFIG_WRITE_OPCODE: usize = 0x04;
const PCI_CONFIG_READ_WRITE_OPCODE: usize = 0x05;
const BOOT_SCRIPT_WIDTH_UINT32: u32 = 2;

type S3Write = unsafe extern "efiapi" fn(*const S3SaveState, usize, ...) -> Status;

/// PI 1.6 S3 Save State protocol layout. Only `write` is invoked, but the
/// trailing entries are retained so the Rust representation matches EDK2.
#[unsafe_protocol("e857caf6-c046-45dc-be3f-ee0765fba887")]
#[repr(C)]
struct S3SaveState {
    write: S3Write,
    insert: usize,
    label: usize,
    compare: usize,
}

const _: () = assert!(core::mem::size_of::<S3SaveState>() == 4 * core::mem::size_of::<usize>());

pub struct S3Script {
    protocol: Option<ScopedProtocol<S3SaveState>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct S3InitError {
    pub location: EfiErrorLocation,
    pub status: Status,
}

impl S3Script {
    pub const fn disabled() -> Self {
        Self { protocol: None }
    }

    pub fn initialize(enabled: bool, skip_s3_resume: bool) -> Result<Self, S3InitError> {
        if !enabled || skip_s3_resume {
            return Ok(Self::disabled());
        }

        let handle =
            boot::get_handle_for_protocol::<S3SaveState>().map_err(|error| S3InitError {
                location: EfiErrorLocation::LocateS3SaveStateProtocol,
                status: error.status(),
            })?;
        // SAFETY: This is the standard PI S3 protocol GUID and the scoped
        // handle keeps the interface open for every script write.
        let protocol = unsafe {
            boot::open_protocol::<S3SaveState>(
                OpenProtocolParams {
                    handle,
                    agent: boot::image_handle(),
                    controller: None,
                },
                OpenProtocolAttributes::GetProtocol,
            )
        }
        .map_err(|error| S3InitError {
            location: EfiErrorLocation::LoadS3SaveStateProtocol,
            status: error.status(),
        })?;
        Ok(Self {
            protocol: Some(protocol),
        })
    }

    pub const fn is_enabled(&self) -> bool {
        self.protocol.is_some()
    }

    pub fn pci_config_write_u32(
        &mut self,
        address: PciAddress,
        offset: u16,
        data: u32,
    ) -> Result<(), Status> {
        let Some(protocol) = &mut self.protocol else {
            return Ok(());
        };
        let this = &**protocol as *const S3SaveState;
        let data_pointer = core::ptr::from_ref(&data).cast::<c_void>();
        // SAFETY: The arguments exactly match the PI boot-script opcode
        // contract and all pointed-to values outlive the synchronous call.
        unsafe {
            (protocol.write)(
                this,
                PCI_CONFIG_WRITE_OPCODE,
                BOOT_SCRIPT_WIDTH_UINT32,
                boot_script_register_address(address, offset),
                1_usize,
                data_pointer,
            )
        }
        .to_result()
        .map_err(|error| error.status())
    }

    pub fn pci_config_read_write_u32(
        &mut self,
        address: PciAddress,
        offset: u16,
        data: u32,
        data_mask: u32,
    ) -> Result<(), Status> {
        let Some(protocol) = &mut self.protocol else {
            return Ok(());
        };
        let this = &**protocol as *const S3SaveState;
        let data_pointer = core::ptr::from_ref(&data).cast::<c_void>();
        let mask_pointer = core::ptr::from_ref(&data_mask).cast::<c_void>();
        // SAFETY: The arguments exactly match the PI boot-script opcode
        // contract and all pointed-to values outlive the synchronous call.
        unsafe {
            (protocol.write)(
                this,
                PCI_CONFIG_READ_WRITE_OPCODE,
                BOOT_SCRIPT_WIDTH_UINT32,
                boot_script_register_address(address, offset),
                data_pointer,
                mask_pointer,
            )
        }
        .to_result()
        .map_err(|error| error.status())
    }
}

impl S3Recorder for S3Script {
    fn memory_read_write_u32(
        &mut self,
        address: u64,
        data: u32,
        data_mask: u32,
    ) -> Result<(), Status> {
        let Some(protocol) = &mut self.protocol else {
            return Ok(());
        };
        let this = &**protocol as *const S3SaveState;
        let data_pointer = core::ptr::from_ref(&data).cast::<c_void>();
        let mask_pointer = core::ptr::from_ref(&data_mask).cast::<c_void>();
        // SAFETY: The arguments exactly match the PI boot-script opcode
        // contract and all pointed-to values outlive the synchronous call.
        unsafe {
            (protocol.write)(
                this,
                MEM_READ_WRITE_OPCODE,
                BOOT_SCRIPT_WIDTH_UINT32,
                address,
                data_pointer,
                mask_pointer,
            )
        }
        .to_result()
        .map_err(|error| error.status())
    }
}
