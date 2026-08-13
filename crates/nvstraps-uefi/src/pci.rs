use nvstraps_core::pci::{
    self, DeviceHeader, PciAddress, REBAR_CAPABILITY_OFFSET, REBAR_CONTROL_OFFSET,
};
use nvstraps_core::status::EfiErrorLocation;
use uefi::boot::{self, OpenProtocolAttributes, OpenProtocolParams, ScopedProtocol};
use uefi::proto::pci::PciIoAddress;
use uefi::proto::pci::root_bridge::PciRootBridgeIo;
use uefi::{Handle, Status};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PciFailure {
    pub location: EfiErrorLocation,
    pub status: Status,
    pub address: Option<PciAddress>,
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

fn register_address(address: PciAddress, offset: u16) -> PciIoAddress {
    let base = PciIoAddress::new(address.bus, address.device, address.function);
    if let Ok(offset) = u8::try_from(offset) {
        base.with_register(offset)
    } else {
        base.with_extended_register(offset as u32)
    }
}
