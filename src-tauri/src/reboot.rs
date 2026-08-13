use nvstraps_deploy::{DeploymentPlan, StepId};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::{
    deployment::load_exact_deployment,
    error::{ApiError, BackendError, BackendResult, CommandResult},
};

const FIRMWARE_REBOOT_ARGUMENTS: [&str; 4] = ["/r", "/fw", "/t", "0"];
const CONFIGURATION_REBOOT_ARGUMENTS: [&str; 3] = ["/r", "/t", "0"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareSetupRebootPreview {
    pub profile_id: String,
    pub active_step: StepId,
    pub confirmation_token: String,
    pub command: String,
    pub arguments: Vec<String>,
    pub immediate: bool,
    pub force_close_applications: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareSetupRebootRequest {
    pub profile_id: String,
    pub confirmation_token: String,
    pub unsaved_work_confirmed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareSetupRebootAccepted {
    pub profile_id: String,
    pub accepted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationRebootPreview {
    pub profile_id: String,
    pub plan_revision: u32,
    pub confirmation_token: String,
    pub command: String,
    pub arguments: Vec<String>,
    pub immediate: bool,
    pub force_close_applications: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationRebootRequest {
    pub profile_id: String,
    pub confirmation_token: String,
    pub unsaved_work_confirmed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationRebootAccepted {
    pub profile_id: String,
    pub accepted: bool,
    pub plan_advanced: bool,
}

#[tauri::command]
pub fn preview_firmware_setup_reboot(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<FirmwareSetupRebootPreview> {
    let exact = load_exact_deployment(&app, &profile_id, "firmware setup reboot preview")
        .map_err(ApiError::from)?;
    ensure_firmware_reboot_available().map_err(ApiError::from)?;
    build_preview(&exact.profile.profile_id, &exact.plan).map_err(ApiError::from)
}

#[tauri::command]
pub async fn reboot_to_firmware_setup(
    app: AppHandle,
    request: FirmwareSetupRebootRequest,
) -> CommandResult<FirmwareSetupRebootAccepted> {
    tauri::async_runtime::spawn_blocking(move || reboot_command(&app, request))
        .await
        .map_err(|error| {
            ApiError::from(BackendError::Deployment(format!(
                "firmware setup reboot worker failed: {error}"
            )))
        })?
        .map_err(ApiError::from)
}

#[tauri::command]
pub fn preview_configuration_reboot(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<ConfigurationRebootPreview> {
    let exact = load_exact_deployment(&app, &profile_id, "configuration reboot preview")
        .map_err(ApiError::from)?;
    ensure_configuration_reboot_available().map_err(ApiError::from)?;
    build_configuration_preview(&exact.profile.profile_id, &exact.plan).map_err(ApiError::from)
}

#[tauri::command]
pub async fn reboot_after_configuration(
    app: AppHandle,
    request: ConfigurationRebootRequest,
) -> CommandResult<ConfigurationRebootAccepted> {
    tauri::async_runtime::spawn_blocking(move || configuration_reboot_command(&app, request))
        .await
        .map_err(|error| {
            ApiError::from(BackendError::Deployment(format!(
                "configuration reboot worker failed: {error}"
            )))
        })?
        .map_err(ApiError::from)
}

fn reboot_command(
    app: &AppHandle,
    request: FirmwareSetupRebootRequest,
) -> BackendResult<FirmwareSetupRebootAccepted> {
    let exact = load_exact_deployment(app, &request.profile_id, "firmware setup reboot")?;
    let preview = build_preview(&exact.profile.profile_id, &exact.plan)?;
    validate_confirmation(
        &preview,
        &request.confirmation_token,
        request.unsaved_work_confirmed,
    )?;
    execute_reboot(&FIRMWARE_REBOOT_ARGUMENTS, "firmware setup")?;
    Ok(FirmwareSetupRebootAccepted {
        profile_id: exact.profile.profile_id,
        accepted: true,
    })
}

fn configuration_reboot_command(
    app: &AppHandle,
    request: ConfigurationRebootRequest,
) -> BackendResult<ConfigurationRebootAccepted> {
    let exact = load_exact_deployment(app, &request.profile_id, "configuration reboot")?;
    let preview = build_configuration_preview(&exact.profile.profile_id, &exact.plan)?;
    validate_configuration_confirmation(
        &preview,
        &request.confirmation_token,
        request.unsaved_work_confirmed,
    )?;
    execute_reboot(&CONFIGURATION_REBOOT_ARGUMENTS, "configuration")?;
    Ok(ConfigurationRebootAccepted {
        profile_id: exact.profile.profile_id,
        accepted: true,
        plan_advanced: false,
    })
}

fn build_preview(
    profile_id: &str,
    plan: &DeploymentPlan,
) -> BackendResult<FirmwareSetupRebootPreview> {
    let active_step = plan.active_step().map(|step| step.id).ok_or_else(|| {
        BackendError::Deployment(
            "firmware setup reboot is unavailable after the deployment plan is complete".into(),
        )
    })?;
    if !matches!(
        active_step,
        StepId::FlashWithVendorRoute | StepId::ConfigureFirmwareSetup
    ) {
        return Err(BackendError::Deployment(format!(
            "firmware setup reboot is not valid while {active_step:?} is active"
        )));
    }
    let suffix = profile_id
        .strip_prefix("nvstraps-")
        .ok_or_else(|| BackendError::Deployment("deployment profile ID is malformed".into()))?;
    Ok(FirmwareSetupRebootPreview {
        profile_id: profile_id.to_owned(),
        active_step,
        confirmation_token: format!("REBOOT-TO-FIRMWARE-{}", suffix.to_ascii_uppercase()),
        command: "Windows shutdown.exe".into(),
        arguments: FIRMWARE_REBOOT_ARGUMENTS
            .iter()
            .map(ToString::to_string)
            .collect(),
        immediate: true,
        force_close_applications: false,
        warnings: vec![
            "Save and close all work before confirming; Windows will restart immediately.".into(),
            "This only opens the firmware user interface. It does not flash firmware or change setup values.".into(),
            "The command deliberately omits /f so applications are not explicitly force-closed.".into(),
        ],
    })
}

fn build_configuration_preview(
    profile_id: &str,
    plan: &DeploymentPlan,
) -> BackendResult<ConfigurationRebootPreview> {
    plan.require_active(StepId::RebootAfterConfiguration)
        .map_err(BackendError::from)?;
    let suffix = profile_id
        .strip_prefix("nvstraps-")
        .ok_or_else(|| BackendError::Deployment("deployment profile ID is malformed".into()))?;
    Ok(ConfigurationRebootPreview {
        profile_id: profile_id.to_owned(),
        plan_revision: plan.revision,
        confirmation_token: format!(
            "REBOOT-AFTER-CONFIGURATION-{}-R{}",
            suffix.to_ascii_uppercase(),
            plan.revision
        ),
        command: "Windows shutdown.exe".into(),
        arguments: CONFIGURATION_REBOOT_ARGUMENTS
            .iter()
            .map(ToString::to_string)
            .collect(),
        immediate: true,
        force_close_applications: false,
        warnings: vec![
            "Save and close all work before confirming; Windows will restart immediately.".into(),
            "The command deliberately omits /f so applications are not explicitly force-closed.".into(),
            "Accepting the reboot request does not complete the plan; the next app session must prove a later Windows boot.".into(),
        ],
    })
}

fn validate_confirmation(
    preview: &FirmwareSetupRebootPreview,
    confirmation_token: &str,
    unsaved_work_confirmed: bool,
) -> BackendResult<()> {
    if !unsaved_work_confirmed {
        return Err(BackendError::Deployment(
            "firmware setup reboot requires explicit confirmation that work is saved".into(),
        ));
    }
    if confirmation_token != preview.confirmation_token {
        return Err(BackendError::Deployment(
            "firmware setup reboot confirmation token does not match this profile".into(),
        ));
    }
    Ok(())
}

fn validate_configuration_confirmation(
    preview: &ConfigurationRebootPreview,
    confirmation_token: &str,
    unsaved_work_confirmed: bool,
) -> BackendResult<()> {
    if !unsaved_work_confirmed {
        return Err(BackendError::Deployment(
            "configuration reboot requires explicit confirmation that work is saved".into(),
        ));
    }
    if confirmation_token != preview.confirmation_token {
        return Err(BackendError::Deployment(
            "configuration reboot confirmation token does not match this profile and plan revision"
                .into(),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn execute_reboot(arguments: &[&str], description: &str) -> BackendResult<()> {
    use std::os::windows::process::CommandExt;

    let executable = shutdown_executable()?;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = std::process::Command::new(&executable)
        .args(arguments)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|error| {
            BackendError::Deployment(format!(
                "failed to launch {}: {error}",
                executable.display()
            ))
        })?;
    if !status.success() {
        return Err(BackendError::Deployment(format!(
            "Windows refused the {description} reboot with exit code {}",
            status
                .code()
                .map_or_else(|| "unknown".into(), |code| code.to_string())
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn ensure_firmware_reboot_available() -> BackendResult<std::path::PathBuf> {
    use windows_sys::Win32::System::SystemInformation::{FirmwareTypeUefi, GetFirmwareType};

    let mut firmware_type = 0;
    // SAFETY: firmware_type points to writable storage for the duration of the call.
    if unsafe { GetFirmwareType(&mut firmware_type) } == 0 {
        return Err(BackendError::windows("GetFirmwareType"));
    }
    if firmware_type != FirmwareTypeUefi {
        return Err(BackendError::Deployment(
            "Windows reports legacy BIOS boot; a firmware UI reboot is unavailable".into(),
        ));
    }

    shutdown_executable()
}

#[cfg(windows)]
fn ensure_configuration_reboot_available() -> BackendResult<std::path::PathBuf> {
    shutdown_executable()
}

#[cfg(windows)]
fn shutdown_executable() -> BackendResult<std::path::PathBuf> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};

    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

    let mut system_directory = [0_u16; 32_768];
    // SAFETY: the buffer is writable and its capacity is passed exactly.
    let length = unsafe {
        GetSystemDirectoryW(system_directory.as_mut_ptr(), system_directory.len() as u32)
    } as usize;
    if length == 0 {
        return Err(BackendError::windows("GetSystemDirectoryW"));
    }
    if length >= system_directory.len() {
        return Err(BackendError::Deployment(
            "Windows system directory path exceeded the guarded buffer".into(),
        ));
    }
    let executable = std::path::PathBuf::from(OsString::from_wide(&system_directory[..length]))
        .join("shutdown.exe");
    if !executable.is_file() {
        return Err(BackendError::Deployment(format!(
            "Windows shutdown executable is unavailable at {}",
            executable.display()
        )));
    }

    Ok(executable)
}

#[cfg(not(windows))]
fn execute_reboot(_arguments: &[&str], _description: &str) -> BackendResult<()> {
    Err(BackendError::UnsupportedPlatform)
}

#[cfg(not(windows))]
fn ensure_firmware_reboot_available() -> BackendResult<std::path::PathBuf> {
    Err(BackendError::UnsupportedPlatform)
}

#[cfg(not(windows))]
fn ensure_configuration_reboot_available() -> BackendResult<std::path::PathBuf> {
    Err(BackendError::UnsupportedPlatform)
}

#[cfg(test)]
mod tests {
    use nvstraps_deploy::{
        BoardPath, DeploymentPlan, FirmwareFingerprint, FirmwareInstallMethod,
        FirmwareInstallRoute, GpuFingerprint, MachineIdentity, MachineProfile, PciLocation,
        RecoveryCapability, RecoveryMethod, Sha256Digest, StepEvidence,
    };

    use super::*;

    fn profile_and_plan() -> (MachineProfile, DeploymentPlan) {
        let profile = MachineProfile::create(
            "reboot test",
            BoardPath::NativeResizableBar,
            MachineIdentity {
                board_manufacturer: "Vendor".into(),
                board_product: "Board".into(),
                board_version: "1".into(),
                bios_vendor: "BIOS vendor".into(),
                bios_version: "2".into(),
                bios_release_date: "2026-08-14".into(),
                gpus: vec![GpuFingerprint {
                    vendor_id: 0x10de,
                    device_id: 0x1e81,
                    subsystem_vendor_id: 0x1462,
                    subsystem_device_id: 0x3755,
                    location: PciLocation {
                        bus: 1,
                        device: 0,
                        function: 0,
                    },
                    bridge_location: PciLocation {
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
                note: "tested recovery".into(),
            },
            FirmwareInstallRoute {
                method: FirmwareInstallMethod::FirmwareSetupUtility,
                artifact_file_name: "vendor.bin".into(),
                tested_or_documented: true,
                official_instructions_url: "https://vendor.invalid/manual".into(),
                note: "documented route".into(),
            },
        )
        .unwrap();
        let plan = DeploymentPlan::for_profile(&profile).unwrap();
        (profile, plan)
    }

    fn advance_to_flash(profile: &MachineProfile, plan: &mut DeploymentPlan) {
        for (step, kind, value) in [
            (
                StepId::VerifyProfile,
                nvstraps_deploy::EvidenceKind::ExactProfileMatch,
                profile.profile_id.as_str(),
            ),
            (
                StepId::ConfirmRecovery,
                nvstraps_deploy::EvidenceKind::RecoveryRouteConfirmed,
                "usbFlashback",
            ),
            (
                StepId::PreserveOriginalFirmware,
                nvstraps_deploy::EvidenceKind::OriginalFirmwareSha256,
                profile.original_firmware.sha256.as_str(),
            ),
            (
                StepId::PrepareRustDriver,
                nvstraps_deploy::EvidenceKind::RustDriverSha256,
                "11f2c3292601b55d09a9fd62244e1c98b49e05c92a965a296332358b5b9c4ee3",
            ),
            (
                StepId::VerifyPatchedArtifact,
                nvstraps_deploy::EvidenceKind::PatchedFirmwareSha256,
                "54b489b90e9ce7bd0be8514896402ead5a600618f601730d640b1d5b8546b098",
            ),
        ] {
            plan.complete(step, StepEvidence::new(kind, value).unwrap())
                .unwrap();
        }
    }

    #[test]
    fn preview_is_bound_to_the_profile_and_never_forces_applications_closed() {
        let (profile, mut plan) = profile_and_plan();
        advance_to_flash(&profile, &mut plan);
        let preview = build_preview(&profile.profile_id, &plan).unwrap();
        assert_eq!(preview.active_step, StepId::FlashWithVendorRoute);
        assert!(
            preview.confirmation_token.ends_with(
                profile
                    .profile_id
                    .strip_prefix("nvstraps-")
                    .unwrap()
                    .to_ascii_uppercase()
                    .as_str()
            )
        );
        assert_eq!(preview.arguments, ["/r", "/fw", "/t", "0"]);
        assert!(preview.immediate);
        assert!(!preview.force_close_applications);
        assert!(!preview.arguments.iter().any(|argument| argument == "/f"));
    }

    #[test]
    fn reboot_requires_saved_work_exact_token_and_an_allowed_plan_step() {
        let (profile, mut plan) = profile_and_plan();
        assert!(build_preview(&profile.profile_id, &plan).is_err());
        advance_to_flash(&profile, &mut plan);
        let preview = build_preview(&profile.profile_id, &plan).unwrap();
        assert!(validate_confirmation(&preview, &preview.confirmation_token, false).is_err());
        assert!(validate_confirmation(&preview, "REBOOT-TO-FIRMWARE-WRONG", true).is_err());
        validate_confirmation(&preview, &preview.confirmation_token, true).unwrap();
    }

    #[test]
    fn configuration_reboot_is_exactly_scoped_and_never_advances_the_plan() {
        let (profile, mut plan) = profile_and_plan();
        advance_to_flash(&profile, &mut plan);
        for (step, kind) in [
            (
                StepId::FlashWithVendorRoute,
                nvstraps_deploy::EvidenceKind::VendorFlashReceipt,
            ),
            (
                StepId::ConfigureFirmwareSetup,
                nvstraps_deploy::EvidenceKind::FirmwareSettingsConfirmed,
            ),
            (
                StepId::RebootAfterFirmware,
                nvstraps_deploy::EvidenceKind::BootObserved,
            ),
            (
                StepId::VerifyDriverLoaded,
                nvstraps_deploy::EvidenceKind::DriverStatus,
            ),
            (
                StepId::WriteNvstrapsConfiguration,
                nvstraps_deploy::EvidenceKind::ConfigurationReadback,
            ),
        ] {
            plan.complete(step, StepEvidence::new(kind, "proof").unwrap())
                .unwrap();
        }

        let preview = build_configuration_preview(&profile.profile_id, &plan).unwrap();
        assert_eq!(preview.arguments, ["/r", "/t", "0"]);
        assert!(!preview.force_close_applications);
        assert!(!preview.arguments.iter().any(|argument| argument == "/f"));
        assert!(
            preview
                .confirmation_token
                .ends_with(&format!("-R{}", plan.revision))
        );
        assert!(
            validate_configuration_confirmation(&preview, &preview.confirmation_token, false)
                .is_err()
        );
        assert!(validate_configuration_confirmation(&preview, "REBOOT-WRONG", true).is_err());
        validate_configuration_confirmation(&preview, &preview.confirmation_token, true).unwrap();
        assert_eq!(
            plan.active_step().map(|step| step.id),
            Some(StepId::RebootAfterConfiguration)
        );
    }
}
