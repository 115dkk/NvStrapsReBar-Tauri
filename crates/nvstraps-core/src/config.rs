use alloc::vec::Vec;
use core::fmt;

use crate::registry::{BAR_SIZE_NONE, is_turing, registry_bar_size};

pub const MAX_GPU_COUNT: usize = 8;
pub const MAX_BRIDGE_COUNT: usize = MAX_GPU_COUNT + 2;
pub const HEADER_SIZE: usize = 1 + 2 + 8;
pub const GPU_SELECTOR_SIZE: usize = 10;
pub const GPU_CONFIG_SIZE: usize = 24;
pub const BRIDGE_CONFIG_SIZE: usize = 7;
pub const MAX_ENCODED_SIZE: usize = HEADER_SIZE
    + 1
    + MAX_GPU_COUNT * GPU_SELECTOR_SIZE
    + 1
    + MAX_GPU_COUNT * GPU_CONFIG_SIZE
    + 1
    + MAX_BRIDGE_COUNT * BRIDGE_CONFIG_SIZE;

pub const OPTION_GLOBAL_MASK: u16 = 0x0003;
pub const OPTION_SKIP_S3: u16 = 0x0004;
pub const OPTION_OVERRIDE_SIZE_MASK: u16 = 0x0008;
pub const OPTION_HAS_SETUP_CRC: u16 = 0x0010;
pub const OPTION_DISABLE_SETUP_CRC: u16 = 0x0020;

