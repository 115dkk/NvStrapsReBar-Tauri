use crate::config::{
    Config, TARGET_PCI_BAR_DISABLED, TARGET_PCI_BAR_GPU_ONLY, TARGET_PCI_BAR_MAX,
    TARGET_PCI_BAR_MIN, TARGET_PCI_BAR_STRAPS_ONLY,
};
use crate::pci::highest_set_bit;

pub const MINIMUM_SAFE_RTC_YEAR: u16 = 2024;
pub const AMD_VENDOR_ID: u16 = 0x1002;
pub const SAPPHIRE_RX_5600_XT_PULSE_DEVICE_ID: u16 = 0x731f;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectiveTarget {
    Disabled,
    Global(u8),
    SelectedGpuOnly,
    StrapsOnly,
}

pub fn effective_target(config: &Config) -> EffectiveTarget {
    let target =
        if config.target_pci_bar_size == TARGET_PCI_BAR_DISABLED && config.is_gpu_configured() {
            TARGET_PCI_BAR_STRAPS_ONLY
        } else {
            config.target_pci_bar_size
        };
    match target {
        TARGET_PCI_BAR_DISABLED => EffectiveTarget::Disabled,
        TARGET_PCI_BAR_MIN..=TARGET_PCI_BAR_MAX => EffectiveTarget::Global(target),
        TARGET_PCI_BAR_GPU_ONLY => EffectiveTarget::SelectedGpuOnly,
        TARGET_PCI_BAR_STRAPS_ONLY => EffectiveTarget::StrapsOnly,
        _ => EffectiveTarget::Disabled,
    }
}

pub const fn rtc_indicates_cmos_reset(year: u16) -> bool {
    year < MINIMUM_SAFE_RTC_YEAR
}

/// Selects the largest advertised ReBAR size that does not exceed the user's
/// global cap. Bit zero is deliberately skipped to preserve the upstream
/// driver's behavior.
pub const fn select_global_rebar_size(mask: u32, maximum: u8) -> Option<u8> {
    if mask == 0 || maximum == 0 {
        return None;
    }
    let mut candidate = {
        let highest = highest_set_bit(mask);
        if highest < maximum { highest } else { maximum }
    };
    while candidate > 0 {
        if mask & (1_u32 << candidate) != 0 {
            return Some(candidate);
        }
        candidate -= 1;
    }
    None
}

pub const fn apply_known_rebar_mask_quirk(
    vendor_id: u16,
    device_id: u16,
    bar_index: u8,
    mask: u32,
) -> u32 {
    if vendor_id == AMD_VENDOR_ID
        && device_id == SAPPHIRE_RX_5600_XT_PULSE_DEVICE_ID
        && bar_index == 0
        && mask == 0x7000
    {
        0x3f000
    } else {
        mask
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::GpuSelector;

    #[test]
    fn gpu_rules_enable_straps_when_the_global_target_is_zero() {
        let mut config = Config::default();
        assert_eq!(effective_target(&config), EffectiveTarget::Disabled);
        config.selectors.push(GpuSelector {
            device_id: 0x1e81,
            subsystem_vendor_id: u16::MAX,
            subsystem_device_id: u16::MAX,
            bus: u8::MAX,
            device: u8::MAX,
            function: u8::MAX,
            bar_size_selector: 7,
            override_bar_size_mask: 0,
        });
        assert_eq!(effective_target(&config), EffectiveTarget::StrapsOnly);
        config.target_pci_bar_size = 12;
        assert_eq!(effective_target(&config), EffectiveTarget::Global(12));
    }

    #[test]
    fn global_size_selection_walks_down_to_an_advertised_bit() {
        assert_eq!(select_global_rebar_size(0b1_0100, 8), Some(4));
        assert_eq!(select_global_rebar_size(0b1_0100, 3), Some(2));
        assert_eq!(select_global_rebar_size(1, 32), None);
        assert_eq!(select_global_rebar_size(0, 32), None);
    }

    #[test]
    fn known_sapphire_capability_quirk_is_narrowly_scoped() {
        assert_eq!(
            apply_known_rebar_mask_quirk(AMD_VENDOR_ID, 0x731f, 0, 0x7000),
            0x3f000
        );
        assert_eq!(
            apply_known_rebar_mask_quirk(AMD_VENDOR_ID, 0x731f, 1, 0x7000),
            0x7000
        );
        assert!(rtc_indicates_cmos_reset(2000));
        assert!(!rtc_indicates_cmos_reset(MINIMUM_SAFE_RTC_YEAR));
    }
}
