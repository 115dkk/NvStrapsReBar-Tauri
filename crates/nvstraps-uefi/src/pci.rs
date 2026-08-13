use nvstraps_core::pci::{
    self, BridgeSavedConfig, DeviceHeader, DeviceSavedConfig, PciAddress, REBAR_CAPABILITY_OFFSET,
    REBAR_CONTROL_OFFSET, RemapError,
};
use nvstraps_core::status::EfiErrorLocation;
use uefi::boot::{self, OpenProtocolAttributes, OpenProtocolParams, ScopedProtocol};
use uefi::proto::pci::PciIoAddress;
use uefi::proto::pci::root_bridge::PciRootBridgeIo;
use uefi::{Handle, Status};

use crate::s3::S3Script;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PciFailure {
    pub location: EfiErrorLocation,
    pub status: Status,
    pub address: Option<PciAddress>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MappingFailure {
    InvalidConfiguration(RemapError),
    Firmware(PciFailure),
}

pub fn open_root_bridge(handle: Handle) -> Result<ScopedProtocol<PciRootBridgeIo>, Status> {
    // SAFETY: The host-bridge callback supplies a live root-bridge handle. The
    // returned scoped protocol is dropped before that callback returns.
    unsafe {
        boot::open_protocol::<PciRootBridgeIo>(
            OpenProtocolParams {
                handle,
                agent: boot::image_handle(),
                controller: None,
            },
            OpenProtocolAttributes::GetProtocol,
        )
    }
    .map_err(|error| error.status())
}

pub struct PciAccess<'root> {
    root: &'root mut PciRootBridgeIo,
}

impl<'root> PciAccess<'root> {
    pub const fn new(root: &'root mut PciRootBridgeIo) -> Self {
        Self { root }
    }

    pub fn read_u8(&mut self, address: PciAddress, offset: u16) -> Result<u8, Status> {
        self.root
            .pci()
            .read_one(register_address(address, offset))
            .map_err(|error| error.status())
    }

    pub fn read_u16(&mut self, address: PciAddress, offset: u16) -> Result<u16, Status> {
        self.root
            .pci()
            .read_one(register_address(address, offset))
            .map_err(|error| error.status())
    }

    pub fn read_u32(&mut self, address: PciAddress, offset: u16) -> Result<u32, Status> {
        self.root
            .pci()
            .read_one(register_address(address, offset))
            .map_err(|error| error.status())
    }

    pub fn write_u8(&mut self, address: PciAddress, offset: u16, value: u8) -> Result<(), Status> {
        self.root
            .pci()
            .write_one(register_address(address, offset), value)
            .map_err(|error| error.status())
    }

    pub fn write_u16(
        &mut self,
        address: PciAddress,
        offset: u16,
        value: u16,
    ) -> Result<(), Status> {
        self.root
            .pci()
            .write_one(register_address(address, offset), value)
            .map_err(|error| error.status())
    }

    pub fn write_u32(
        &mut self,
        address: PciAddress,
        offset: u16,
        value: u32,
    ) -> Result<(), Status> {
        self.root
            .pci()
            .write_one(register_address(address, offset), value)
            .map_err(|error| error.status())
    }

    pub fn device_header(&mut self, address: PciAddress) -> Result<Option<DeviceHeader>, Status> {
        let identity = self.read_u32(address, pci::VENDOR_DEVICE_OFFSET)?;
        if identity == u32::MAX {
            return Ok(None);
        }
        let cacheline_header = self.read_u32(address, pci::CACHELINE_HEADER_OFFSET)?;
        Ok(Some(DeviceHeader {
            address,
            vendor_id: identity as u16,
            device_id: (identity >> 16) as u16,
            header_type: (cacheline_header >> 16) as u8,
        }))
    }

    pub fn device_class(&mut self, address: PciAddress) -> Result<u32, Status> {
        self.read_u32(address, pci::REVISION_CLASS_OFFSET)
            .map(|value| value & 0xffff_ff00)
    }

    pub fn device_bar0(&mut self, address: PciAddress) -> Result<u32, Status> {
        self.read_u32(address, pci::BAR0_OFFSET)
    }

    pub fn device_subsystem(&mut self, address: PciAddress) -> Result<(u16, u16), Status> {
        self.read_u32(address, pci::SUBSYSTEM_ID_OFFSET)
            .map(|value| (value as u16, (value >> 16) as u16))
    }

    pub fn bridge_secondary_bus(&mut self, address: PciAddress) -> Result<u8, Status> {
        self.read_u32(address, pci::BRIDGE_BUS_OFFSET)
            .map(|value| (value >> 8) as u8)
    }

