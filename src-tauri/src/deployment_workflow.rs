use std::time::{SystemTime, UNIX_EPOCH};

use nvstraps_deploy::{BoardPath, DeploymentPlan, DeploymentWorkflow, MachineProfile, StepId};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{
    app::{AppState, SaveReceipt, save_config_inner},
    config::ConfigDraft,
    deployment::load_exact_deployment,
    error::{ApiError, BackendError, BackendResult, CommandResult},
    firmware::{STATUS_VARIABLE_NAME, read_variable},
    status::DriverStatus,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualDeploymentStepPreview {
    pub profile_id: String,
    pub plan_revision: u32,
    pub step_id: StepId,
    pub title: String,
    pub confirmation_token: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmManualDeploymentStepRequest {
    pub profile_id: String,
    pub step_id: StepId,
    pub confirmation_token: String,
    pub confirmed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualDeploymentStepReceipt {
    pub plan: DeploymentPlan,
    pub step_id: StepId,
    pub recorded_at_unix_ms: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverVerificationReceipt {
    pub plan: DeploymentPlan,
    pub status: DriverStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationRebootVerificationReceipt {
    pub plan: DeploymentPlan,
    pub configuration_saved_at_unix_ms: String,
    pub booted_at_unix_ms: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDeploymentConfigRequest {
    pub profile_id: String,
    pub draft: ConfigDraft,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDeploymentConfigReceipt {
    pub plan: DeploymentPlan,
    pub save: SaveReceipt,
}

#[tauri::command]
pub fn preview_manual_deployment_step(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<ManualDeploymentStepPreview> {
    let exact = load_exact_deployment(&app, &profile_id, "manual deployment step preview")
        .map_err(ApiError::from)?;
    build_manual_step_preview(&exact.profile, &exact.plan).map_err(ApiError::from)
}

#[tauri::command]
pub fn confirm_manual_deployment_step(
    app: AppHandle,
    request: ConfirmManualDeploymentStepRequest,
) -> CommandResult<ManualDeploymentStepReceipt> {
    confirm_manual_deployment_step_command(&app, request).map_err(ApiError::from)
}

#[tauri::command]
pub fn verify_deployment_driver(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<DriverVerificationReceipt> {
    verify_deployment_driver_command(&app, &profile_id).map_err(ApiError::from)
}

#[tauri::command]
pub fn verify_configuration_reboot(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<ConfigurationRebootVerificationReceipt> {
    verify_configuration_reboot_command(&app, &profile_id).map_err(ApiError::from)
}

#[tauri::command]
pub fn save_deployment_config(
    app: AppHandle,
    request: SaveDeploymentConfigRequest,
    state: State<'_, AppState>,
) -> CommandResult<SaveDeploymentConfigReceipt> {
    save_deployment_config_command(&app, request, &state).map_err(ApiError::from)
}

fn save_deployment_config_command(
    app: &AppHandle,
    request: SaveDeploymentConfigRequest,
    state: &AppState,
) -> BackendResult<SaveDeploymentConfigReceipt> {
    let exact = load_exact_deployment(app, &request.profile_id, "NvStraps configuration write")?;
    exact
        .plan
        .require_active(StepId::WriteNvstrapsConfiguration)
        .map_err(BackendError::from)?;

    // The existing writer re-enumerates topology, validates, writes the EFI variable, and performs
    // an exact byte-for-byte readback. Only that successful receipt may advance the durable plan.
    let save = save_config_inner(request.draft, state)?;
    let mut workflow = DeploymentWorkflow::from_plan(&exact.store, &exact.profile, exact.plan)
        .map_err(BackendError::from)?;
    workflow
        .record_step(
            StepId::WriteNvstrapsConfiguration,
            configuration_readback_evidence(&save),
        )
        .map_err(BackendError::from)?;

    Ok(SaveDeploymentConfigReceipt {
        plan: workflow.into_plan(),
        save,
    })
}

fn confirm_manual_deployment_step_command(
    app: &AppHandle,
    request: ConfirmManualDeploymentStepRequest,
) -> BackendResult<ManualDeploymentStepReceipt> {
    let exact = load_exact_deployment(app, &request.profile_id, "manual deployment confirmation")?;
    let preview = build_manual_step_preview(&exact.profile, &exact.plan)?;
    if !request.confirmed {
        return Err(BackendError::Deployment(
            "manual deployment steps require explicit operator confirmation".into(),
        ));
    }
    if request.step_id != preview.step_id {
        return Err(BackendError::Deployment(format!(
            "manual confirmation is stale: {:?} is active, not {:?}",
            preview.step_id, request.step_id
        )));
    }
    if request.confirmation_token != preview.confirmation_token {
        return Err(BackendError::Deployment(
            "manual confirmation token does not match this profile, step, and plan revision".into(),
        ));
    }

    let recorded_at_unix_ms = unix_timestamp_ms();
    let evidence = format!("operator-attested:{recorded_at_unix_ms}");
    let mut workflow = DeploymentWorkflow::from_plan(&exact.store, &exact.profile, exact.plan)
        .map_err(BackendError::from)?;
    workflow
        .record_step(request.step_id, evidence)
        .map_err(BackendError::from)?;
    Ok(ManualDeploymentStepReceipt {
        plan: workflow.into_plan(),
        step_id: request.step_id,
        recorded_at_unix_ms,
    })
}

fn verify_deployment_driver_command(
    app: &AppHandle,
    profile_id: &str,
) -> BackendResult<DriverVerificationReceipt> {
    let exact = load_exact_deployment(app, profile_id, "Rust DXE driver verification")?;
    let active_step = exact
        .plan
        .active_step()
        .map(|step| step.id)
        .ok_or_else(|| {
            BackendError::Deployment("the deployment plan is already complete".into())
        })?;
    let records_boot = driver_verification_records_boot(active_step)?;

    let raw = read_driver_status_raw()?;
    let status = DriverStatus::from_raw(raw);
    if !status.proves_driver_loaded() {
        return Err(BackendError::Deployment(format!(
            "Rust DXE driver was not proven loaded: {} ({})",
            status.label, status.raw
        )));
    }

    let mut workflow = DeploymentWorkflow::from_plan(&exact.store, &exact.profile, exact.plan)
        .map_err(BackendError::from)?;
    if records_boot {
        // The status variable deliberately lacks NON_VOLATILE. Reading a valid value therefore
        // proves that this Windows session followed a boot in which the Rust DXE driver ran.
        workflow
            .record_step(
                StepId::RebootAfterFirmware,
                format!("volatile-status-observed:{}", unix_timestamp_ms()),
            )
            .map_err(BackendError::from)?;
    }
    workflow
        .record_step(StepId::VerifyDriverLoaded, status.raw.clone())
        .map_err(BackendError::from)?;
    Ok(DriverVerificationReceipt {
        plan: workflow.into_plan(),
        status,
    })
}

fn driver_verification_records_boot(active_step: StepId) -> BackendResult<bool> {
    match active_step {
        StepId::RebootAfterFirmware => Ok(true),
        StepId::VerifyDriverLoaded => Ok(false),
        _ => Err(BackendError::Deployment(format!(
            "Rust DXE verification is not valid while {active_step:?} is active"
        ))),
    }
}

fn verify_configuration_reboot_command(
    app: &AppHandle,
    profile_id: &str,
) -> BackendResult<ConfigurationRebootVerificationReceipt> {
    let exact = load_exact_deployment(app, profile_id, "configuration reboot verification")?;
    exact
        .plan
        .require_active(StepId::RebootAfterConfiguration)
        .map_err(BackendError::from)?;
    let configuration_saved_at = configuration_saved_at_unix_ms(&exact.plan)?;
    let booted_at = current_boot_time_unix_ms()?;
    if !boot_proves_configuration_reboot(configuration_saved_at, booted_at) {
        return Err(BackendError::Deployment(format!(
            "the current Windows boot ({booted_at}) is not later than the configuration readback ({configuration_saved_at})"
        )));
    }

    let mut workflow = DeploymentWorkflow::from_plan(&exact.store, &exact.profile, exact.plan)
        .map_err(BackendError::from)?;
    workflow
        .record_step(StepId::RebootAfterConfiguration, booted_at.to_string())
        .map_err(BackendError::from)?;
    Ok(ConfigurationRebootVerificationReceipt {
        plan: workflow.into_plan(),
        configuration_saved_at_unix_ms: configuration_saved_at.to_string(),
        booted_at_unix_ms: booted_at.to_string(),
    })
}

fn configuration_saved_at_unix_ms(plan: &DeploymentPlan) -> BackendResult<u64> {
    plan.completed_evidence(StepId::WriteNvstrapsConfiguration)
        .map_err(BackendError::from)?
        .value
        .parse::<u64>()
        .map_err(|_| {
            BackendError::Deployment(
                "configuration readback evidence does not contain a Unix millisecond timestamp"
                    .into(),
            )
        })
}

fn boot_proves_configuration_reboot(configuration_saved_at: u64, booted_at: u64) -> bool {
    booted_at > configuration_saved_at
}

#[cfg(windows)]
fn current_boot_time_unix_ms() -> BackendResult<u64> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount64;

    let now: u64 = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| BackendError::Deployment("the Windows clock predates the Unix epoch".into()))?
        .as_millis()
        .try_into()
        .map_err(|_| BackendError::Deployment("the Windows clock value is too large".into()))?;
    // SAFETY: GetTickCount64 has no preconditions and returns milliseconds since system start.
    let uptime = unsafe { GetTickCount64() };
    now.checked_sub(uptime).ok_or_else(|| {
        BackendError::Deployment("Windows uptime exceeds the current wall-clock value".into())
    })
}

#[cfg(not(windows))]
fn current_boot_time_unix_ms() -> BackendResult<u64> {
    Err(BackendError::UnsupportedPlatform)
}

fn read_driver_status_raw() -> BackendResult<u64> {
    match read_variable(STATUS_VARIABLE_NAME)? {
        Some(bytes) if bytes.len() == size_of::<u64>() => {
            let mut raw = [0_u8; size_of::<u64>()];
            raw.copy_from_slice(&bytes);
            Ok(u64::from_le_bytes(raw))
        }
        Some(bytes) => Err(BackendError::Deployment(format!(
            "Rust DXE status variable is {} bytes; exactly 8 bytes are required",
            bytes.len()
        ))),
        None => Err(BackendError::Deployment(
            "Rust DXE status variable is missing; the driver was not proven loaded".into(),
        )),
    }
}

fn build_manual_step_preview(
    profile: &MachineProfile,
    plan: &DeploymentPlan,
) -> BackendResult<ManualDeploymentStepPreview> {
    let active = plan.active_step().ok_or_else(|| {
        BackendError::Deployment("the deployment plan is already complete".into())
    })?;
    let warnings = manual_step_warnings(profile, active.id)?;
    let suffix = profile
        .profile_id
        .strip_prefix("nvstraps-")
        .ok_or_else(|| BackendError::Deployment("deployment profile ID is malformed".into()))?;
    Ok(ManualDeploymentStepPreview {
        profile_id: profile.profile_id.clone(),
        plan_revision: plan.revision,
        step_id: active.id,
        title: active.title.clone(),
        confirmation_token: format!(
            "CONFIRM-{}-{}-R{}",
            manual_step_slug(active.id),
            suffix.to_ascii_uppercase(),
            plan.revision
        ),
        warnings,
    })
}

fn manual_step_slug(step_id: StepId) -> &'static str {
    match step_id {
        StepId::FlashWithVendorRoute => "VENDOR-FLASH",
        StepId::ConfigureFirmwareSetup => "FIRMWARE-SETTINGS",
        StepId::ConfigureNvidiaApplications => "NVIDIA-POLICY",
        _ => "UNSUPPORTED",
    }
}

fn manual_step_warnings(profile: &MachineProfile, step_id: StepId) -> BackendResult<Vec<String>> {
    let warnings = match step_id {
        StepId::FlashWithVendorRoute => {
            let route = profile.firmware_install.as_ref().ok_or_else(|| {
                BackendError::Deployment(
                    "this legacy profile has no pinned firmware install route; recreate it before flashing"
                        .into(),
                )
            })?;
            vec![
                format!(
                    "Use only the pinned {:?} route and artifact {}.",
                    route.method, route.artifact_file_name
                ),
                "Confirm only after the vendor tool reports success; this is an operator attestation, not an automatic flash verification.".into(),
                "Keep the pinned recovery route available and do not interrupt power during the flash.".into(),
            ]
        }
        StepId::ConfigureFirmwareSetup => vec![
            match profile.board_path {
                BoardPath::NativeResizableBar => {
                    "Enable native ReBAR and Above 4G decoding, and disable CSM.".into()
                }
                BoardPath::LegacyAbove4g => {
                    "Enable Above 4G decoding and disable CSM; do not claim native motherboard ReBAR.".into()
                }
            },
            "Confirm only after saving these exact firmware setup values.".into(),
        ],
        StepId::ConfigureNvidiaApplications => vec![
            "Confirm only after applying and independently reviewing the intended per-application ReBAR policy.".into(),
            "Installing or launching NVIDIA Profile Inspector does not satisfy this step.".into(),
        ],
        _ => {
            return Err(BackendError::Deployment(format!(
                "{step_id:?} is not an operator-attested deployment step"
            )));
        }
    };
    Ok(warnings)
}

fn unix_timestamp_ms() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn configuration_readback_evidence(save: &SaveReceipt) -> String {
    save.saved_at_unix_ms.clone()
}

#[cfg(test)]
mod tests {
    use nvstraps_deploy::{
        DeploymentStep, FirmwareFingerprint, FirmwareInstallMethod, FirmwareInstallRoute,
        MachineIdentity, RecoveryCapability, RecoveryMethod, Sha256Digest, StepKind, StepState,
    };

    use super::*;

    fn profile() -> MachineProfile {
        MachineProfile::create(
            "workflow adapter test",
            BoardPath::NativeResizableBar,
            MachineIdentity {
                board_manufacturer: "Vendor".into(),
                board_product: "Board".into(),
                board_version: "1".into(),
                bios_vendor: "BIOS".into(),
                bios_version: "2".into(),
                bios_release_date: "2026-08-14".into(),
                gpus: vec![nvstraps_deploy::GpuFingerprint {
                    vendor_id: 0x10de,
                    device_id: 0x1e81,
                    subsystem_vendor_id: 0x1462,
                    subsystem_device_id: 0x3755,
                    location: nvstraps_deploy::PciLocation {
                        bus: 1,
                        device: 0,
                        function: 0,
                    },
                    bridge_location: nvstraps_deploy::PciLocation {
                        bus: 0,
                        device: 1,
                        function: 0,
                    },
                    bar0_base: 0x8000_0000,
                    bar0_top: 0x80ff_ffff,
                }],
            },
            FirmwareFingerprint {
                file_name: "vendor.bin".into(),
                byte_length: 4,
                sha256: Sha256Digest::from_bytes(b"test"),
            },
            RecoveryCapability {
                method: RecoveryMethod::UsbFlashback,
                tested_or_documented: true,
                note: "documented".into(),
            },
            FirmwareInstallRoute {
                method: FirmwareInstallMethod::FirmwareSetupUtility,
                artifact_file_name: "vendor.bin".into(),
                tested_or_documented: true,
                official_instructions_url: "https://vendor.invalid/manual".into(),
                note: "documented".into(),
            },
        )
        .unwrap()
    }

    fn active_plan(profile: &MachineProfile, step_id: StepId, revision: u32) -> DeploymentPlan {
        DeploymentPlan {
            schema_version: 1,
            profile_id: profile.profile_id.clone(),
            original_firmware_sha256: profile.original_firmware.sha256.clone(),
            recovery_method: profile.recovery.method,
            revision,
            steps: vec![DeploymentStep {
                id: step_id,
                kind: StepKind::PhysicalConfirmation,
                title: "Test active step".into(),
                state: StepState::Ready,
                evidence: None,
            }],
        }
    }

    #[test]
    fn configuration_evidence_is_the_exact_readback_timestamp() {
        let save = SaveReceipt {
            saved_at_unix_ms: "1786654321000".into(),
            bytes_written: 24,
            variable_present: true,
            reboot_required: true,
            draft: ConfigDraft::default(),
        };

        assert_eq!(configuration_readback_evidence(&save), "1786654321000");
    }

    #[test]
    fn manual_preview_is_bound_to_profile_step_and_revision() {
        let profile = profile();
        let preview = build_manual_step_preview(
            &profile,
            &active_plan(&profile, StepId::FlashWithVendorRoute, 6),
        )
        .unwrap();

        assert_eq!(preview.step_id, StepId::FlashWithVendorRoute);
        assert!(
            preview
                .confirmation_token
                .starts_with("CONFIRM-VENDOR-FLASH-")
        );
        assert!(preview.confirmation_token.ends_with("-R6"));
        assert!(
            build_manual_step_preview(
                &profile,
                &active_plan(&profile, StepId::VerifyDriverLoaded, 9)
            )
            .is_err()
        );
        assert!(
            build_manual_step_preview(
                &profile,
                &active_plan(&profile, StepId::RebootAfterFirmware, 8)
            )
            .is_err()
        );
    }

    #[test]
    fn volatile_driver_status_also_proves_the_returned_firmware_boot() {
        assert!(driver_verification_records_boot(StepId::RebootAfterFirmware).unwrap());
        assert!(!driver_verification_records_boot(StepId::VerifyDriverLoaded).unwrap());
        assert!(driver_verification_records_boot(StepId::ConfigureFirmwareSetup).is_err());
    }

    #[test]
    fn only_a_boot_after_the_configuration_readback_satisfies_the_gate() {
        assert!(!boot_proves_configuration_reboot(1_000, 999));
        assert!(!boot_proves_configuration_reboot(1_000, 1_000));
        assert!(boot_proves_configuration_reboot(1_000, 1_001));
    }
}
