use std::{
    fs,
    path::{Path, PathBuf},
};

use nvstraps_deploy::{
    ArtifactKind, BoardPath, DeploymentPlan, DeploymentStore, EvidenceKind, FirmwareFingerprint,
    MachineIdentity, MachineProfile, ProfileMatch, RecoveryCapability, StepEvidence, StepId,
    StepState, StoredArtifact,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, path::BaseDirectory};

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwarePreparation {
    pub plan: DeploymentPlan,
    pub driver: StoredArtifact,
    pub patched_firmware: Option<StoredArtifact>,
    pub injection: Option<InjectionReceipt>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectionReceipt {
    pub firmware_volume_offset: usize,
    pub file_offset: usize,
    pub replaced_pad_file: bool,
    pub erase_polarity: bool,
    pub encapsulated_volume_image: bool,
    pub recompressed_guided_section: bool,
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

#[tauri::command]
pub async fn prepare_firmware_artifact(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<FirmwarePreparation> {
    tauri::async_runtime::spawn_blocking(move || prepare_command(&app, &profile_id))
        .await
        .map_err(|error| {
            ApiError::from(BackendError::Deployment(format!(
                "firmware preparation worker failed: {error}"
            )))
        })?
        .map_err(ApiError::from)
}

fn prepare_command(app: &AppHandle, profile_id: &str) -> BackendResult<FirmwarePreparation> {
    let store = store(app)?;
    let profile = store.load_profile(profile_id).map_err(BackendError::from)?;
    let plan = store.load_plan(&profile).map_err(BackendError::from)?;
    let devices = enumerate_gpus()?;
    let current_identity = collect_machine_identity(&devices)?;
    let original_path = store
        .original_firmware_path(profile_id)
        .map_err(BackendError::from)?;
    let original_fingerprint = FirmwareFingerprint::inspect(&original_path)?;
    let comparison = profile.compare(&current_identity, Some(&original_fingerprint));
    if !comparison.is_exact() {
        let differences = serde_json::to_string(&comparison.differences)
            .unwrap_or_else(|_| "machine profile mismatch".into());
        return Err(BackendError::Deployment(format!(
            "machine profile changed; firmware preparation was refused: {differences}"
        )));
    }

    let driver_path = app
        .path()
        .resolve("NvStrapsReBar.ffs", BaseDirectory::Resource)
        .map_err(|error| {
            BackendError::Deployment(format!("bundled Rust driver path failed: {error}"))
        })?;
    let driver_ffs = fs::read(&driver_path).map_err(|error| {
        BackendError::Deployment(format!(
            "bundled Rust driver could not be read at {}: {error}",
            driver_path.display()
        ))
    })?;
    prepare_from_bytes(&store, &profile, plan, &driver_ffs)
}

fn prepare_from_bytes(
    store: &DeploymentStore,
    profile: &MachineProfile,
    mut plan: DeploymentPlan,
    bundled_driver: &[u8],
) -> BackendResult<FirmwarePreparation> {
    plan.validate_for(profile).map_err(|error| {
        BackendError::Deployment(format!("deployment plan is invalid: {error}"))
    })?;
    let driver = if step_is_completed(&plan, StepId::PrepareRustDriver) {
        let (artifact, bytes) = store
            .load_artifact(profile, ArtifactKind::RustDriverFfs)
            .map_err(BackendError::from)?;
        nvstraps_ffs::inspect_ffs(&bytes).map_err(|error| {
            BackendError::Deployment(format!("persisted Rust driver is invalid: {error}"))
        })?;
        require_step_value(&plan, StepId::PrepareRustDriver, artifact.sha256.as_str())?;
        artifact
    } else {
        require_active_step(&plan, StepId::PrepareRustDriver)?;
        nvstraps_ffs::inspect_ffs(bundled_driver).map_err(|error| {
            BackendError::Deployment(format!("bundled Rust driver is invalid: {error}"))
        })?;
        let artifact = store
            .preserve_artifact(profile, ArtifactKind::RustDriverFfs, bundled_driver)
            .map_err(BackendError::from)?;
        plan.complete(
            StepId::PrepareRustDriver,
            StepEvidence::new(EvidenceKind::RustDriverSha256, artifact.sha256.to_string())
                .map_err(|error| BackendError::Deployment(error.to_string()))?,
        )
        .map_err(|error| BackendError::Deployment(error.to_string()))?;
        store
            .save_plan(profile, &plan)
            .map_err(BackendError::from)?;
        artifact
    };

    if profile.board_path == BoardPath::LegacyAbove4g {
        return Ok(FirmwarePreparation {
            plan,
            driver,
            patched_firmware: None,
            injection: None,
        });
    }

    if step_is_completed(&plan, StepId::VerifyPatchedArtifact) {
        let (artifact, _) = store
            .load_artifact(profile, ArtifactKind::PatchedFirmware)
            .map_err(BackendError::from)?;
        require_step_value(
            &plan,
            StepId::VerifyPatchedArtifact,
            artifact.sha256.as_str(),
        )?;
        return Ok(FirmwarePreparation {
            plan,
            driver,
            patched_firmware: Some(artifact),
            injection: None,
        });
    }

    require_active_step(&plan, StepId::VerifyPatchedArtifact)?;
    let (_, driver_bytes) = store
        .load_artifact(profile, ArtifactKind::RustDriverFfs)
        .map_err(BackendError::from)?;
    let original_path = store
        .original_firmware_path(&profile.profile_id)
        .map_err(BackendError::from)?;
    let original = fs::read(&original_path).map_err(|error| {
        BackendError::Deployment(format!(
            "preserved original firmware could not be read: {error}"
        ))
    })?;
    let (patched, injection) = nvstraps_ffs::inject_ffs(&original, &driver_bytes)
        .map_err(|error| BackendError::Deployment(format!("firmware injection failed: {error}")))?;
    match nvstraps_ffs::inject_ffs(&patched, &driver_bytes) {
        Err(nvstraps_ffs::InjectionError::DriverAlreadyPresent) => {}
        Err(error) => {
            return Err(BackendError::Deployment(format!(
                "patched firmware duplicate check failed unexpectedly: {error}"
            )));
        }
        Ok(_) => {
            return Err(BackendError::Deployment(
                "patched firmware accepted a duplicate driver GUID".into(),
            ));
        }
    }
    let patched_firmware = store
        .preserve_artifact(profile, ArtifactKind::PatchedFirmware, &patched)
        .map_err(BackendError::from)?;
    plan.complete(
        StepId::VerifyPatchedArtifact,
        StepEvidence::new(
            EvidenceKind::PatchedFirmwareSha256,
            patched_firmware.sha256.to_string(),
        )
        .map_err(|error| BackendError::Deployment(error.to_string()))?,
    )
    .map_err(|error| BackendError::Deployment(error.to_string()))?;
    store
        .save_plan(profile, &plan)
        .map_err(BackendError::from)?;

    Ok(FirmwarePreparation {
        plan,
        driver,
        patched_firmware: Some(patched_firmware),
        injection: Some(InjectionReceipt {
            firmware_volume_offset: injection.firmware_volume_offset,
            file_offset: injection.file_offset,
            replaced_pad_file: injection.replaced_pad_file,
            erase_polarity: injection.erase_polarity,
            encapsulated_volume_image: injection.encapsulated_volume_image,
            recompressed_guided_section: injection.recompressed_guided_section,
        }),
    })
}

fn require_active_step(plan: &DeploymentPlan, expected: StepId) -> BackendResult<()> {
    match plan.active_step() {
        Some(step) if step.id == expected => Ok(()),
        Some(step) => Err(BackendError::Deployment(format!(
            "deployment step {expected:?} cannot run while {:?} is active",
            step.id
        ))),
        None => Err(BackendError::Deployment(
            "deployment plan has no active step".into(),
        )),
    }
}

fn step_is_completed(plan: &DeploymentPlan, id: StepId) -> bool {
    plan.steps
        .iter()
        .any(|step| step.id == id && step.state == StepState::Completed)
}

fn require_step_value(plan: &DeploymentPlan, id: StepId, expected: &str) -> BackendResult<()> {
    let value = plan
        .steps
        .iter()
        .find(|step| step.id == id && step.state == StepState::Completed)
        .and_then(|step| step.evidence.as_ref())
        .map(|evidence| evidence.value.as_str());
    if value == Some(expected) {
        Ok(())
    } else {
        Err(BackendError::Deployment(format!(
            "persisted artifact does not match evidence for {id:?}"
        )))
    }
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
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use nvstraps_deploy::{GpuFingerprint, PciLocation, RecoveryMethod, Sha256Digest};

    use super::*;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "nvstraps-tauri-deployment-{}-{nonce}-{}",
                std::process::id(),
                TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            assert!(self.0.starts_with(std::env::temp_dir()));
            let _ = fs::remove_dir_all(&self.0);
        }
    }

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

    fn profile(path: BoardPath, firmware: FirmwareFingerprint) -> MachineProfile {
        MachineProfile::create(
            "test machine",
            path,
            identity(),
            firmware,
            RecoveryCapability {
                method: RecoveryMethod::UsbFlashback,
                tested_or_documented: true,
                note: "documented recovery".into(),
            },
        )
        .unwrap()
    }

    fn synthetic_driver_ffs() -> Vec<u8> {
        let mut image = vec![0_u8; 0x200];
        image[..2].copy_from_slice(b"MZ");
        image[0x3c..0x40].copy_from_slice(&0x80_u32.to_le_bytes());
        image[0x80..0x84].copy_from_slice(b"PE\0\0");
        let coff = 0x84;
        image[coff..coff + 2].copy_from_slice(&0x8664_u16.to_le_bytes());
        image[coff + 16..coff + 18].copy_from_slice(&0xf0_u16.to_le_bytes());
        let optional = coff + 20;
        image[optional..optional + 2].copy_from_slice(&0x20b_u16.to_le_bytes());
        image[optional + 68..optional + 70].copy_from_slice(&11_u16.to_le_bytes());
        image[optional + 70..optional + 72].copy_from_slice(&0x0100_u16.to_le_bytes());
        nvstraps_ffs::build_ffs(&image).unwrap()
    }

    fn synthetic_firmware() -> Vec<u8> {
        let length = 8192_usize;
        let mut firmware = vec![0xff; length];
        firmware[..16].fill(0);
        firmware[16..32].copy_from_slice(&[
            0x78, 0xe5, 0x8c, 0x8c, 0x3d, 0x8a, 0x1c, 0x4f, 0x99, 0x35, 0x89, 0x61, 0x85, 0xc3,
            0x2d, 0xd3,
        ]);
        firmware[32..40].copy_from_slice(&(length as u64).to_le_bytes());
        firmware[40..44].copy_from_slice(b"_FVH");
        firmware[44..48].copy_from_slice(&0x800_u32.to_le_bytes());
        firmware[48..50].copy_from_slice(&72_u16.to_le_bytes());
        firmware[50..52].fill(0);
        firmware[52..54].copy_from_slice(&0_u16.to_le_bytes());
        firmware[54] = 0;
        firmware[55] = 2;
        firmware[56..60].copy_from_slice(&1_u32.to_le_bytes());
        firmware[60..64].copy_from_slice(&(length as u32).to_le_bytes());
        firmware[64..72].fill(0);
        let sum = firmware[..72].chunks_exact(2).fold(0_u16, |sum, pair| {
            sum.wrapping_add(u16::from_le_bytes([pair[0], pair[1]]))
        });
        firmware[50..52].copy_from_slice(&0_u16.wrapping_sub(sum).to_le_bytes());

        let dxe_core = 72;
        firmware[dxe_core..dxe_core + 16].fill(0x11);
        firmware[dxe_core + 16..dxe_core + 18].fill(0);
        firmware[dxe_core + 18] = 0x05;
        firmware[dxe_core + 19] = 0;
        firmware[dxe_core + 20..dxe_core + 23].copy_from_slice(&[24, 0, 0]);
        firmware[dxe_core + 23] = !0x07;
        firmware
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

    #[test]
    fn modern_preparation_injects_once_and_advances_each_durable_revision() {
        let directory = TestDirectory::new();
        let source = directory.0.join("vendor.bin");
        fs::write(&source, synthetic_firmware()).unwrap();
        let profile = profile(
            BoardPath::NativeResizableBar,
            FirmwareFingerprint::inspect(&source).unwrap(),
        );
        let store = DeploymentStore::new(directory.0.join("store"));
        let provisioned = store.provision_profile(&profile, &source).unwrap();
        let driver = synthetic_driver_ffs();

        let prepared = prepare_from_bytes(&store, &profile, provisioned.plan, &driver).unwrap();
        assert_eq!(prepared.plan.revision, 5);
        assert_eq!(
            prepared.plan.active_step().unwrap().id,
            StepId::FlashWithVendorRoute
        );
        assert!(prepared.injection.is_some());
        let (_, patched) = store
            .load_artifact(&profile, ArtifactKind::PatchedFirmware)
            .unwrap();
        assert!(matches!(
            nvstraps_ffs::inject_ffs(&patched, &driver),
            Err(nvstraps_ffs::InjectionError::DriverAlreadyPresent)
        ));

        let repeated = prepare_from_bytes(&store, &profile, prepared.plan, &driver).unwrap();
        assert_eq!(repeated.plan.revision, 5);
        assert!(repeated.injection.is_none());
        assert_eq!(repeated.patched_firmware, prepared.patched_firmware);
    }

    #[test]
    fn legacy_preparation_stops_before_board_specific_patches() {
        let directory = TestDirectory::new();
        let source = directory.0.join("vendor.bin");
        fs::write(&source, b"legacy vendor firmware").unwrap();
        let profile = profile(
            BoardPath::LegacyAbove4g,
            FirmwareFingerprint::inspect(&source).unwrap(),
        );
        let store = DeploymentStore::new(directory.0.join("store"));
        let provisioned = store.provision_profile(&profile, &source).unwrap();

        let prepared =
            prepare_from_bytes(&store, &profile, provisioned.plan, &synthetic_driver_ffs())
                .unwrap();
        assert_eq!(prepared.plan.revision, 4);
        assert_eq!(
            prepared.plan.active_step().unwrap().id,
            StepId::ApplyLegacyBoardPatches
        );
        assert!(prepared.patched_firmware.is_none());
        assert!(prepared.injection.is_none());
    }
}