    pub fn find_extended_capability(
        &mut self,
        address: PciAddress,
        capability_id: u16,
    ) -> Result<Option<u16>, PciFailure> {
        let mut offset = pci::EXTENDED_CAPABILITY_BASE;
        let mut header = self
            .read_u32(address, offset)
            .map_err(|status| PciFailure {
                location: EfiErrorLocation::PciStartFindCapability,
                status,
                address: Some(address),
            })?;
        if header == 0 || header == u32::MAX {
            return Ok(None);
        }

        let mut remaining = (pci::EXTENDED_CONFIG_SPACE_SIZE - pci::EXTENDED_CAPABILITY_BASE) / 8;
        while remaining > 0 {
            remaining -= 1;
            if pci::extended_capability_id(header) == capability_id && offset != 0 {
                return Ok(Some(offset));
            }
            offset = pci::next_extended_capability(header);
            if offset < pci::EXTENDED_CAPABILITY_BASE {
                break;
            }
            header = self
                .read_u32(address, offset)
                .map_err(|status| PciFailure {
                    location: EfiErrorLocation::PciFindCapability,
                    status,
                    address: Some(address),
                })?;
        }
        Ok(None)
    }

    pub fn rebar_possible_sizes(
        &mut self,
        address: PciAddress,
        capability_offset: u16,
        bar_index: u8,
    ) -> Result<u32, Status> {
        let Some(bar_offset) = self.rebar_bar_offset(address, capability_offset, bar_index)? else {
            return Ok(0);
        };
        self.read_u32(address, bar_offset + REBAR_CAPABILITY_OFFSET)
            .map(pci::rebar_possible_sizes)
    }

    pub fn set_rebar_size(
        &mut self,
        address: PciAddress,
        capability_offset: u16,
        bar_index: u8,
        size_bit_index: u8,
    ) -> Result<bool, Status> {
        let Some(bar_offset) = self.rebar_bar_offset(address, capability_offset, bar_index)? else {
            return Ok(false);
        };
        let control = self.read_u32(address, bar_offset + REBAR_CONTROL_OFFSET)?;
        self.write_u32(
            address,
            bar_offset + REBAR_CONTROL_OFFSET,
            pci::with_rebar_size(control, size_bit_index),
        )?;
        Ok(true)
    }

    pub fn save_and_remap_bridge(
        &mut self,
        address: PciAddress,
        base_address: u64,
        inclusive_top_address: u64,
        target_io_base_limit: u64,
        resume: &mut S3Script,
    ) -> Result<BridgeSavedConfig, MappingFailure> {
        let saved = BridgeSavedConfig {
            command: self
                .read_u32(address, pci::COMMAND_OFFSET)
                .map_err(|status| {
                    MappingFailure::Firmware(bridge_config_failure(address, status))
                })?,
            io_base_limit: self.read_u32(address, pci::BRIDGE_IO_BASE_OFFSET).map_err(
                |status| MappingFailure::Firmware(bridge_config_failure(address, status)),
            )?,
            memory_base_limit: self
                .read_u32(address, pci::BRIDGE_MEMORY_BASE_OFFSET)
                .map_err(|status| {
                    MappingFailure::Firmware(bridge_config_failure(address, status))
                })?,
        };
        let bus_configuration = self
            .read_u32(address, pci::BRIDGE_BUS_OFFSET)
            .map_err(|status| MappingFailure::Firmware(bridge_config_failure(address, status)))?;
        let remap = pci::bridge_remap(
            saved.command,
            saved.io_base_limit,
            base_address,
            inclusive_top_address,
            target_io_base_limit,
        )
        .map_err(MappingFailure::InvalidConfiguration)?;

        let apply_result = (|| {
            self.write_u32(
                address,
                pci::BRIDGE_MEMORY_BASE_OFFSET,
                remap.memory_base_limit,
            )
            .map_err(|status| bridge_config_failure(address, status))?;
            self.write_u32(address, pci::BRIDGE_IO_BASE_OFFSET, remap.io_base_limit)
                .map_err(|status| bridge_config_failure(address, status))?;
            self.write_u32(address, pci::COMMAND_OFFSET, remap.command)
                .map_err(|status| bridge_config_failure(address, status))?;

            resume
                .pci_config_read_write_u32(
                    address,
                    pci::BRIDGE_BUS_OFFSET,
                    bus_configuration & 0x00ff_ffff,
                    0xff00_0000,
                )
                .map_err(|status| s3_failure(address, status))?;
            resume
                .pci_config_write_u32(
                    address,
                    pci::BRIDGE_MEMORY_BASE_OFFSET,
                    remap.memory_base_limit,
                )
                .map_err(|status| s3_failure(address, status))?;
            resume
                .pci_config_read_write_u32(
                    address,
                    pci::BRIDGE_IO_BASE_OFFSET,
                    remap.io_base_limit & 0x0000_ffff,
                    0xffff_0000,
                )
                .map_err(|status| s3_failure(address, status))?;
            resume
                .pci_config_read_write_u32(
                    address,
                    pci::COMMAND_OFFSET,
                    pci::REQUIRED_COMMAND_BITS,
                    !pci::REQUIRED_COMMAND_BITS,
                )
                .map_err(|status| s3_failure(address, status))?;
            Ok(())
        })();

        if let Err(failure) = apply_result {
            if let Err(restore_failure) = self.restore_bridge(address, saved) {
                return Err(MappingFailure::Firmware(restore_failure));
            }
            return Err(MappingFailure::Firmware(failure));
        }
        Ok(saved)
    }

