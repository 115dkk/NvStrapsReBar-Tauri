use nvstraps_core::{
    config::{
        BridgeConfig, DeviceIdentity, GpuConfig, GpuSelector, MAX_BRIDGE_COUNT, MAX_GPU_COUNT,
        OPTION_DISABLE_SETUP_CRC, OPTION_GLOBAL_MASK, OPTION_OVERRIDE_SIZE_MASK, OPTION_SKIP_S3,
        TARGET_PCI_BAR_GPU_ONLY, TARGET_PCI_BAR_MAX, TARGET_PCI_BAR_STRAPS_ONLY,
    },
    registry::{BAR_SIZE_EXCLUDED, BAR_SIZE_NONE, MAX_BAR_SIZE_SELECTOR, registry_bar_size},
};
use serde::{Deserialize, Serialize};

use crate::{
    devices::GpuDevice,
    error::{BackendError, BackendResult},
};

pub use nvstraps_core::config::{Config as NvConfig, TARGET_PCI_BAR_DISABLED};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDraft {
    pub global_mode: u8,
    pub target_pci_bar_size: u8,
    pub skip_s3_resume: bool,
    pub override_bar_size_mask: bool,
    pub guard_setup_changes: bool,
    pub rules: Vec<GpuRule>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchScope {
    Device,
    Subsystem,
    Location,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GpuRule {
    pub match_scope: MatchScope,
    pub device_id: u16,
    pub subsystem_vendor_id: u16,
    pub subsystem_device_id: u16,
    pub bus: u8,
    pub device: u8,
    pub function: u8,
    pub bar_size_selector: Option<u8>,
    pub override_bar_size_mask: Option<bool>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentConfigRecommendation {
    pub draft: ConfigDraft,
    pub turing_gpu_count: usize,
    pub registry_managed_gpu_count: usize,
    pub exact_fallback_rule_count: usize,
}

impl Default for ConfigDraft {
    fn default() -> Self {
        Self {
            global_mode: 0,
            target_pci_bar_size: TARGET_PCI_BAR_DISABLED,
            skip_s3_resume: false,
            override_bar_size_mask: false,
            guard_setup_changes: true,
            rules: Vec::new(),
        }
    }
}

pub fn config_from_draft(draft: &ConfigDraft, devices: &[GpuDevice]) -> BackendResult<NvConfig> {
    validate_draft(draft, devices)?;
    let mut option_flags = u16::from(draft.global_mode) & OPTION_GLOBAL_MASK;
    option_flags |= u16::from(draft.skip_s3_resume) * OPTION_SKIP_S3;
    option_flags |= u16::from(draft.override_bar_size_mask) * OPTION_OVERRIDE_SIZE_MASK;
    if !draft.guard_setup_changes {
        option_flags |= OPTION_DISABLE_SETUP_CRC;
    }

    let mut config = NvConfig {
        target_pci_bar_size: draft.target_pci_bar_size,
        option_flags,
        setup_var_crc: 0,
        selectors: draft.rules.iter().map(selector_from_rule).collect(),
        gpu_configs: Vec::new(),
        bridge_configs: Vec::new(),
    };
    populate_hardware(&mut config, devices)?;
    Ok(config)
}

pub fn recommend_deployment_config(
    devices: &[GpuDevice],
) -> BackendResult<DeploymentConfigRecommendation> {
    let turing_devices = devices
        .iter()
        .filter(|device| device.is_turing)
        .collect::<Vec<_>>();
    if turing_devices.is_empty() {
        return Err(invalid(
            "the guarded deployment preset requires at least one detected Turing GPU",
        ));
    }

    let mut registry_managed_gpu_count = 0;
    let mut rules = Vec::new();
    for device in &turing_devices {
        if registry_bar_size(device.device_id).is_some() {
            registry_managed_gpu_count += 1;
            continue;
        }
        let bar_size_selector = device.recommended_bar_size_selector.ok_or_else(|| {
            invalid(format!(
                "Turing GPU {:04X} has no safe fallback BAR selector",
                device.device_id
            ))
        })?;
        rules.push(GpuRule {
            match_scope: MatchScope::Location,
            device_id: device.device_id,
            subsystem_vendor_id: device.subsystem_vendor_id,
            subsystem_device_id: device.subsystem_device_id,
            bus: device.bus,
            device: device.device,
            function: device.function,
            bar_size_selector: Some(bar_size_selector),
            override_bar_size_mask: None,
        });
    }
    rules.sort_by_key(|rule| {
        (
            rule.bus,
            rule.device,
            rule.function,
            rule.device_id,
            rule.subsystem_vendor_id,
            rule.subsystem_device_id,
        )
    });

    let draft = ConfigDraft {
        global_mode: 1,
        target_pci_bar_size: TARGET_PCI_BAR_DISABLED,
        skip_s3_resume: false,
        override_bar_size_mask: false,
        guard_setup_changes: true,
        rules,
    };
    // Build the exact wire model now so the recommendation endpoint cannot offer a draft that
    // would later fail the firmware count, topology, or BAR0 safety gates.
    config_from_draft(&draft, devices)?;

    Ok(DeploymentConfigRecommendation {
        exact_fallback_rule_count: draft.rules.len(),
        draft,
        turing_gpu_count: turing_devices.len(),
        registry_managed_gpu_count,
    })
}

pub fn require_recommended_deployment_config(
    draft: &ConfigDraft,
    devices: &[GpuDevice],
) -> BackendResult<()> {
    let expected = recommend_deployment_config(devices)?;
    if expected.draft != *draft {
        return Err(invalid(
            "the deployment configuration no longer matches the guarded backend recommendation; refresh it before saving",
        ));
    }
    Ok(())
}

pub fn draft_from_config(config: &NvConfig) -> ConfigDraft {
    ConfigDraft {
        global_mode: config.global_mode(),
        target_pci_bar_size: config.target_pci_bar_size,
        skip_s3_resume: config.skip_s3_resume(),
        override_bar_size_mask: config.override_bar_size_mask(),
        guard_setup_changes: config.setup_crc_enabled(),
        rules: config.selectors.iter().map(rule_from_selector).collect(),
    }
}

pub fn effective_bar_size(config: &NvConfig, device: &GpuDevice) -> Option<u8> {
    config.lookup_bar_size(device_identity(device)).selector
}

pub fn setup_crc_hex(config: &NvConfig) -> String {
    format!("0x{:016X}", config.setup_var_crc)
}

fn populate_hardware(config: &mut NvConfig, devices: &[GpuDevice]) -> BackendResult<()> {
    for device in devices {
        let selector = effective_bar_size(config, device);
        if selector.is_none_or(|value| value >= BAR_SIZE_EXCLUDED) {
            continue;
        }
        if device.bar0_base == 0
            || device.bar0_top < device.bar0_base
            || device.bar0_base > u64::from(u32::MAX)
            || device.bar0_top > u64::from(u32::MAX)
        {
            return Err(invalid(format!(
                "{} has no usable 32-bit BAR0 range for the DXE driver",
                device.name
            )));
        }
        let bar_size = device
            .bar0_top
            .checked_sub(device.bar0_base)
            .and_then(|size| size.checked_add(1))
            .ok_or_else(|| invalid(format!("{} has an invalid BAR0 range", device.name)))?;
        if device.bar0_base & 0xF != 0 || bar_size == 0 || device.bar0_base % bar_size != 0 {
            return Err(invalid(format!(
                "{} has a BAR0 range that is not naturally aligned",
                device.name
            )));
        }

        config.gpu_configs.push(GpuConfig {
            device_id: device.device_id,
            subsystem_vendor_id: device.subsystem_vendor_id,
            subsystem_device_id: device.subsystem_device_id,
            bus: device.bus,
            device: device.device,
            function: device.function,
            bar0_base: device.bar0_base,
            bar0_top: device.bar0_top,
        });

        let bridge = BridgeConfig {
            vendor_id: device.bridge.vendor_id,
            device_id: device.bridge.device_id,
            bus: device.bridge.bus,
            device: device.bridge.device,
            function: device.bridge.function,
            secondary_bus: device.bus,
        };
        if let Some(existing) = config
            .bridge_configs
            .iter()
            .find(|item| item.secondary_bus == bridge.secondary_bus)
        {
            if existing != &bridge {
                return Err(invalid(format!(
                    "multiple parent bridges were reported for PCI bus {}",
                    bridge.secondary_bus
                )));
            }
        } else {
            config.bridge_configs.push(bridge);
        }
    }

    if config.gpu_configs.len() > MAX_GPU_COUNT {
        return Err(invalid("at most eight configured GPUs are supported"));
    }
    if config.bridge_configs.len() > MAX_BRIDGE_COUNT {
        return Err(invalid("too many PCI bridge records"));
    }
    Ok(())
}

fn selector_from_rule(rule: &GpuRule) -> GpuSelector {
    let (subsystem_vendor_id, subsystem_device_id, bus, device, function) = match rule.match_scope {
        MatchScope::Device => (u16::MAX, u16::MAX, u8::MAX, u8::MAX, u8::MAX),
        MatchScope::Subsystem => (
            rule.subsystem_vendor_id,
            rule.subsystem_device_id,
            u8::MAX,
            u8::MAX,
            u8::MAX,
        ),
        MatchScope::Location => (
            rule.subsystem_vendor_id,
            rule.subsystem_device_id,
            rule.bus,
            rule.device,
            rule.function,
        ),
    };
    GpuSelector {
        device_id: rule.device_id,
        subsystem_vendor_id,
        subsystem_device_id,
        bus,
        device,
        function,
        bar_size_selector: rule.bar_size_selector.unwrap_or(BAR_SIZE_NONE),
        override_bar_size_mask: rule
            .override_bar_size_mask
            .map_or(0, |enabled| if enabled { 1 } else { u8::MAX }),
    }
}

fn rule_from_selector(selector: &GpuSelector) -> GpuRule {
    let has_subsystem =
        selector.subsystem_vendor_id != u16::MAX && selector.subsystem_device_id != u16::MAX;
    let has_location =
        selector.bus != u8::MAX || selector.device != u8::MAX || selector.function != u8::MAX;
    let match_scope = if has_location {
        MatchScope::Location
    } else if has_subsystem {
        MatchScope::Subsystem
    } else {
        MatchScope::Device
    };
    GpuRule {
        match_scope,
        device_id: selector.device_id,
        subsystem_vendor_id: selector.subsystem_vendor_id,
        subsystem_device_id: selector.subsystem_device_id,
        bus: selector.bus,
        device: selector.device,
        function: selector.function,
        bar_size_selector: (selector.bar_size_selector != BAR_SIZE_NONE)
            .then_some(selector.bar_size_selector),
        override_bar_size_mask: match selector.override_bar_size_mask {
            0 => None,
            u8::MAX => Some(false),
            _ => Some(true),
        },
    }
}

pub fn validate_draft(draft: &ConfigDraft, devices: &[GpuDevice]) -> BackendResult<()> {
    if draft.global_mode > 2 {
        return Err(invalid("global mode must be 0, 1, or 2"));
    }
    if !valid_target_pci_size(draft.target_pci_bar_size) {
        return Err(invalid("unsupported target PCI BAR size selector"));
    }
    if draft.rules.len() > MAX_GPU_COUNT {
        return Err(invalid("at most eight GPU rules are supported"));
    }
    for (index, rule) in draft.rules.iter().enumerate() {
        if rule
            .bar_size_selector
            .is_some_and(|value| value > MAX_BAR_SIZE_SELECTOR && value != BAR_SIZE_EXCLUDED)
        {
            return Err(invalid("unsupported GPU BAR size selector"));
        }
        if rule.bar_size_selector.is_none() && rule.override_bar_size_mask.is_none() {
            return Err(invalid(
                "a GPU rule must change a BAR size or mask override",
            ));
        }
        if rule.match_scope == MatchScope::Location && (rule.device > 31 || rule.function > 7) {
            return Err(invalid("PCI device/function is out of range"));
        }
        if draft.rules[..index]
            .iter()
            .any(|candidate| same_rule_identity(candidate, rule))
        {
            return Err(invalid("duplicate GPU rule match scope"));
        }
        let exists = devices.iter().any(|device| {
            device.device_id == rule.device_id
                && match rule.match_scope {
                    MatchScope::Device => true,
                    MatchScope::Subsystem => {
                        device.subsystem_vendor_id == rule.subsystem_vendor_id
                            && device.subsystem_device_id == rule.subsystem_device_id
                    }
                    MatchScope::Location => {
                        device.subsystem_vendor_id == rule.subsystem_vendor_id
                            && device.subsystem_device_id == rule.subsystem_device_id
                            && device.bus == rule.bus
                            && device.device == rule.device
                            && device.function == rule.function
                    }
                }
        });
        if !exists {
            return Err(invalid(format!(
                "GPU rule for device {:04X} does not match current hardware",
                rule.device_id
            )));
        }
    }
    Ok(())
}

fn same_rule_identity(left: &GpuRule, right: &GpuRule) -> bool {
    left.match_scope == right.match_scope
        && left.device_id == right.device_id
        && match left.match_scope {
            MatchScope::Device => true,
            MatchScope::Subsystem => {
                left.subsystem_vendor_id == right.subsystem_vendor_id
                    && left.subsystem_device_id == right.subsystem_device_id
            }
            MatchScope::Location => {
                left.subsystem_vendor_id == right.subsystem_vendor_id
                    && left.subsystem_device_id == right.subsystem_device_id
                    && left.bus == right.bus
                    && left.device == right.device
                    && left.function == right.function
            }
        }
}

fn valid_target_pci_size(selector: u8) -> bool {
    selector <= TARGET_PCI_BAR_MAX
        || selector == TARGET_PCI_BAR_GPU_ONLY
        || selector == TARGET_PCI_BAR_STRAPS_ONLY
}

fn device_identity(device: &GpuDevice) -> DeviceIdentity {
    DeviceIdentity {
        device_id: device.device_id,
        subsystem_vendor_id: device.subsystem_vendor_id,
        subsystem_device_id: device.subsystem_device_id,
        bus: device.bus,
        device: device.device,
        function: device.function,
    }
}

fn invalid(message: impl Into<String>) -> BackendError {
    BackendError::InvalidConfiguration(message.into())
}

#[cfg(test)]
mod tests {
    use nvstraps_core::config::{Config, GpuSelector};

    use super::*;
    use crate::devices::PciBridge;

    fn sample_device(device_id: u16) -> GpuDevice {
        GpuDevice {
            id: "pci-01-00-0".into(),
            name: "Test GPU".into(),
            vendor_id: 0x10DE,
            device_id,
            subsystem_vendor_id: 0x1462,
            subsystem_device_id: 0x3722,
            bus: 1,
            device: 0,
            function: 0,
            bridge: PciBridge {
                vendor_id: 0x8086,
                device_id: 0x1901,
                bus: 0,
                device: 1,
                function: 0,
            },
            bar0_base: 0xF000_0000,
            bar0_top: 0xF0FF_FFFF,
            current_bar_size: 0x0100_0000,
            dedicated_video_memory: 8 * 1024 * 1024 * 1024,
            is_turing: true,
            recommended_bar_size_selector: Some(5),
            effective_bar_size_selector: None,
        }
    }

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
            gpu_configs: Vec::new(),
            bridge_configs: Vec::new(),
        }
    }

    #[test]
    fn draft_round_trip_preserves_rule_scope_and_flags() {
        let config = sample_config();
        let draft = draft_from_config(&config);
        assert_eq!(draft.global_mode, 2);
        assert!(draft.skip_s3_resume);
        assert!(draft.override_bar_size_mask);
        assert_eq!(draft.rules[0].match_scope, MatchScope::Device);
        assert_eq!(draft.rules[0].bar_size_selector, Some(7));
        validate_draft(&draft, &[sample_device(0x1E84)]).unwrap();
    }

    #[test]
    fn hardware_population_uses_the_shared_registry_policy() {
        let draft = ConfigDraft {
            global_mode: 1,
            ..ConfigDraft::default()
        };
        let config = config_from_draft(&draft, &[sample_device(0x1E84)]).unwrap();
        assert_eq!(effective_bar_size(&config, &sample_device(0x1E84)), Some(7));
        assert_eq!(config.gpu_configs.len(), 1);
        assert_eq!(config.bridge_configs.len(), 1);
    }

    #[test]
    fn aggressive_global_mode_is_required_for_unlisted_turing_ids() {
        let device = sample_device(0x1F81);
        let mut config = Config {
            option_flags: 1,
            ..Config::default()
        };
        assert_eq!(effective_bar_size(&config, &device), None);
        config.option_flags = 2;
        assert_eq!(effective_bar_size(&config, &device), Some(5));
    }

    #[test]
    fn guarded_recommendation_uses_registry_plus_exact_unknown_gpu_rules() {
        let known = sample_device(0x1E84);
        let mut unknown = sample_device(0x1F81);
        unknown.id = "pci-02-00-0".into();
        unknown.bus = 2;
        unknown.bar0_base = 0xE000_0000;
        unknown.bar0_top = 0xE0FF_FFFF;

        let recommendation =
            recommend_deployment_config(&[unknown.clone(), known.clone()]).unwrap();
        assert_eq!(recommendation.turing_gpu_count, 2);
        assert_eq!(recommendation.registry_managed_gpu_count, 1);
        assert_eq!(recommendation.exact_fallback_rule_count, 1);
        assert_eq!(recommendation.draft.global_mode, 1);
        assert_eq!(recommendation.draft.target_pci_bar_size, 0);
        assert!(recommendation.draft.guard_setup_changes);
        assert_eq!(
            recommendation.draft.rules[0].match_scope,
            MatchScope::Location
        );
        assert_eq!(recommendation.draft.rules[0].bus, 2);

        let config =
            config_from_draft(&recommendation.draft, &[known.clone(), unknown.clone()]).unwrap();
        assert_eq!(effective_bar_size(&config, &known), Some(7));
        assert_eq!(effective_bar_size(&config, &unknown), Some(5));
    }

    #[test]
    fn guarded_recommendation_refuses_a_non_turing_inventory() {
        let mut device = sample_device(0x2684);
        device.is_turing = false;
        device.recommended_bar_size_selector = None;
        assert!(recommend_deployment_config(&[device]).is_err());
    }

    #[test]
    fn deployment_write_requires_the_fresh_backend_recommendation() {
        let device = sample_device(0x1E84);
        let recommendation = recommend_deployment_config(core::slice::from_ref(&device)).unwrap();
        require_recommended_deployment_config(
            &recommendation.draft,
            core::slice::from_ref(&device),
        )
        .unwrap();

        let mut changed = recommendation.draft;
        changed.override_bar_size_mask = true;
        assert!(
            require_recommended_deployment_config(&changed, core::slice::from_ref(&device))
                .unwrap_err()
                .to_string()
                .contains("guarded backend recommendation")
        );
    }
}
