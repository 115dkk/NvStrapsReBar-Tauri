use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[allow(dead_code)]
    #[error("this operation is only supported on Windows")]
    UnsupportedPlatform,
    #[error("{operation} failed with Windows error {code}")]
    Windows { operation: &'static str, code: u32 },
    #[error("firmware variable {name} is unavailable: {reason}")]
    FirmwareUnavailable { name: &'static str, reason: String },
    #[error("invalid NvStrapsReBar configuration: {0}")]
    InvalidConfiguration(String),
    #[error("GPU inventory failed: {0}")]
    DeviceInventory(String),
    #[error("application state could not be locked")]
    StatePoisoned,
    #[error("failed to relaunch with administrator privileges: {0}")]
    Elevation(String),
}

impl BackendError {
    pub fn windows(operation: &'static str) -> Self {
        #[cfg(windows)]
        {
            Self::Windows {
                operation,
                // SAFETY: GetLastError has no preconditions.
                code: unsafe { windows_sys::Win32::Foundation::GetLastError() },
            }
        }

        #[cfg(not(windows))]
        {
            let _ = operation;
            Self::UnsupportedPlatform
        }
    }
}

impl From<nvstraps_core::config::ConfigError> for BackendError {
    fn from(error: nvstraps_core::config::ConfigError) -> Self {
        Self::InvalidConfiguration(error.to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
    pub recoverable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windows_error: Option<u32>,
}

impl From<BackendError> for ApiError {
    fn from(error: BackendError) -> Self {
        let (code, recoverable, windows_error) = match &error {
            BackendError::UnsupportedPlatform => ("unsupported_platform", false, None),
            BackendError::Windows { code, .. } => ("windows_api_error", true, Some(*code)),
            BackendError::FirmwareUnavailable { .. } => ("firmware_unavailable", true, None),
            BackendError::InvalidConfiguration(_) => ("invalid_configuration", true, None),
            BackendError::DeviceInventory(_) => ("device_inventory_failed", true, None),
            BackendError::StatePoisoned => ("state_unavailable", false, None),
            BackendError::Elevation(_) => ("elevation_failed", true, None),
        };

        Self {
            code,
            message: error.to_string(),
            recoverable,
            windows_error,
        }
    }
}

impl From<nvstraps_core::config::ConfigError> for ApiError {
    fn from(error: nvstraps_core::config::ConfigError) -> Self {
        BackendError::from(error).into()
    }
}

pub type BackendResult<T> = Result<T, BackendError>;
pub type CommandResult<T> = Result<T, ApiError>;
