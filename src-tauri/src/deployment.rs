use std::{
    fs,
    path::{Path, PathBuf},
};

use nvstraps_deploy::{
    ArtifactKind, BoardPath, DeploymentPackageReceipt, DeploymentPlan, DeploymentStore,
    EvidenceKind, FirmwareFingerprint, FirmwareInstallRoute, LegacyPatchCatalogFile,
    LegacyPatchProfile, LegacyPatchRisk, MachineIdentity, MachineProfile, ProfileMatch,
    RecoveryCapability, Sha256Digest, StepEvidence, StepId, StepState, StoredArtifact,
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
    pub firmware_install: FirmwareInstallRoute,
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
    pub injection: Option<InjectionReceipt>,
}

pub(crate) struct ExactDeployment {
    pub store: DeploymentStore,
    pub profile: MachineProfile,
    pub plan: DeploymentPlan,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPatchReceipt {
    pub upstream_commit: String,
    pub original_firmware_sha256: String,
    pub patched_firmware_sha256: String,
    pub catalogs: Vec<LegacyCatalogPatchReceipt>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyCatalogPatchReceipt {
    pub catalog: LegacyPatchCatalogFile,
    pub source_sha256: String,
    pub applications: Vec<LegacyRulePatchReceipt>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyRulePatchReceipt {
    pub rule_id: String,
    pub expected_matches: usize,
    pub changes: Vec<LegacyPatchChangeReceipt>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPatchChangeReceipt {
    pub path: Vec<LegacyPatchPathReceipt>,
    pub offset: usize,
    pub before_hex: String,
    pub after_hex: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum LegacyPatchPathReceipt {
    FirmwareVolume {
        offset: usize,
    },
    FirmwareFile {
        offset: usize,
        file_guid_hex: String,
    },
    Section {
        offset: usize,
        content_offset: usize,
        section_type: u8,
    },
    LzmaPayload,
    UncompressedPayload,
    EfiCompressedPayload {
        compression: String,
    },
}

const LEGACY_PATCH_UPSTREAM_COMMIT: &str = "9c80fdb2cd3db94bdd19c58bd00d5ecf822f6430";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPatchCatalogView {
    pub catalog: LegacyPatchCatalogFile,
    pub upstream_commit: &'static str,
    pub source_sha256: String,
    pub rules: Vec<LegacyPatchRuleView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPatchRuleView {
    pub rule_id: String,
    pub description: Option<String>,
    pub section_type: u8,
    pub required_risks: Vec<LegacyPatchRisk>,
}

struct BuiltinLegacyCatalog {
    catalog: LegacyPatchCatalogFile,
    parsed: nvstraps_ffs::LegacyPatchCatalog,
}

#[tauri::command]
pub fn list_legacy_patch_catalogs() -> CommandResult<Vec<LegacyPatchCatalogView>> {
    builtin_legacy_catalogs()
        .map(|catalogs| {
            catalogs
                .iter()
                .map(|catalog| LegacyPatchCatalogView {
                    catalog: catalog.catalog,
                    upstream_commit: LEGACY_PATCH_UPSTREAM_COMMIT,
                    source_sha256: catalog.parsed.source_sha256.clone(),
                    rules: catalog
                        .parsed
                        .rules
                        .iter()
                        .map(|rule| LegacyPatchRuleView {
                            rule_id: rule.id.as_str().to_owned(),
                            description: rule.description.clone(),
                            section_type: rule.section_type,
                            required_risks: required_risks(
                                catalog.catalog,
                                rule.description.as_deref(),
                            ),
                        })
                        .collect(),
                })
                .collect()
        })
        .map_err(ApiError::from)
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
    exact
        .store
        .export_deployment_package(&exact.profile, &exact.plan, request.destination_root)
        .map_err(BackendError::from)
}

fn prepare_command(app: &AppHandle, profile_id: &str) -> BackendResult<FirmwarePreparation> {
    let exact = load_exact_deployment(app, profile_id, "firmware preparation")?;

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
    prepare_from_bytes(&exact.store, &exact.profile, exact.plan, &driver_ffs)
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
    let comparison = profile.compare(&current_identity, Some(&original_fingerprint));
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
    })
}

fn prepare_from_bytes(
    store: &DeploymentStore,
    profile: &MachineProfile,
    mut plan: DeploymentPlan,
    bundled_driver: &[u8],
) -> BackendResult<FirmwarePreparation> {
    validate_builtin_legacy_profile(profile)?;
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

    let (legacy_patched_firmware, legacy_patch_receipt, legacy_patch) =
        if profile.board_path == BoardPath::LegacyAbove4g {
            if step_is_completed(&plan, StepId::ApplyLegacyBoardPatches) {
                load_legacy_patch_artifacts(store, profile, &plan)?
            } else {
                require_active_step(&plan, StepId::ApplyLegacyBoardPatches)?;
                let original = read_preserved_original(store, profile)?;
                let (patched, receipt) = apply_builtin_legacy_patches(profile, &original)?;
                let patched_artifact = store
                    .preserve_artifact(profile, ArtifactKind::LegacyPatchedFirmware, &patched)
                    .map_err(BackendError::from)?;
                if receipt.patched_firmware_sha256 != patched_artifact.sha256.as_str() {
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
                plan.complete(
                    StepId::ApplyLegacyBoardPatches,
                    StepEvidence::new(
                        EvidenceKind::LegacyPatchReceipt,
                        receipt_artifact.sha256.to_string(),
                    )
                    .map_err(|error| BackendError::Deployment(error.to_string()))?,
                )
                .map_err(|error| BackendError::Deployment(error.to_string()))?;
                store
                    .save_plan(profile, &plan)
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
            legacy_patched_firmware,
            legacy_patch_receipt,
            legacy_patch,
            patched_firmware: Some(artifact),
            injection: None,
        });
    }

    require_active_step(&plan, StepId::VerifyPatchedArtifact)?;
    let (_, driver_bytes) = store
        .load_artifact(profile, ArtifactKind::RustDriverFfs)
        .map_err(BackendError::from)?;
    let base_firmware = if profile.board_path == BoardPath::LegacyAbove4g {
        store
            .load_artifact(profile, ArtifactKind::LegacyPatchedFirmware)
            .map_err(BackendError::from)?
            .1
    } else {
        read_preserved_original(store, profile)?
    };
    let (patched, injection) = nvstraps_ffs::inject_ffs(&base_firmware, &driver_bytes)
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
        legacy_patched_firmware,
        legacy_patch_receipt,
        legacy_patch,
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

fn read_preserved_original(
    store: &DeploymentStore,
    profile: &MachineProfile,
) -> BackendResult<Vec<u8>> {
    let original_path = store
        .original_firmware_path(&profile.profile_id)
        .map_err(BackendError::from)?;
    fs::read(&original_path).map_err(|error| {
        BackendError::Deployment(format!(
            "preserved original firmware could not be read: {error}"
        ))
    })
}

fn apply_builtin_legacy_patches(
    profile: &MachineProfile,
    original: &[u8],
) -> BackendResult<(Vec<u8>, LegacyPatchReceipt)> {
    let legacy = profile.legacy_patches.as_ref().ok_or_else(|| {
        BackendError::Deployment("legacy patch profile is missing after validation".into())
    })?;
    let catalogs = builtin_legacy_catalogs()?;
    let mut patched = original.to_vec();
    let mut catalog_receipts = Vec::new();

    for catalog in &catalogs {
        let selected: Vec<_> = catalog
            .parsed
            .rules
            .iter()
            .filter_map(|rule| {
                legacy
                    .selections
                    .iter()
                    .find(|selection| {
                        selection.catalog == catalog.catalog
                            && selection.rule_id == rule.id.as_str()
                    })
                    .map(|selection| nvstraps_ffs::LegacyPatchSelection {
                        rule_id: rule.id.clone(),
                        expected_matches: selection.expected_matches as usize,
                    })
            })
            .collect();
        if selected.is_empty() {
            continue;
        }
        let (next, report) =
            nvstraps_ffs::patch_legacy_firmware(&patched, &catalog.parsed, &selected).map_err(
                |error| {
                    BackendError::Deployment(format!(
                        "legacy firmware patching failed in catalog {:?}: {error}",
                        catalog.catalog
                    ))
                },
            )?;
        patched = next;
        catalog_receipts.push(LegacyCatalogPatchReceipt {
            catalog: catalog.catalog,
            source_sha256: report.catalog_sha256,
            applications: report
                .applications
                .into_iter()
                .map(|application| LegacyRulePatchReceipt {
                    rule_id: application.rule_id.as_str().to_owned(),
                    expected_matches: application.expected_matches,
                    changes: application
                        .changes
                        .into_iter()
                        .map(map_legacy_patch_change)
                        .collect(),
                })
                .collect(),
        });
    }

    if catalog_receipts.len() != legacy.catalogs.len() {
        return Err(BackendError::Deployment(
            "legacy patch execution did not cover every pinned catalog".into(),
        ));
    }
    let receipt = LegacyPatchReceipt {
        upstream_commit: legacy.upstream_commit.clone(),
        original_firmware_sha256: Sha256Digest::from_bytes(original).to_string(),
        patched_firmware_sha256: Sha256Digest::from_bytes(&patched).to_string(),
        catalogs: catalog_receipts,
    };
    validate_legacy_patch_receipt(profile, &receipt)?;
    Ok((patched, receipt))
}

fn map_legacy_patch_change(
    change: nvstraps_ffs::LegacyFirmwarePatchChange,
) -> LegacyPatchChangeReceipt {
    LegacyPatchChangeReceipt {
        path: change
            .path
            .into_iter()
            .map(|part| match part {
                nvstraps_ffs::LegacyFirmwarePatchPath::FirmwareVolume { offset } => {
                    LegacyPatchPathReceipt::FirmwareVolume { offset }
                }
                nvstraps_ffs::LegacyFirmwarePatchPath::FirmwareFile { offset, file_guid } => {
                    LegacyPatchPathReceipt::FirmwareFile {
                        offset,
                        file_guid_hex: hex_bytes(&file_guid),
                    }
                }
                nvstraps_ffs::LegacyFirmwarePatchPath::Section {
                    offset,
                    content_offset,
                    section_type,
                } => LegacyPatchPathReceipt::Section {
                    offset,
                    content_offset,
                    section_type,
                },
                nvstraps_ffs::LegacyFirmwarePatchPath::LzmaPayload => {
                    LegacyPatchPathReceipt::LzmaPayload
                }
                nvstraps_ffs::LegacyFirmwarePatchPath::UncompressedPayload => {
                    LegacyPatchPathReceipt::UncompressedPayload
                }
                nvstraps_ffs::LegacyFirmwarePatchPath::EfiCompressedPayload { compression } => {
                    LegacyPatchPathReceipt::EfiCompressedPayload {
                        compression: match compression {
                            nvstraps_ffs::EfiCompression::EfiStandard => "efiStandard",
                            nvstraps_ffs::EfiCompression::Tiano => "tiano",
                        }
                        .to_owned(),
                    }
                }
            })
            .collect(),
        offset: change.change.offset,
        before_hex: hex_bytes(&change.change.before),
        after_hex: hex_bytes(&change.change.after),
    }
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
    require_step_value(
        plan,
        StepId::ApplyLegacyBoardPatches,
        receipt_artifact.sha256.as_str(),
    )?;
    let receipt: LegacyPatchReceipt = serde_json::from_slice(&receipt_bytes).map_err(|error| {
        BackendError::Deployment(format!(
            "persisted legacy patch receipt is invalid: {error}"
        ))
    })?;
    validate_legacy_patch_receipt(profile, &receipt)?;
    if receipt.patched_firmware_sha256 != patched_artifact.sha256.as_str() {
        return Err(BackendError::Deployment(
            "persisted legacy patch artifact does not match its receipt".into(),
        ));
    }
    Ok((
        Some(patched_artifact),
        Some(receipt_artifact),
        Some(receipt),
    ))
}

fn validate_legacy_patch_receipt(
    profile: &MachineProfile,
    receipt: &LegacyPatchReceipt,
) -> BackendResult<()> {
    let legacy = profile.legacy_patches.as_ref().ok_or_else(|| {
        BackendError::Deployment("legacy patch receipt belongs to a non-legacy profile".into())
    })?;
    if receipt.upstream_commit != legacy.upstream_commit
        || receipt.original_firmware_sha256 != profile.original_firmware.sha256.as_str()
        || receipt.catalogs.len() != legacy.catalogs.len()
    {
        return Err(BackendError::Deployment(
            "legacy patch receipt does not match its machine profile".into(),
        ));
    }
    let mut recorded_rules = Vec::new();
    for catalog in &receipt.catalogs {
        let Some(pin) = legacy
            .catalogs
            .iter()
            .find(|pin| pin.catalog == catalog.catalog)
        else {
            return Err(BackendError::Deployment(
                "legacy patch receipt contains an unpinned catalog".into(),
            ));
        };
        if pin.source_sha256.as_str() != catalog.source_sha256 {
            return Err(BackendError::Deployment(
                "legacy patch receipt catalog hash does not match its profile".into(),
            ));
        }
        for application in &catalog.applications {
            let Some(selection) = legacy.selections.iter().find(|selection| {
                selection.catalog == catalog.catalog && selection.rule_id == application.rule_id
            }) else {
                return Err(BackendError::Deployment(
                    "legacy patch receipt contains an unselected rule".into(),
                ));
            };
            if usize::from(selection.expected_matches) != application.expected_matches
                || application.changes.len() != application.expected_matches
            {
                return Err(BackendError::Deployment(
                    "legacy patch receipt has an unexpected match count".into(),
                ));
            }
            recorded_rules.push((
                catalog.catalog,
                application.rule_id.as_str(),
                application.expected_matches,
            ));
        }
    }
    recorded_rules.sort_unstable();
    let mut expected_rules: Vec<_> = legacy
        .selections
        .iter()
        .map(|selection| {
            (
                selection.catalog,
                selection.rule_id.as_str(),
                usize::from(selection.expected_matches),
            )
        })
        .collect();
    expected_rules.sort_unstable();
    if recorded_rules != expected_rules {
        return Err(BackendError::Deployment(
            "legacy patch receipt does not cover every selected rule".into(),
        ));
    }
    Ok(())
}

fn hex_bytes(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("writing to a string cannot fail");
    }
    output
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
    let profile = MachineProfile::create_with_legacy(
        request.display_name,
        request.board_path,
        identity,
        firmware,
        request.recovery,
        request.firmware_install,
        request.legacy_patches,
    )
    .map_err(BackendError::from)?;
    validate_builtin_legacy_profile(&profile)?;
    Ok(profile)
}

fn builtin_legacy_catalogs() -> BackendResult<Vec<BuiltinLegacyCatalog>> {
    let sources = [
        (
            LegacyPatchCatalogFile::General,
            include_str!("../../UEFIPatch/patches.txt"),
        ),
        (
            LegacyPatchCatalogFile::HaswellAbove4g,
            include_str!("../../UEFIPatch/HswAbove4G.txt"),
        ),
        (
            LegacyPatchCatalogFile::IvyBridgeUsb3,
            include_str!("../../UEFIPatch/IvyUSB3.txt"),
        ),
        (
            LegacyPatchCatalogFile::HaswellUsb3,
            include_str!("../../UEFIPatch/HswUSB3.txt"),
        ),
        (
            LegacyPatchCatalogFile::BroadwellUsb3,
            include_str!("../../UEFIPatch/BdwUSB3.txt"),
        ),
    ];
    sources
        .into_iter()
        .map(|(catalog, source)| {
            nvstraps_ffs::LegacyPatchCatalog::parse(source)
                .map(|parsed| BuiltinLegacyCatalog { catalog, parsed })
                .map_err(|error| {
                    BackendError::Deployment(format!(
                        "built-in legacy patch catalog {catalog:?} is invalid: {error}"
                    ))
                })
        })
        .collect()
}

fn validate_builtin_legacy_profile(profile: &MachineProfile) -> BackendResult<()> {
    let Some(legacy) = profile.legacy_patches.as_ref() else {
        return Ok(());
    };
    if legacy.upstream_commit != LEGACY_PATCH_UPSTREAM_COMMIT {
        return Err(BackendError::Deployment(format!(
            "legacy patch bundle pins unsupported upstream commit {}; expected {LEGACY_PATCH_UPSTREAM_COMMIT}",
            legacy.upstream_commit
        )));
    }
    let catalogs = builtin_legacy_catalogs()?;
    for pin in &legacy.catalogs {
        let catalog = catalogs
            .iter()
            .find(|catalog| catalog.catalog == pin.catalog)
            .ok_or_else(|| {
                BackendError::Deployment(format!(
                    "legacy patch catalog {:?} is not built into this application",
                    pin.catalog
                ))
            })?;
        let expected = Sha256Digest::parse(catalog.parsed.source_sha256.clone())
            .map_err(BackendError::from)?;
        if pin.source_sha256 != expected {
            return Err(BackendError::Deployment(format!(
                "legacy patch catalog {:?} digest does not match the built-in source",
                pin.catalog
            )));
        }
    }
    for selection in &legacy.selections {
        let catalog = catalogs
            .iter()
            .find(|catalog| catalog.catalog == selection.catalog)
            .expect("the deployment domain requires every selected catalog to be pinned");
        let rule = catalog
            .parsed
            .rules
            .iter()
            .find(|rule| rule.id.as_str() == selection.rule_id)
            .ok_or_else(|| {
                BackendError::Deployment(format!(
                    "legacy patch rule {} is not in built-in catalog {:?}",
                    selection.rule_id, selection.catalog
                ))
            })?;
        let risks = required_risks(selection.catalog, rule.description.as_deref());
        if selection.required_risks != risks {
            return Err(BackendError::Deployment(format!(
                "legacy patch rule {} has an incorrect risk declaration",
                selection.rule_id
            )));
        }
    }
    Ok(())
}

fn required_risks(
    catalog: LegacyPatchCatalogFile,
    description: Option<&str>,
) -> Vec<LegacyPatchRisk> {
    let description = description.unwrap_or_default();
    let mut risks = Vec::new();
    if description.contains("MAY REQUIRE DSDT MODIFICATION")
        || description.eq_ignore_ascii_case("replace old patch")
    {
        risks.push(LegacyPatchRisk::DsdtModification);
    }
    if description.contains("NVRAM whitelist") {
        risks.push(LegacyPatchRisk::NvramWhitelist);
    }
    if matches!(
        catalog,
        LegacyPatchCatalogFile::IvyBridgeUsb3
            | LegacyPatchCatalogFile::HaswellUsb3
            | LegacyPatchCatalogFile::BroadwellUsb3
    ) {
        risks.push(LegacyPatchRisk::UsbControllerBlacklist);
    }
    risks
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
        FirmwareInstallMethod, GpuFingerprint, LegacyPatchCatalogFile, LegacyPatchCatalogPin,
        LegacyPatchSelection, PciLocation, RecoveryMethod, Sha256Digest,
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
        let catalogs = builtin_legacy_catalogs().unwrap();
        let catalog = catalogs
            .iter()
            .find(|catalog| catalog.catalog == LegacyPatchCatalogFile::General)
            .unwrap();
        let rule = &catalog.parsed.rules[0];
        LegacyPatchProfile::create(
            LEGACY_PATCH_UPSTREAM_COMMIT,
            vec![LegacyPatchCatalogPin {
                catalog: LegacyPatchCatalogFile::General,
                source_sha256: Sha256Digest::parse(catalog.parsed.source_sha256.clone()).unwrap(),
            }],
            vec![LegacyPatchSelection {
                catalog: LegacyPatchCatalogFile::General,
                rule_id: rule.id.as_str().to_owned(),
                expected_matches: 1,
                required_risks: required_risks(
                    LegacyPatchCatalogFile::General,
                    rule.description.as_deref(),
                ),
            }],
            vec![],
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

    fn synthetic_legacy_firmware() -> Vec<u8> {
        let catalogs = builtin_legacy_catalogs().unwrap();
        let catalog = catalogs
            .iter()
            .find(|catalog| catalog.catalog == LegacyPatchCatalogFile::General)
            .unwrap();
        let rule = &catalog.parsed.rules[0];
        assert!(!rule.find_pattern().contains('.'));
        let pattern = decode_hex(rule.find_pattern());

        let mut section = vec![0_u8; 4];
        let section_size = section.len() + pattern.len();
        section[..3].copy_from_slice(&(section_size as u32).to_le_bytes()[..3]);
        section[3] = rule.section_type;
        section.extend_from_slice(&pattern);

        let file_size = 24 + section.len();
        let mut file = vec![0_u8; 24];
        file[..16].copy_from_slice(&rule.file_guid);
        file[18] = 0x06;
        file[19] = 0x40;
        file[20..23].copy_from_slice(&(file_size as u32).to_le_bytes()[..3]);
        file[16] = checksum8(&file);
        file[17] = checksum8(&section);
        file[23] = !0x07;
        file.extend_from_slice(&section);

        let mut firmware = synthetic_firmware();
        firmware[96..96 + file.len()].copy_from_slice(&file);
        firmware
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    fn checksum8(bytes: &[u8]) -> u8 {
        0_u8.wrapping_sub(bytes.iter().fold(0_u8, |sum, byte| sum.wrapping_add(*byte)))
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
            firmware_install: firmware_install(),
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
    fn built_in_catalogs_are_pinned_and_profile_rules_cannot_be_forged() {
        let views = list_legacy_patch_catalogs().unwrap();
        assert_eq!(views.len(), 5);
        assert!(views.iter().all(|view| {
            view.upstream_commit == LEGACY_PATCH_UPSTREAM_COMMIT
                && view.source_sha256.len() == 64
                && !view.rules.is_empty()
        }));

        let mut forged = valid_builtin_legacy_profile();
        forged.selections[0].rule_id = "00".repeat(32);
        let request = CreateProfileRequest {
            display_name: "legacy".into(),
            board_path: BoardPath::LegacyAbove4g,
            firmware_path: "ignored".into(),
            recovery: RecoveryCapability {
                method: RecoveryMethod::ExternalSpiProgrammer,
                tested_or_documented: true,
                note: "tested clip and backup".into(),
            },
            firmware_install: firmware_install(),
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
        let package = store
            .export_deployment_package(&profile, &prepared.plan, &destination)
            .unwrap();
        assert_eq!(package.manifest.files.len(), 6);
        assert!(
            package
                .package_path
                .join("receipts/legacy-patch-receipt.json")
                .is_file()
        );
        let mut forged_receipt = prepared.legacy_patch.clone().unwrap();
        let duplicate = forged_receipt.catalogs[0].applications[0].clone();
        forged_receipt.catalogs[0].applications.push(duplicate);
        assert!(validate_legacy_patch_receipt(&profile, &forged_receipt).is_err());

        let (_, legacy_patched) = store
            .load_artifact(&profile, ArtifactKind::LegacyPatchedFirmware)
            .unwrap();
        let catalogs = builtin_legacy_catalogs().unwrap();
        let catalog = catalogs
            .iter()
            .find(|catalog| catalog.catalog == LegacyPatchCatalogFile::General)
            .unwrap();
        let rule = &catalog.parsed.rules[0];
        assert!(matches!(
            nvstraps_ffs::patch_legacy_firmware(
                &legacy_patched,
                &catalog.parsed,
                &[nvstraps_ffs::LegacyPatchSelection {
                    rule_id: rule.id.clone(),
                    expected_matches: 1,
                }]
            ),
            Err(nvstraps_ffs::LegacyFirmwarePatchError::InvalidRule(
                nvstraps_ffs::LegacyPatchError::MatchCount { actual: 0, .. }
            ))
        ));

        let repeated =
            prepare_from_bytes(&store, &profile, prepared.plan, &synthetic_driver_ffs()).unwrap();
        assert_eq!(repeated.plan.revision, 6);
        assert!(repeated.injection.is_none());
        assert_eq!(repeated.patched_firmware, prepared.patched_firmware);
        assert_eq!(repeated.legacy_patch, prepared.legacy_patch);
    }
}
