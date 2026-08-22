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
    #[error(
        "BAR settings are locked because neither current-boot DXE execution nor an expanded Turing aperture was observed"
    )]
    BarSettingsControlNotObserved,
    #[error("GPU or bridge topology changed after BAR settings were loaded")]
    StaleTopology,
    #[error("saved NvStrapsReBar configuration changed after BAR settings were loaded")]
    StaleConfiguration,
    #[error("firmware readback did not match the requested NvStrapsReBar configuration")]
    ReadbackMismatch,
    #[error("invalid NvStrapsReBar configuration: {0}")]
    InvalidConfiguration(String),
    #[error("GPU inventory failed: {0}")]
    DeviceInventory(String),
    #[error("machine identity failed: {0}")]
    MachineIdentity(String),
    #[error("firmware injection failed: {0}")]
    FirmwareInjection(#[source] nvstraps_ffs::InjectionError),
    #[error("deployment workflow failed: {0}")]
    Deployment(String),
    #[error("application state could not be locked")]
    StatePoisoned,
    #[error("failed to relaunch with administrator privileges: {0}")]
    Elevation(String),
    #[error("settings snapshot failed: {0}")]
    SettingsSnapshot(String),
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firmware_injection: Option<FirmwareInjectionDiagnostic>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareVolumePathDiagnostic {
    pub container_file_offsets: Vec<usize>,
    pub firmware_volume_offset: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareFilePathDiagnostic {
    pub container_file_offsets: Vec<usize>,
    pub firmware_volume_offset: usize,
    pub file_offset: usize,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FirmwareInjectionDiagnostic {
    InvalidDriverFfs {
        detail: String,
    },
    InvalidFirmware {
        detail: &'static str,
    },
    DriverAlreadyPresent,
    CompressionFailure {
        detail: String,
    },
    UnsupportedCapsule {
        capsule_kind: &'static str,
        header_size: u32,
        body_offset: u32,
        flags: u32,
    },
    MalformedCapsule {
        capsule_kind: &'static str,
        detail: &'static str,
    },
    AmbiguousDxeTargets {
        targets: Vec<FirmwareVolumePathDiagnostic>,
    },
    IncompleteDxeTargetCensus {
        uninspected_containers: Vec<FirmwareFilePathDiagnostic>,
    },
    UnsupportedDxeTarget {
        target: FirmwareVolumePathDiagnostic,
    },
    NoDxeVolume,
    InsufficientDxeSpace {
        target: FirmwareVolumePathDiagnostic,
        available_bytes: usize,
        required_bytes: usize,
    },
    RecompressedContainerTooLarge {
        container_file_offsets: Vec<usize>,
        firmware_volume_offset: usize,
        file_offset: usize,
        available_bytes: usize,
        required_bytes: usize,
    },
}

impl From<&nvstraps_ffs::FirmwareVolumePath> for FirmwareVolumePathDiagnostic {
    fn from(path: &nvstraps_ffs::FirmwareVolumePath) -> Self {
        Self {
            container_file_offsets: path.container_file_offsets.clone(),
            firmware_volume_offset: path.firmware_volume_offset,
        }
    }
}

impl From<&nvstraps_ffs::FirmwareFilePath> for FirmwareFilePathDiagnostic {
    fn from(path: &nvstraps_ffs::FirmwareFilePath) -> Self {
        Self {
            container_file_offsets: path.container_file_offsets.clone(),
            firmware_volume_offset: path.firmware_volume_offset,
            file_offset: path.file_offset,
        }
    }
}

impl From<&nvstraps_ffs::InjectionError> for FirmwareInjectionDiagnostic {
    fn from(error: &nvstraps_ffs::InjectionError) -> Self {
        use nvstraps_ffs::InjectionError;

        match error {
            InjectionError::InvalidFfs(error) => Self::InvalidDriverFfs {
                detail: error.to_string(),
            },
            InjectionError::InvalidFirmware(detail) => Self::InvalidFirmware { detail },
            InjectionError::DriverAlreadyPresent => Self::DriverAlreadyPresent,
            InjectionError::Compression(detail) => Self::CompressionFailure {
                detail: detail.clone(),
            },
            InjectionError::UnsupportedCapsule(header) => Self::UnsupportedCapsule {
                capsule_kind: capsule_kind_name(header.kind),
                header_size: header.header_size,
                body_offset: header.body_offset,
                flags: header.flags,
            },
            InjectionError::MalformedCapsule(header) => Self::MalformedCapsule {
                capsule_kind: capsule_kind_name(header.kind),
                detail: header.reason,
            },
            InjectionError::AmbiguousDxeTargets { candidates } => Self::AmbiguousDxeTargets {
                targets: candidates.iter().map(Into::into).collect(),
            },
            InjectionError::IncompleteDxeTargetCensus {
                uninspected_containers,
            } => Self::IncompleteDxeTargetCensus {
                uninspected_containers: uninspected_containers.iter().map(Into::into).collect(),
            },
            InjectionError::UnsupportedDxeTarget { target } => Self::UnsupportedDxeTarget {
                target: target.into(),
            },
            InjectionError::NoTopLevelDxeVolume => Self::NoDxeVolume,
            InjectionError::NoSpace {
                location,
                available_bytes,
                required_bytes,
            } => Self::InsufficientDxeSpace {
                target: location.into(),
                available_bytes: *available_bytes,
                required_bytes: *required_bytes,
            },
            InjectionError::RecompressedContainerTooLarge {
                container_file_offsets,
                firmware_volume_offset,
                file_offset,
                available_bytes,
                required_bytes,
            } => Self::RecompressedContainerTooLarge {
                container_file_offsets: container_file_offsets.clone(),
                firmware_volume_offset: *firmware_volume_offset,
                file_offset: *file_offset,
                available_bytes: *available_bytes,
                required_bytes: *required_bytes,
            },
        }
    }
}

fn capsule_kind_name(kind: nvstraps_ffs::UefiCapsuleKind) -> &'static str {
    match kind {
        nvstraps_ffs::UefiCapsuleKind::Standard => "standard",
        nvstraps_ffs::UefiCapsuleKind::Toshiba => "toshiba",
        nvstraps_ffs::UefiCapsuleKind::AptioSigned => "aptioSigned",
        nvstraps_ffs::UefiCapsuleKind::AptioUnsigned => "aptioUnsigned",
    }
}

impl From<BackendError> for ApiError {
    fn from(error: BackendError) -> Self {
        let firmware_injection = match &error {
            BackendError::FirmwareInjection(error) => Some(error.into()),
            _ => None,
        };
        let (code, recoverable, windows_error) = match &error {
            BackendError::UnsupportedPlatform => ("unsupported_platform", false, None),
            BackendError::Windows { code, .. } => ("windows_api_error", true, Some(*code)),
            BackendError::FirmwareUnavailable { .. } => ("firmware_unavailable", true, None),
            BackendError::BarSettingsControlNotObserved => {
                ("bar_settings_control_not_observed", true, None)
            }
            BackendError::StaleTopology => ("stale_topology", true, None),
            BackendError::StaleConfiguration => ("stale_configuration", true, None),
            BackendError::ReadbackMismatch => ("readback_mismatch", true, None),
            BackendError::InvalidConfiguration(_) => ("invalid_configuration", true, None),
            BackendError::DeviceInventory(_) => ("device_inventory_failed", true, None),
            BackendError::MachineIdentity(_) => ("machine_identity_failed", true, None),
            BackendError::FirmwareInjection(_) => ("firmware_injection_failed", true, None),
            BackendError::Deployment(_) => ("deployment_failed", true, None),
            BackendError::StatePoisoned => ("state_unavailable", false, None),
            BackendError::Elevation(_) => ("elevation_failed", true, None),
            BackendError::SettingsSnapshot(_) => ("settings_snapshot_failed", true, None),
        };

        Self {
            code,
            message: error.to_string(),
            recoverable,
            windows_error,
            firmware_injection,
        }
    }
}

impl From<nvstraps_core::config::ConfigError> for ApiError {
    fn from(error: nvstraps_core::config::ConfigError) -> Self {
        BackendError::from(error).into()
    }
}

impl From<nvstraps_deploy::ProfileError> for BackendError {
    fn from(error: nvstraps_deploy::ProfileError) -> Self {
        Self::Deployment(error.to_string())
    }
}

impl From<nvstraps_deploy::StoreError> for BackendError {
    fn from(error: nvstraps_deploy::StoreError) -> Self {
        Self::Deployment(error.to_string())
    }
}

impl From<nvstraps_deploy::PlanError> for BackendError {
    fn from(error: nvstraps_deploy::PlanError) -> Self {
        Self::Deployment(error.to_string())
    }
}

pub type BackendResult<T> = Result<T, BackendError>;
pub type CommandResult<T> = Result<T, ApiError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bar_settings_failures_keep_stable_typed_codes() {
        assert_eq!(
            ApiError::from(BackendError::BarSettingsControlNotObserved).code,
            "bar_settings_control_not_observed"
        );
        assert_eq!(
            ApiError::from(BackendError::StaleTopology).code,
            "stale_topology"
        );
        assert_eq!(
            ApiError::from(BackendError::StaleConfiguration).code,
            "stale_configuration"
        );
        assert_eq!(
            ApiError::from(BackendError::ReadbackMismatch).code,
            "readback_mismatch"
        );
    }

    #[test]
    fn firmware_injection_failures_keep_a_stable_typed_code() {
        let error = ApiError::from(BackendError::FirmwareInjection(
            nvstraps_ffs::InjectionError::NoTopLevelDxeVolume,
        ));
        assert_eq!(error.code, "firmware_injection_failed");
        assert_eq!(
            error.message,
            "firmware injection failed: no DXE firmware volume was found through a supported layout"
        );
    }

    #[test]
    fn firmware_injection_diagnostics_preserve_capacity_numbers() {
        let error = ApiError::from(BackendError::FirmwareInjection(
            nvstraps_ffs::InjectionError::NoSpace {
                location: nvstraps_ffs::FirmwareVolumePath {
                    container_file_offsets: vec![0x120],
                    firmware_volume_offset: 0x40,
                },
                available_bytes: 3_016,
                required_bytes: 34_904,
            },
        ));
        let serialized = serde_json::to_value(error).unwrap();

        assert_eq!(
            serialized["firmwareInjection"]["kind"],
            "insufficientDxeSpace"
        );
        assert_eq!(serialized["firmwareInjection"]["availableBytes"], 3_016);
        assert_eq!(serialized["firmwareInjection"]["requiredBytes"], 34_904);
        assert_eq!(
            serialized["firmwareInjection"]["target"]["containerFileOffsets"][0],
            0x120
        );
    }
}
