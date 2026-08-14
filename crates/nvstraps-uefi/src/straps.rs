use nvstraps_core::straps::{
    NVIDIA_STRAPS_SET0_ADDRESS_OFFSET, NVIDIA_STRAPS_SET1_ADDRESS_OFFSET, StrapError,
};
use uefi::Status;

use crate::mmio::{plan_bar1_straps_from_mmio, write_bar1_strap};

pub trait S3Recorder {
    fn memory_read_write_u32(
        &mut self,
        address: u64,
        data: u32,
        data_mask: u32,
    ) -> Result<(), Status>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StrapApplyResult {
    pub reported_changed: bool,
    pub resume_error: Option<Status>,
}

/// Programs NVIDIA's BAR1 strap fields and records equivalent S3 operations.
///
/// # Safety
///
/// `bar0_base` must be the validated, naturally aligned 32-bit BAR0 mapping of
/// the NVIDIA device currently being processed. The bridge and device command
/// registers must expose that mapping for the duration of this call.
pub unsafe fn configure_bar1_size(
    bar0_base: u64,
    bar_size_selector: u8,
    resume: &mut impl S3Recorder,
) -> Result<StrapApplyResult, StrapError> {
    let set0_address = bar0_base
        .checked_add(NVIDIA_STRAPS_SET0_ADDRESS_OFFSET)
        .ok_or(StrapError::AddressOverflow)?;
    let set1_address = bar0_base
        .checked_add(NVIDIA_STRAPS_SET1_ADDRESS_OFFSET)
        .ok_or(StrapError::AddressOverflow)?;
    let set0_pointer = set0_address as *mut u32;
    let set1_pointer = set1_address as *mut u32;

    // SAFETY: Guaranteed by this function's BAR0 mapping contract.
    let plan = unsafe {
        plan_bar1_straps_from_mmio(
            set0_pointer.cast_const(),
            set1_pointer.cast_const(),
            bar_size_selector,
        )
    }?;
    let mut resume_error = None;

    if let Some(write) = plan.set0 {
        // SAFETY: Guaranteed by this function's BAR0 mapping contract.
        unsafe { write_bar1_strap(set0_pointer, write.register_value) };
        if let Err(status) =
            resume.memory_read_write_u32(set0_address, write.resume_data, write.resume_mask)
        {
            resume_error.get_or_insert(status);
        }
    }
    if let Some(write) = plan.set1 {
        // SAFETY: Guaranteed by this function's BAR0 mapping contract.
        unsafe { write_bar1_strap(set1_pointer, write.register_value) };
        if let Err(status) =
            resume.memory_read_write_u32(set1_address, write.resume_data, write.resume_mask)
        {
            resume_error.get_or_insert(status);
        }
    }

    Ok(StrapApplyResult {
        reported_changed: plan.reported_changed,
        resume_error,
    })
}
