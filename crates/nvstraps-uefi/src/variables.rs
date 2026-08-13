use nvstraps_core::config::{Config, ConfigError, MAX_ENCODED_SIZE};
use uefi::guid;
use uefi::prelude::{Status, cstr16};
use uefi::runtime::{self, VariableAttributes, VariableVendor};

const CONFIG_NAME: &uefi::CStr16 = cstr16!("NvStrapsReBar");
const STATUS_NAME: &uefi::CStr16 = cstr16!("NvStrapsReBarStatus");
const VENDOR: VariableVendor = VariableVendor(guid!("e3ee4a27-e2a2-4435-bba3-184ccad935a8"));

const CONFIG_ATTRIBUTES: VariableAttributes = VariableAttributes::from_bits_retain(
    VariableAttributes::NON_VOLATILE.bits()
        | VariableAttributes::BOOTSERVICE_ACCESS.bits()
        | VariableAttributes::RUNTIME_ACCESS.bits(),
);
const STATUS_ATTRIBUTES: VariableAttributes = VariableAttributes::from_bits_retain(
    VariableAttributes::BOOTSERVICE_ACCESS.bits() | VariableAttributes::RUNTIME_ACCESS.bits(),
);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigReadError {
    Firmware(Status),
    Parse(ConfigError),
}

pub fn read_config() -> Result<Config, ConfigReadError> {
    let mut buffer = [0_u8; MAX_ENCODED_SIZE];
    match runtime::get_variable(CONFIG_NAME, &VENDOR, &mut buffer) {
        Ok((bytes, _attributes)) => Config::decode(bytes).map_err(ConfigReadError::Parse),
        Err(error) if error.status() == Status::NOT_FOUND => Ok(Config::default()),
        Err(error) => Err(ConfigReadError::Firmware(error.status())),
    }
}

pub fn write_config(config: &Config) -> Result<(), Status> {
    let encoded = config.encode().map_err(|_| Status::BAD_BUFFER_SIZE)?;
    runtime::set_variable(CONFIG_NAME, &VENDOR, CONFIG_ATTRIBUTES, &encoded)
        .map_err(|error| error.status())
}

pub fn write_status(raw: u64) -> Result<(), Status> {
    runtime::set_variable(STATUS_NAME, &VENDOR, STATUS_ATTRIBUTES, &raw.to_le_bytes())
        .map_err(|error| error.status())
}
