use nvstraps_core::straps::StrapError;
use uefi::Status;

use crate::mmio::MappedBar0;

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
pub(crate) fn configure_bar1_size(
    mapped_bar0: &mut MappedBar0,
    bar_size_selector: u8,
    resume: &mut impl S3Recorder,
) -> Result<StrapApplyResult, StrapError> {
    let plan = mapped_bar0.plan(bar_size_selector)?;
    let mut resume_error = None;

    if let Some(write) = plan.set0 {
        mapped_bar0.write_set0(write);
        if let Err(status) = resume.memory_read_write_u32(
            mapped_bar0.set0_address(),
            write.resume_data,
            write.resume_mask,
        ) {
            resume_error.get_or_insert(status);
        }
    }
    if let Some(write) = plan.set1 {
        mapped_bar0.write_set1(write);
        if let Err(status) = resume.memory_read_write_u32(
            mapped_bar0.set1_address(),
            write.resume_data,
            write.resume_mask,
        ) {
            resume_error.get_or_insert(status);
        }
    }

    Ok(StrapApplyResult {
        reported_changed: plan.reported_changed,
        resume_error,
    })
}
