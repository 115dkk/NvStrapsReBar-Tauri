use core::mem::size_of;
use core::ptr::NonNull;

use nvstraps_core::config::Config;
use nvstraps_core::setup_crc::setup_variable_crc64;
use nvstraps_core::status::EfiErrorLocation;
use uefi::Guid;
use uefi::boot::{self, MemoryType};
use uefi::prelude::{Status, cstr16};
use uefi::runtime::{self, VariableAttributes, VariableVendor};

const SETUP_NAME: &uefi::CStr16 = cstr16!("Setup");
const CUSTOM_NAME: &uefi::CStr16 = cstr16!("Custom");
const MINIMUM_SETUP_SIZE: usize = 16;
const INITIAL_VARIABLE_NAME_UNITS: usize = 512;

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
    let mut data =
        PoolBuffer::allocate_zeroed(size).map_err(|status| SetupVariableError::Firmware {
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

    let mut name = PoolBuffer::allocate_zeroed(INITIAL_VARIABLE_NAME_UNITS * size_of::<u16>())
        .map_err(|status| SetupVariableError::Firmware {
            location: EfiErrorLocation::AllocateSetupVarName,
            status,
        })?;
    let mut vendor = VariableVendor(Guid::default());
    loop {
        match runtime::get_next_variable_key(name.as_mut_u16_slice(), &mut vendor) {
            Ok(()) => {}
            Err(error) if error.status() == Status::NOT_FOUND => break,
            Err(error) if error.status() == Status::BUFFER_TOO_SMALL => {
                let required_units = (*error.data()).ok_or(SetupVariableError::Firmware {
                    location: EfiErrorLocation::AllocateSetupVarName,
                    status: Status::BAD_BUFFER_SIZE,
                })?;
                let required_bytes = required_units.checked_mul(size_of::<u16>()).ok_or(
                    SetupVariableError::Firmware {
                        location: EfiErrorLocation::AllocateSetupVarName,
                        status: Status::BAD_BUFFER_SIZE,
                    },
                )?;
                if required_bytes <= name.length {
                    return Err(SetupVariableError::Firmware {
                        location: EfiErrorLocation::AllocateSetupVarName,
                        status: Status::BUFFER_TOO_SMALL,
                    });
                }
                name.grow_zeroed(required_bytes).map_err(|status| {
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
        let key_name = uefi::CStr16::from_u16_until_nul(name.as_u16_slice()).map_err(|_| {
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

struct PoolBuffer {
    pointer: NonNull<u8>,
    length: usize,
}

impl PoolBuffer {
    fn allocate(length: usize) -> Result<Self, Status> {
        let pointer = boot::allocate_pool(MemoryType::BOOT_SERVICES_DATA, length)
            .map_err(|error| error.status())?;
        Ok(Self { pointer, length })
    }

    fn as_mut_slice(&mut self) -> &mut [u8] {
        // SAFETY: allocate_pool returned `length` writable bytes owned by this guard.
        unsafe { core::slice::from_raw_parts_mut(self.pointer.as_ptr(), self.length) }
    }

    fn allocate_zeroed(length: usize) -> Result<Self, Status> {
        let buffer = Self::allocate(length)?;
        // SAFETY: The allocation owns `length` writable bytes.
        unsafe { buffer.pointer.as_ptr().write_bytes(0, length) };
        Ok(buffer)
    }

    fn grow_zeroed(&mut self, length: usize) -> Result<(), Status> {
        if length <= self.length {
            return Err(Status::BAD_BUFFER_SIZE);
        }
        let mut replacement = Self::allocate_zeroed(length)?;
        // SAFETY: Both allocations are live and disjoint; the old length is smaller.
        unsafe {
            self.pointer
                .as_ptr()
                .copy_to_nonoverlapping(replacement.pointer.as_ptr(), self.length);
        }
        core::mem::swap(self, &mut replacement);
        Ok(())
    }

    fn as_u16_slice(&self) -> &[u16] {
        // SAFETY: UEFI pool memory is suitably aligned and the length is maintained in u16 units.
        unsafe {
            core::slice::from_raw_parts(
                self.pointer.as_ptr().cast(),
                self.length / size_of::<u16>(),
            )
        }
    }

    fn as_mut_u16_slice(&mut self) -> &mut [u16] {
        // SAFETY: This guard uniquely owns suitably aligned pool memory of the stated length.
        unsafe {
            core::slice::from_raw_parts_mut(
                self.pointer.as_ptr().cast(),
                self.length / size_of::<u16>(),
            )
        }
    }
}

impl Drop for PoolBuffer {
    fn drop(&mut self) {
        // SAFETY: This guard uniquely owns the pool allocation.
        let _ = unsafe { boot::free_pool(self.pointer) };
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
