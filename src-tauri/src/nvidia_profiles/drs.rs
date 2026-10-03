//! The part of the NVIDIA driver settings (DRS) API the app uses, as a trait so the policy and
//! command code run against the real driver on Windows and an in-memory database in tests.

use std::{fmt, path::Path};

use super::policy::{REBAR_SETTING_IDS, RebarSettings, Setting, Value};

#[cfg(test)]
pub const NVAPI_ERROR: i32 = -1;
pub const NVAPI_LIBRARY_NOT_FOUND: i32 = -2;
pub const NVAPI_NO_IMPLEMENTATION: i32 = -3;
pub const NVAPI_NVIDIA_DEVICE_NOT_FOUND: i32 = -6;
pub const NVAPI_END_ENUMERATION: i32 = -7;
pub const NVAPI_INVALID_USER_PRIVILEGE: i32 = -137;
pub const NVAPI_SETTING_NOT_FOUND: i32 = -160;
pub const NVAPI_PROFILE_NOT_FOUND: i32 = -163;

/// A failed NVAPI call and its `NvAPI_Status`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrsError {
    pub function: &'static str,
    pub status: i32,
}

impl DrsError {
    pub fn new(function: &'static str, status: i32) -> Self {
        Self { function, status }
    }

    /// No NVIDIA driver answers: the library, the GPU, or the API is missing.
    pub fn driver_missing(&self) -> bool {
        matches!(
            self.status,
            NVAPI_LIBRARY_NOT_FOUND | NVAPI_NO_IMPLEMENTATION | NVAPI_NVIDIA_DEVICE_NOT_FOUND
        )
    }

    pub fn needs_administrator(&self) -> bool {
        self.status == NVAPI_INVALID_USER_PRIVILEGE
    }
}

impl fmt::Display for DrsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} returned NvAPI status {}",
            self.function, self.status
        )
    }
}

pub type DrsResult<T> = Result<T, DrsError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProfileHandle(pub usize);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileInfo {
    pub name: String,
    pub predefined: bool,
    pub app_count: u32,
}

/// An open DRS session with the settings loaded. Changes stay in the session until `save`.
pub trait DrsSession {
    fn profile(&mut self, index: u32) -> DrsResult<Option<ProfileHandle>>;
    fn profile_info(&mut self, profile: ProfileHandle) -> DrsResult<ProfileInfo>;
    fn applications(&mut self, profile: ProfileHandle, count: u32) -> DrsResult<Vec<String>>;
    fn find_profile(&mut self, name: &str) -> DrsResult<Option<ProfileHandle>>;
    fn global_profile(&mut self) -> DrsResult<ProfileHandle>;
    fn setting(&mut self, profile: ProfileHandle, id: u32) -> DrsResult<Option<Setting>>;
    fn set_setting(&mut self, profile: ProfileHandle, id: u32, value: &Value) -> DrsResult<()>;
    /// Removes the value written on this PC; a predefined value comes back.
    fn delete_setting(&mut self, profile: ProfileHandle, id: u32) -> DrsResult<()>;
    fn save(&mut self) -> DrsResult<()>;
    fn save_to_file(&mut self, path: &Path) -> DrsResult<()>;
    fn load_from_file(&mut self, path: &Path) -> DrsResult<()>;

    fn rebar_settings(&mut self, profile: ProfileHandle) -> DrsResult<RebarSettings> {
        let mut settings = RebarSettings::default();
        for id in REBAR_SETTING_IDS {
            settings.set(id, self.setting(profile, id)?);
        }
        Ok(settings)
    }
}

pub trait DrsDriver {
    type Session<'a>: DrsSession
    where
        Self: 'a;

    /// The driver version as major * 100 + minor (616.64 is 61664).
    fn driver_version(&self) -> DrsResult<u32>;
    /// A session with the system settings loaded.
    fn open(&self) -> DrsResult<Self::Session<'_>>;
    /// A session without loaded settings, to load a settings file into.
    fn open_empty(&self) -> DrsResult<Self::Session<'_>>;
}

pub fn driver_version_text(version: u32) -> String {
    format!("{}.{:02}", version / 100, version % 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn driver_versions_print_like_nvidia_does() {
        assert_eq!(driver_version_text(61_664), "616.64");
        assert_eq!(driver_version_text(56_105), "561.05");
    }

    #[test]
    fn missing_driver_and_privilege_statuses_are_named() {
        assert!(DrsError::new("NvAPI_Initialize", NVAPI_NVIDIA_DEVICE_NOT_FOUND).driver_missing());
        assert!(
            DrsError::new("NvAPI_DRS_SaveSettings", NVAPI_INVALID_USER_PRIVILEGE)
                .needs_administrator()
        );
        assert!(!DrsError::new("NvAPI_DRS_SaveSettings", NVAPI_ERROR).driver_missing());
    }
}
