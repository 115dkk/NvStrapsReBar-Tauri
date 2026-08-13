use nvstraps_core::boot_policy::{EffectiveTarget, effective_target, rtc_indicates_cmos_reset};
use nvstraps_core::status::{EfiErrorLocation, StatusCode};
use uefi::{Status, runtime};

use crate::engine::FirmwareEngine;
use crate::host_bridge;
use crate::s3::S3Script;
use crate::setup_variable::{self, SetupGuardDecision, SetupVariableError};
use crate::status_writer::StatusWriter;
use crate::variables::{self, ConfigReadError};

pub fn initialize() -> Status {
    let mut status = StatusWriter::new();
    let mut config = match variables::read_config() {
        Ok(config) => config,
        Err(ConfigReadError::Firmware(error)) => {
            record_efi_error(&mut status, EfiErrorLocation::ReadConfigVar, error);
            return Status::SUCCESS;
        }
        Err(ConfigReadError::Parse(_)) => {
            record_status(&mut status, StatusCode::ParseError);
            return Status::SUCCESS;
        }
    };
    if config.is_driver_configured() && !config.is_gpu_configured() {
        record_status(&mut status, StatusCode::GpuUnconfigured);
    }
    let target = effective_target(&config);
    if target == EffectiveTarget::Disabled {
        record_status(&mut status, StatusCode::Unconfigured);
        return Status::SUCCESS;
    }

    let setup_changed = if config.setup_crc_enabled() {
        match setup_variable::evaluate_setup_guard(&mut config) {
            Ok(SetupGuardDecision::Initialized) => {
                if let Err(error) = variables::write_config(&config) {
                    record_efi_error(&mut status, EfiErrorLocation::WriteConfigVar, error);
                }
                false
            }
            Ok(SetupGuardDecision::Unchanged) => false,
            Ok(SetupGuardDecision::Changed) => true,
            Err(error) => {
                record_setup_error(&mut status, error);
                true
            }
        }
    } else {
        false
    };
    if setup_changed {
        // Deliberately do not persist this clear: restoring the previous UEFI
        // settings should restore the user's configuration on the next boot.
        config.clear_for_safety();
        record_status(&mut status, StatusCode::Cleared);
        return Status::SUCCESS;
    }

    let cmos_reset = match runtime::get_time() {
        Ok(time) => rtc_indicates_cmos_reset(time.year()),
        Err(error) => {
            record_efi_error(&mut status, EfiErrorLocation::CmosTime, error.status());
            true
        }
    };
    if cmos_reset {
        config.clear_for_safety();
        if let Err(error) = variables::write_config(&config) {
            record_efi_error(&mut status, EfiErrorLocation::WriteConfigVar, error);
        }
        record_status(&mut status, StatusCode::Cleared);
        return Status::SUCCESS;
    }

    record_status(&mut status, StatusCode::Configured);
    let resume = match S3Script::initialize(config.is_gpu_configured(), config.skip_s3_resume()) {
        Ok(resume) => resume,
        Err(error) => {
            record_efi_error(&mut status, error.location, error.status);
            S3Script::disabled()
        }
    };
    let engine = FirmwareEngine::new(config, target, resume, status);
    if let Err(error) = host_bridge::install(engine) {
        record_efi_error(&mut status, error.location, error.status);
    }
    Status::SUCCESS
}

fn record_setup_error(status: &mut StatusWriter, error: SetupVariableError) {
    match error {
        SetupVariableError::Firmware {
            location,
            status: firmware_status,
        } => record_efi_error(status, location, firmware_status),
        SetupVariableError::BadAttributes => {
            record_status(status, StatusCode::BadSetupVarAttributes);
        }
        SetupVariableError::Ambiguous => {
            record_status(status, StatusCode::AmbiguousSetupVariable);
        }
        SetupVariableError::Missing => {
            record_status(status, StatusCode::MissingSetupVariable);
        }
    }
}

fn record_status(status: &mut StatusWriter, code: StatusCode) {
    let _ = status.record(code, None);
}

fn record_efi_error(
    status: &mut StatusWriter,
    location: EfiErrorLocation,
    firmware_status: Status,
) {
    let _ = status.record_efi_error(location, firmware_status, None);
}
