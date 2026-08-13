use crate::status::PciLocation;

pub const CONFIG_SPACE_SIZE: u16 = 256;
pub const EXTENDED_CONFIG_SPACE_SIZE: u16 = 4096;
pub const EXTENDED_CAPABILITY_BASE: u16 = 0x100;
pub const RESIZABLE_BAR_CAPABILITY_ID: u16 = 0x15;

pub const VENDOR_DEVICE_OFFSET: u16 = 0x00;
pub const COMMAND_OFFSET: u16 = 0x04;
pub const REVISION_CLASS_OFFSET: u16 = 0x08;
pub const CACHELINE_HEADER_OFFSET: u16 = 0x0c;
pub const BAR0_OFFSET: u16 = 0x10;
pub const BRIDGE_BUS_OFFSET: u16 = 0x18;
pub const BRIDGE_IO_BASE_OFFSET: u16 = 0x1c;
pub const BRIDGE_MEMORY_BASE_OFFSET: u16 = 0x20;
pub const SUBSYSTEM_ID_OFFSET: u16 = 0x2c;

pub const COMMAND_IO: u32 = 0x01;
pub const COMMAND_MEMORY: u32 = 0x02;
pub const COMMAND_BUS_MASTER: u32 = 0x04;
pub const REQUIRED_COMMAND_BITS: u32 = COMMAND_IO | COMMAND_MEMORY | COMMAND_BUS_MASTER;

pub const HEADER_TYPE_MULTI_FUNCTION: u8 = 0x80;
pub const HEADER_TYPE_PCI_TO_PCI_BRIDGE: u8 = 0x01;
pub const VGA_CLASS_REGISTER: u32 = 0x0300_0000;

pub const REBAR_CAPABILITY_OFFSET: u16 = 4;
pub const REBAR_CONTROL_OFFSET: u16 = 8;
pub const REBAR_CAPABILITY_SIZES: u32 = 0x00ff_fff0;
pub const REBAR_CONTROL_BAR_INDEX: u32 = 0x0000_0007;
pub const REBAR_CONTROL_BAR_COUNT: u32 = 0x0000_00e0;
pub const REBAR_CONTROL_BAR_COUNT_SHIFT: u32 = 5;
pub const REBAR_CONTROL_BAR_SIZE: u32 = 0x0000_1f00;
pub const REBAR_CONTROL_BAR_SIZE_SHIFT: u32 = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PciAddress {
    pub bus: u8,
    pub device: u8,
    pub function: u8,
}

impl PciAddress {
    pub const fn new(bus: u8, device: u8, function: u8) -> Option<Self> {
        if device <= 31 && function <= 7 {
            Some(Self {
                bus,
                device,
                function,
            })
        } else {
            None
        }
    }