pub const TARGET_PCI_BAR_DISABLED: u8 = 0;
pub const TARGET_PCI_BAR_MIN: u8 = 1;
pub const TARGET_PCI_BAR_MAX: u8 = 32;
pub const TARGET_PCI_BAR_GPU_ONLY: u8 = 64;
pub const TARGET_PCI_BAR_STRAPS_ONLY: u8 = 65;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Config {
    pub target_pci_bar_size: u8,
    pub option_flags: u16,
    pub setup_var_crc: u64,
    pub selectors: Vec<GpuSelector>,
    pub gpu_configs: Vec<GpuConfig>,
    pub bridge_configs: Vec<BridgeConfig>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GpuSelector {
    pub device_id: u16,
    pub subsystem_vendor_id: u16,
    pub subsystem_device_id: u16,
    pub bus: u8,
    pub device: u8,
    pub function: u8,
    pub bar_size_selector: u8,
    pub override_bar_size_mask: u8,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GpuConfig {
    pub device_id: u16,
    pub subsystem_vendor_id: u16,
    pub subsystem_device_id: u16,
    pub bus: u8,
    pub device: u8,
    pub function: u8,
    pub bar0_base: u64,
    pub bar0_top: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BridgeConfig {
    pub vendor_id: u16,
    pub device_id: u16,
    pub bus: u8,
    pub device: u8,
    pub function: u8,
    pub secondary_bus: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeviceIdentity {
    pub device_id: u16,
    pub subsystem_vendor_id: u16,
    pub subsystem_device_id: u16,
    pub bus: u8,
    pub device: u8,
    pub function: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum ConfigPriority {
    Unconfigured = 0,
    ImpliedGlobal = 1,
    FoundGlobal = 2,
    ExplicitDevice = 3,
    ExplicitSubsystem = 4,
    ExplicitLocation = 5,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BarSizeDecision {
    pub priority: ConfigPriority,
    pub selector: Option<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MaskOverrideDecision {
    pub priority: ConfigPriority,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigError {
    HeaderTruncated,
    RecordTruncated,
    SizeOverflow,
    TooManySelectors,
    TooManyGpuConfigs,
    TooManyBridgeConfigs,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::HeaderTruncated => "configuration header is truncated",
            Self::RecordTruncated => "configuration record is truncated",
            Self::SizeOverflow => "configuration size overflow",
            Self::TooManySelectors => "at most eight GPU rules are supported",
            Self::TooManyGpuConfigs => "at most eight configured GPUs are supported",
            Self::TooManyBridgeConfigs => "too many PCI bridge records",
        })
    }
}

#[cfg(feature = "std")]
impl std::error::Error for ConfigError {}

impl Config {
    pub fn decode(bytes: &[u8]) -> Result<Self, ConfigError> {
        if bytes.is_empty() {
            return Ok(Self::default());
        }
        if bytes.len() < HEADER_SIZE + 3 {
            return Err(ConfigError::HeaderTruncated);
        }

        let mut cursor = Cursor::new(bytes);
        let target_pci_bar_size = cursor.byte()?;
        let option_flags = cursor.word()?;
        let setup_var_crc = cursor.qword()?;
        let selector_count = cursor.byte()? as usize;
        if selector_count > MAX_GPU_COUNT {
            return Err(ConfigError::TooManySelectors);
        }
        let mut selectors = Vec::with_capacity(selector_count);
        for _ in 0..selector_count {
            let device_id = cursor.word()?;
            let subsystem_vendor_id = cursor.word()?;
            let subsystem_device_id = cursor.word()?;
            let bus = cursor.byte()?;
            let packed_location = cursor.byte()?;
            let (device, function) = unpack_location(bus, packed_location);
            selectors.push(GpuSelector {
                device_id,
                subsystem_vendor_id,
                subsystem_device_id,
                bus,
                device,
                function,
                bar_size_selector: cursor.byte()?,
                override_bar_size_mask: cursor.byte()?,
            });
        }

        let gpu_count = cursor.byte()? as usize;
        if gpu_count > MAX_GPU_COUNT {
            return Err(ConfigError::TooManyGpuConfigs);
        }
        let mut gpu_configs = Vec::with_capacity(gpu_count);
        for _ in 0..gpu_count {
            let device_id = cursor.word()?;
            let subsystem_vendor_id = cursor.word()?;
            let subsystem_device_id = cursor.word()?;
            let bus = cursor.byte()?;
            let packed_location = cursor.byte()?;
            let (device, function) = unpack_location(bus, packed_location);
            gpu_configs.push(GpuConfig {
                device_id,
                subsystem_vendor_id,
                subsystem_device_id,
                bus,
                device,
                function,
                bar0_base: cursor.qword()?,
                bar0_top: cursor.qword()?,
            });
        }

        let bridge_count = cursor.byte()? as usize;
        if bridge_count > MAX_BRIDGE_COUNT {
            return Err(ConfigError::TooManyBridgeConfigs);
        }
        let mut bridge_configs = Vec::with_capacity(bridge_count);
        for _ in 0..bridge_count {
            let vendor_id = cursor.word()?;
            let device_id = cursor.word()?;
            let bus = cursor.byte()?;
            let packed_location = cursor.byte()?;
            let (device, function) = unpack_location(bus, packed_location);
            bridge_configs.push(BridgeConfig {
                vendor_id,
                device_id,
                bus,
                device,
                function,
                secondary_bus: cursor.byte()?,
            });
        }

        Ok(Self {
            target_pci_bar_size,
            option_flags,
            setup_var_crc,
            selectors,
            gpu_configs,
            bridge_configs,
        })
    }

    pub fn encode(&self) -> Result<Vec<u8>, ConfigError> {
        self.validate_counts()?;
        if !self.is_driver_configured() {
            return Ok(Vec::new());
        }

        let capacity = HEADER_SIZE
            + 1
            + self.selectors.len() * GPU_SELECTOR_SIZE
            + 1
            + self.gpu_configs.len() * GPU_CONFIG_SIZE
            + 1
            + self.bridge_configs.len() * BRIDGE_CONFIG_SIZE;
        let mut bytes = Vec::with_capacity(capacity);
        bytes.push(self.target_pci_bar_size);
        bytes.extend_from_slice(&self.option_flags.to_le_bytes());
        bytes.extend_from_slice(&self.setup_var_crc.to_le_bytes());
        bytes.push(self.selectors.len() as u8);
        for selector in &self.selectors {
            bytes.extend_from_slice(&selector.device_id.to_le_bytes());
            bytes.extend_from_slice(&selector.subsystem_vendor_id.to_le_bytes());
            bytes.extend_from_slice(&selector.subsystem_device_id.to_le_bytes());
            bytes.push(selector.bus);
            bytes.push(pack_location(selector.device, selector.function));
            bytes.push(selector.bar_size_selector);
            bytes.push(selector.override_bar_size_mask);
        }
        bytes.push(self.gpu_configs.len() as u8);
        for gpu in &self.gpu_configs {
            bytes.extend_from_slice(&gpu.device_id.to_le_bytes());
            bytes.extend_from_slice(&gpu.subsystem_vendor_id.to_le_bytes());
            bytes.extend_from_slice(&gpu.subsystem_device_id.to_le_bytes());
            bytes.push(gpu.bus);
            bytes.push(pack_location(gpu.device, gpu.function));
            bytes.extend_from_slice(&gpu.bar0_base.to_le_bytes());
            bytes.extend_from_slice(&gpu.bar0_top.to_le_bytes());
        }
        bytes.push(self.bridge_configs.len() as u8);
        for bridge in &self.bridge_configs {
            bytes.extend_from_slice(&bridge.vendor_id.to_le_bytes());
            bytes.extend_from_slice(&bridge.device_id.to_le_bytes());
            bytes.push(bridge.bus);
            bytes.push(pack_location(bridge.device, bridge.function));
            bytes.push(bridge.secondary_bus);
        }
        debug_assert_eq!(bytes.len(), capacity);
        Ok(bytes)
    }

    pub const fn global_mode(&self) -> u8 {
        (self.option_flags & OPTION_GLOBAL_MASK) as u8
    }

    pub const fn skip_s3_resume(&self) -> bool {
        self.option_flags & OPTION_SKIP_S3 != 0
    }

    pub const fn override_bar_size_mask(&self) -> bool {
        self.option_flags & OPTION_OVERRIDE_SIZE_MASK != 0
    }

    pub const fn has_setup_crc(&self) -> bool {
        self.option_flags & OPTION_HAS_SETUP_CRC != 0
    }

    pub const fn setup_crc_enabled(&self) -> bool {
        self.option_flags & OPTION_DISABLE_SETUP_CRC == 0
    }

    pub fn is_gpu_configured(&self) -> bool {
        self.global_mode() != 0 || !self.selectors.is_empty()
    }

    pub fn is_driver_configured(&self) -> bool {
        self.target_pci_bar_size != TARGET_PCI_BAR_DISABLED || self.is_gpu_configured()
    }

    pub fn lookup_bar_size(&self, device: DeviceIdentity) -> BarSizeDecision {
        let mut result = BarSizeDecision {
            priority: ConfigPriority::Unconfigured,
            selector: None,
        };
        for selector in &self.selectors {
            if selector.device_id != device.device_id {
                continue;
            }
            if selector.has_subsystem() {
                if !selector.matches_subsystem(device) {
                    continue;
                }
                if selector.has_location() {
                    if selector.matches_location(device)
                        && selector.bar_size_selector != BAR_SIZE_NONE
                    {
                        return BarSizeDecision {
                            priority: ConfigPriority::ExplicitLocation,
                            selector: Some(selector.bar_size_selector),
                        };
                    }
                } else if selector.bar_size_selector != BAR_SIZE_NONE {
                    result = BarSizeDecision {
                        priority: ConfigPriority::ExplicitSubsystem,
                        selector: Some(selector.bar_size_selector),
                    };
                }
            } else if result.priority < ConfigPriority::ExplicitSubsystem
                && selector.bar_size_selector != BAR_SIZE_NONE
            {
                result = BarSizeDecision {
                    priority: ConfigPriority::ExplicitDevice,
                    selector: Some(selector.bar_size_selector),
                };
            }
        }

        if result.priority == ConfigPriority::Unconfigured && self.global_mode() != 0 {
            if let Some(selector) = registry_bar_size(device.device_id) {
                return BarSizeDecision {
                    priority: ConfigPriority::FoundGlobal,
                    selector: Some(selector),
                };
            }
            if self.global_mode() > 1 && is_turing(device.device_id) {
                return BarSizeDecision {
                    priority: ConfigPriority::ImpliedGlobal,
                    selector: Some(5),
                };
            }
        }
        result
    }

    pub fn lookup_bar_size_mask_override(&self, device: DeviceIdentity) -> MaskOverrideDecision {
        let mut result = MaskOverrideDecision {
            priority: ConfigPriority::Unconfigured,
            enabled: false,
        };
        for selector in &self.selectors {
            if selector.device_id != device.device_id {
                continue;
            }
            if selector.has_subsystem() {
                if !selector.matches_subsystem(device) {
                    continue;
                }
                if selector.has_location() {
                    if selector.matches_location(device) && selector.override_bar_size_mask != 0 {
                        return MaskOverrideDecision {
                            priority: ConfigPriority::ExplicitLocation,
                            enabled: selector.override_bar_size_mask != u8::MAX,
                        };
                    }
                } else if selector.override_bar_size_mask != 0 {
                    result = MaskOverrideDecision {
                        priority: ConfigPriority::ExplicitSubsystem,
                        enabled: selector.override_bar_size_mask != u8::MAX,
                    };
                }
            } else if result.priority < ConfigPriority::ExplicitSubsystem
                && selector.override_bar_size_mask != 0
            {
                result = MaskOverrideDecision {
                    priority: ConfigPriority::ExplicitDevice,
                    enabled: selector.override_bar_size_mask != u8::MAX,
                };
            }
        }
        if result.priority == ConfigPriority::Unconfigured {
            result = MaskOverrideDecision {
                priority: ConfigPriority::FoundGlobal,
                enabled: self.override_bar_size_mask(),
            };
        }
        result
    }

    pub fn lookup_gpu_config(&self, bus: u8, device: u8, function: u8) -> Option<&GpuConfig> {
        self.gpu_configs.iter().find(|config| {
            config.bus == bus && config.device == device && config.function == function
        })
    }

    pub fn lookup_bridge_config(&self, secondary_bus: u8) -> Option<&BridgeConfig> {
        self.bridge_configs
            .iter()
            .find(|config| config.secondary_bus == secondary_bus)
    }

    pub fn bridge_device(&self, bus: u8, device: u8, function: u8) -> Option<(u16, u16)> {
        self.bridge_configs
            .iter()
            .find(|config| {
                config.bus == bus && config.device == device && config.function == function
            })
            .map(|config| (config.vendor_id, config.device_id))
    }

    fn validate_counts(&self) -> Result<(), ConfigError> {
        if self.selectors.len() > MAX_GPU_COUNT {
            return Err(ConfigError::TooManySelectors);
        }
        if self.gpu_configs.len() > MAX_GPU_COUNT {
            return Err(ConfigError::TooManyGpuConfigs);
        }
        if self.bridge_configs.len() > MAX_BRIDGE_COUNT {
            return Err(ConfigError::TooManyBridgeConfigs);
        }
        Ok(())
    }
}

impl GpuSelector {
    fn has_subsystem(&self) -> bool {
        self.subsystem_vendor_id != u16::MAX && self.subsystem_device_id != u16::MAX
    }

    fn has_location(&self) -> bool {
        self.bus != u8::MAX || self.device != u8::MAX || self.function != u8::MAX
    }

    fn matches_subsystem(&self, device: DeviceIdentity) -> bool {
        self.subsystem_vendor_id == device.subsystem_vendor_id
            && self.subsystem_device_id == device.subsystem_device_id
    }

    fn matches_location(&self, device: DeviceIdentity) -> bool {
        self.bus == device.bus && self.device == device.device && self.function == device.function
    }
}

fn pack_location(device: u8, function: u8) -> u8 {
    ((device << 3) & 0xF8) | (function & 0x07)
}

fn unpack_location(bus: u8, value: u8) -> (u8, u8) {
    if bus == u8::MAX && value == u8::MAX {
        (u8::MAX, u8::MAX)
    } else {
        ((value >> 3) & 0x1F, value & 0x07)
    }
}

struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn take<const N: usize>(&mut self) -> Result<[u8; N], ConfigError> {
        let end = self
            .position
            .checked_add(N)
            .ok_or(ConfigError::SizeOverflow)?;
        let value = self
            .bytes
            .get(self.position..end)
            .ok_or(ConfigError::RecordTruncated)?;
        self.position = end;
        value.try_into().map_err(|_| ConfigError::RecordTruncated)
    }

    fn byte(&mut self) -> Result<u8, ConfigError> {
        Ok(self.take::<1>()?[0])
    }

    fn word(&mut self) -> Result<u16, ConfigError> {
        Ok(u16::from_le_bytes(self.take()?))
    }

    fn qword(&mut self) -> Result<u64, ConfigError> {
        Ok(u64::from_le_bytes(self.take()?))
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec;

    use super::*;

    fn sample_config() -> Config {
        Config {
            target_pci_bar_size: 64,
            option_flags: 0x000E,
            setup_var_crc: 0x1122_3344_5566_7788,
            selectors: vec![GpuSelector {
                device_id: 0x1E84,
                subsystem_vendor_id: u16::MAX,
                subsystem_device_id: u16::MAX,
                bus: u8::MAX,
                device: u8::MAX,
                function: u8::MAX,
                bar_size_selector: 7,
                override_bar_size_mask: 0,
            }],
            gpu_configs: vec![GpuConfig {
                device_id: 0x1E84,
                subsystem_vendor_id: 0x1462,
                subsystem_device_id: 0x3722,
                bus: 1,
                device: 0,
                function: 0,
                bar0_base: 0xFA00_0000,
                bar0_top: 0xFAFF_FFFF,
            }],
            bridge_configs: vec![BridgeConfig {
                vendor_id: 0x8086,
                device_id: 0x1901,
                bus: 0,
                device: 1,
                function: 0,
                secondary_bus: 1,
            }],
        }
    }

    fn sample_identity() -> DeviceIdentity {
        DeviceIdentity {
            device_id: 0x1E84,
            subsystem_vendor_id: 0x1462,
            subsystem_device_id: 0x3722,
            bus: 1,
            device: 0,
            function: 0,
        }
    }

    #[test]
    fn binary_format_matches_the_upstream_c_layout() {
        let encoded = sample_config().encode().unwrap();
        let expected = [
            0x40, 0x0E, 0x00, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x01, 0x84, 0x1E,
            0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x07, 0x00, 0x01, 0x84, 0x1E, 0x62, 0x14, 0x22,
            0x37, 0x01, 0x00, 0x00, 0x00, 0x00, 0xFA, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF,
            0xFA, 0x00, 0x00, 0x00, 0x00, 0x01, 0x86, 0x80, 0x01, 0x19, 0x00, 0x08, 0x01,
        ];
        assert_eq!(encoded, expected);
        assert_eq!(Config::decode(&encoded).unwrap(), sample_config());
    }

    #[test]
    fn lookup_priority_matches_the_c_implementation() {
        let config = sample_config();
        assert_eq!(
            config.lookup_bar_size(sample_identity()),
            BarSizeDecision {
                priority: ConfigPriority::ExplicitDevice,
                selector: Some(7),
            }
        );
        assert_eq!(
            config.lookup_bar_size_mask_override(sample_identity()),
            MaskOverrideDecision {
                priority: ConfigPriority::FoundGlobal,
                enabled: true,
            }
        );
    }

    #[test]
    fn empty_configuration_encodes_as_variable_deletion() {
        assert!(Config::default().encode().unwrap().is_empty());
        assert_eq!(Config::decode(&[]).unwrap(), Config::default());
    }
}
