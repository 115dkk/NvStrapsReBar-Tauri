use alloc::boxed::Box;

use nvstraps_core::config::Config;
use nvstraps_core::setup_crc::setup_variable_crc64;
use nvstraps_core::status::EfiErrorLocation;
use uefi::prelude::{Status, cstr16};
use uefi::runtime::{self, VariableAttributes, VariableVendor};

const SETUP_NAME: &uefi::CStr16 = cstr16!("Setup");
const CUSTOM_NAME: &uefi::CStr16 = cstr16!("Custom");
const MINIMUM_SETUP_SIZE: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SetupVariableError {
    Firmware {
        location: EfiErrorLocation,
        status: Status,
    },
    BadAttributes,
    Ambiguous,
    Missing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SetupGuardDecision {
    Initialized,
    Unchanged,
    Changed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SelectedVariable {
    name: &'static uefi::CStr16,
    vendor: VariableVendor,
}

pub fn evaluate_setup_guard(config: &mut Config) -> Result<SetupGuardDecision, SetupVariableError> {
    let data = read_setup_variable()?;
    let crc = setup_variable_crc64(&data);
    if config.has_setup_crc() {
        return Ok(if config.setup_var_crc == crc {
            SetupGuardDecision::Unchanged
        } else {
            SetupGuardDecision::Changed
        });
    }

    config.record_setup_crc(crc);
    Ok(SetupGuardDecision::Initialized)
}

pub fn read_setup_variable() -> Result<Box<[u8]>, SetupVariableError> {
    let selected = find_setup_variable()?;
    let (data, attributes) =
        runtime::get_variable_boxed(selected.name, &selected.vendor).map_err(|error| {
            SetupVariableError::Firmware {
                location: EfiErrorLocation::ReadSetupVar,
                status: error.status(),
            }
        })?;
    let required = VariableAttributes::NON_VOLATILE | VariableAttributes::BOOTSERVICE_ACCESS;
    if !attributes.contains(required)
        || attributes.contains(VariableAttributes::HARDWARE_ERROR_RECORD)
    {
        return Err(SetupVariableError::BadAttributes);
    }
    Ok(data)
}

fn find_setup_variable() -> Result<SelectedVariable, SetupVariableError> {
    let mut setup_vendor = None;
    let mut custom_vendor = None;
    let mut custom_count = 0_usize;

    for key in runtime::variable_keys() {
        let key = key.map_err(|error| SetupVariableError::Firmware {
            location: EfiErrorLocation::EnumVar,
            status: error.status(),
        })?;
        if key.name.as_ref() == SETUP_NAME {
            if variable_size(SETUP_NAME, &key.vendor)? < MINIMUM_SETUP_SIZE {
                continue;
            }
            if setup_vendor.replace(key.vendor).is_some() {
                return Err(SetupVariableError::Ambiguous);
            }
        } else if key.name.as_ref() == CUSTOM_NAME {
            custom_count += 1;
            custom_vendor.get_or_insert(key.vendor);
        }
    }

    if let Some(vendor) = setup_vendor {
        return Ok(SelectedVariable {
            name: SETUP_NAME,
            vendor,
        });
    }
    match (custom_count, custom_vendor) {
        (1, Some(vendor)) => Ok(SelectedVariable {
            name: CUSTOM_NAME,
            vendor,
        }),
        (0, _) => Err(SetupVariableError::Missing),
        _ => Err(SetupVariableError::Ambiguous),
    }
}

fn variable_size(
    name: &uefi::CStr16,
    vendor: &VariableVendor,
) -> Result<usize, SetupVariableError> {
    match runtime::get_variable(name, vendor, &mut []) {
        Ok((data, _attributes)) => Ok(data.len()),
        Err(error) if error.status() == Status::BUFFER_TOO_SMALL => {
            (*error.data()).ok_or(SetupVariableError::Firmware {
                location: EfiErrorLocation::EnumSetupVarSize,
                status: Status::BAD_BUFFER_SIZE,
            })
        }
        Err(error) => Err(SetupVariableError::Firmware {
            location: EfiErrorLocation::EnumSetupVarSize,
            status: error.status(),
        }),
    }
}
