pub const STATUS_NOT_LOADED: u32 = 10;
pub const STATUS_INTERNAL_EFI_ERROR: u32 = 180;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PciLocation {
    pub bus: u8,
    pub device: u8,
    pub function: u8,
}

impl PciLocation {
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

    pub const fn pack(self) -> u16 {
        ((self.bus as u16) << 8)
            | (((self.device as u16) & 0x1F) << 3)
            | ((self.function as u16) & 0x07)
    }

    pub const fn unpack(value: u16) -> Self {
        Self {
            bus: (value >> 8) as u8,
            device: ((value >> 3) & 0x1F) as u8,
            function: (value & 0x07) as u8,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodedStatus {
    pub raw: u64,
    pub code: u32,
    pub pci_location: Option<PciLocation>,
    pub efi_error_location: Option<u8>,
    pub efi_status: Option<u8>,
}

impl DecodedStatus {
    pub const fn decode(raw: u64) -> Self {
        let code = (raw & 0xFFFF_FFFF) as u32;
        let packed_location = (raw >> 48) as u16;
        let is_efi_error = code == STATUS_INTERNAL_EFI_ERROR;
        Self {
            raw,
            code,
            pci_location: if packed_location == 0 {
                None
            } else {
                Some(PciLocation::unpack(packed_location))
            },
            efi_error_location: if is_efi_error {
                Some(((raw >> 40) & 0xFF) as u8)
            } else {
                None
            },
            efi_status: if is_efi_error {
                Some(((raw >> 32) & 0xFF) as u8)
            } else {
                None
            },
        }
    }

    pub const fn encode(code: u32, location: Option<PciLocation>) -> u64 {
        let location = match location {
            Some(location) => (location.pack() as u64) << 48,
            None => 0,
        };
        location | code as u64
    }

    pub const fn encode_efi_error(
        error_location: u8,
        efi_status: u8,
        location: Option<PciLocation>,
    ) -> u64 {
        Self::encode(STATUS_INTERNAL_EFI_ERROR, location)
            | ((efi_status as u64) << 32)
            | ((error_location as u64) << 40)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_layout_matches_the_c_contract() {
        let location = PciLocation::new(1, 1, 0).unwrap();
        let raw = DecodedStatus::encode_efi_error(17, 9, Some(location));
        let decoded = DecodedStatus::decode(raw);
        assert_eq!(decoded.code, STATUS_INTERNAL_EFI_ERROR);
        assert_eq!(decoded.pci_location, Some(location));
        assert_eq!(decoded.efi_error_location, Some(17));
        assert_eq!(decoded.efi_status, Some(9));
    }
}
