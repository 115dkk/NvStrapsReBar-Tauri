use std::path::{Path, PathBuf};

use nvstraps_deploy::{
    BoardPath, DeploymentPlan, DeploymentStore, FirmwareFingerprint, MachineIdentity,
    MachineProfile, ProfileMatch, RecoveryCapability,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    devices::enumerate_gpus,
    error::{ApiError, BackendError, BackendResult, CommandResult},
    machine::collect_machine_identity,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProfileRequest {
    pub display_name: String,
    pub board_path: BoardPath,
    pub firmware_path: String,
    pub recovery: RecoveryCapability,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareProfileRequest {
    pub profile_id: String,
    pub firmware_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentBundle {
    pub profile: MachineProfile,
    pub plan: DeploymentPlan,
    pub original_firmware_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileComparison {
    pub profile: MachineProfile,
    pub current_identity: MachineIdentity,
    pub firmware: Option<FirmwareFingerprint>,
    pub result: ProfileMatch,
}

#[tauri::command]
pub fn inspect_firmware_image(path: String) -> CommandResult<FirmwareFingerprint> {
    inspect_firmware_path(&path).map_err(ApiError::from)
}

#[tauri::command]
pub fn create_machine_profile(
    app: AppHandle,
    request: CreateProfileRequest,
) -> CommandResult<DeploymentBundle> {
    let firmware_path = canonical_firmware_path(&request.firmware_path).map_err(ApiError::from)?;
    let firmware = FirmwareFingerprint::inspect(&firmware_path)
        .map_err(BackendError::from)
        .map_err(ApiError::from)?;
    let devices = enumerate_gpus().map_err(ApiError::from)?;
    let identity = collect_machine_identity(&devices).map_err(ApiError::from)?;
    let profile = build_profile(request, identity, firmware).map_err(ApiError::from)?;
    let provisioned = store(&app)
        .and_then(|store| {
            store
                .provision_profile(&profile, &firmware_path)
                .map_err(BackendError::from)
        })
        .map_err(ApiError::from)?;
    Ok(DeploymentBundle {
        profile: provisioned.profile,
        plan: provisioned.plan,
        original_firmware_path: provisioned
            .original_firmware_path
            .to_string_lossy()
            .into_owned(),
    })
}

#[tauri::command]
pub fn list_machine_profiles(app: AppHandle) -> CommandResult<Vec<MachineProfile>> {
    store(&app)
        .and_then(|store| store.list_profiles().map_err(BackendError::from))
        .map_err(ApiError::from)
}

#[tauri::command]
pub fn get_deployment_plan(app: AppHandle, profile_id: String) -> CommandResult<DeploymentPlan> {
    store(&app)
        .and_then(|store| {
            let profile = store
                .load_profile(&profile_id)
                .map_err(BackendError::from)?;
            store.load_plan(&profile).map_err(BackendError::from)
        })
        .map_err(ApiError::from)
}

#[tauri::command]
pub fn compare_machine_profile(
    app: AppHandle,
    request: CompareProfileRequest,
) -> CommandResult<ProfileComparison> {
    let profile = store(&app)
        .and_then(|store| {
            store
                .load_profile(&request.profile_id)
                .map_err(BackendError::from)
        })
        .map_err(ApiError::from)?;
    let devices = enumerate_gpus().map_err(ApiError::from)?;
    let current_identity = collect_machine_identity(&devices).map_err(ApiError::from)?;
    let firmware = request
        .firmware_path
        .as_deref()
        .map(inspect_firmware_path)
        .transpose()
        .map_err(ApiError::from)?;
    let result = profile.compare(&current_identity, firmware.as_ref());
    Ok(ProfileComparison {
        profile,
        current_identity,
        firmware,
        result,
    })
}

fn build_profile(
    request: CreateProfileRequest,
    identity: MachineIdentity,
    firmware: FirmwareFingerprint,
) -> BackendResult<MachineProfile> {
    MachineProfile::create(
        request.display_name,
        request.board_path,
        identity,
        firmware,
        request.recovery,
    )
    .map_err(BackendError::from)
}

fn inspect_firmware_path(path: &str) -> BackendResult<FirmwareFingerprint> {
    let path = canonical_firmware_path(path)?;
    FirmwareFingerprint::inspect(path).map_err(BackendError::from)
}

fn canonical_firmware_path(path: &str) -> BackendResult<PathBuf> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(BackendError::Deployment(
            "firmware image path must be absolute".into(),
        ));
    }
    let path = path.canonicalize().map_err(|error| {
        BackendError::Deployment(format!(
            "firmware image path could not be resolved: {error}"
        ))
    })?;
    if !path.is_file() {
        return Err(BackendError::Deployment(
            "firmware image path is not a regular file".into(),
        ));
    }
    Ok(path)
}

fn store(app: &AppHandle) -> BackendResult<DeploymentStore> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| BackendError::Deployment(format!("local data path failed: {error}")))?
        .join("deployment-v1");
    Ok(DeploymentStore::new(root))
}

#[cfg(test)]
mod tests {
    use nvstraps_deploy::{GpuFingerprint, PciLocation, RecoveryMethod, Sha256Digest};

    use super::*;

    fn identity() -> MachineIdentity {
        MachineIdentity {
            board_manufacturer: "Vendor".into(),
            board_product: "Product".into(),
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
        }
    }

    #[test]
    fn profile_request_cannot_bypass_recovery_validation() {
        let request = CreateProfileRequest {
            display_name: "test".into(),
            board_path: BoardPath::LegacyAbove4g,
            firmware_path: "ignored".into(),
            recovery: RecoveryCapability {
                method: RecoveryMethod::None,
                tested_or_documented: false,
                note: String::new(),
            },
        };
        let firmware = FirmwareFingerprint {
            file_name: "firmware.bin".into(),
            byte_length: 4,
            sha256: Sha256Digest::from_bytes(b"test"),
        };
        assert!(build_profile(request, identity(), firmware).is_err());
    }

    #[test]
    fn relative_firmware_paths_are_rejected_before_file_access() {
        let error = canonical_firmware_path("relative/firmware.bin").unwrap_err();
        assert!(error.to_string().contains("must be absolute"));
    }
}
