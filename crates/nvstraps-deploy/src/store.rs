use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;

use crate::{
    BoardPath, DeploymentPlan, DeploymentWorkflow, FirmwareFingerprint, FirmwareInstallRoute,
    MachineIdentity, MachineProfile, PlanError, ProfileError, RecoveryCapability, Sha256Digest,
    StepId,
};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub struct DeploymentStore {
    root: PathBuf,
}

#[derive(Clone, Debug)]
pub struct ProvisionedDeployment {
    pub profile: MachineProfile,
    pub plan: DeploymentPlan,
    pub original_firmware_path: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactKind {
    RustDriverFfs,
    LegacyPatchedFirmware,
    PatchedFirmware,
    LegacyPatchReceipt,
    FirmwareInjectionReceipt,
}

impl ArtifactKind {
    fn file_name(self) -> &'static str {
        match self {
            Self::RustDriverFfs => "rust-driver.ffs",
            Self::LegacyPatchedFirmware => "legacy-patched-firmware.bin",
            Self::PatchedFirmware => "patched-firmware.bin",
            Self::LegacyPatchReceipt => "legacy-patch-receipt.json",
            Self::FirmwareInjectionReceipt => "firmware-injection-receipt.json",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredArtifact {
    pub kind: ArtifactKind,
    pub path: PathBuf,
    pub byte_length: u64,
    pub sha256: Sha256Digest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PackageFilePurpose {
    PatchedFirmware,
    OriginalRecoveryFirmware,
    MachineProfile,
    DeploymentPlan,
    LegacyPatchReceipt,
    FirmwareInjectionReceipt,
    OperatorInstructions,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentPackageFile {
    pub relative_path: String,
    pub purpose: PackageFilePurpose,
    pub byte_length: u64,
    pub sha256: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentPackageManifest {
    pub schema_version: u8,
    pub profile_id: String,
    pub board_path: BoardPath,
    pub machine: MachineIdentity,
    pub original_firmware: FirmwareFingerprint,
    pub patched_firmware: FirmwareFingerprint,
    pub recovery: RecoveryCapability,
    pub firmware_install: FirmwareInstallRoute,
    pub plan_revision: u32,
    pub files: Vec<DeploymentPackageFile>,
    pub manual_gates: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentPackageReceipt {
    pub package_path: PathBuf,
    pub manifest: DeploymentPackageManifest,
    pub manifest_sha256: Sha256Digest,
    pub checksums_sha256: Sha256Digest,
}

impl DeploymentStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn provision_profile(
        &self,
        profile: &MachineProfile,
        source_firmware: impl AsRef<Path>,
    ) -> Result<ProvisionedDeployment, StoreError> {
        profile.validate()?;
        let source_firmware = source_firmware.as_ref();
        let inspected = crate::FirmwareFingerprint::inspect(source_firmware)?;
        if inspected.byte_length != profile.original_firmware.byte_length
            || inspected.sha256 != profile.original_firmware.sha256
        {
            return Err(StoreError::FirmwareChanged);
        }

        self.save_profile(profile)?;
        let original_firmware_path = self.original_firmware_path(&profile.profile_id)?;
        copy_new_verified(
            source_firmware,
            &original_firmware_path,
            &profile.original_firmware.sha256,
        )?;

        let plan = match self.load_plan(profile) {
            Ok(plan) => plan,
            Err(StoreError::MissingPlan(_)) => {
                let plan = DeploymentPlan::for_profile(profile)?;
                self.save_plan(profile, &plan)?;
                plan
            }
            Err(error) => return Err(error),
        };
        let mut workflow = DeploymentWorkflow::from_plan(self, profile, plan)?;
        for (step, value) in [
            (StepId::VerifyProfile, profile.profile_id.as_str()),
            (
                StepId::ConfirmRecovery,
                profile.recovery.method.evidence_value(),
            ),
            (
                StepId::PreserveOriginalFirmware,
                profile.original_firmware.sha256.as_str(),
            ),
        ] {
            if !workflow.plan().is_step_completed(step) {
                workflow.record_step(step, value)?;
            }
        }
        let plan = workflow.into_plan();

        Ok(ProvisionedDeployment {
            profile: profile.clone(),
            plan,
            original_firmware_path,
        })
    }

    pub fn save_profile(&self, profile: &MachineProfile) -> Result<(), StoreError> {
        profile.validate()?;
        let path = self.profile_path(&profile.profile_id)?;
        write_json_once(&path, profile)
    }

    pub fn load_profile(&self, profile_id: &str) -> Result<MachineProfile, StoreError> {
        let path = self.profile_path(profile_id)?;
        let profile: MachineProfile = read_json(&path)?;
        profile.validate()?;
        if profile.profile_id != profile_id {
            return Err(StoreError::ProfilePathMismatch);
        }
        Ok(profile)
    }

    pub fn list_profiles(&self) -> Result<Vec<MachineProfile>, StoreError> {
        let directory = self.root.join("profiles");
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut profiles = Vec::new();
        for entry in fs::read_dir(&directory).map_err(|source| StoreError::Io {
            path: directory.clone(),
            source,
        })? {
            let entry = entry.map_err(|source| StoreError::Io {
                path: directory.clone(),
                source,
            })?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let profile: MachineProfile = read_json(&path)?;
            profile.validate()?;
            if path.file_stem().and_then(|value| value.to_str())
                != Some(profile.profile_id.as_str())
            {
                return Err(StoreError::ProfilePathMismatch);
            }
            profiles.push(profile);
        }
        profiles.sort_by(|left, right| left.profile_id.cmp(&right.profile_id));
        Ok(profiles)
    }

    pub fn save_plan(
        &self,
        profile: &MachineProfile,
        plan: &DeploymentPlan,
    ) -> Result<(), StoreError> {
        plan.validate_for(profile)?;
        let path = self.plan_path(&profile.profile_id, plan.revision)?;
        write_json_once(&path, plan)
    }

    pub fn load_plan(&self, profile: &MachineProfile) -> Result<DeploymentPlan, StoreError> {
        profile.validate()?;
        let directory = self.plan_directory(&profile.profile_id)?;
        if !directory.exists() {
            return Err(StoreError::MissingPlan(profile.profile_id.clone()));
        }
        let mut latest: Option<DeploymentPlan> = None;
        for entry in fs::read_dir(&directory).map_err(|source| StoreError::Io {
            path: directory.clone(),
            source,
        })? {
            let entry = entry.map_err(|source| StoreError::Io {
                path: directory.clone(),
                source,
            })?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let plan: DeploymentPlan = read_json(&path)?;
            plan.validate_for(profile)?;
            let path_revision = path
                .file_stem()
                .and_then(|value| value.to_str())
                .and_then(|value| value.parse::<u32>().ok())
                .ok_or_else(|| StoreError::InvalidPlanPath(path.clone()))?;
            if path_revision != plan.revision {
                return Err(StoreError::InvalidPlanPath(path));
            }
            if latest
                .as_ref()
                .is_none_or(|current| plan.revision > current.revision)
            {
                latest = Some(plan);
            }
        }
        latest.ok_or_else(|| StoreError::MissingPlan(profile.profile_id.clone()))
    }

    pub fn original_firmware_path(&self, profile_id: &str) -> Result<PathBuf, StoreError> {
        validate_profile_id(profile_id)?;
        Ok(self
            .root
            .join("artifacts")
            .join(profile_id)
            .join("original-firmware.bin"))
    }

    pub fn preserve_artifact(
        &self,
        profile: &MachineProfile,
        kind: ArtifactKind,
        bytes: &[u8],
    ) -> Result<StoredArtifact, StoreError> {
        profile.validate()?;
        if bytes.is_empty() {
            return Err(StoreError::EmptyArtifact);
        }
        let path = self.artifact_path(&profile.profile_id, kind)?;
        write_bytes_once(&path, bytes)?;
        let persisted = fs::read(&path).map_err(|source| StoreError::Io {
            path: path.clone(),
            source,
        })?;
        if persisted != bytes {
            return Err(StoreError::ImmutableConflict(path));
        }
        Ok(StoredArtifact {
            kind,
            path,
            byte_length: persisted.len() as u64,
            sha256: Sha256Digest::from_bytes(&persisted),
        })
    }

    pub fn load_artifact(
        &self,
        profile: &MachineProfile,
        kind: ArtifactKind,
    ) -> Result<(StoredArtifact, Vec<u8>), StoreError> {
        profile.validate()?;
        let path = self.artifact_path(&profile.profile_id, kind)?;
        let bytes = fs::read(&path).map_err(|source| StoreError::Io {
            path: path.clone(),
            source,
        })?;
        if bytes.is_empty() {
            return Err(StoreError::EmptyArtifact);
        }
        let artifact = StoredArtifact {
            kind,
            path,
            byte_length: bytes.len() as u64,
            sha256: Sha256Digest::from_bytes(&bytes),
        };
        Ok((artifact, bytes))
    }

    pub fn export_deployment_package(
        &self,
        profile: &MachineProfile,
        plan: &DeploymentPlan,
        expected_injection_receipt_sha256: &Sha256Digest,
        destination_root: impl AsRef<Path>,
    ) -> Result<DeploymentPackageReceipt, StoreError> {
        profile.validate()?;
        plan.validate_for(profile)?;
        let firmware_install = profile
            .firmware_install
            .clone()
            .ok_or(StoreError::PackageRequiresPinnedInstallRoute)?;
        let (patched_artifact, patched_bytes) =
            self.load_artifact(profile, ArtifactKind::PatchedFirmware)?;
        if plan
            .require_completed_value(
                StepId::VerifyPatchedArtifact,
                patched_artifact.sha256.as_str(),
            )
            .is_err()
        {
            return Err(StoreError::PatchedArtifactNotVerified);
        }

        let original_path = self.original_firmware_path(&profile.profile_id)?;
        let original_bytes = fs::read(&original_path).map_err(|source| StoreError::Io {
            path: original_path.clone(),
            source,
        })?;
        let original_fingerprint = FirmwareFingerprint::inspect(&original_path)?;
        if original_fingerprint.byte_length != profile.original_firmware.byte_length
            || original_fingerprint.sha256 != profile.original_firmware.sha256
        {
            return Err(StoreError::FirmwareChanged);
        }

        let legacy_receipt = if profile.board_path == BoardPath::LegacyAbove4g {
            let receipt = self
                .load_artifact(profile, ArtifactKind::LegacyPatchReceipt)
                .map_err(|error| match error {
                    StoreError::Io { source, .. } if source.kind() == io::ErrorKind::NotFound => {
                        StoreError::MissingLegacyPatchReceipt
                    }
                    other => other,
                })?;
            if plan
                .require_completed_value(StepId::ApplyLegacyBoardPatches, receipt.0.sha256.as_str())
                .is_err()
            {
                return Err(StoreError::LegacyPatchReceiptNotVerified);
            }
            Some(receipt)
        } else {
            None
        };
        let firmware_injection_receipt = self
            .load_artifact(profile, ArtifactKind::FirmwareInjectionReceipt)
            .map_err(|error| match error {
                StoreError::Io { source, .. } if source.kind() == io::ErrorKind::NotFound => {
                    StoreError::MissingFirmwareInjectionReceipt
                }
                other => other,
            })?;
        if firmware_injection_receipt.0.sha256 != *expected_injection_receipt_sha256 {
            return Err(StoreError::FirmwareInjectionReceiptChanged);
        }

        let destination_root = destination_root.as_ref();
        if !destination_root.is_absolute() {
            return Err(StoreError::PackageDestinationMustBeAbsolute);
        }
        let destination_root =
            fs::canonicalize(destination_root).map_err(|source| StoreError::Io {
                path: destination_root.to_owned(),
                source,
            })?;
        if !destination_root.is_dir() {
            return Err(StoreError::PackageDestinationNotDirectory(destination_root));
        }
        let profile_suffix = profile
            .profile_id
            .strip_prefix("nvstraps-")
            .expect("validated profile IDs always have the nvstraps prefix");
        let package_path = destination_root.join(format!("NvStrapsReBar-{profile_suffix}"));
        if package_path.exists() {
            return Err(StoreError::PackageAlreadyExists(package_path));
        }
        let staging_path = destination_root.join(format!(
            ".NvStrapsReBar-{}-{}-{}.tmp",
            profile_suffix,
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&staging_path).map_err(|source| StoreError::Io {
            path: staging_path.clone(),
            source,
        })?;

        let result = (|| {
            let mut files = Vec::new();
            files.push(write_package_file(
                &staging_path,
                &format!("flash/{}", firmware_install.artifact_file_name),
                PackageFilePurpose::PatchedFirmware,
                &patched_bytes,
            )?);
            files.push(write_package_file(
                &staging_path,
                "recovery/original-firmware.bin",
                PackageFilePurpose::OriginalRecoveryFirmware,
                &original_bytes,
            )?);

            let profile_relative = "receipts/machine-profile.json";
            let profile_bytes = json_bytes(&staging_path.join(profile_relative), profile)?;
            files.push(write_package_file(
                &staging_path,
                profile_relative,
                PackageFilePurpose::MachineProfile,
                &profile_bytes,
            )?);
            let plan_relative = "receipts/deployment-plan.json";
            let plan_bytes = json_bytes(&staging_path.join(plan_relative), plan)?;
            files.push(write_package_file(
                &staging_path,
                plan_relative,
                PackageFilePurpose::DeploymentPlan,
                &plan_bytes,
            )?);
            files.push(write_package_file(
                &staging_path,
                "receipts/firmware-injection-receipt.json",
                PackageFilePurpose::FirmwareInjectionReceipt,
                &firmware_injection_receipt.1,
            )?);
            if let Some((_, receipt_bytes)) = legacy_receipt.as_ref() {
                files.push(write_package_file(
                    &staging_path,
                    "receipts/legacy-patch-receipt.json",
                    PackageFilePurpose::LegacyPatchReceipt,
                    receipt_bytes,
                )?);
            }

            let manual_gates = manual_gates(profile);
            let instructions = operator_instructions(profile, &firmware_install, &manual_gates);
            files.push(write_package_file(
                &staging_path,
                "DEPLOYMENT.txt",
                PackageFilePurpose::OperatorInstructions,
                instructions.as_bytes(),
            )?);
            files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

            let manifest = DeploymentPackageManifest {
                schema_version: 1,
                profile_id: profile.profile_id.clone(),
                board_path: profile.board_path,
                machine: profile.identity.clone(),
                original_firmware: profile.original_firmware.clone(),
                patched_firmware: FirmwareFingerprint {
                    file_name: firmware_install.artifact_file_name.clone(),
                    byte_length: patched_artifact.byte_length,
                    sha256: patched_artifact.sha256.clone(),
                },
                recovery: profile.recovery.clone(),
                firmware_install,
                plan_revision: plan.revision,
                files,
                manual_gates,
            };
            let manifest_relative = "deployment-manifest.json";
            let manifest_bytes = json_bytes(&staging_path.join(manifest_relative), &manifest)?;
            write_bytes_once(&staging_path.join(manifest_relative), &manifest_bytes)?;
            let manifest_sha256 = Sha256Digest::from_bytes(&manifest_bytes);

            let mut checksums = String::new();
            for file in &manifest.files {
                use std::fmt::Write as _;
                writeln!(checksums, "{} *{}", file.sha256, file.relative_path)
                    .expect("writing checksums to a string cannot fail");
            }
            use std::fmt::Write as _;
            writeln!(checksums, "{} *{manifest_relative}", manifest_sha256)
                .expect("writing checksums to a string cannot fail");
            let checksums_bytes = checksums.into_bytes();
            write_bytes_once(&staging_path.join("SHA256SUMS.txt"), &checksums_bytes)?;
            let checksums_sha256 = Sha256Digest::from_bytes(&checksums_bytes);

            verify_package_files(
                &staging_path,
                &manifest,
                &manifest_sha256,
                &checksums_sha256,
            )?;
            fs::rename(&staging_path, &package_path).map_err(|source| StoreError::Io {
                path: package_path.clone(),
                source,
            })?;
            Ok(DeploymentPackageReceipt {
                package_path: package_path.clone(),
                manifest,
                manifest_sha256,
                checksums_sha256,
            })
        })();

        if result.is_err() && staging_path.exists() {
            let _ = fs::remove_dir_all(&staging_path);
        }
        result
    }

    fn profile_path(&self, profile_id: &str) -> Result<PathBuf, StoreError> {
        validate_profile_id(profile_id)?;
        Ok(self
            .root
            .join("profiles")
            .join(format!("{profile_id}.json")))
    }

    fn artifact_path(&self, profile_id: &str, kind: ArtifactKind) -> Result<PathBuf, StoreError> {
        validate_profile_id(profile_id)?;
        Ok(self
            .root
            .join("artifacts")
            .join(profile_id)
            .join(kind.file_name()))
    }

    fn plan_directory(&self, profile_id: &str) -> Result<PathBuf, StoreError> {
        validate_profile_id(profile_id)?;
        Ok(self.root.join("plans").join(profile_id))
    }

    fn plan_path(&self, profile_id: &str, revision: u32) -> Result<PathBuf, StoreError> {
        Ok(self
            .plan_directory(profile_id)?
            .join(format!("{revision:010}.json")))
    }
}

fn write_package_file(
    root: &Path,
    relative_path: &str,
    purpose: PackageFilePurpose,
    bytes: &[u8],
) -> Result<DeploymentPackageFile, StoreError> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(StoreError::InvalidPackageRelativePath(
            relative_path.to_owned(),
        ));
    }
    let path = root.join(relative);
    write_bytes_once(&path, bytes)?;
    let persisted = fs::read(&path).map_err(|source| StoreError::Io {
        path: path.clone(),
        source,
    })?;
    if persisted != bytes {
        return Err(StoreError::PackageVerificationFailed(relative_path.into()));
    }
    Ok(DeploymentPackageFile {
        relative_path: relative_path.to_owned(),
        purpose,
        byte_length: persisted.len() as u64,
        sha256: Sha256Digest::from_bytes(&persisted),
    })
}

fn json_bytes(path: &Path, value: &impl Serialize) -> Result<Vec<u8>, StoreError> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|source| StoreError::Json {
        path: path.to_owned(),
        source,
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn manual_gates(profile: &MachineProfile) -> Vec<String> {
    vec![
        "Confirm that the live board, BIOS, GPU topology, and source image still match the machine profile before flashing.".into(),
        "Use only the pinned vendor install route; never bypass capsule signatures or vendor integrity checks.".into(),
        format!(
            "Keep the documented recovery route ready before flashing: {}",
            profile.recovery.note
        ),
        match profile.board_path {
            BoardPath::NativeResizableBar => {
                "In firmware setup, enable native Resizable BAR and Above 4G decoding, and disable CSM.".into()
            }
            BoardPath::LegacyAbove4g => {
                "In firmware setup, enable Above 4G decoding and disable CSM.".into()
            }
        },
        "Do not interrupt power. Treat the vendor flash completion and the first successful reboot as physical confirmations.".into(),
    ]
}

fn operator_instructions(
    profile: &MachineProfile,
    firmware_install: &FirmwareInstallRoute,
    manual_gates: &[String],
) -> String {
    let mut output = format!(
        "NvStrapsReBar verified deployment package\n\nProfile: {}\nBoard: {} {}\nBIOS: {} {} ({})\nPatched image: flash/{}\nInstall method: {:?}\nOfficial instructions: {}\nInstall note: {}\nRecovery method: {:?}\nRecovery image: recovery/original-firmware.bin\nRecovery note: {}\n\nVerify every file with SHA256SUMS.txt before use.\n\nManual gates:\n",
        profile.profile_id,
        profile.identity.board_manufacturer,
        profile.identity.board_product,
        profile.identity.bios_vendor,
        profile.identity.bios_version,
        profile.identity.bios_release_date,
        firmware_install.artifact_file_name,
        firmware_install.method,
        firmware_install.official_instructions_url,
        firmware_install.note,
        profile.recovery.method,
        profile.recovery.note,
    );
    for (index, gate) in manual_gates.iter().enumerate() {
        use std::fmt::Write as _;
        writeln!(output, "{}. {gate}", index + 1)
            .expect("writing instructions to a string cannot fail");
    }
    output
}

fn verify_package_files(
    root: &Path,
    manifest: &DeploymentPackageManifest,
    manifest_sha256: &Sha256Digest,
    checksums_sha256: &Sha256Digest,
) -> Result<(), StoreError> {
    for file in &manifest.files {
        let path = root.join(&file.relative_path);
        let bytes = fs::read(&path).map_err(|source| StoreError::Io {
            path: path.clone(),
            source,
        })?;
        if bytes.len() as u64 != file.byte_length || Sha256Digest::from_bytes(&bytes) != file.sha256
        {
            return Err(StoreError::PackageVerificationFailed(
                file.relative_path.clone(),
            ));
        }
    }
    for (relative_path, expected) in [
        ("deployment-manifest.json", manifest_sha256),
        ("SHA256SUMS.txt", checksums_sha256),
    ] {
        let path = root.join(relative_path);
        let bytes = fs::read(&path).map_err(|source| StoreError::Io {
            path: path.clone(),
            source,
        })?;
        if Sha256Digest::from_bytes(&bytes) != *expected {
            return Err(StoreError::PackageVerificationFailed(relative_path.into()));
        }
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error(transparent)]
    InvalidProfile(#[from] ProfileError),
    #[error(transparent)]
    InvalidPlan(#[from] PlanError),
    #[error("deployment profile ID is malformed")]
    InvalidProfileId,
    #[error("persisted profile ID does not match its path")]
    ProfilePathMismatch,
    #[error("persisted deployment plan revision does not match its path: {0}")]
    InvalidPlanPath(PathBuf),
    #[error("profile {0} has no deployment plan")]
    MissingPlan(String),
    #[error("the source firmware changed after it was fingerprinted")]
    FirmwareChanged,
    #[error("deployment artifacts must not be empty")]
    EmptyArtifact,
    #[error("persisted content conflicts with an immutable deployment record: {0}")]
    ImmutableConflict(PathBuf),
    #[error("deployment packages require a current profile with a pinned install route")]
    PackageRequiresPinnedInstallRoute,
    #[error("the patched firmware artifact has not been verified by the deployment plan")]
    PatchedArtifactNotVerified,
    #[error("the firmware injection receipt required by this profile is missing")]
    MissingFirmwareInjectionReceipt,
    #[error("the firmware injection receipt changed after backend validation")]
    FirmwareInjectionReceiptChanged,
    #[error("the legacy patch receipt required by this profile is missing")]
    MissingLegacyPatchReceipt,
    #[error("the legacy patch receipt does not match the deployment plan evidence")]
    LegacyPatchReceiptNotVerified,
    #[error("the deployment package destination must be an absolute path")]
    PackageDestinationMustBeAbsolute,
    #[error("the deployment package destination is not a directory: {0}")]
    PackageDestinationNotDirectory(PathBuf),
    #[error("a deployment package already exists and will not be overwritten: {0}")]
    PackageAlreadyExists(PathBuf),
    #[error("deployment package relative path is unsafe: {0}")]
    InvalidPackageRelativePath(String),
    #[error("deployment package file failed read-back verification: {0}")]
    PackageVerificationFailed(String),
    #[error("failed to access {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to decode {path}: {source}")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

fn validate_profile_id(value: &str) -> Result<(), StoreError> {
    let Some(suffix) = value.strip_prefix("nvstraps-") else {
        return Err(StoreError::InvalidProfileId);
    };
    if suffix.len() != 24
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(StoreError::InvalidProfileId);
    }
    Ok(())
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, StoreError> {
    let bytes = fs::read(path).map_err(|source| StoreError::Io {
        path: path.to_owned(),
        source,
    })?;
    serde_json::from_slice(&bytes).map_err(|source| StoreError::Json {
        path: path.to_owned(),
        source,
    })
}

fn write_json_once(path: &Path, value: &impl Serialize) -> Result<(), StoreError> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|source| StoreError::Json {
        path: path.to_owned(),
        source,
    })?;
    bytes.push(b'\n');
    write_bytes_once(path, &bytes)
}

fn write_bytes_once(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| StoreError::Io {
            path: parent.to_owned(),
            source,
        })?;
    }
    if path.exists() {
        return ensure_same_file(path, bytes);
    }

    let temporary = temporary_path(path);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|source| StoreError::Io {
                path: temporary.clone(),
                source,
            })?;
        file.write_all(bytes).map_err(|source| StoreError::Io {
            path: temporary.clone(),
            source,
        })?;
        file.sync_all().map_err(|source| StoreError::Io {
            path: temporary.clone(),
            source,
        })?;
        drop(file);
        match fs::rename(&temporary, path) {
            Ok(()) => {}
            Err(_) if path.exists() => ensure_same_file(path, bytes)?,
            Err(source) => {
                return Err(StoreError::Io {
                    path: path.to_owned(),
                    source,
                });
            }
        }
        Ok(())
    })();
    if result.is_err() || temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn ensure_same_file(path: &Path, expected: &[u8]) -> Result<(), StoreError> {
    let actual = fs::read(path).map_err(|source| StoreError::Io {
        path: path.to_owned(),
        source,
    })?;
    if actual == expected {
        Ok(())
    } else {
        Err(StoreError::ImmutableConflict(path.to_owned()))
    }
}

fn copy_new_verified(
    source: &Path,
    destination: &Path,
    expected_sha256: &Sha256Digest,
) -> Result<(), StoreError> {
    if destination.exists() {
        let fingerprint = crate::FirmwareFingerprint::inspect(destination)?;
        return if fingerprint.sha256 == *expected_sha256 {
            Ok(())
        } else {
            Err(StoreError::ImmutableConflict(destination.to_owned()))
        };
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|source| StoreError::Io {
            path: parent.to_owned(),
            source,
        })?;
    }
    let temporary = temporary_path(destination);
    let result = (|| {
        let mut input = File::open(source).map_err(|error| StoreError::Io {
            path: source.to_owned(),
            source: error,
        })?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|source| StoreError::Io {
                path: temporary.clone(),
                source,
            })?;
        io::copy(&mut input, &mut output).map_err(|source| StoreError::Io {
            path: temporary.clone(),
            source,
        })?;
        output.sync_all().map_err(|source| StoreError::Io {
            path: temporary.clone(),
            source,
        })?;
        drop(output);
        let copied = crate::FirmwareFingerprint::inspect(&temporary)?;
        if copied.sha256 != *expected_sha256 {
            return Err(StoreError::FirmwareChanged);
        }
        match fs::rename(&temporary, destination) {
            Ok(()) => {}
            Err(_) if destination.exists() => {
                let existing = crate::FirmwareFingerprint::inspect(destination)?;
                if existing.sha256 != *expected_sha256 {
                    return Err(StoreError::ImmutableConflict(destination.to_owned()));
                }
            }
            Err(source) => {
                return Err(StoreError::Io {
                    path: destination.to_owned(),
                    source,
                });
            }
        }
        Ok(())
    })();
    if result.is_err() || temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn temporary_path(destination: &Path) -> PathBuf {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("deployment");
    destination.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), sequence))
}

