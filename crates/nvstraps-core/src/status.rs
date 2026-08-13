pub const STATUS_NOT_LOADED: u32 = StatusCode::NotLoaded as u32;
pub const STATUS_INTERNAL_EFI_ERROR: u32 = StatusCode::InternalEfiError as u32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum StatusCode {
    NotLoaded = 10,
    Configured = 20,
    GpuUnconfigured = 30,
    Unconfigured = 40,
    Cleared = 50,
    BridgeFound = 60,
    GpuFound = 70,
    GpuStrapsConfigured = 80,
    GpuStrapsPreConfigured = 90,
    GpuStrapsConfirm = 100,
    GpuDelayElapsed = 110,
    GpuReBarConfigured = 120,
    GpuStrapsNoConfirm = 130,
    GpuReBarSizeOverride = 135,
    GpuNoReBarCapability = 140,
    GpuExcluded = 150,
    NoBridgeConfig = 159,
    BadBridgeConfig = 160,
    BridgeNotEnumerated = 161,
    NoGpuConfig = 162,
    BadGpuConfig = 163,
    BadSetupVarAttributes = 164,
    AmbiguousSetupVariable = 165,
    MissingSetupVariable = 166,
    EfiAllocationError = 170,
    InternalEfiError = 180,
    NvarApiError = 190,
    ParseError = 200,
}

impl StatusCode {
    pub const fn raw(self) -> u32 {
        self as u32
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum EfiErrorLocation {
    None = 0,
    ReadConfigVar = 1,
    EnumVar = 2,
    EnumSetupVarSize = 3,
    ReadSetupVar = 4,
    ReadSetupVarSize = 5,
    AllocateSetupVarName = 6,
    AllocateSetupVarData = 7,
    WriteConfigVar = 8,
    PciStartFindCapability = 9,
    PciFindCapability = 10,
    PciBridgeSecondaryBus = 11,
    PciBridgeConfig = 12,
    PciBridgeRestore = 13,
    PciDeviceBarConfig = 14,
    PciDeviceBarRestore = 15,
    PciDeviceSubsystem = 16,
    LocateBridgeProtocol = 17,
    LoadBridgeProtocol = 18,
    LocateS3SaveStateProtocol = 19,
    LoadS3SaveStateProtocol = 20,
    WriteS3SaveStateProtocol = 21,
    ReadBaseAddress0 = 22,
    CmosTime = 23,
    CreateTimer = 24,
    CloseTimer = 25,
    SetupTimer = 26,
    WaitTimer = 27,
    CreateEvent = 28,
    CloseEvent = 29,
}

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
        Self::encode_value(code as u64, location)
    }

    pub const fn encode_value(value: u64, location: Option<PciLocation>) -> u64 {
        let location = match location {
            Some(location) => (location.pack() as u64) << 48,
            None => 0,
        };
        location | (value & 0x0000_FFFF_FFFF_FFFF)
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StatusAccumulator {
    value: u64,
}

impl Default for StatusAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

impl StatusAccumulator {
    pub const fn new() -> Self {
        Self {
            value: STATUS_NOT_LOADED as u64,
        }
    }

    pub const fn value(self) -> u64 {
        self.value
    }

    pub fn record(&mut self, code: StatusCode, location: Option<PciLocation>) -> Option<u64> {
        let code = code.raw() as u64;
        if code <= self.value {
            return None;
        }
        self.value = code;
        Some(DecodedStatus::encode_value(self.value, location))
    }

    pub fn record_efi_error(
        &mut self,
        error_location: EfiErrorLocation,
        efi_status: u8,
        location: Option<PciLocation>,
    ) -> Option<u64> {
        if self.value >= 1_u64 << 32 {
            return None;
        }
        self.value = ((error_location as u64) << 40)
            | ((efi_status as u64) << 32)
            | STATUS_INTERNAL_EFI_ERROR as u64;
        Some(DecodedStatus::encode_value(self.value, location))
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

    #[test]
    fn status_codes_and_error_locations_match_the_c_enums() {
        assert_eq!(StatusCode::GpuReBarSizeOverride.raw(), 135);
        assert_eq!(StatusCode::NoBridgeConfig.raw(), 159);
        assert_eq!(StatusCode::ParseError.raw(), 200);
        assert_eq!(EfiErrorLocation::ReadConfigVar as u8, 1);
        assert_eq!(EfiErrorLocation::LocateBridgeProtocol as u8, 17);
        assert_eq!(EfiErrorLocation::CloseEvent as u8, 29);
    }

    #[test]
    fn accumulator_keeps_only_progress_and_first_efi_error() {
        let location = PciLocation::new(2, 3, 1).unwrap();
        let mut status = StatusAccumulator::new();
        assert!(status.record(StatusCode::Configured, None).is_some());
        assert!(status.record(StatusCode::NotLoaded, None).is_none());
        let raw = status
            .record_efi_error(EfiErrorLocation::PciFindCapability, 14, Some(location))
            .unwrap();
        assert_eq!(DecodedStatus::decode(raw).pci_location, Some(location));
        assert!(
            status
                .record_efi_error(EfiErrorLocation::CmosTime, 7, None)
                .is_none()
        );
        assert!(status.record(StatusCode::ParseError, None).is_none());
    }
}
