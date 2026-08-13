use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Serialize, de::DeserializeOwned};
use thiserror::Error;

use crate::{
    DeploymentPlan, EvidenceKind, MachineProfile, PlanError, ProfileError, Sha256Digest,
    StepEvidence, StepId,
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
}

impl ArtifactKind {
    fn file_name(self) -> &'static str {
        match self {
            Self::RustDriverFfs => "rust-driver.ffs",
            Self::LegacyPatchedFirmware => "legacy-patched-firmware.bin",
            Self::PatchedFirmware => "patched-firmware.bin",
            Self::LegacyPatchReceipt => "legacy-patch-receipt.json",
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

        let mut plan = match self.load_plan(profile) {
            Ok(plan) => plan,
            Err(StoreError::MissingPlan(_)) => {
                let plan = DeploymentPlan::for_profile(profile)?;
                self.save_plan(profile, &plan)?;
                plan
            }
            Err(error) => return Err(error),
        };
        for (step, kind, value) in [
            (
                StepId::VerifyProfile,
                EvidenceKind::ExactProfileMatch,
                profile.profile_id.as_str(),
            ),
            (
                StepId::ConfirmRecovery,
                EvidenceKind::RecoveryRouteConfirmed,
                profile.recovery.method.evidence_value(),
            ),
            (
                StepId::PreserveOriginalFirmware,
                EvidenceKind::OriginalFirmwareSha256,
                profile.original_firmware.sha256.as_str(),
            ),
        ] {
            if plan.active_step().is_some_and(|active| active.id == step) {
                plan.complete(step, StepEvidence::new(kind, value)?)?;
                self.save_plan(profile, &plan)?;
            }
        }

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
        BoardPath, FirmwareFingerprint, GpuFingerprint, MachineIdentity, PciLocation,
        RecoveryCapability, RecoveryMethod, StepState,
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
}
