use crate::config::{Config, ConfigPriority, DeviceIdentity, GpuConfig};
use crate::registry::{BAR_SIZE_EXCLUDED, BAR_SIZE_NONE, MAX_BAR_SIZE_SELECTOR};

pub const NVIDIA_STRAPS_BASE_OFFSET: u64 = 0x0010_1000;
pub const NVIDIA_STRAPS_SET0_OFFSET: u64 = 0x0000_0000;
pub const NVIDIA_STRAPS_SET1_OFFSET: u64 = 0x0000_000c;
pub const NVIDIA_STRAPS_SET0_ADDRESS_OFFSET: u64 =
    NVIDIA_STRAPS_BASE_OFFSET + NVIDIA_STRAPS_SET0_OFFSET;
pub const NVIDIA_STRAPS_SET1_ADDRESS_OFFSET: u64 =
    NVIDIA_STRAPS_BASE_OFFSET + NVIDIA_STRAPS_SET1_OFFSET;
pub const BAR1_INDEX: u8 = 1;

const BAR1_SIZE_PART1_SHIFT: u32 = 14;
const BAR1_SIZE_PART1_MASK: u32 = 0x0000_c000;
const BAR1_SIZE_PART2_SHIFT: u32 = 20;
const BAR1_SIZE_PART2_MASK: u32 = 0x0070_0000;
const STRAP_OVERRIDE_ENABLE: u32 = 0x8000_0000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StrapWrite {
    pub register_value: u32,
    pub resume_data: u32,
    pub resume_mask: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StrapPlan {
    pub set0: Option<StrapWrite>,
    pub set1: Option<StrapWrite>,
    /// Mirrors the original driver's sum comparison, including its odd case
    /// where registers change but this value can remain false.
    pub reported_changed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StrapError {
    InvalidBarSizeSelector,
    AddressOverflow,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GpuWindowError {
    AddressAboveFourGiB,
    ReversedRange,
    UnalignedBase,
    BaseNotAlignedToWindow,
}

pub fn plan_bar1_straps(
    straps0: u32,
    straps1: u32,
    bar_size_selector: u8,
) -> Result<StrapPlan, StrapError> {
    if bar_size_selector > MAX_BAR_SIZE_SELECTOR {
        return Err(StrapError::InvalidBarSizeSelector);
    }

    let current_part1 = ((straps0 & BAR1_SIZE_PART1_MASK) >> BAR1_SIZE_PART1_SHIFT) as u8;
    let current_part2 = ((straps1 & BAR1_SIZE_PART2_MASK) >> BAR1_SIZE_PART2_SHIFT) as u8;
    let (target_part1, target_part2) = target_parts(bar_size_selector);
    let set0 = (current_part1 != target_part1).then_some(StrapWrite {
        register_value: (straps0 & !BAR1_SIZE_PART1_MASK)
            | ((target_part1 as u32) << BAR1_SIZE_PART1_SHIFT)
            | STRAP_OVERRIDE_ENABLE,
        resume_data: ((target_part1 as u32) << BAR1_SIZE_PART1_SHIFT) | STRAP_OVERRIDE_ENABLE,
        resume_mask: !BAR1_SIZE_PART1_MASK,
    });
    let set1 = (current_part2 != target_part2).then_some(StrapWrite {
        register_value: (straps1 & !BAR1_SIZE_PART2_MASK)
            | ((target_part2 as u32) << BAR1_SIZE_PART2_SHIFT)
            | STRAP_OVERRIDE_ENABLE,
        resume_data: ((target_part2 as u32) << BAR1_SIZE_PART2_SHIFT) | STRAP_OVERRIDE_ENABLE,
        resume_mask: !BAR1_SIZE_PART2_MASK,
    });

    Ok(StrapPlan {
        set0,
        set1,
        reported_changed: current_part1 + current_part2 != target_part1 + target_part2,
    })
}

pub const fn target_parts(bar_size_selector: u8) -> (u8, u8) {
    if bar_size_selector < 3 {
        (bar_size_selector, 0)
    } else if bar_size_selector < 10 {
        (2, bar_size_selector - 2)
    } else {
        (3, 7)
    }
}

pub const fn bar1_rebar_size_bit(bar_size_selector: u8) -> Option<u8> {
    if bar_size_selector <= MAX_BAR_SIZE_SELECTOR {
        Some(bar_size_selector + 6)
    } else {
        None
    }
}

pub const fn bar1_size_is_advertised(mask: u32, bar_size_selector: u8) -> bool {
    match bar1_rebar_size_bit(bar_size_selector) {
        Some(bit) => mask & (1_u32 << bit) != 0,
        None => false,
    }
}

pub const fn add_bar1_size_to_mask(mask: u32, bar_size_selector: u8) -> Option<(u32, bool)> {
    match bar1_rebar_size_bit(bar_size_selector) {
        Some(bit) => {
            let value = 1_u32 << bit;
            Some((mask | value, mask & value == 0))
        }
        None => None,
    }
}

pub fn selected_bar_size(config: &Config, device: DeviceIdentity) -> Option<u8> {
    let decision = config.lookup_bar_size(device);
    if decision.priority == ConfigPriority::Unconfigured {
        return None;
    }
    match decision.selector {
        Some(selector)
            if selector != BAR_SIZE_NONE
                && selector != BAR_SIZE_EXCLUDED
                && selector <= MAX_BAR_SIZE_SELECTOR =>
        {
            Some(selector)
        }
        _ => None,
    }
}

pub fn validate_gpu_window(config: &GpuConfig) -> Result<(), GpuWindowError> {
    if config.bar0_base >= u32::MAX as u64 || config.bar0_top >= u32::MAX as u64 {
        return Err(GpuWindowError::AddressAboveFourGiB);
    }
    if config.bar0_top < config.bar0_base {
        return Err(GpuWindowError::ReversedRange);
    }
    if config.bar0_base & 0x0f != 0 {
        return Err(GpuWindowError::UnalignedBase);
    }
    let window_size = config.bar0_top - config.bar0_base + 1;
    if !config.bar0_base.is_multiple_of(window_size) {
        return Err(GpuWindowError::BaseNotAlignedToWindow);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selector_split_matches_the_documented_pstraps_encoding() {
        assert_eq!(target_parts(0), (0, 0));
        assert_eq!(target_parts(2), (2, 0));
        assert_eq!(target_parts(3), (2, 1));
        assert_eq!(target_parts(9), (2, 7));
        assert_eq!(target_parts(10), (3, 7));
    }

    #[test]
    fn strap_plan_preserves_unrelated_bits_and_sets_override() {
        let plan = plan_bar1_straps(0x1234_0001, 0x0560_0002, 7).unwrap();
        let set0 = plan.set0.expect("set0 changes");
        let set1 = plan.set1.expect("set1 changes");
        assert_eq!(set0.register_value & BAR1_SIZE_PART1_MASK, 2 << 14);
        assert_eq!(set1.register_value & BAR1_SIZE_PART2_MASK, 5 << 20);
        assert_ne!(set0.register_value & STRAP_OVERRIDE_ENABLE, 0);
        assert_eq!(set0.resume_mask, !BAR1_SIZE_PART1_MASK);
        assert_eq!(set1.resume_mask, !BAR1_SIZE_PART2_MASK);
    }

    #[test]
    fn reported_changed_retains_the_original_sum_quirk() {
        // Current (3, 1) and target (2, 2) differ in both registers but have
        // the same sum. The C driver reports this as pre-configured.
        let straps0 = 3 << BAR1_SIZE_PART1_SHIFT;
        let straps1 = 1 << BAR1_SIZE_PART2_SHIFT;
        let plan = plan_bar1_straps(straps0, straps1, 4).unwrap();
        assert!(plan.set0.is_some());
        assert!(plan.set1.is_some());
        assert!(!plan.reported_changed);
    }

    #[test]
    fn bar1_mask_uses_selector_plus_six() {
        assert!(bar1_size_is_advertised(1 << 13, 7));
        assert!(!bar1_size_is_advertised(1 << 12, 7));
        assert_eq!(add_bar1_size_to_mask(0, 7), Some((1 << 13, true)));
        assert_eq!(add_bar1_size_to_mask(1 << 13, 7), Some((1 << 13, false)));
        assert_eq!(add_bar1_size_to_mask(0, 11), None);
    }

    #[test]
    fn gpu_window_validation_matches_firmware_guards_without_underflow() {
        let valid = GpuConfig {
            device_id: 0x1e81,
            subsystem_vendor_id: 0x1462,
            subsystem_device_id: 0x3750,
            bus: 1,
            device: 0,
            function: 0,
            bar0_base: 0xc000_0000,
            bar0_top: 0xc0ff_ffff,
        };
        assert_eq!(validate_gpu_window(&valid), Ok(()));

        let mut invalid = valid;
        invalid.bar0_top = invalid.bar0_base - 1;
        assert_eq!(
            validate_gpu_window(&invalid),
            Err(GpuWindowError::ReversedRange)
        );
        invalid = valid;
        invalid.bar0_base += 0x10;
        assert_eq!(
            validate_gpu_window(&invalid),
            Err(GpuWindowError::BaseNotAlignedToWindow)
        );
    }
}
