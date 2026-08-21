use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use nvstraps_deploy::MachineIdentity;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{
    bar_settings::{
        BarSettingsStatus, SavedConfigurationObservation, StatusVariableObservation,
        assess_driver_runtime,
    },
    config::{
        ConfigDraft, NvConfig, config_from_draft, draft_from_config, effective_bar_size,
        setup_crc_hex, validate_draft,
    },
    devices::{GpuDevice, enumerate_gpus},
    error::{ApiError, BackendError, BackendResult, CommandResult},
    firmware::{
        CONFIG_VARIABLE_NAME, STATUS_VARIABLE_NAME, inspect_access, read_variable,
        relaunch_elevated, write_variable,
    },
    hardware_support::{HardwareSupportAssessment, determine_hardware_support},
    machine::collect_machine_identity,
    status::DriverStatus,
};

#[derive(Default)]
pub struct AppState {
    inner: Mutex<BackendState>,
    elevation_request: ElevationRequestGate,
}

#[derive(Default)]
struct ElevationRequestGate(AtomicBool);

impl ElevationRequestGate {
    fn try_begin(&self) -> bool {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    fn reset(&self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Default)]
pub(crate) struct BackendState {
    pub(crate) devices: Vec<GpuDevice>,
    pub(crate) config: Option<NvConfig>,
    config_variable_present: Option<bool>,
    firmware_accessible: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSnapshot {
    pub schema_version: u8,
    pub platform: PlatformInfo,
    pub firmware: FirmwareInfo,
    pub driver_status: Option<DriverStatus>,
    pub bar_settings: BarSettingsStatus,
    pub config: Option<ConfigView>,
    pub devices: Vec<GpuDevice>,
    pub machine_identity: Option<MachineIdentity>,
    pub hardware_support: HardwareSupportAssessment,
    pub notices: Vec<Notice>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub operating_system: &'static str,
    pub architecture: &'static str,
    pub supported: bool,
    pub uefi: bool,
    pub elevated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareInfo {
    pub accessible: bool,
    pub privilege_enabled: bool,
    pub config_variable_present: Option<bool>,
    pub access_error: Option<ApiError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub draft: ConfigDraft,
    pub raw_size: usize,
    pub setup_fingerprint_present: bool,
    pub setup_crc: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub kind: &'static str,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub changed: bool,
    pub variable_will_exist: bool,
    pub encoded_size: usize,
    pub affected_gpu_ids: Vec<String>,
    pub reboot_required: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReceipt {
    pub saved_at_unix_ms: String,
    pub bytes_written: usize,
    pub variable_present: bool,
    pub reboot_required: bool,
    pub draft: ConfigDraft,
}

#[tauri::command]
pub fn get_system_snapshot(state: State<'_, AppState>) -> CommandResult<SystemSnapshot> {
    refresh_snapshot(&state).map_err(ApiError::from)
}

#[tauri::command]
pub fn refresh_system(state: State<'_, AppState>) -> CommandResult<SystemSnapshot> {
    refresh_snapshot(&state).map_err(ApiError::from)
}

#[tauri::command]
pub fn validate_config(
    draft: ConfigDraft,
    state: State<'_, AppState>,
) -> CommandResult<ValidationReport> {
    let guard = lock_backend_state(&state).map_err(ApiError::from)?;
    validation_report_for(&draft, &guard)
}

pub(crate) fn lock_backend_state(
    state: &AppState,
) -> BackendResult<std::sync::MutexGuard<'_, BackendState>> {
    state.inner.lock().map_err(|_| BackendError::StatePoisoned)
}

pub(crate) fn validation_report_for(
    draft: &ConfigDraft,
    guard: &BackendState,
) -> CommandResult<ValidationReport> {
    let draft = draft.clone();
    if let Err(error) = validate_draft(&draft, &guard.devices) {
        return Ok(ValidationReport {
            valid: false,
            errors: vec![error.to_string()],
            warnings: Vec::new(),
            changed: guard
                .config
                .as_ref()
                .is_none_or(|config| draft_from_config(config) != draft),
            variable_will_exist: false,
            encoded_size: 0,
            affected_gpu_ids: Vec::new(),
            reboot_required: false,
        });
    }
    let config = config_from_draft(&draft, &guard.devices).map_err(ApiError::from)?;
    let encoded = config.encode().map_err(ApiError::from)?;
    let affected_gpu_ids = guard
        .devices
        .iter()
        .filter(|device| effective_bar_size(&config, device).is_some())
        .map(|device| device.id.clone())
        .collect::<Vec<_>>();
    let mut warnings = Vec::new();
    if draft.skip_s3_resume {
        warnings.push("S3 resume reconfiguration is disabled; resume behavior must be verified on this machine.".into());
    }
    if affected_gpu_ids.is_empty() && !encoded.is_empty() {
        warnings.push("The current settings do not select any detected NVIDIA GPU.".into());
    }
    let changed = guard
        .config
        .as_ref()
        .is_none_or(|persisted| persisted.encode().ok().as_deref() != Some(encoded.as_slice()));
    Ok(ValidationReport {
        valid: true,
        errors: Vec::new(),
        warnings,
        changed,
        variable_will_exist: !encoded.is_empty(),
        encoded_size: encoded.len(),
        affected_gpu_ids,
        reboot_required: changed,
    })
}

#[tauri::command]
pub fn save_config(draft: ConfigDraft, state: State<'_, AppState>) -> CommandResult<SaveReceipt> {
    save_config_inner(draft, &state).map_err(ApiError::from)
}

pub(crate) fn save_config_inner(
    draft: ConfigDraft,
    state: &AppState,
) -> BackendResult<SaveReceipt> {
    // Re-enumerate immediately before a consequential write so a draft validated against stale
    // GPU or bridge topology cannot be persisted after a hardware change.
    let current_devices = enumerate_gpus()?;
    save_config_for_devices_inner(draft, state, current_devices)
}

pub(crate) fn save_config_for_devices_inner(
    draft: ConfigDraft,
    state: &AppState,
    current_devices: Vec<GpuDevice>,
) -> BackendResult<SaveReceipt> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| BackendError::StatePoisoned)?;
    if !guard.firmware_accessible {
        return Err(BackendError::FirmwareUnavailable {
            name: CONFIG_VARIABLE_NAME,
            reason: "restart the application as administrator and try again".into(),
        });
    }
    let config = config_from_draft(&draft, &current_devices)?;
    let encoded = config.encode()?;
    write_variable(CONFIG_VARIABLE_NAME, &encoded)?;
    let verified = read_variable(CONFIG_VARIABLE_NAME)?.unwrap_or_default();
    if verified != encoded {
        return Err(BackendError::ReadbackMismatch);
    }
    guard.devices = current_devices;
    guard.config = Some(config);
    guard.config_variable_present = Some(!encoded.is_empty());
    let saved_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    Ok(SaveReceipt {
        saved_at_unix_ms: saved_at,
        bytes_written: encoded.len(),
        variable_present: !encoded.is_empty(),
        reboot_required: true,
        draft,
    })
}

#[tauri::command]
pub fn request_elevation(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    if !state.elevation_request.try_begin() {
        return Ok(());
    }
    if let Err(error) = relaunch_elevated() {
        state.elevation_request.reset();
        return Err(ApiError::from(error));
    }
    app.exit(0);
    Ok(())
}

fn refresh_snapshot(state: &AppState) -> BackendResult<SystemSnapshot> {
    let access = inspect_access();
    let mut devices = enumerate_gpus()?;
    let mut notices = Vec::new();
    let mut access_error = None;
    let mut config = None;
    let mut config_bytes = None;
    let mut config_invalid = false;
    let mut raw_size = 0;
    let mut config_variable_present = None;
    let mut status_variable = StatusVariableObservation::Unavailable;

    if !access.is_uefi {
        notices.push(Notice {
            kind: "error",
            message: "Windows is not running in UEFI mode; firmware variables are unavailable."
                .into(),
        });
    } else if access.privilege_enabled {
        match read_variable(CONFIG_VARIABLE_NAME) {
            Ok(value) => {
                config_variable_present = Some(value.is_some());
                let bytes = value.unwrap_or_default();
                raw_size = bytes.len();
                match NvConfig::decode(&bytes) {
                    Ok(decoded) => config = Some(decoded),
                    Err(error) => {
                        config_invalid = true;
                        notices.push(Notice {
                            kind: "error",
                            message: format!(
                                "Saved NvStrapsReBar configuration is invalid: {error}"
                            ),
                        });
                    }
                }
                config_bytes = Some(bytes);
            }
            Err(error) => access_error = Some(ApiError::from(error)),
        }
        match read_variable(STATUS_VARIABLE_NAME) {
            Ok(Some(bytes)) => status_variable = StatusVariableObservation::Present(bytes),
            Ok(None) => status_variable = StatusVariableObservation::Missing,
            Err(error) => {
                notices.push(Notice {
                    kind: "warning",
                    message: format!("Driver status could not be read: {error}"),
                });
            }
        }
    } else {
        access_error = Some(ApiError::from(BackendError::FirmwareUnavailable {
            name: CONFIG_VARIABLE_NAME,
            reason: "administrator privileges are required".into(),
        }));
        notices.push(Notice {
            kind: "warning",
            message: "Administrator access is required to read or save UEFI settings.".into(),
        });
    }

    if devices.is_empty() {
        notices.push(Notice {
            kind: "warning",
            message: "No NVIDIA display adapters were detected.".into(),
        });
    }
    let machine_identity = match collect_machine_identity(&devices) {
        Ok(identity) => Some(identity),
        Err(error) => {
            notices.push(Notice {
                kind: "warning",
                message: format!("Machine identity could not be pinned: {error}"),
            });
            None
        }
    };
    if let Some(current) = &config {
        for device in &mut devices {
            device.effective_bar_size_selector = effective_bar_size(current, device);
        }
    }

    let config_view = config.as_ref().map(|current| ConfigView {
        draft: draft_from_config(current),
        raw_size,
        setup_fingerprint_present: current.has_setup_crc(),
        setup_crc: setup_crc_hex(current),
    });
    let firmware_accessible = firmware_is_accessible(
        access.is_uefi,
        access.privilege_enabled,
        access_error.is_some(),
    );
    let saved_configuration = match (config.as_ref(), config_bytes.as_deref(), config_invalid) {
        (Some(config), Some(raw), false) => SavedConfigurationObservation::Valid { config, raw },
        (_, Some(raw), true) => SavedConfigurationObservation::Invalid { raw },
        _ => SavedConfigurationObservation::Unreadable,
    };
    let runtime = assess_driver_runtime(&status_variable, saved_configuration, &devices);
    let hardware_support = determine_hardware_support(machine_identity.as_ref(), &devices);
    let snapshot = SystemSnapshot {
        schema_version: 2,
        platform: PlatformInfo {
            operating_system: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            supported: cfg!(windows),
            uefi: access.is_uefi,
            elevated: access.is_elevated,
        },
        firmware: FirmwareInfo {
            accessible: firmware_accessible,
            privilege_enabled: access.privilege_enabled,
            config_variable_present,
            access_error,
        },
        driver_status: runtime.driver_status,
        bar_settings: runtime.bar_settings,
        config: config_view,
        devices: devices.clone(),
        machine_identity,
        hardware_support,
        notices,
    };

    let mut guard = state
        .inner
        .lock()
        .map_err(|_| BackendError::StatePoisoned)?;
    guard.devices = devices;
    guard.config = config;
    guard.config_variable_present = config_variable_present;
    guard.firmware_accessible = firmware_accessible;
    Ok(snapshot)
}

fn firmware_is_accessible(is_uefi: bool, privilege_enabled: bool, has_access_error: bool) -> bool {
    is_uefi && privilege_enabled && !has_access_error
}

#[cfg(test)]
mod tests {
    use super::{ElevationRequestGate, firmware_is_accessible};

    #[test]
    fn firmware_access_requires_uefi_privilege_and_no_error() {
        assert!(firmware_is_accessible(true, true, false));
        assert!(!firmware_is_accessible(false, true, false));
        assert!(!firmware_is_accessible(true, false, false));
        assert!(!firmware_is_accessible(true, true, true));
    }

    #[test]
    fn elevation_request_gate_is_single_flight_and_resets_after_launch_failure() {
        let gate = ElevationRequestGate::default();
        assert!(gate.try_begin());
        assert!(!gate.try_begin());
        gate.reset();
        assert!(gate.try_begin());
    }
}
