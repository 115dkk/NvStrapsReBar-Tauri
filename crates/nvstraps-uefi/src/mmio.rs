use core::ptr::{read_volatile, write_volatile};

use nvstraps_core::straps::{self, StrapError, StrapPlan};

/// Reads the two NVIDIA BAR1 strap registers and derives the required writes.
///
/// # Safety
///
/// `set0` and `set1` must each be valid, naturally aligned pointers to an
/// initialized `u32` MMIO register for the duration of the volatile reads.
pub unsafe fn plan_bar1_straps_from_mmio(
    set0: *const u32,
    set1: *const u32,
    bar_size_selector: u8,
) -> Result<StrapPlan, StrapError> {
    // SAFETY: The caller owns both pointer validity and MMIO alignment.
    let straps0 = unsafe { read_volatile(set0) };
    // SAFETY: The caller owns both pointer validity and MMIO alignment.
    let straps1 = unsafe { read_volatile(set1) };
    straps::plan_bar1_straps(straps0, straps1, bar_size_selector)
}

/// Writes one planned NVIDIA strap value through volatile MMIO.
///
/// # Safety
///
/// `register` must be a valid, naturally aligned, writable `u32` MMIO
/// register for the duration of the volatile write.
pub unsafe fn write_bar1_strap(register: *mut u32, value: u32) {
    // SAFETY: The caller owns pointer validity, writability, and alignment.
    unsafe { write_volatile(register, value) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_registers_are_read_and_written_through_the_real_mmio_boundary() {
        let mut set0 = 0x1234_0001_u32;
        let mut set1 = 0x0560_0002_u32;

        // SAFETY: Both pointers come from live, aligned, initialized `u32`
        // allocations and remain valid for the complete operation.
        let plan =
            unsafe { plan_bar1_straps_from_mmio(&raw const set0, &raw const set1, 7).unwrap() };
        let set0_write = plan.set0.expect("set0 requires a write");
        let set1_write = plan.set1.expect("set1 requires a write");

        // SAFETY: Both pointers still refer to their live writable `u32`
        // allocations. Miri interprets these exact volatile operations.
        unsafe {
            write_bar1_strap(&raw mut set0, set0_write.register_value);
            write_bar1_strap(&raw mut set1, set1_write.register_value);
        }

        assert_eq!(set0, set0_write.register_value);
        assert_eq!(set1, set1_write.register_value);
    }

    #[test]
    fn an_already_configured_pair_requires_no_mmio_write() {
        let set0 = (2_u32 << 14) | 0x21;
        let set1 = (5_u32 << 20) | 0x42;

        // SAFETY: Both pointers refer to live, aligned, initialized values.
        let plan = unsafe { plan_bar1_straps_from_mmio(&raw const set0, &raw const set1, 7) }
            .expect("selector is valid");

        assert_eq!(plan.set0, None);
        assert_eq!(plan.set1, None);
        assert!(!plan.reported_changed);
    }

    #[test]
    fn an_invalid_selector_produces_no_write_plan() {
        let set0 = 0x1234_0001_u32;
        let set1 = 0x0560_0002_u32;

        // SAFETY: Both pointers refer to live, aligned, initialized values.
        let result = unsafe { plan_bar1_straps_from_mmio(&raw const set0, &raw const set1, 11) };

        assert_eq!(result, Err(StrapError::InvalidBarSizeSelector));
    }
}
