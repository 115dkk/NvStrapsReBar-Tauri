use std::{
    borrow::Cow,
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
};

use nvstraps_deploy::{
    ArtifactKind, BoardPath, DeploymentPackageReceipt, DeploymentPlan, DeploymentStore,
    DeploymentWorkflow, FirmwareFingerprint, FirmwareInstallRoute, FirmwareTargetPolicy,
    LegacyPatchProfile, MachineIdentity, MachineProfile, ProfileDifference, ProfileError,
    ProfileMatch, ProvisionedDeployment, RecoveryCapability, Sha256Digest, StepId, StoredArtifact,
};
#[cfg(test)]
use nvstraps_legacy::LegacyPatchCatalogView;
use nvstraps_legacy::{LegacyCatalogAuthority, LegacyFirmwareCatalogAnalysis, LegacyPatchReceipt};
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
    pub expected_firmware: FirmwareFingerprint,
    pub recovery: RecoveryCapability,
    pub firmware_install: FirmwareInstallRoute,
    #[serde(default)]
    pub firmware_target_policy: FirmwareTargetPolicy,
    pub legacy_patches: Option<LegacyPatchProfile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareProfileRequest {
    pub profile_id: String,
    pub firmware_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDeploymentPackageRequest {
    pub profile_id: String,
    pub destination_root: String,
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
    pub legacy_patched_firmware: Option<StoredArtifact>,
    pub legacy_patch_receipt: Option<StoredArtifact>,
    pub legacy_patch: Option<LegacyPatchReceipt>,
    pub patched_firmware: Option<StoredArtifact>,
    pub firmware_injection_receipt: Option<StoredArtifact>,
    pub injection: Option<InjectionReceipt>,
}

pub(crate) struct ExactDeployment {
    pub store: DeploymentStore,
    pub profile: MachineProfile,
    pub plan: DeploymentPlan,
    pub devices: Vec<crate::devices::GpuDevice>,
    pub current_identity: MachineIdentity,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectionReceipt {
    pub firmware_target_policy: FirmwareTargetPolicy,
    pub policy_version: u8,
    pub source_sha256: String,
    pub driver_sha256: String,
    pub patched_firmware_sha256: String,
    pub census_sha256: String,
    pub patched_target_count: usize,
    pub grew_firmware_volume: bool,
    pub firmware_volume_growth_bytes: usize,
    pub targets: Vec<InjectionTargetReceipt>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectionTargetReceipt {
    pub target_container_file_offsets: Vec<usize>,
    pub target_firmware_volume_offset: usize,
    pub driver_file_offset: usize,
    pub container_firmware_volume_offset: usize,
    pub container_file_offset: usize,
    pub replaced_pad_file: bool,
    pub erase_polarity: bool,
    pub encapsulated_volume_image: bool,
    pub recompressed_guided_section: bool,
    pub grew_firmware_volume: bool,
    pub firmware_volume_growth_bytes: usize,
}

const MAX_FIRMWARE_IMAGE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyFirmwareAnalysisView {
    pub firmware: FirmwareFingerprint,
    pub upstream_commit: String,
    pub catalogs: Vec<LegacyFirmwareCatalogAnalysis>,
}

#[cfg(test)]
fn legacy_patch_catalog_views() -> CommandResult<Vec<LegacyPatchCatalogView>> {
    legacy_authority()
        .and_then(|authority| authority.catalog_views().map_err(legacy_error))
        .map_err(ApiError::from)
}

#[tauri::command]
pub fn inspect_firmware_image(path: String) -> CommandResult<FirmwareFingerprint> {
    inspect_firmware_path(&path).map_err(ApiError::from)
}

#[tauri::command]
pub async fn analyze_legacy_firmware(path: String) -> CommandResult<LegacyFirmwareAnalysisView> {
    tauri::async_runtime::spawn_blocking(move || analyze_legacy_firmware_path(&path))
        .await
        .map_err(|error| {
            ApiError::from(BackendError::Deployment(format!(
                "legacy firmware analysis worker failed: {error}"
            )))
        })?
        .map_err(ApiError::from)
}

#[tauri::command]
pub async fn create_machine_profile(
    app: AppHandle,
    request: CreateProfileRequest,
) -> CommandResult<DeploymentBundle> {
    tauri::async_runtime::spawn_blocking(move || create_profile_command(&app, request))
        .await
        .map_err(|error| {
            ApiError::from(BackendError::Deployment(format!(
                "machine profile worker failed: {error}"
            )))
        })?
        .map_err(ApiError::from)
}

fn create_profile_command(
    app: &AppHandle,
    request: CreateProfileRequest,
) -> BackendResult<DeploymentBundle> {
    let firmware_path = canonical_firmware_path(&request.firmware_path)?;
    let firmware = FirmwareFingerprint::inspect(&firmware_path)?;
    require_expected_firmware(&request.expected_firmware, &firmware)?;
    let devices = enumerate_gpus()?;
    let identity = collect_machine_identity(&devices)?;
    let profile = build_profile(request, identity, firmware)?;
    let original = read_firmware_image(&firmware_path, &profile.original_firmware)?;
    let driver_ffs = read_bundled_driver(app)?;
    let deployment_store = store(app)?;
    let provisioned = provision_feasible_profile(
        &deployment_store,
        &profile,
        &firmware_path,
        &original,
        &driver_ffs,
    )?;
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
    let store = store(&app).map_err(ApiError::from)?;
    let profile = store
        .load_profile(&request.profile_id)
        .map_err(BackendError::from)
        .map_err(ApiError::from)?;
    let plan = store
        .load_plan(&profile)
        .map_err(BackendError::from)
        .map_err(ApiError::from)?;
    let devices = enumerate_gpus().map_err(ApiError::from)?;
    let current_identity = collect_machine_identity(&devices).map_err(ApiError::from)?;
    let firmware = request
        .firmware_path
        .as_deref()
        .map(inspect_firmware_path)
        .transpose()
        .map_err(ApiError::from)?;
    let mut result = deployment_identity_comparison(&profile, &plan, &current_identity)
        .map_err(ApiError::from)?;
    if firmware.as_ref().is_some_and(|firmware| {
        profile.original_firmware.byte_length != firmware.byte_length
            || profile.original_firmware.sha256 != firmware.sha256
    }) {
        result.differences.push(ProfileDifference::FirmwareImage);
    }
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

#[tauri::command]
pub async fn export_deployment_package(
    app: AppHandle,
    request: ExportDeploymentPackageRequest,
) -> CommandResult<DeploymentPackageReceipt> {
    tauri::async_runtime::spawn_blocking(move || export_package_command(&app, request))
        .await
        .map_err(|error| {
            ApiError::from(BackendError::Deployment(format!(
                "deployment package worker failed: {error}"
            )))
        })?
        .map_err(ApiError::from)
}

fn export_package_command(
    app: &AppHandle,
    request: ExportDeploymentPackageRequest,
) -> BackendResult<DeploymentPackageReceipt> {
    let exact = load_exact_deployment(app, &request.profile_id, "deployment package export")?;
    let injection_receipt_sha256 =
        validate_persisted_patched_artifact(&exact.store, &exact.profile, &exact.plan)?
            .ok_or_else(|| {
                BackendError::Deployment(
                    "deployment package export requires a verified firmware injection receipt"
                        .into(),
                )
            })?;
    exact
        .store
        .export_deployment_package(
            &exact.profile,
            &exact.plan,
            &injection_receipt_sha256,
            request.destination_root,
        )
        .map_err(BackendError::from)
}

fn prepare_command(app: &AppHandle, profile_id: &str) -> BackendResult<FirmwarePreparation> {
    let exact = load_exact_deployment(app, profile_id, "firmware preparation")?;
    let driver_ffs = read_bundled_driver(app)?;
    prepare_from_bytes(&exact.store, &exact.profile, exact.plan, &driver_ffs)
}

fn read_bundled_driver(app: &AppHandle) -> BackendResult<Vec<u8>> {
    let driver_path = app
        .path()
        .resolve("NvStrapsReBar.ffs", BaseDirectory::Resource)
        .map_err(|error| {
            BackendError::Deployment(format!("bundled Rust driver path failed: {error}"))
        })?;
    fs::read(&driver_path).map_err(|error| {
        BackendError::Deployment(format!(
            "bundled Rust driver could not be read at {}: {error}",
            driver_path.display()
        ))
    })
}

pub(crate) fn load_exact_deployment(
    app: &AppHandle,
    profile_id: &str,
    operation: &'static str,
) -> BackendResult<ExactDeployment> {
    let store = store(app)?;
    let profile = store.load_profile(profile_id).map_err(BackendError::from)?;
    validate_builtin_legacy_profile(&profile)?;
    let plan = store.load_plan(&profile).map_err(BackendError::from)?;
    let devices = enumerate_gpus()?;
    let current_identity = collect_machine_identity(&devices)?;
    let original_path = store
        .original_firmware_path(profile_id)
        .map_err(BackendError::from)?;
    let original_fingerprint = FirmwareFingerprint::inspect(&original_path)?;
    let mut comparison = deployment_identity_comparison(&profile, &plan, &current_identity)?;
    if profile.original_firmware.byte_length != original_fingerprint.byte_length
        || profile.original_firmware.sha256 != original_fingerprint.sha256
    {
        comparison
            .differences
            .push(ProfileDifference::FirmwareImage);
    }
    if !comparison.is_exact() {
        let differences = serde_json::to_string(&comparison.differences)
            .unwrap_or_else(|_| "machine profile mismatch".into());
        return Err(BackendError::Deployment(format!(
            "machine profile changed; {operation} was refused: {differences}"
        )));
    }
    Ok(ExactDeployment {
        store,
        profile,
        plan,
        devices,
        current_identity,
    })
}

fn deployment_identity_comparison(
    profile: &MachineProfile,
    plan: &DeploymentPlan,
    current_identity: &MachineIdentity,
) -> BackendResult<ProfileMatch> {
    let boot_observation = plan.latest_boot_observation().map_err(BackendError::from)?;
    let expected = boot_observation
        .as_ref()
        .map_or(&profile.identity, |observation| &observation.identity);
    Ok(match plan.active_step().map(|step| step.id) {
        Some(
            StepId::FlashWithVendorRoute
            | StepId::ConfigureFirmwareSetup
            | StepId::RebootAfterFirmware,
        ) => expected.compare_allowing_firmware_transition(current_identity),
        Some(StepId::RebootAfterConfiguration) => {
            expected.compare_allowing_bar0_relocation(current_identity)
        }
        _ => expected.compare_exact(current_identity),
    })
}

fn prepare_from_bytes(
    store: &DeploymentStore,
    profile: &MachineProfile,
    plan: DeploymentPlan,
    bundled_driver: &[u8],
) -> BackendResult<FirmwarePreparation> {
    validate_builtin_legacy_profile(profile)?;
    let mut workflow =
        DeploymentWorkflow::from_plan(store, profile, plan).map_err(BackendError::from)?;
    let driver = if workflow.plan().is_step_completed(StepId::PrepareRustDriver) {
        let (artifact, bytes) = store
            .load_artifact(profile, ArtifactKind::RustDriverFfs)
            .map_err(BackendError::from)?;
        nvstraps_ffs::inspect_bundled_ffs(&bytes).map_err(|error| {
            BackendError::Deployment(format!("persisted Rust driver is invalid: {error}"))
        })?;
        workflow
            .plan()
            .require_completed_value(StepId::PrepareRustDriver, artifact.sha256.as_str())
            .map_err(BackendError::from)?;
        artifact
    } else {
        workflow
            .plan()
            .require_active(StepId::PrepareRustDriver)
            .map_err(BackendError::from)?;
        nvstraps_ffs::inspect_bundled_ffs(bundled_driver).map_err(|error| {
            BackendError::Deployment(format!("bundled Rust driver is invalid: {error}"))
        })?;
        let artifact = store
            .preserve_artifact(profile, ArtifactKind::RustDriverFfs, bundled_driver)
            .map_err(BackendError::from)?;
        workflow
            .record_step(StepId::PrepareRustDriver, artifact.sha256.to_string())
            .map_err(BackendError::from)?;
        artifact
    };

    let (legacy_patched_firmware, legacy_patch_receipt, legacy_patch) =
        if profile.board_path == BoardPath::LegacyAbove4g {
            if workflow
                .plan()
                .is_step_completed(StepId::ApplyLegacyBoardPatches)
            {
                load_legacy_patch_artifacts(store, profile, workflow.plan())?
            } else {
                workflow
                    .plan()
                    .require_active(StepId::ApplyLegacyBoardPatches)
                    .map_err(BackendError::from)?;
                let original = read_preserved_original(store, profile)?;
                let payload = firmware_payload_for_profile(profile, &original)?;
                let (patched, receipt) = apply_builtin_legacy_patches(profile, payload.as_ref())?;
                let patched_artifact = store
                    .preserve_artifact(profile, ArtifactKind::LegacyPatchedFirmware, &patched)
                    .map_err(BackendError::from)?;
                if receipt.patched_firmware_sha256 != patched_artifact.sha256 {
                    return Err(BackendError::Deployment(
                        "legacy patch receipt does not match the persisted artifact".into(),
                    ));
                }
                let receipt_bytes = serde_json::to_vec_pretty(&receipt).map_err(|error| {
                    BackendError::Deployment(format!(
                        "legacy patch receipt could not be encoded: {error}"
                    ))
                })?;
                let receipt_artifact = store
                    .preserve_artifact(profile, ArtifactKind::LegacyPatchReceipt, &receipt_bytes)
                    .map_err(BackendError::from)?;
                workflow
                    .record_step(
                        StepId::ApplyLegacyBoardPatches,
                        receipt_artifact.sha256.to_string(),
                    )
                    .map_err(BackendError::from)?;
                (
                    Some(patched_artifact),
                    Some(receipt_artifact),
                    Some(receipt),
                )
            }
        } else {
            (None, None, None)
        };

    if workflow
        .plan()
        .is_step_completed(StepId::VerifyPatchedArtifact)
    {
        let _ = validate_persisted_patched_artifact(store, profile, workflow.plan())?;
        let (artifact, _) = store
            .load_artifact(profile, ArtifactKind::PatchedFirmware)
            .map_err(BackendError::from)?;
        let (injection_receipt_artifact, injection) = load_injection_receipt(store, profile)?;
        workflow
            .plan()
            .require_completed_value(StepId::VerifyPatchedArtifact, artifact.sha256.as_str())
            .map_err(BackendError::from)?;
        return Ok(FirmwarePreparation {
            plan: workflow.into_plan(),
            driver,
            legacy_patched_firmware,
            legacy_patch_receipt,
            legacy_patch,
            patched_firmware: Some(artifact),
            firmware_injection_receipt: Some(injection_receipt_artifact),
            injection: Some(injection),
        });
    }

    workflow
        .plan()
        .require_active(StepId::VerifyPatchedArtifact)
        .map_err(BackendError::from)?;
    let (_, driver_bytes) = store
        .load_artifact(profile, ArtifactKind::RustDriverFfs)
        .map_err(BackendError::from)?;
    let base_firmware = if profile.board_path == BoardPath::LegacyAbove4g {
        store
            .load_artifact(profile, ArtifactKind::LegacyPatchedFirmware)
            .map_err(BackendError::from)?
            .1
    } else {
        let original = read_preserved_original(store, profile)?;
        firmware_payload_for_profile(profile, &original)?.into_owned()
    };
    let (patched, injection) = inject_ffs_for_profile(profile, &base_firmware, &driver_bytes)?;
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
    let injection = injection_receipt(profile, injection, &patched_firmware.sha256)?;
    let injection_receipt_bytes = serde_json::to_vec_pretty(&injection).map_err(|error| {
        BackendError::Deployment(format!(
            "firmware injection receipt could not be encoded: {error}"
        ))
    })?;
    let injection_receipt_artifact = store
        .preserve_artifact(
            profile,
            ArtifactKind::FirmwareInjectionReceipt,
            &injection_receipt_bytes,
        )
        .map_err(BackendError::from)?;
    workflow
        .record_step(
            StepId::VerifyPatchedArtifact,
            patched_firmware.sha256.to_string(),
        )
        .map_err(BackendError::from)?;

    Ok(FirmwarePreparation {
        plan: workflow.into_plan(),
        driver,
        legacy_patched_firmware,
        legacy_patch_receipt,
        legacy_patch,
        patched_firmware: Some(patched_firmware),
        firmware_injection_receipt: Some(injection_receipt_artifact),
        injection: Some(injection),
    })
}

fn injection_receipt(
    profile: &MachineProfile,
    injection: nvstraps_ffs::FirmwareInjectionBatch,
    patched_firmware_sha256: &Sha256Digest,
) -> BackendResult<InjectionReceipt> {
    let policy_version = injection.plan.policy_version;
    let source_sha256 = sha256_bytes_hex(&injection.plan.source_sha256);
    let driver_sha256 = sha256_bytes_hex(&injection.plan.driver_sha256);
    let census_sha256 = sha256_bytes_hex(&injection.plan.census_sha256);
    let patched_target_count = injection.targets.len();
    let grew_firmware_volume = injection
        .targets
        .iter()
        .any(|target| target.grew_firmware_volume);
    let firmware_volume_growth_bytes =
        injection
            .targets
            .iter()
            .try_fold(0_usize, |total, target| {
                total
                    .checked_add(target.firmware_volume_growth_bytes)
                    .ok_or_else(|| {
                        BackendError::Deployment(
                            "firmware-volume growth receipt byte count overflowed".into(),
                        )
                    })
            })?;
    let targets = injection
        .targets
        .into_iter()
        .map(|target| InjectionTargetReceipt {
            target_container_file_offsets: target.target.container_file_offsets,
            target_firmware_volume_offset: target.target.firmware_volume_offset,
            driver_file_offset: target.driver_file_offset,
            container_firmware_volume_offset: target.firmware_volume_offset,
            container_file_offset: target.file_offset,
            replaced_pad_file: target.replaced_pad_file,
            erase_polarity: target.erase_polarity,
            encapsulated_volume_image: target.encapsulated_volume_image,
            recompressed_guided_section: target.recompressed_guided_section,
            grew_firmware_volume: target.grew_firmware_volume,
            firmware_volume_growth_bytes: target.firmware_volume_growth_bytes,
        })
        .collect();
    Ok(InjectionReceipt {
        firmware_target_policy: profile.firmware_target_policy,
        policy_version,
        source_sha256,
        driver_sha256,
        patched_firmware_sha256: patched_firmware_sha256.to_string(),
        census_sha256,
        patched_target_count,
        grew_firmware_volume,
        firmware_volume_growth_bytes,
        targets,
    })
}

fn load_injection_receipt(
    store: &DeploymentStore,
    profile: &MachineProfile,
) -> BackendResult<(StoredArtifact, InjectionReceipt)> {
    let (artifact, bytes) = store
        .load_artifact(profile, ArtifactKind::FirmwareInjectionReceipt)
        .map_err(BackendError::from)?;
    let receipt = serde_json::from_slice(&bytes).map_err(|error| {
        BackendError::Deployment(format!(
            "firmware injection receipt could not be decoded: {error}"
        ))
    })?;
    Ok((artifact, receipt))
}

fn sha256_bytes_hex(bytes: &[u8; 32]) -> String {
    let mut encoded = String::with_capacity(64);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

fn read_preserved_original(
    store: &DeploymentStore,
    profile: &MachineProfile,
) -> BackendResult<Vec<u8>> {
    let original_path = store
        .original_firmware_path(&profile.profile_id)
        .map_err(BackendError::from)?;
    read_firmware_image(&original_path, &profile.original_firmware)
}

pub(crate) fn validate_persisted_patched_artifact(
    store: &DeploymentStore,
    profile: &MachineProfile,
    plan: &DeploymentPlan,
) -> BackendResult<Option<Sha256Digest>> {
    if !plan.is_step_completed(StepId::VerifyPatchedArtifact) {
        return Ok(None);
    }

    let (driver_artifact, driver_bytes) = store
        .load_artifact(profile, ArtifactKind::RustDriverFfs)
        .map_err(BackendError::from)?;
    plan.require_completed_value(StepId::PrepareRustDriver, driver_artifact.sha256.as_str())
        .map_err(BackendError::from)?;
    nvstraps_ffs::inspect_bundled_ffs(&driver_bytes)
        .map_err(nvstraps_ffs::InjectionError::from)
        .map_err(BackendError::FirmwareInjection)?;

    let base_firmware = if profile.board_path == BoardPath::LegacyAbove4g {
        let _ = load_legacy_patch_artifacts(store, profile, plan)?;
        store
            .load_artifact(profile, ArtifactKind::LegacyPatchedFirmware)
            .map_err(BackendError::from)?
            .1
    } else {
        let original = read_preserved_original(store, profile)?;
        firmware_payload_for_profile(profile, &original)?.into_owned()
    };
    let (expected, expected_injection) =
        inject_ffs_for_profile(profile, &base_firmware, &driver_bytes)?;
    let (patched_artifact, patched_bytes) = store
        .load_artifact(profile, ArtifactKind::PatchedFirmware)
        .map_err(BackendError::from)?;
    plan.require_completed_value(
        StepId::VerifyPatchedArtifact,
        patched_artifact.sha256.as_str(),
    )
    .map_err(BackendError::from)?;
    if patched_bytes != expected {
        return Err(BackendError::Deployment(
            "persisted patched firmware does not match the current atomic all-target injector; create a new machine profile so every proven DXE target is rebuilt"
                .into(),
        ));
    }
    let expected_receipt =
        injection_receipt(profile, expected_injection, &patched_artifact.sha256)?;
    let (receipt_artifact, persisted_receipt) = load_injection_receipt(store, profile)?;
    if persisted_receipt != expected_receipt {
        return Err(BackendError::Deployment(
            "persisted firmware injection receipt does not match the exact current all-target rebuild"
                .into(),
        ));
    }
    Ok(Some(receipt_artifact.sha256))
}

fn apply_builtin_legacy_patches(
    profile: &MachineProfile,
    original: &[u8],
) -> BackendResult<(Vec<u8>, LegacyPatchReceipt)> {
    let legacy = profile.legacy_patches.as_ref().ok_or_else(|| {
        BackendError::Deployment("legacy patch profile is missing after validation".into())
    })?;
    let application = legacy_authority()?
        .apply(original, legacy)
        .map_err(legacy_error)?;
    Ok((application.patched_firmware, application.receipt))
}

fn load_legacy_patch_artifacts(
    store: &DeploymentStore,
    profile: &MachineProfile,
    plan: &DeploymentPlan,
) -> BackendResult<(
    Option<StoredArtifact>,
    Option<StoredArtifact>,
    Option<LegacyPatchReceipt>,
)> {
    let (patched_artifact, _) = store
        .load_artifact(profile, ArtifactKind::LegacyPatchedFirmware)
        .map_err(BackendError::from)?;
    let (receipt_artifact, receipt_bytes) = store
        .load_artifact(profile, ArtifactKind::LegacyPatchReceipt)
        .map_err(BackendError::from)?;
    plan.require_completed_value(
        StepId::ApplyLegacyBoardPatches,
        receipt_artifact.sha256.as_str(),
    )
    .map_err(BackendError::from)?;
    let receipt: LegacyPatchReceipt = serde_json::from_slice(&receipt_bytes).map_err(|error| {
        BackendError::Deployment(format!(
            "persisted legacy patch receipt is invalid: {error}"
        ))
    })?;
    validate_legacy_patch_receipt(profile, &patched_artifact.sha256, &receipt)?;
    Ok((
        Some(patched_artifact),
        Some(receipt_artifact),
        Some(receipt),
    ))
}

fn validate_legacy_patch_receipt(
    profile: &MachineProfile,
    patched_sha256: &Sha256Digest,
    receipt: &LegacyPatchReceipt,
) -> BackendResult<()> {
    let legacy = profile.legacy_patches.as_ref().ok_or_else(|| {
        BackendError::Deployment("legacy patch receipt belongs to a non-legacy profile".into())
    })?;
    legacy_authority()?
        .validate_receipt(
            legacy,
            &profile.original_firmware.sha256,
            patched_sha256,
            receipt,
        )
        .map_err(legacy_error)
}

fn build_profile(
    request: CreateProfileRequest,
    identity: MachineIdentity,
    firmware: FirmwareFingerprint,
) -> BackendResult<MachineProfile> {
    let profile = match (request.board_path, request.legacy_patches) {
        (BoardPath::NativeResizableBar, None) => MachineProfile::create_with_target_policy(
            request.display_name,
            request.board_path,
            identity,
            firmware,
            request.recovery,
            request.firmware_install,
            request.firmware_target_policy,
        ),
        (BoardPath::LegacyAbove4g, Some(legacy_patches)) => {
            MachineProfile::create_legacy_with_target_policy(
                request.display_name,
                identity,
                firmware,
                request.recovery,
                request.firmware_install,
                legacy_patches,
                request.firmware_target_policy,
            )
        }
        (BoardPath::NativeResizableBar, Some(_)) => Err(ProfileError::LegacyPatchProfileForbidden),
        (BoardPath::LegacyAbove4g, None) => Err(ProfileError::LegacyPatchProfileRequired),
    }
    .map_err(BackendError::from)?;
    validate_builtin_legacy_profile(&profile)?;
    Ok(profile)
}

fn require_expected_firmware(
    expected: &FirmwareFingerprint,
    actual: &FirmwareFingerprint,
) -> BackendResult<()> {
    if actual == expected {
        Ok(())
    } else {
        Err(BackendError::Deployment(format!(
            "firmware image changed after inspection; expected {} bytes with SHA-256 {}, found {} bytes with SHA-256 {}",
            expected.byte_length, expected.sha256, actual.byte_length, actual.sha256
        )))
    }
}

fn legacy_authority() -> BackendResult<LegacyCatalogAuthority> {
    LegacyCatalogAuthority::load().map_err(legacy_error)
}

fn legacy_error(error: nvstraps_legacy::LegacyCatalogError) -> BackendError {
    BackendError::Deployment(error.to_string())
}

fn validate_builtin_legacy_profile(profile: &MachineProfile) -> BackendResult<()> {
    let Some(legacy) = profile.legacy_patches.as_ref() else {
        return Ok(());
    };
    legacy_authority()?
        .validate_profile(legacy)
        .map_err(legacy_error)
}

fn analyze_legacy_firmware_path(path: &str) -> BackendResult<LegacyFirmwareAnalysisView> {
    let path = canonical_firmware_path(path)?;
    let firmware = FirmwareFingerprint::inspect(&path)?;
    let bytes = read_firmware_image(&path, &firmware)?;
    analyze_legacy_firmware_bytes(firmware, &bytes)
}

fn analyze_legacy_firmware_bytes(
    firmware: FirmwareFingerprint,
    bytes: &[u8],
) -> BackendResult<LegacyFirmwareAnalysisView> {
    let analysis = legacy_authority()?.analyze(bytes).map_err(legacy_error)?;
    Ok(LegacyFirmwareAnalysisView {
        firmware,
        upstream_commit: analysis.upstream_commit,
        catalogs: analysis.catalogs,
    })
}

fn read_firmware_image(path: &Path, expected: &FirmwareFingerprint) -> BackendResult<Vec<u8>> {
    let length = path
        .metadata()
        .map_err(|error| {
            BackendError::Deployment(format!(
                "firmware image metadata failed at {}: {error}",
                path.display()
            ))
        })?
        .len();
    if length > MAX_FIRMWARE_IMAGE_BYTES {
        return Err(BackendError::Deployment(format!(
            "firmware image is {length} bytes; the analysis limit is {MAX_FIRMWARE_IMAGE_BYTES} bytes"
        )));
    }
    let bytes = fs::read(path).map_err(|error| {
        BackendError::Deployment(format!(
            "firmware image could not be read at {}: {error}",
            path.display()
        ))
    })?;
    if bytes.len() as u64 != expected.byte_length
        || Sha256Digest::from_bytes(&bytes) != expected.sha256
    {
        return Err(BackendError::Deployment(
            "firmware image changed while it was being analyzed".into(),
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
fn verify_legacy_profile_application(
    profile: &MachineProfile,
    original: &[u8],
) -> BackendResult<()> {
    let _ = dry_run_profile_firmware(profile, original)?;
    Ok(())
}

fn dry_run_profile_firmware<'a>(
    profile: &MachineProfile,
    original: &'a [u8],
) -> BackendResult<Cow<'a, [u8]>> {
    let payload = firmware_payload_for_profile(profile, original)?;
    if profile.legacy_patches.is_some() {
        apply_builtin_legacy_patches(profile, payload.as_ref())
            .map(|(patched, _)| Cow::Owned(patched))
    } else {
        Ok(payload)
    }
}

fn firmware_payload_for_profile<'a>(
    _profile: &MachineProfile,
    original: &'a [u8],
) -> BackendResult<Cow<'a, [u8]>> {
    match nvstraps_ffs::inspect_firmware_envelope(original) {
        nvstraps_ffs::FirmwareEnvelope::RawOrVendorImage => Ok(Cow::Borrowed(original)),
        nvstraps_ffs::FirmwareEnvelope::MalformedCapsule(header) => Err(
            BackendError::FirmwareInjection(nvstraps_ffs::InjectionError::MalformedCapsule(header)),
        ),
        nvstraps_ffs::FirmwareEnvelope::UefiCapsule(header) => {
            Err(BackendError::FirmwareInjection(
                nvstraps_ffs::InjectionError::UnsupportedCapsule(header),
            ))
        }
    }
}

fn injection_plan_for_profile(
    profile: &MachineProfile,
    firmware: &[u8],
    driver_ffs: &[u8],
) -> BackendResult<nvstraps_ffs::FirmwareInjectionPlan> {
    let plan = nvstraps_ffs::plan_ffs_injection(firmware, driver_ffs)
        .map_err(BackendError::FirmwareInjection)?;
    if plan.targets.len() > 1
        && profile.firmware_target_policy != FirmwareTargetPolicy::PatchEveryDxeDomain
    {
        return Err(BackendError::FirmwareInjection(
            nvstraps_ffs::InjectionError::AmbiguousDxeTargets {
                candidates: plan.targets,
            },
        ));
    }
    Ok(plan)
}

fn inject_ffs_for_profile(
    profile: &MachineProfile,
    firmware: &[u8],
    driver_ffs: &[u8],
) -> BackendResult<(Vec<u8>, nvstraps_ffs::FirmwareInjectionBatch)> {
    let plan = injection_plan_for_profile(profile, firmware, driver_ffs)?;
    nvstraps_ffs::inject_ffs_with_plan(firmware, driver_ffs, &plan)
        .map_err(BackendError::FirmwareInjection)
}

fn verify_injection_feasibility(
    profile: &MachineProfile,
    firmware: &[u8],
    driver_ffs: &[u8],
) -> BackendResult<()> {
    inject_ffs_for_profile(profile, firmware, driver_ffs).map(|_| ())
}

fn provision_feasible_profile(
    store: &DeploymentStore,
    profile: &MachineProfile,
    firmware_path: &Path,
    original: &[u8],
    driver_ffs: &[u8],
) -> BackendResult<ProvisionedDeployment> {
    let base_firmware = dry_run_profile_firmware(profile, original)?;
    verify_injection_feasibility(profile, base_firmware.as_ref(), driver_ffs)?;
    store
        .provision_profile(profile, firmware_path)
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

    use nvstraps_deploy::{
        BootObservation, EvidenceKind, FirmwareInstallMethod, GpuFingerprint,
        LegacyPatchCatalogFile, PciLocation, RecoveryMethod, Sha256Digest, StepEvidence,
    };
    use nvstraps_legacy::{
        LEGACY_PATCH_UPSTREAM_COMMIT, LegacyFirmwareRuleStatus,
        test_support::{selected_profile, synthetic_legacy_firmware},
    };

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
        let legacy_patches = (path == BoardPath::LegacyAbove4g).then(valid_builtin_legacy_profile);
        MachineProfile::create_with_legacy(
            "test machine",
            path,
            identity(),
            firmware,
            RecoveryCapability {
                method: RecoveryMethod::UsbFlashback,
                tested_or_documented: true,
                note: "documented recovery".into(),
            },
            firmware_install(),
            legacy_patches,
        )
        .unwrap()
    }

    fn profile_with_target_policy(
        firmware: FirmwareFingerprint,
        firmware_target_policy: FirmwareTargetPolicy,
    ) -> MachineProfile {
        MachineProfile::create_with_target_policy(
            "test machine",
            BoardPath::NativeResizableBar,
            identity(),
            firmware,
            RecoveryCapability {
                method: RecoveryMethod::UsbFlashback,
                tested_or_documented: true,
                note: "documented boot-independent recovery".into(),
            },
            firmware_install(),
            firmware_target_policy,
        )
        .unwrap()
    }

    fn advance_to_flash(profile: &MachineProfile, plan: &mut DeploymentPlan) {
        for (step, kind, value) in [
            (
                StepId::VerifyProfile,
                EvidenceKind::ExactProfileMatch,
                profile.profile_id.clone(),
            ),
            (
                StepId::ConfirmRecovery,
                EvidenceKind::RecoveryRouteConfirmed,
                profile.recovery.method.evidence_value().into(),
            ),
            (
                StepId::PreserveOriginalFirmware,
                EvidenceKind::OriginalFirmwareSha256,
                profile.original_firmware.sha256.to_string(),
            ),
            (
                StepId::PrepareRustDriver,
                EvidenceKind::RustDriverSha256,
                "11f2c3292601b55d09a9fd62244e1c98b49e05c92a965a296332358b5b9c4ee3".into(),
            ),
            (
                StepId::VerifyPatchedArtifact,
                EvidenceKind::PatchedFirmwareSha256,
                "54b489b90e9ce7bd0be8514896402ead5a600618f601730d640b1d5b8546b098".into(),
            ),
        ] {
            plan.complete(step, StepEvidence::new(kind, value).unwrap())
                .unwrap();
        }
    }

    fn firmware_install() -> FirmwareInstallRoute {
        FirmwareInstallRoute {
            method: FirmwareInstallMethod::FirmwareSetupUtility,
            artifact_file_name: "vendor.bin".into(),
            tested_or_documented: true,
            official_instructions_url: "https://vendor.invalid/manual".into(),
            note: "Select the pinned artifact in firmware setup".into(),
        }
    }

    fn valid_builtin_legacy_profile() -> LegacyPatchProfile {
        selected_profile()
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

    fn synthetic_full_firmware() -> Vec<u8> {
        let mut firmware = synthetic_firmware();
        let trailing = 96;
        let trailing_size = firmware.len() - trailing;
        firmware[trailing..].fill(0);
        firmware[trailing..trailing + 16].fill(0x44);
        firmware[trailing + 18] = 0x06;
        firmware[trailing + 20..trailing + 23]
            .copy_from_slice(&(trailing_size as u32).to_le_bytes()[..3]);
        firmware[trailing + 23] = !0x07;
        firmware
    }

    #[test]
    fn profile_request_cannot_bypass_recovery_validation() {
        let request = CreateProfileRequest {
            display_name: "test".into(),
            board_path: BoardPath::LegacyAbove4g,
            firmware_path: "ignored".into(),
            expected_firmware: FirmwareFingerprint {
                file_name: "firmware.bin".into(),
                byte_length: 4,
                sha256: Sha256Digest::from_bytes(b"test"),
            },
            recovery: RecoveryCapability {
                method: RecoveryMethod::None,
                tested_or_documented: false,
                note: String::new(),
            },
            firmware_install: firmware_install(),
            firmware_target_policy: FirmwareTargetPolicy::RequireUnique,
            legacy_patches: None,
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
    fn external_programmer_profiles_require_a_pinned_full_chip_or_bios_region_dump() {
        let raw = synthetic_firmware();
        let body_offset = 0x800_usize;
        let mut capsule = vec![0_u8; body_offset + raw.len()];
        capsule[..16].copy_from_slice(&[
            0x8b, 0xa6, 0x3c, 0x4a, 0x23, 0x77, 0xfb, 0x48, 0x80, 0x3d, 0x57, 0x8c, 0xc1, 0xfe,
            0xc4, 0x4d,
        ]);
        capsule[16..20].copy_from_slice(&(body_offset as u32).to_le_bytes());
        capsule[20..24].copy_from_slice(&0x0001_0001_u32.to_le_bytes());
        let capsule_size = capsule.len() as u32;
        capsule[24..28].copy_from_slice(&capsule_size.to_le_bytes());
        capsule[28..30].copy_from_slice(&(body_offset as u16).to_le_bytes());
        capsule[body_offset..].copy_from_slice(&raw);

        let fingerprint = FirmwareFingerprint {
            file_name: "vendor.cap".into(),
            byte_length: capsule.len() as u64,
            sha256: Sha256Digest::from_bytes(&capsule),
        };
        let mut install = firmware_install();
        install.method = FirmwareInstallMethod::ExternalSpiProgrammer;
        install.artifact_file_name = "patched.bin".into();
        let external = MachineProfile::create(
            "external programmer",
            BoardPath::NativeResizableBar,
            identity(),
            fingerprint.clone(),
            RecoveryCapability {
                method: RecoveryMethod::ExternalSpiProgrammer,
                tested_or_documented: true,
                note: "known-good programmer".into(),
            },
            install,
        )
        .unwrap();
        assert!(matches!(
            firmware_payload_for_profile(&external, &capsule),
            Err(BackendError::FirmwareInjection(
                nvstraps_ffs::InjectionError::UnsupportedCapsule(_)
            ))
        ));

        let vendor_route = profile(BoardPath::NativeResizableBar, fingerprint);
        assert!(matches!(
            firmware_payload_for_profile(&vendor_route, &capsule),
            Err(BackendError::FirmwareInjection(
                nvstraps_ffs::InjectionError::UnsupportedCapsule(_)
            ))
        ));
    }

    #[test]
    fn deployment_preflight_pins_each_controlled_identity_transition() {
        let profile = profile(
            BoardPath::NativeResizableBar,
            FirmwareFingerprint {
                file_name: "vendor.bin".into(),
                byte_length: 4,
                sha256: Sha256Digest::from_bytes(b"test"),
            },
        );
        let mut plan = DeploymentPlan::for_profile(&profile).unwrap();
        advance_to_flash(&profile, &mut plan);
        let mut transitioned = profile.identity.clone();
        transitioned.bios_version = "3".into();
        transitioned.bios_release_date = "2026-08-15".into();
        transitioned.gpus[0].bar0_base += 0x1_0000_0000;
        transitioned.gpus[0].bar0_top += 0x1_0000_0000;

        assert!(
            deployment_identity_comparison(&profile, &plan, &transitioned)
                .unwrap()
                .is_exact()
        );
        let mut different_vendor = transitioned.clone();
        different_vendor.bios_vendor = "Unexpected vendor".into();
        assert!(
            !deployment_identity_comparison(&profile, &plan, &different_vendor)
                .unwrap()
                .is_exact()
        );
        plan.complete_with_value(StepId::FlashWithVendorRoute, "operator-attested:1")
            .unwrap();
        plan.complete_with_value(StepId::ConfigureFirmwareSetup, "operator-attested:2")
            .unwrap();
        assert!(
            deployment_identity_comparison(&profile, &plan, &transitioned)
                .unwrap()
                .is_exact()
        );

        let boot = BootObservation::new(3, transitioned.clone())
            .unwrap()
            .to_evidence_value()
            .unwrap();
        plan.complete_with_value(StepId::RebootAfterFirmware, boot)
            .unwrap();
        plan.complete_with_value(StepId::VerifyDriverLoaded, "0x0000000000000028")
            .unwrap();
        let mut moved_again = transitioned.clone();
        moved_again.gpus[0].bar0_base += 0x1000;
        assert!(
            !deployment_identity_comparison(&profile, &plan, &moved_again)
                .unwrap()
                .is_exact()
        );
        assert!(
            deployment_identity_comparison(&profile, &plan, &transitioned)
                .unwrap()
                .is_exact()
        );

        plan.complete_with_value(StepId::WriteNvstrapsConfiguration, "readback:exact")
            .unwrap();
        assert!(
            deployment_identity_comparison(&profile, &plan, &moved_again)
                .unwrap()
                .is_exact()
        );
        let mut changed_bios_again = moved_again;
        changed_bios_again.bios_version = "4".into();
        assert!(
            !deployment_identity_comparison(&profile, &plan, &changed_bios_again)
                .unwrap()
                .is_exact()
        );
    }

    #[test]
    fn built_in_catalogs_are_pinned_and_profile_rules_cannot_be_forged() {
        let views = legacy_patch_catalog_views().unwrap();
        assert_eq!(views.len(), 5);
        assert!(views.iter().all(|view| {
            view.upstream_commit == LEGACY_PATCH_UPSTREAM_COMMIT
                && view.source_sha256.as_str().len() == 64
                && !view.rules.is_empty()
        }));

        let mut forged = valid_builtin_legacy_profile();
        forged.selections[0].rule_id = "00".repeat(32);
        let request = CreateProfileRequest {
            display_name: "legacy".into(),
            board_path: BoardPath::LegacyAbove4g,
            firmware_path: "ignored".into(),
            expected_firmware: FirmwareFingerprint {
                file_name: "firmware.bin".into(),
                byte_length: 4,
                sha256: Sha256Digest::from_bytes(b"test"),
            },
            recovery: RecoveryCapability {
                method: RecoveryMethod::ExternalSpiProgrammer,
                tested_or_documented: true,
                note: "tested clip and backup".into(),
            },
            firmware_install: firmware_install(),
            firmware_target_policy: FirmwareTargetPolicy::RequireUnique,
            legacy_patches: Some(forged),
        };
        let firmware = FirmwareFingerprint {
            file_name: "firmware.bin".into(),
            byte_length: 4,
            sha256: Sha256Digest::from_bytes(b"test"),
        };
        assert!(
            build_profile(request, identity(), firmware)
                .unwrap_err()
                .to_string()
                .contains("not in built-in catalog")
        );
    }

    #[test]
    fn profile_creation_rejects_firmware_changed_after_client_inspection() {
        let inspected = FirmwareFingerprint {
            file_name: "vendor.bin".into(),
            byte_length: 4,
            sha256: Sha256Digest::from_bytes(b"old!"),
        };
        let changed = FirmwareFingerprint {
            file_name: "vendor.bin".into(),
            byte_length: 4,
            sha256: Sha256Digest::from_bytes(b"new!"),
        };

        let error = require_expected_firmware(&inspected, &changed).unwrap_err();
        assert!(error.to_string().contains("changed after inspection"));
        require_expected_firmware(&inspected, &inspected).unwrap();
    }

    #[test]
    fn legacy_analysis_recommends_only_exact_zero_risk_matches() {
        let bytes = synthetic_legacy_firmware();
        let firmware = FirmwareFingerprint {
            file_name: "legacy.bin".into(),
            byte_length: bytes.len() as u64,
            sha256: Sha256Digest::from_bytes(&bytes),
        };

        let analysis = analyze_legacy_firmware_bytes(firmware.clone(), &bytes).unwrap();
        assert_eq!(analysis.firmware, firmware);
        assert_eq!(analysis.catalogs.len(), 5);
        let applicable: Vec<_> = analysis
            .catalogs
            .iter()
            .flat_map(|catalog| {
                catalog.rules.iter().filter_map(move |rule| {
                    matches!(rule.status, LegacyFirmwareRuleStatus::Applicable)
                        .then_some((catalog.catalog, rule))
                })
            })
            .collect();
        assert_eq!(applicable.len(), 1);
        assert_eq!(applicable[0].0, LegacyPatchCatalogFile::General);
        assert_eq!(applicable[0].1.expected_matches, Some(1));
        assert!(applicable[0].1.required_risks.is_empty());
        assert!(applicable[0].1.recommended);
    }

    #[test]
    fn legacy_profile_creation_dry_run_rejects_stale_match_counts() {
        let bytes = synthetic_legacy_firmware();
        let firmware = FirmwareFingerprint {
            file_name: "legacy.bin".into(),
            byte_length: bytes.len() as u64,
            sha256: Sha256Digest::from_bytes(&bytes),
        };
        let valid = profile(BoardPath::LegacyAbove4g, firmware.clone());
        verify_legacy_profile_application(&valid, &bytes).unwrap();

        let mut stale_legacy = valid_builtin_legacy_profile();
        stale_legacy.selections[0].expected_matches = 2;
        let stale = MachineProfile::create_with_legacy(
            "legacy stale count",
            BoardPath::LegacyAbove4g,
            identity(),
            firmware,
            RecoveryCapability {
                method: RecoveryMethod::UsbFlashback,
                tested_or_documented: true,
                note: "documented recovery".into(),
            },
            firmware_install(),
            Some(stale_legacy),
        )
        .unwrap();
        assert!(
            verify_legacy_profile_application(&stale, &bytes)
                .unwrap_err()
                .to_string()
                .contains("matched 1 times instead of the required 2")
        );
    }

    #[test]
    fn infeasible_profile_is_refused_before_any_store_state_is_created() {
        let directory = TestDirectory::new();
        let source = directory.0.join("full.bin");
        let original = synthetic_full_firmware();
        fs::write(&source, &original).unwrap();
        let profile = profile(
            BoardPath::NativeResizableBar,
            FirmwareFingerprint::inspect(&source).unwrap(),
        );
        let store = DeploymentStore::new(directory.0.join("store"));

        let error = provision_feasible_profile(
            &store,
            &profile,
            &source,
            &original,
            &synthetic_driver_ffs(),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            BackendError::FirmwareInjection(nvstraps_ffs::InjectionError::NoSpace { .. })
        ));
        assert!(!store.root().exists());
    }

    #[test]
    fn multi_target_profile_requires_and_honors_the_bound_patch_every_policy() {
        let directory = TestDirectory::new();
        let source = directory.0.join("dual.bin");
        let original = [synthetic_firmware(), synthetic_firmware()].concat();
        fs::write(&source, &original).unwrap();
        let fingerprint = FirmwareFingerprint::inspect(&source).unwrap();
        let driver = synthetic_driver_ffs();

        let unique = profile(BoardPath::NativeResizableBar, fingerprint.clone());
        let unique_store = DeploymentStore::new(directory.0.join("unique-store"));
        assert!(matches!(
            provision_feasible_profile(&unique_store, &unique, &source, &original, &driver,),
            Err(BackendError::FirmwareInjection(
                nvstraps_ffs::InjectionError::AmbiguousDxeTargets { .. }
            ))
        ));
        assert!(!unique_store.root().exists());

        let patch_every =
            profile_with_target_policy(fingerprint, FirmwareTargetPolicy::PatchEveryDxeDomain);
        let approved_store = DeploymentStore::new(directory.0.join("approved-store"));
        let provisioned =
            provision_feasible_profile(&approved_store, &patch_every, &source, &original, &driver)
                .unwrap();
        assert_eq!(
            provisioned.profile.firmware_target_policy,
            FirmwareTargetPolicy::PatchEveryDxeDomain
        );
    }

    #[test]
    fn preserved_original_is_rehashed_at_the_read_boundary() {
        let directory = TestDirectory::new();
        let source = directory.0.join("vendor.bin");
        fs::write(&source, synthetic_firmware()).unwrap();
        let profile = profile(
            BoardPath::NativeResizableBar,
            FirmwareFingerprint::inspect(&source).unwrap(),
        );
        let store = DeploymentStore::new(directory.0.join("store"));
        store.provision_profile(&profile, &source).unwrap();
        let preserved = store.original_firmware_path(&profile.profile_id).unwrap();
        let mut changed = synthetic_firmware();
        changed[100] ^= 0x01;
        fs::write(preserved, changed).unwrap();

        assert!(
            read_preserved_original(&store, &profile)
                .unwrap_err()
                .to_string()
                .contains("changed while it was being analyzed")
        );
    }

    #[test]
    fn resume_refuses_a_partial_dual_target_artifact_from_an_older_injector() {
        let directory = TestDirectory::new();
        let source = directory.0.join("dual.bin");
        let first = synthetic_firmware();
        let original = [first.clone(), synthetic_firmware()].concat();
        fs::write(&source, &original).unwrap();
        let profile = profile_with_target_policy(
            FirmwareFingerprint::inspect(&source).unwrap(),
            FirmwareTargetPolicy::PatchEveryDxeDomain,
        );
        let store = DeploymentStore::new(directory.0.join("store"));
        let provisioned = store.provision_profile(&profile, &source).unwrap();
        let driver = synthetic_driver_ffs();
        let driver_artifact = store
            .preserve_artifact(&profile, ArtifactKind::RustDriverFfs, &driver)
            .unwrap();

        let mut partial = original;
        partial[96..96 + driver.len()].copy_from_slice(&driver);
        partial[96 + 23] = !0x07;
        partial[96 + driver.len()..96 + ((driver.len() + 7) & !7)].fill(0xff);
        let patched_artifact = store
            .preserve_artifact(&profile, ArtifactKind::PatchedFirmware, &partial)
            .unwrap();
        let mut workflow =
            DeploymentWorkflow::from_plan(&store, &profile, provisioned.plan).unwrap();
        workflow
            .record_step(
                StepId::PrepareRustDriver,
                driver_artifact.sha256.to_string(),
            )
            .unwrap();
        workflow
            .record_step(
                StepId::VerifyPatchedArtifact,
                patched_artifact.sha256.to_string(),
            )
            .unwrap();
        let old_plan = workflow.into_plan();

        let error = prepare_from_bytes(&store, &profile, old_plan, &driver).unwrap_err();
        assert!(matches!(
            error,
            BackendError::Deployment(message)
                if message.contains("does not match the current atomic all-target injector")
        ));
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
        assert!(prepared.firmware_injection_receipt.is_some());
        let (_, patched) = store
            .load_artifact(&profile, ArtifactKind::PatchedFirmware)
            .unwrap();
        assert!(matches!(
            nvstraps_ffs::inject_ffs(&patched, &driver),
            Err(nvstraps_ffs::InjectionError::DriverAlreadyPresent)
        ));

        let repeated = prepare_from_bytes(&store, &profile, prepared.plan, &driver).unwrap();
        assert_eq!(repeated.plan.revision, 5);
        assert!(repeated.injection.is_some());
        assert!(repeated.firmware_injection_receipt.is_some());
        assert_eq!(repeated.patched_firmware, prepared.patched_firmware);

        let receipt_artifact = repeated.firmware_injection_receipt.clone().unwrap();
        let mut forged_receipt = repeated.injection.clone().unwrap();
        forged_receipt.census_sha256 = "00".repeat(32);
        fs::write(
            &receipt_artifact.path,
            serde_json::to_vec_pretty(&forged_receipt).unwrap(),
        )
        .unwrap();
        let error = prepare_from_bytes(&store, &profile, repeated.plan, &driver).unwrap_err();
        assert!(matches!(
            error,
            BackendError::Deployment(message)
                if message.contains("injection receipt does not match")
        ));
    }

    #[test]
    fn legacy_preparation_persists_patches_receipt_and_final_driver() {
        let directory = TestDirectory::new();
        let source = directory.0.join("vendor.bin");
        fs::write(&source, synthetic_legacy_firmware()).unwrap();
        let profile = profile(
            BoardPath::LegacyAbove4g,
            FirmwareFingerprint::inspect(&source).unwrap(),
        );
        let store = DeploymentStore::new(directory.0.join("store"));
        let provisioned = store.provision_profile(&profile, &source).unwrap();

        let prepared =
            prepare_from_bytes(&store, &profile, provisioned.plan, &synthetic_driver_ffs())
                .unwrap();
        assert_eq!(prepared.plan.revision, 6);
        assert_eq!(
            prepared.plan.active_step().unwrap().id,
            StepId::FlashWithVendorRoute
        );
        assert!(prepared.legacy_patched_firmware.is_some());
        assert!(prepared.legacy_patch_receipt.is_some());
        assert_eq!(prepared.legacy_patch.as_ref().unwrap().catalogs.len(), 1);
        assert!(prepared.patched_firmware.is_some());
        assert!(prepared.injection.is_some());
        let destination = directory.0.join("usb");
        fs::create_dir(&destination).unwrap();
        let injection_receipt_sha256 = prepared
            .firmware_injection_receipt
            .as_ref()
            .unwrap()
            .sha256
            .clone();
        let package = store
            .export_deployment_package(
                &profile,
                &prepared.plan,
                &injection_receipt_sha256,
                &destination,
            )
            .unwrap();
        assert_eq!(package.manifest.files.len(), 7);
        assert!(
            package
                .package_path
                .join("receipts/legacy-patch-receipt.json")
                .is_file()
        );
        assert!(
            package
                .package_path
                .join("receipts/firmware-injection-receipt.json")
                .is_file()
        );
        let mut forged_receipt = prepared.legacy_patch.clone().unwrap();
        let duplicate = forged_receipt.catalogs[0].applications[0].clone();
        forged_receipt.catalogs[0].applications.push(duplicate);
        let legacy_patched_sha256 = prepared
            .legacy_patched_firmware
            .as_ref()
            .unwrap()
            .sha256
            .clone();
        assert!(
            validate_legacy_patch_receipt(&profile, &legacy_patched_sha256, &forged_receipt,)
                .is_err()
        );

        let (_, legacy_patched) = store
            .load_artifact(&profile, ArtifactKind::LegacyPatchedFirmware)
            .unwrap();
        let reapply_error = legacy_authority()
            .unwrap()
            .apply(&legacy_patched, profile.legacy_patches.as_ref().unwrap())
            .unwrap_err();
        assert!(reapply_error.to_string().contains("matched 0 times"));

        let repeated =
            prepare_from_bytes(&store, &profile, prepared.plan, &synthetic_driver_ffs()).unwrap();
        assert_eq!(repeated.plan.revision, 6);
        assert!(repeated.injection.is_some());
        assert!(repeated.firmware_injection_receipt.is_some());
        assert_eq!(repeated.patched_firmware, prepared.patched_firmware);
        assert_eq!(repeated.legacy_patch, prepared.legacy_patch);
    }
}