#[cfg(test)]
mod tests {
    use std::{
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use crate::{
        BoardPath, EvidenceKind, FirmwareFingerprint, FirmwareInstallMethod, FirmwareInstallRoute,
        GpuFingerprint, MachineIdentity, PciLocation, RecoveryCapability, RecoveryMethod,
        StepEvidence, StepState,
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
                "nvstraps-deploy-{}-{nonce}-{}",
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

    fn profile(firmware: FirmwareFingerprint) -> MachineProfile {
        MachineProfile::create(
            "test machine",
            BoardPath::NativeResizableBar,
            MachineIdentity {
                board_manufacturer: "Board vendor".into(),
                board_product: "Board product".into(),
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
            firmware,
            RecoveryCapability {
                method: RecoveryMethod::UsbFlashback,
                tested_or_documented: true,
                note: "documented rear-panel recovery".into(),
            },
            FirmwareInstallRoute {
                method: FirmwareInstallMethod::FirmwareSetupUtility,
                artifact_file_name: "vendor-bios.bin".into(),
                tested_or_documented: true,
                official_instructions_url: "https://vendor.invalid/manual".into(),
                note: "Select the pinned image in firmware setup".into(),
            },
        )
        .unwrap()
    }

    #[test]
    fn provisioning_is_append_only_verified_and_idempotent() {
        let directory = TestDirectory::new();
        let source = directory.0.join("vendor-bios.bin");
        fs::write(&source, b"known vendor firmware image").unwrap();
        let firmware = FirmwareFingerprint::inspect(&source).unwrap();
        let profile = profile(firmware.clone());
        let store = DeploymentStore::new(directory.0.join("store"));

        let provisioned = store.provision_profile(&profile, &source).unwrap();
        assert_eq!(
            FirmwareFingerprint::inspect(&provisioned.original_firmware_path)
                .unwrap()
                .sha256,
            firmware.sha256
        );
        assert_eq!(
            provisioned.plan.active_step().unwrap().id,
            StepId::PrepareRustDriver
        );
        assert_eq!(provisioned.plan.revision, 3);
        assert_eq!(store.list_profiles().unwrap(), vec![profile.clone()]);

        let repeated = store.provision_profile(&profile, &source).unwrap();
        assert_eq!(repeated.plan, provisioned.plan);
        let snapshots = fs::read_dir(directory.0.join("store/plans").join(&profile.profile_id))
            .unwrap()
            .count();
        assert_eq!(snapshots, 4);
    }

    #[test]
    fn immutable_records_reject_changed_content_and_path_traversal() {
        let directory = TestDirectory::new();
        let source = directory.0.join("vendor-bios.bin");
        fs::write(&source, b"known firmware").unwrap();
        let profile = profile(FirmwareFingerprint::inspect(&source).unwrap());
        let store = DeploymentStore::new(directory.0.join("store"));
        store.provision_profile(&profile, &source).unwrap();

        let mut conflicting = profile.clone();
        conflicting.display_name = "changed after persistence".into();
        assert!(matches!(
            store.save_profile(&conflicting),
            Err(StoreError::ImmutableConflict(_))
        ));
        assert!(matches!(
            store.load_profile("../../escape"),
            Err(StoreError::InvalidProfileId)
        ));
    }

    #[test]
    fn malformed_plan_history_is_never_silently_skipped() {
        let directory = TestDirectory::new();
        let source = directory.0.join("vendor-bios.bin");
        fs::write(&source, b"known firmware").unwrap();
        let profile = profile(FirmwareFingerprint::inspect(&source).unwrap());
        let store = DeploymentStore::new(directory.0.join("store"));
        let provisioned = store.provision_profile(&profile, &source).unwrap();

        let corrupt_path = directory
            .0
            .join("store/plans")
            .join(&profile.profile_id)
            .join("0000000004.json");
        fs::write(&corrupt_path, b"not json").unwrap();
        assert!(matches!(
            store.load_plan(&profile),
            Err(StoreError::Json { .. })
        ));
        assert_eq!(provisioned.plan.steps[0].state, StepState::Completed);
    }

    #[test]
    fn generated_artifacts_are_immutable_and_rehashed_after_persistence() {
        let directory = TestDirectory::new();
        let source = directory.0.join("vendor-bios.bin");
        fs::write(&source, b"known firmware").unwrap();
        let profile = profile(FirmwareFingerprint::inspect(&source).unwrap());
        let store = DeploymentStore::new(directory.0.join("store"));
        store.provision_profile(&profile, &source).unwrap();

        let first = store
            .preserve_artifact(&profile, ArtifactKind::RustDriverFfs, b"verified FFS")
            .unwrap();
        assert_eq!(first.sha256, Sha256Digest::from_bytes(b"verified FFS"));
        let (loaded, bytes) = store
            .load_artifact(&profile, ArtifactKind::RustDriverFfs)
            .unwrap();
        assert_eq!(loaded, first);
        assert_eq!(bytes, b"verified FFS");
        assert!(matches!(
            store.preserve_artifact(&profile, ArtifactKind::RustDriverFfs, b"different FFS"),
            Err(StoreError::ImmutableConflict(_))
        ));
    }

    #[test]
    fn verified_package_is_complete_reproducible_and_never_overwritten() {
        let directory = TestDirectory::new();
        let source = directory.0.join("vendor-bios.bin");
        fs::write(&source, b"known vendor firmware image").unwrap();
        let profile = profile(FirmwareFingerprint::inspect(&source).unwrap());
        let store = DeploymentStore::new(directory.0.join("store"));
        let mut plan = store.provision_profile(&profile, &source).unwrap().plan;

        let driver = store
            .preserve_artifact(&profile, ArtifactKind::RustDriverFfs, b"verified Rust FFS")
            .unwrap();
        plan.complete(
            StepId::PrepareRustDriver,
            StepEvidence::new(EvidenceKind::RustDriverSha256, driver.sha256.to_string()).unwrap(),
        )
        .unwrap();
        store.save_plan(&profile, &plan).unwrap();
        let patched = store
            .preserve_artifact(
                &profile,
                ArtifactKind::PatchedFirmware,
                b"verified patched firmware image",
            )
            .unwrap();
        plan.complete(
            StepId::VerifyPatchedArtifact,
            StepEvidence::new(
                EvidenceKind::PatchedFirmwareSha256,
                patched.sha256.to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        store.save_plan(&profile, &plan).unwrap();
        let firmware_injection_receipt = br#"{"schemaVersion":1,"targetCount":1}"#;
        let persisted_firmware_injection_receipt = store
            .preserve_artifact(
                &profile,
                ArtifactKind::FirmwareInjectionReceipt,
                firmware_injection_receipt,
            )
            .unwrap();
        assert_eq!(
            persisted_firmware_injection_receipt
                .path
                .file_name()
                .unwrap(),
            "firmware-injection-receipt.json"
        );

        let destination = directory.0.join("usb");
        fs::create_dir(&destination).unwrap();
        assert!(matches!(
            store.export_deployment_package(
                &profile,
                &plan,
                &Sha256Digest::from_bytes(b"stale validated receipt"),
                &destination,
            ),
            Err(StoreError::FirmwareInjectionReceiptChanged)
        ));
        let receipt = store
            .export_deployment_package(
                &profile,
                &plan,
                &persisted_firmware_injection_receipt.sha256,
                &destination,
            )
            .unwrap();
        assert_eq!(
            fs::read(receipt.package_path.join("flash/vendor-bios.bin")).unwrap(),
            b"verified patched firmware image"
        );
        assert_eq!(
            fs::read(receipt.package_path.join("recovery/original-firmware.bin")).unwrap(),
            b"known vendor firmware image"
        );
        let persisted_manifest: DeploymentPackageManifest = serde_json::from_slice(
            &fs::read(receipt.package_path.join("deployment-manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(persisted_manifest, receipt.manifest);
        assert_eq!(persisted_manifest.files.len(), 6);
        assert_eq!(
            fs::read(
                receipt
                    .package_path
                    .join("receipts/firmware-injection-receipt.json")
            )
            .unwrap(),
            firmware_injection_receipt
        );
        assert!(persisted_manifest.files.iter().any(|file| {
            file.relative_path == "receipts/firmware-injection-receipt.json"
                && file.purpose == PackageFilePurpose::FirmwareInjectionReceipt
                && file.sha256 == Sha256Digest::from_bytes(firmware_injection_receipt)
        }));
        assert_eq!(
            Sha256Digest::from_bytes(
                fs::read(receipt.package_path.join("deployment-manifest.json")).unwrap()
            ),
            receipt.manifest_sha256
        );
        assert!(receipt.package_path.join("SHA256SUMS.txt").is_file());
        assert!(receipt.package_path.join("DEPLOYMENT.txt").is_file());
        assert!(matches!(
            store.export_deployment_package(
                &profile,
                &plan,
                &persisted_firmware_injection_receipt.sha256,
                &destination,
            ),
            Err(StoreError::PackageAlreadyExists(_))
        ));
    }

    #[test]
    fn package_export_refuses_unverified_artifacts_and_relative_destinations() {
        let directory = TestDirectory::new();
        let source = directory.0.join("vendor-bios.bin");
        fs::write(&source, b"known firmware").unwrap();
        let profile = profile(FirmwareFingerprint::inspect(&source).unwrap());
        let store = DeploymentStore::new(directory.0.join("store"));
        let plan = store.provision_profile(&profile, &source).unwrap().plan;
        store
            .preserve_artifact(&profile, ArtifactKind::PatchedFirmware, b"unverified")
            .unwrap();
        assert!(matches!(
            store.export_deployment_package(
                &profile,
                &plan,
                &Sha256Digest::from_bytes(b"missing receipt"),
                &directory.0,
            ),
            Err(StoreError::PatchedArtifactNotVerified)
        ));

        let mut verified = plan;
        let driver = store
            .preserve_artifact(&profile, ArtifactKind::RustDriverFfs, b"driver")
            .unwrap();
        verified
            .complete(
                StepId::PrepareRustDriver,
                StepEvidence::new(EvidenceKind::RustDriverSha256, driver.sha256.to_string())
                    .unwrap(),
            )
            .unwrap();
        let (_, patched_bytes) = store
            .load_artifact(&profile, ArtifactKind::PatchedFirmware)
            .unwrap();
        verified
            .complete(
                StepId::VerifyPatchedArtifact,
                StepEvidence::new(
                    EvidenceKind::PatchedFirmwareSha256,
                    Sha256Digest::from_bytes(patched_bytes).to_string(),
                )
                .unwrap(),
            )
            .unwrap();
        assert!(matches!(
            store.export_deployment_package(
                &profile,
                &verified,
                &Sha256Digest::from_bytes(b"missing receipt"),
                &directory.0,
            ),
            Err(StoreError::MissingFirmwareInjectionReceipt)
        ));
        let injection_receipt = store
            .preserve_artifact(
                &profile,
                ArtifactKind::FirmwareInjectionReceipt,
                br#"{"schemaVersion":1}"#,
            )
            .unwrap();
        assert!(matches!(
            store.export_deployment_package(
                &profile,
                &verified,
                &injection_receipt.sha256,
                "relative-usb",
            ),
            Err(StoreError::PackageDestinationMustBeAbsolute)
        ));
    }
}