    pub fn restore_bridge(
        &mut self,
        address: PciAddress,
        saved: BridgeSavedConfig,
    ) -> Result<(), PciFailure> {
        let mut first_error = None;
        for (offset, value) in [
            (pci::COMMAND_OFFSET, saved.command),
            (pci::BRIDGE_IO_BASE_OFFSET, saved.io_base_limit),
            (pci::BRIDGE_MEMORY_BASE_OFFSET, saved.memory_base_limit),
        ] {
            if let Err(status) = self.write_u32(address, offset, value) {
                first_error.get_or_insert(status);
            }
        }
        first_error.map_or(Ok(()), |status| {
            Err(PciFailure {
                location: EfiErrorLocation::PciBridgeRestore,
                status,
                address: Some(address),
            })
        })
    }

    pub fn save_and_remap_device_bar0(
        &mut self,
        address: PciAddress,
        base_address: u64,
        resume: &mut S3Script,
    ) -> Result<DeviceSavedConfig, MappingFailure> {
        let saved = DeviceSavedConfig {
            command: self
                .read_u32(address, pci::COMMAND_OFFSET)
                .map_err(|status| {
                    MappingFailure::Firmware(device_config_failure(address, status))
                })?,
            bar0: self.read_u32(address, pci::BAR0_OFFSET).map_err(|status| {
                MappingFailure::Firmware(device_config_failure(address, status))
            })?,
        };
        let remap = pci::device_remap(saved.command, base_address)
            .map_err(MappingFailure::InvalidConfiguration)?;

        let apply_result = (|| {
            self.write_u32(address, pci::BAR0_OFFSET, remap.bar0)
                .map_err(|status| device_config_failure(address, status))?;
            self.write_u32(address, pci::COMMAND_OFFSET, remap.command)
                .map_err(|status| device_config_failure(address, status))?;
            resume
                .pci_config_write_u32(address, pci::BAR0_OFFSET, remap.bar0)
                .map_err(|status| s3_failure(address, status))?;
            resume
                .pci_config_read_write_u32(
                    address,
                    pci::COMMAND_OFFSET,
                    pci::REQUIRED_COMMAND_BITS,
                    !pci::REQUIRED_COMMAND_BITS,
                )
                .map_err(|status| s3_failure(address, status))?;
            Ok(())
        })();

        if let Err(failure) = apply_result {
            if let Err(restore_failure) = self.restore_device_bar0(address, saved) {
                return Err(MappingFailure::Firmware(restore_failure));
            }
            return Err(MappingFailure::Firmware(failure));
        }
        Ok(saved)
    }

    pub fn restore_device_bar0(
        &mut self,
        address: PciAddress,
        saved: DeviceSavedConfig,
    ) -> Result<(), PciFailure> {
        let mut first_error = None;
        for (offset, value) in [
            (pci::COMMAND_OFFSET, saved.command),
            (pci::BAR0_OFFSET, saved.bar0),
        ] {
            if let Err(status) = self.write_u32(address, offset, value) {
                first_error.get_or_insert(status);
            }
        }
        first_error.map_or(Ok(()), |status| {
            Err(PciFailure {
                location: EfiErrorLocation::PciDeviceBarRestore,
                status,
                address: Some(address),
            })
        })
    }

    fn rebar_bar_offset(
        &mut self,
        address: PciAddress,
        mut capability_offset: u16,
        bar_index: u8,
    ) -> Result<Option<u16>, Status> {
        let first_control = self.read_u32(address, capability_offset + REBAR_CONTROL_OFFSET)?;
        let bar_count = pci::rebar_bar_count(first_control);
        for _ in 0..bar_count {
            let control = self.read_u32(address, capability_offset + REBAR_CONTROL_OFFSET)?;
            if pci::rebar_bar_index(control) == bar_index {
                return Ok(Some(capability_offset));
            }
            capability_offset = capability_offset.saturating_add(8);
        }
        Ok(None)
    }
}

fn bridge_config_failure(address: PciAddress, status: Status) -> PciFailure {
    PciFailure {
        location: EfiErrorLocation::PciBridgeConfig,
        status,
        address: Some(address),
    }
}

fn device_config_failure(address: PciAddress, status: Status) -> PciFailure {
    PciFailure {
        location: EfiErrorLocation::PciDeviceBarConfig,
        status,
        address: Some(address),
    }
}

fn s3_failure(address: PciAddress, status: Status) -> PciFailure {
    PciFailure {
        location: EfiErrorLocation::WriteS3SaveStateProtocol,
        status,
        address: Some(address),
    }
}

fn register_address(address: PciAddress, offset: u16) -> PciIoAddress {
    let base = PciIoAddress::new(address.bus, address.device, address.function);
    if let Ok(offset) = u8::try_from(offset) {
        base.with_register(offset)
    } else {
        base.with_extended_register(offset as u32)
    }
}
