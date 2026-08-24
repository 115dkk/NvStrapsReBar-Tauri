use core::ptr::{NonNull, read_volatile, write_volatile};

use nvstraps_core::straps::{self, StrapError, StrapPlan, StrapWrite};
#[cfg(target_os = "uefi")]
use nvstraps_core::straps::{
    NVIDIA_STRAPS_SET0_ADDRESS_OFFSET, NVIDIA_STRAPS_SET1_ADDRESS_OFFSET, ValidatedGpuWindow,
};

/// Proof that the firmware device transaction currently exposes the validated
/// BAR0 aperture. Raw addresses cannot escape this Module.
pub(crate) struct MappedBar0 {
    set0: NonNull<u32>,
    set1: NonNull<u32>,
}

impl MappedBar0 {
    /// Creates the MMIO proof immediately after PCI BAR0 remapping succeeds.
    ///
    /// # Safety
    ///
    /// The caller must have mapped `window` to the NVIDIA device currently
    /// being processed and must keep that mapping active until this value is
    /// dropped.
    #[cfg(target_os = "uefi")]
    pub(crate) unsafe fn assume_mapped(window: ValidatedGpuWindow) -> Result<Self, StrapError> {
        let set0 = window
            .register_address(NVIDIA_STRAPS_SET0_ADDRESS_OFFSET)
            .ok_or(StrapError::AddressOverflow)?;
        let set1 = window
            .register_address(NVIDIA_STRAPS_SET1_ADDRESS_OFFSET)
            .ok_or(StrapError::AddressOverflow)?;
        let set0 = NonNull::new(core::ptr::without_provenance_mut(set0 as usize))
            .ok_or(StrapError::AddressOverflow)?;
        let set1 = NonNull::new(core::ptr::without_provenance_mut(set1 as usize))
            .ok_or(StrapError::AddressOverflow)?;
        Ok(Self { set0, set1 })
    }

    pub(crate) fn plan(&self, bar_size_selector: u8) -> Result<StrapPlan, StrapError> {
        // SAFETY: Construction proves that both addresses are live, aligned MMIO
        // registers for the complete lifetime of this proof value.
        let (straps0, straps1) = unsafe {
            (
                read_volatile(self.set0.as_ptr()),
                read_volatile(self.set1.as_ptr()),
            )
        };
        straps::plan_bar1_straps(straps0, straps1, bar_size_selector)
    }

    pub(crate) fn write_set0(&mut self, write: StrapWrite) {
        self.write(self.set0, write.register_value);
    }

    pub(crate) fn write_set1(&mut self, write: StrapWrite) {
        self.write(self.set1, write.register_value);
    }

    #[cfg(target_os = "uefi")]
    pub(crate) fn set0_address(&self) -> u64 {
        self.set0.as_ptr().addr() as u64
    }

    #[cfg(target_os = "uefi")]
    pub(crate) fn set1_address(&self) -> u64 {
        self.set1.as_ptr().addr() as u64
    }

    fn write(&mut self, register: NonNull<u32>, value: u32) {
        // SAFETY: Construction proves validity and exclusive transaction access;
        // volatile preserves the hardware write.
        unsafe { write_volatile(register.as_ptr(), value) };
    }

    #[cfg(test)]
    fn with_live_registers<R>(
        set0: &mut u32,
        set1: &mut u32,
        operation: impl FnOnce(&mut Self) -> R,
    ) -> R {
        let mut registers = Self {
            set0: NonNull::from(set0),
            set1: NonNull::from(set1),
        };
        operation(&mut registers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_registers_are_read_and_written_through_the_real_mmio_seam() {
        let mut set0 = 0x1234_0001_u32;
        let mut set1 = 0x0560_0002_u32;

        MappedBar0::with_live_registers(&mut set0, &mut set1, |registers| {
            let plan = registers.plan(7).unwrap();
            registers.write_set0(plan.set0.expect("set0 requires a write"));
            registers.write_set1(plan.set1.expect("set1 requires a write"));
        });

        assert_eq!(set0, 0x9234_8001);
        assert_eq!(set1, 0x8550_0002);
    }

    #[test]
    fn an_already_configured_pair_requires_no_mmio_write() {
        let mut set0 = (2_u32 << 14) | 0x21;
        let mut set1 = (5_u32 << 20) | 0x42;

        MappedBar0::with_live_registers(&mut set0, &mut set1, |registers| {
            let plan = registers.plan(7).expect("selector is valid");
            assert_eq!(plan.set0, None);
            assert_eq!(plan.set1, None);
            assert!(!plan.reported_changed);
        });
    }

    #[test]
    fn an_invalid_selector_produces_no_write_plan() {
        let mut set0 = 0x1234_0001_u32;
        let mut set1 = 0x0560_0002_u32;

        MappedBar0::with_live_registers(&mut set0, &mut set1, |registers| {
            assert_eq!(registers.plan(11), Err(StrapError::InvalidBarSizeSelector));
        });
    }
}