    pub const fn location(self) -> PciLocation {
        PciLocation {
            bus: self.bus,
            device: self.device,
            function: self.function,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeviceHeader {
    pub address: PciAddress,
    pub vendor_id: u16,
    pub device_id: u16,
    pub header_type: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BridgeRemap {
    pub command: u32,
    pub io_base_limit: u32,
    pub memory_base_limit: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeviceRemap {
    pub command: u32,
    pub bar0: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemapError {
    AddressAboveFourGiB,
    InvalidRange,
    UnalignedBar,
}

pub const fn is_pci_bridge(header_type: u8) -> bool {
    header_type & !HEADER_TYPE_MULTI_FUNCTION == HEADER_TYPE_PCI_TO_PCI_BRIDGE
}

pub const fn is_vga_controller(class_register: u32) -> bool {
    class_register == VGA_CLASS_REGISTER
}

pub const fn extended_capability_id(header: u32) -> u16 {
    (header & 0xffff) as u16
}

pub const fn next_extended_capability(header: u32) -> u16 {
    ((header >> 20) & 0xffc) as u16
}

pub const fn rebar_bar_count(control: u32) -> u8 {
    ((control & REBAR_CONTROL_BAR_COUNT) >> REBAR_CONTROL_BAR_COUNT_SHIFT) as u8
}

pub const fn rebar_bar_index(control: u32) -> u8 {
    (control & REBAR_CONTROL_BAR_INDEX) as u8
}

pub const fn rebar_possible_sizes(capability: u32) -> u32 {
    (capability & REBAR_CAPABILITY_SIZES) >> 4
}

pub const fn with_rebar_size(control: u32, size_bit_index: u8) -> u32 {
    (control & !REBAR_CONTROL_BAR_SIZE)
        | (((size_bit_index as u32) << REBAR_CONTROL_BAR_SIZE_SHIFT) & REBAR_CONTROL_BAR_SIZE)
}

pub const fn highest_set_bit(value: u32) -> u8 {
    if value == 0 {
        0
    } else {
        (u32::BITS - 1 - value.leading_zeros()) as u8
    }
}

pub fn bridge_remap(
    saved_command: u32,
    saved_io_base_limit: u32,
    base_address: u64,
    inclusive_top_address: u64,
    target_io_base_limit: u64,
) -> Result<BridgeRemap, RemapError> {
    if base_address > u32::MAX as u64
        || inclusive_top_address > u32::MAX as u64
        || target_io_base_limit > u32::MAX as u64
    {
        return Err(RemapError::AddressAboveFourGiB);
    }

    let mut top_exclusive = inclusive_top_address
        .checked_add(1)
        .ok_or(RemapError::InvalidRange)?;
    if top_exclusive & 0x000f_ffff != 0 {
        top_exclusive = top_exclusive
            .checked_add(0x0010_0000)
            .ok_or(RemapError::InvalidRange)?
            & 0xfff0_0000;
    }
    if top_exclusive <= base_address {
        return Err(RemapError::InvalidRange);
    }

    let io = target_io_base_limit as u32;
    let io_range = (io & 0xff00) | ((io >> 8) & 0x00ff);
    Ok(BridgeRemap {
        command: saved_command | REQUIRED_COMMAND_BITS,
        io_base_limit: (saved_io_base_limit & 0xffff_0000) | (io_range & 0xffff),
        memory_base_limit: (((base_address as u32) >> 16) & 0x0000_fff0)
            | ((top_exclusive as u32) & 0xfff0_0000),
    })
}

pub const fn device_remap(
    saved_command: u32,
    base_address: u64,
) -> Result<DeviceRemap, RemapError> {
    if base_address > u32::MAX as u64 {
        return Err(RemapError::AddressAboveFourGiB);
    }
    if base_address & 0x0f != 0 {
        return Err(RemapError::UnalignedBar);
    }
    Ok(DeviceRemap {
        command: saved_command | REQUIRED_COMMAND_BITS,
        bar0: (base_address as u32) & 0xffff_fff0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_and_header_helpers_match_pci_layout() {
        let address = PciAddress::new(2, 31, 7).unwrap();
        assert_eq!(address.location().pack(), 0x02ff);
        assert!(PciAddress::new(0, 32, 0).is_none());
        assert!(is_pci_bridge(0x01));
        assert!(is_pci_bridge(0x81));
        assert!(!is_pci_bridge(0x00));
        assert!(is_vga_controller(0x0300_0000));
    }

    #[test]
    fn extended_capability_and_rebar_fields_match_linux_style_masks() {
        let header = 0x1801_0015;
        assert_eq!(extended_capability_id(header), 0x15);
        assert_eq!(next_extended_capability(header), 0x180);

        let control = 0x0000_0362;
        assert_eq!(rebar_bar_count(control), 3);
        assert_eq!(rebar_bar_index(control), 2);
        assert_eq!(
            with_rebar_size(control, 0x1a) & REBAR_CONTROL_BAR_SIZE,
            0x1a00
        );
        assert_eq!(rebar_possible_sizes(0x00ab_cdf0), 0x000a_bcdf);
        assert_eq!(highest_set_bit(0x1200), 12);
        assert_eq!(highest_set_bit(0), 0);
    }

    #[test]
    fn bridge_window_rounding_matches_the_c_driver() {
        let remap = bridge_remap(0x100, 0xabcd_0000, 0xc000_0000, 0xc0ff_ffff, 0xf1f1)
            .expect("valid remap");
        assert_eq!(remap.command, 0x107);
        assert_eq!(remap.io_base_limit, 0xabcd_f1f1);
        assert_eq!(remap.memory_base_limit, 0xc100_c000);

        let rounded = bridge_remap(0, 0, 0xc000_0000, 0xc000_0123, 0xf1f1).expect("rounded remap");
        assert_eq!(rounded.memory_base_limit, 0xc010_c000);
        assert_eq!(
            bridge_remap(0, 0, 0x1_0000_0000, 0x1_000f_ffff, 0xf1f1),
            Err(RemapError::AddressAboveFourGiB)
        );
    }

    #[test]
    fn device_bar_remap_rejects_truncation_and_misalignment() {
        assert_eq!(
            device_remap(0x100, 0xc000_0000),
            Ok(DeviceRemap {
                command: 0x107,
                bar0: 0xc000_0000,
            })
        );
        assert_eq!(device_remap(0, 0xc000_0001), Err(RemapError::UnalignedBar));
        assert_eq!(
            device_remap(0, 0x1_0000_0000),
            Err(RemapError::AddressAboveFourGiB)
        );
    }
}
