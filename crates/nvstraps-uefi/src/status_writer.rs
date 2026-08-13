use nvstraps_core::status::{EfiErrorLocation, PciLocation, StatusAccumulator, StatusCode};
use uefi::Status;

use crate::variables;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StatusWriter {
    accumulator: StatusAccumulator,
}

impl StatusWriter {
    pub const fn new() -> Self {
        Self {
            accumulator: StatusAccumulator::new(),
        }
    }

    pub fn record(
        &mut self,
        code: StatusCode,
        location: Option<PciLocation>,
    ) -> Result<(), Status> {
        if let Some(raw) = self.accumulator.record(code, location) {
            variables::write_status(raw)?;
        }
        Ok(())
    }

    pub fn record_efi_error(
        &mut self,
        error_location: EfiErrorLocation,
        status: Status,
        location: Option<PciLocation>,
    ) -> Result<(), Status> {
        self.record_efi_error_code(error_location, (status.0 & 0xff) as u8, location)
    }

    pub fn record_efi_error_code(
        &mut self,
        error_location: EfiErrorLocation,
        status: u8,
        location: Option<PciLocation>,
    ) -> Result<(), Status> {
        if let Some(raw) = self
            .accumulator
            .record_efi_error(error_location, status, location)
        {
            variables::write_status(raw)?;
        }
        Ok(())
    }

    pub const fn value(&self) -> u64 {
        self.accumulator.value()
    }
}
