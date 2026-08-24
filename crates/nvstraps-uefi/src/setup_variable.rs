use nvstraps_core::config::Config;
use nvstraps_core::setup_crc::setup_variable_crc64;
use nvstraps_core::status::EfiErrorLocation;
use uefi::Guid;
use uefi::prelude::{Status, cstr16};
use uefi::runtime::{self, VariableAttributes, VariableVendor};

use crate::pool::PoolVec;

const SETUP_NAME: &uefi::CStr16 = cstr16!("Setup");
const CUSTOM_NAME: &uefi::CStr16 = cstr16!("Custom");
const MINIMUM_SETUP_SIZE: usize = 16;
const MAXIMUM_SETUP_SIZE: usize = 1024 * 1024;
const INITIAL_VARIABLE_NAME_UNITS: usize = 512;
const MAXIMUM_VARIABLE_NAME_UNITS: usize = 16 * 1024;
const MAXIMUM_ENUMERATED_VARIABLES: usize = 4096;

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
    let crc = read_setup_variable_crc()?;
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

fn read_setup_variable_crc() -> Result<u64, SetupVariableError> {
    let selected = find_setup_variable()?;
    let size = variable_size(selected.name, &selected.vendor)?;
    let mut data = PoolVec::<u8>::zeroed(size).map_err(|status| SetupVariableError::Firmware {
        location: EfiErrorLocation::AllocateSetupVarData,
        status,
    })?;
    let (bytes, attributes) =
        runtime::get_variable(selected.name, &selected.vendor, data.as_mut_slice()).map_err(
            |error| SetupVariableError::Firmware {
                location: EfiErrorLocation::ReadSetupVar,
                status: error.status(),
            },
        )?;
    let required = VariableAttributes::NON_VOLATILE | VariableAttributes::BOOTSERVICE_ACCESS;
    if !attributes.contains(required)
        || attributes.contains(VariableAttributes::HARDWARE_ERROR_RECORD)
    {
        return Err(SetupVariableError::BadAttributes);
    }
    Ok(setup_variable_crc64(bytes))
}

fn find_setup_variable() -> Result<SelectedVariable, SetupVariableError> {
    let mut setup_vendor = None;
    let mut custom_vendor = None;
    let mut custom_count = 0_usize;

    let mut name = PoolVec::<u16>::zeroed(INITIAL_VARIABLE_NAME_UNITS).map_err(|status| {
        SetupVariableError::Firmware {
            location: EfiErrorLocation::AllocateSetupVarName,
            status,
        }
    })?;
    let mut vendor = VariableVendor(Guid::default());
    let mut enumerated_variables = 0_usize;
    loop {
        match runtime::get_next_variable_key(name.as_mut_slice(), &mut vendor) {
            Ok(()) => {
                enumerated_variables += 1;
                if enumerated_variables > MAXIMUM_ENUMERATED_VARIABLES {
                    return Err(SetupVariableError::Firmware {
                        location: EfiErrorLocation::EnumVar,
                        status: Status::ABORTED,
                    });
                }
            }
            Err(error) if error.status() == Status::NOT_FOUND => break,
            Err(error) if error.status() == Status::BUFFER_TOO_SMALL => {
                let required_units = (*error.data()).ok_or(SetupVariableError::Firmware {
                    location: EfiErrorLocation::AllocateSetupVarName,
                    status: Status::BAD_BUFFER_SIZE,
                })?;
                if required_units > MAXIMUM_VARIABLE_NAME_UNITS {
                    return Err(SetupVariableError::Firmware {
                        location: EfiErrorLocation::AllocateSetupVarName,
                        status: Status::BAD_BUFFER_SIZE,
                    });
                }
                if required_units <= name.len() {
                    return Err(SetupVariableError::Firmware {
                        location: EfiErrorLocation::AllocateSetupVarName,
                        status: Status::BUFFER_TOO_SMALL,
                    });
                }
                name.grow_zeroed(required_units).map_err(|status| {
                    SetupVariableError::Firmware {
                        location: EfiErrorLocation::AllocateSetupVarName,
                        status,
                    }
                })?;
                continue;
            }
            Err(error) => {
                return Err(SetupVariableError::Firmware {
                    location: EfiErrorLocation::EnumVar,
                    status: error.status(),
                });
            }
        }
        let key_name = uefi::CStr16::from_u16_until_nul(name.as_slice()).map_err(|_| {
            SetupVariableError::Firmware {
                location: EfiErrorLocation::EnumVar,
                status: Status::UNSUPPORTED,
            }
        })?;
        if key_name == SETUP_NAME {
            if variable_size(SETUP_NAME, &vendor)? < MINIMUM_SETUP_SIZE {
                continue;
            }
            if setup_vendor.replace(vendor).is_some() {
                return Err(SetupVariableError::Ambiguous);
            }
        } else if key_name == CUSTOM_NAME {
            custom_count += 1;
            custom_vendor.get_or_insert(vendor);
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
        Ok((data, _attributes)) => bounded_setup_size(data.len()),
        Err(error) if error.status() == Status::BUFFER_TOO_SMALL => {
            let size = (*error.data()).ok_or(SetupVariableError::Firmware {
                location: EfiErrorLocation::EnumSetupVarSize,
                status: Status::BAD_BUFFER_SIZE,
            })?;
            bounded_setup_size(size)
        }
        Err(error) => Err(SetupVariableError::Firmware {
            location: EfiErrorLocation::EnumSetupVarSize,
            status: error.status(),
        }),
    }
}

fn bounded_setup_size(size: usize) -> Result<usize, SetupVariableError> {
    if size > MAXIMUM_SETUP_SIZE {
        return Err(SetupVariableError::Firmware {
            location: EfiErrorLocation::EnumSetupVarSize,
            status: Status::BAD_BUFFER_SIZE,
        });
    }
    Ok(size)
}
