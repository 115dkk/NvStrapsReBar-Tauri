//! Recoverable machine pinning and deployment sequencing for NvStrapsReBar.
//!
//! This crate deliberately contains no firmware writer, flasher, reboot call, or UI. It owns the
//! safety contract those adapters must satisfy before a consequential action can become ready.

use std::{
    fmt,
    fs::File,
    io::{self, BufReader, Read},
    path::Path,
};

use serde::{Deserialize, Deserializer, Serialize, de};
use sha2::{Digest, Sha256};
use thiserror::Error;

mod store;

pub use store::{ArtifactKind, DeploymentStore, ProvisionedDeployment, StoreError, StoredArtifact};

pub const PROFILE_SCHEMA_VERSION: u8 = 2;
pub const PLAN_SCHEMA_VERSION: u8 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct Sha256Digest(String);

impl Sha256Digest {
    pub fn parse(value: impl Into<String>) -> Result<Self, ProfileError> {
        let value = value.into().to_ascii_lowercase();
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ProfileError::InvalidSha256);
        }
        Ok(Self(value))
    }

    pub fn from_bytes(bytes: impl AsRef<[u8]>) -> Self {
        let digest = Sha256::digest(bytes);
        Self(hex(&digest))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Sha256Digest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(de::Error::custom)
    }
}

impl fmt::Display for Sha256Digest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareFingerprint {
    pub file_name: String,
    pub byte_length: u64,
    pub sha256: Sha256Digest,
}

impl FirmwareFingerprint {
    pub fn inspect(path: impl AsRef<Path>) -> Result<Self, ProfileError> {
        let path = path.as_ref();
        let file = File::open(path).map_err(ProfileError::ReadFirmware)?;
        let byte_length = file.metadata().map_err(ProfileError::ReadFirmware)?.len();
        if byte_length == 0 {
            return Err(ProfileError::EmptyFirmwareImage);
        }

        let mut reader = BufReader::new(file);
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 1024 * 1024];
        loop {
            let count = reader
                .read(&mut buffer)
                .map_err(ProfileError::ReadFirmware)?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }

        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(ProfileError::MissingFirmwareFileName)?
            .to_owned();
        Ok(Self {
            file_name,
            byte_length,
            sha256: Sha256Digest(hex(&hasher.finalize())),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PciLocation {
    pub bus: u8,
    pub device: u8,
    pub function: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuFingerprint {
    pub vendor_id: u16,
    pub device_id: u16,
    pub subsystem_vendor_id: u16,
    pub subsystem_device_id: u16,
    pub location: PciLocation,
    pub bridge_location: PciLocation,
    pub bar0_base: u64,
    pub bar0_top: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineIdentity {
    pub board_manufacturer: String,
    pub board_product: String,
    pub board_version: String,
    pub bios_vendor: String,
    pub bios_version: String,
    pub bios_release_date: String,
    pub gpus: Vec<GpuFingerprint>,
}

impl MachineIdentity {
    fn normalized(mut self) -> Result<Self, ProfileError> {
        self.board_manufacturer = required_text("board manufacturer", self.board_manufacturer)?;
        self.board_product = required_text("board product", self.board_product)?;
        self.board_version = required_text("board version", self.board_version)?;
        self.bios_vendor = required_text("BIOS vendor", self.bios_vendor)?;
        self.bios_version = required_text("BIOS version", self.bios_version)?;
        self.bios_release_date = required_text("BIOS release date", self.bios_release_date)?;
        if self.gpus.is_empty() {
            return Err(ProfileError::NoGpuFingerprint);
        }
        for gpu in &self.gpus {
            for location in [gpu.location, gpu.bridge_location] {
                if location.device > 31 || location.function > 7 {
                    return Err(ProfileError::InvalidPciLocation);
                }
            }
            if gpu.bar0_base > gpu.bar0_top {
                return Err(ProfileError::InvalidBar0Range);
            }
        }
        self.gpus.sort();
        self.gpus.dedup();
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BoardPath {
    NativeResizableBar,
    LegacyAbove4g,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyPatchCatalogFile {
    General,
    HaswellAbove4g,
    IvyBridgeUsb3,
    HaswellUsb3,
    BroadwellUsb3,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPatchCatalogPin {
    pub catalog: LegacyPatchCatalogFile,
    pub source_sha256: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPatchSelection {
    pub catalog: LegacyPatchCatalogFile,
    pub rule_id: String,
    pub expected_matches: u16,
    pub required_risks: Vec<LegacyPatchRisk>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyPatchRisk {
    DsdtModification,
    NvramWhitelist,
    UsbControllerBlacklist,
    ExperimentalX79,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyRiskAcknowledgement {
    pub risk: LegacyPatchRisk,
    pub note: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPatchProfile {
    pub upstream_commit: String,
    pub catalogs: Vec<LegacyPatchCatalogPin>,
    pub selections: Vec<LegacyPatchSelection>,
    pub acknowledgements: Vec<LegacyRiskAcknowledgement>,
}

impl LegacyPatchProfile {
    pub fn create(
        upstream_commit: impl Into<String>,
        catalogs: Vec<LegacyPatchCatalogPin>,
        selections: Vec<LegacyPatchSelection>,
        acknowledgements: Vec<LegacyRiskAcknowledgement>,
    ) -> Result<Self, ProfileError> {
        Self {
            upstream_commit: upstream_commit.into(),
            catalogs,
            selections,
            acknowledgements,
        }
        .normalized()
    }

    pub fn validate(&self) -> Result<(), ProfileError> {
        if self.clone().normalized()? != *self {
            return Err(ProfileError::LegacyPatchProfileNotCanonical);
        }
        Ok(())
    }

    fn normalized(mut self) -> Result<Self, ProfileError> {
        self.upstream_commit = self.upstream_commit.trim().to_ascii_lowercase();
        if self.upstream_commit.len() != 40
            || !self
                .upstream_commit
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(ProfileError::InvalidUpstreamCommit);
        }
        if self.catalogs.is_empty() || self.selections.is_empty() {
            return Err(ProfileError::EmptyLegacyPatchBundle);
        }
        self.catalogs.sort_by_key(|pin| pin.catalog);
        if self
            .catalogs
            .windows(2)
            .any(|pair| pair[0].catalog == pair[1].catalog)
        {
            return Err(ProfileError::DuplicateLegacyPatchCatalog);
        }

        for selection in &mut self.selections {
            selection.rule_id = selection.rule_id.trim().to_ascii_lowercase();
            if selection.rule_id.len() != 64
                || !selection
                    .rule_id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(ProfileError::InvalidLegacyRuleId);
            }
            if selection.expected_matches == 0 {
                return Err(ProfileError::InvalidLegacyExpectedMatches);
            }
            selection.required_risks.sort();
            selection.required_risks.dedup();
            if !self
                .catalogs
                .iter()
                .any(|pin| pin.catalog == selection.catalog)
            {
                return Err(ProfileError::MissingLegacyPatchCatalog);
            }
        }
        self.selections.sort_by(|left, right| {
            (left.catalog, &left.rule_id).cmp(&(right.catalog, &right.rule_id))
        });
        if self
            .selections
            .windows(2)
            .any(|pair| pair[0].catalog == pair[1].catalog && pair[0].rule_id == pair[1].rule_id)
        {
            return Err(ProfileError::DuplicateLegacyPatchSelection);
        }
        if self.catalogs.iter().any(|pin| {
            !self
                .selections
                .iter()
                .any(|selection| selection.catalog == pin.catalog)
        }) {
            return Err(ProfileError::UnusedLegacyPatchCatalog);
        }

        for acknowledgement in &mut self.acknowledgements {
            acknowledgement.note = required_text(
                "legacy patch risk acknowledgement",
                acknowledgement.note.clone(),
            )?;
        }
        self.acknowledgements.sort();
        if self
            .acknowledgements
            .windows(2)
            .any(|pair| pair[0].risk == pair[1].risk)
        {
            return Err(ProfileError::DuplicateLegacyRiskAcknowledgement);
        }
        for selection in &self.selections {
            if selection.required_risks.iter().any(|risk| {
                !self
                    .acknowledgements
                    .iter()
                    .any(|acknowledgement| acknowledgement.risk == *risk)
            }) {
                return Err(ProfileError::LegacyRiskNotAcknowledged);
            }
        }
        if self.acknowledgements.iter().any(|acknowledgement| {
            !self
                .selections
                .iter()
                .any(|selection| selection.required_risks.contains(&acknowledgement.risk))
        }) {
            return Err(ProfileError::UnusedLegacyRiskAcknowledgement);
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryMethod {
    DualBios,
    UsbFlashback,
    VendorRecovery,
    ExternalSpiProgrammer,
    None,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCapability {
    pub method: RecoveryMethod,
    pub tested_or_documented: bool,
    pub note: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineProfile {
    pub schema_version: u8,
    pub profile_id: String,
    pub display_name: String,
    pub board_path: BoardPath,
    #[serde(default)]
    pub legacy_patches: Option<LegacyPatchProfile>,
    pub identity: MachineIdentity,
    pub original_firmware: FirmwareFingerprint,
    pub recovery: RecoveryCapability,
}

impl MachineProfile {
    pub fn create(
        display_name: impl Into<String>,
        board_path: BoardPath,
        identity: MachineIdentity,
        original_firmware: FirmwareFingerprint,
        recovery: RecoveryCapability,
    ) -> Result<Self, ProfileError> {
        Self::create_with_legacy(
            display_name,
            board_path,
            identity,
            original_firmware,
            recovery,
            None,
        )
    }

    pub fn create_with_legacy(
        display_name: impl Into<String>,
        board_path: BoardPath,
        identity: MachineIdentity,
        mut original_firmware: FirmwareFingerprint,
        mut recovery: RecoveryCapability,
        legacy_patches: Option<LegacyPatchProfile>,
    ) -> Result<Self, ProfileError> {
        let display_name = required_text("profile display name", display_name.into())?;
        let identity = identity.normalized()?;
        original_firmware.file_name =
            required_text("firmware file name", original_firmware.file_name)?;
        if original_firmware.byte_length == 0 {
            return Err(ProfileError::EmptyFirmwareImage);
        }
        if recovery.method == RecoveryMethod::None || !recovery.tested_or_documented {
            return Err(ProfileError::RecoveryNotEstablished);
        }
        recovery.note = required_text("recovery note", recovery.note)?;
        match (board_path, &legacy_patches) {
            (BoardPath::LegacyAbove4g, None) => {
                return Err(ProfileError::LegacyPatchProfileRequired);
            }
            (BoardPath::NativeResizableBar, Some(_)) => {
                return Err(ProfileError::LegacyPatchProfileForbidden);
            }
            (_, Some(legacy)) => legacy.validate()?,
            _ => {}
        }

        let profile_id = profile_id(
            board_path,
            &identity,
            &original_firmware,
            legacy_patches.as_ref(),
        );
        let profile = Self {
            schema_version: PROFILE_SCHEMA_VERSION,
            profile_id,
            display_name,
            board_path,
            legacy_patches,
            identity,
            original_firmware,
            recovery,
        };
        profile.validate()?;
        Ok(profile)
    }

    pub fn validate(&self) -> Result<(), ProfileError> {
        if !matches!(self.schema_version, 1 | PROFILE_SCHEMA_VERSION) {
            return Err(ProfileError::UnsupportedSchema(self.schema_version));
        }
        required_text("profile display name", self.display_name.clone())?;
        let normalized_identity = self.identity.clone().normalized()?;
        if normalized_identity != self.identity {
            return Err(ProfileError::IdentityNotCanonical);
        }
        required_text(
            "firmware file name",
            self.original_firmware.file_name.clone(),
        )?;
        if self.original_firmware.byte_length == 0 {
            return Err(ProfileError::EmptyFirmwareImage);
        }
        if self.recovery.method == RecoveryMethod::None || !self.recovery.tested_or_documented {
            return Err(ProfileError::RecoveryNotEstablished);
        }
        required_text("recovery note", self.recovery.note.clone())?;
        match (self.board_path, &self.legacy_patches) {
            (BoardPath::LegacyAbove4g, Some(legacy)) => legacy.validate()?,
            (BoardPath::LegacyAbove4g, None) => {
                return Err(ProfileError::LegacyPatchProfileRequired);
            }
            (BoardPath::NativeResizableBar, Some(_)) => {
                return Err(ProfileError::LegacyPatchProfileForbidden);
            }
            (BoardPath::NativeResizableBar, None) => {}
        }
        if self.schema_version == 1 && self.legacy_patches.is_some() {
            return Err(ProfileError::UnsupportedSchema(self.schema_version));
        }
        let expected = profile_id(
            self.board_path,
            &self.identity,
            &self.original_firmware,
            self.legacy_patches.as_ref(),
        );
        if self.profile_id != expected {
            return Err(ProfileError::ProfileIdMismatch);
        }
        Ok(())
    }

    pub fn compare(
        &self,
        current: &MachineIdentity,
        firmware: Option<&FirmwareFingerprint>,
    ) -> ProfileMatch {
        let mut differences = Vec::new();
        let Ok(current) = current.clone().normalized() else {
            differences.push(ProfileDifference::InvalidCurrentIdentity);
            return ProfileMatch { differences };
        };

        compare_field(
            &mut differences,
            "boardManufacturer",
            &self.identity.board_manufacturer,
            &current.board_manufacturer,
        );
        compare_field(
            &mut differences,
            "boardProduct",
            &self.identity.board_product,
            &current.board_product,
        );
        compare_field(
            &mut differences,
            "boardVersion",
            &self.identity.board_version,
            &current.board_version,
        );
        compare_field(
            &mut differences,
            "biosVendor",
            &self.identity.bios_vendor,
            &current.bios_vendor,
        );
        compare_field(
            &mut differences,
            "biosVersion",
            &self.identity.bios_version,
            &current.bios_version,
        );
        compare_field(
            &mut differences,
            "biosReleaseDate",
            &self.identity.bios_release_date,
            &current.bios_release_date,
        );
        if self.identity.gpus != current.gpus {
            differences.push(ProfileDifference::GpuTopology);
        }
        if let Some(firmware) = firmware
            && (self.original_firmware.byte_length != firmware.byte_length
                || self.original_firmware.sha256 != firmware.sha256)
        {
            differences.push(ProfileDifference::FirmwareImage);
        }
        ProfileMatch { differences }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ProfileDifference {
    Field {
        field: String,
        expected: String,
        actual: String,
    },
    GpuTopology,
    FirmwareImage,
    InvalidCurrentIdentity,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMatch {
    pub differences: Vec<ProfileDifference>,
}

impl ProfileMatch {
    pub fn is_exact(&self) -> bool {
        self.differences.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    Automated,
    ExternalTool,
    FirmwareManual,
    Reboot,
    PhysicalConfirmation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepId {
    VerifyProfile,
    ConfirmRecovery,
    PreserveOriginalFirmware,
    PrepareRustDriver,
    ApplyLegacyBoardPatches,
    VerifyPatchedArtifact,
    FlashWithVendorRoute,
    ConfigureFirmwareSetup,
    RebootAfterFirmware,
    VerifyDriverLoaded,
    WriteNvstrapsConfiguration,
    RebootAfterConfiguration,
    VerifyResizableBar,
    ConfigureNvidiaApplications,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepState {
    Ready,
    Pending,
    Completed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EvidenceKind {
    ExactProfileMatch,
    RecoveryRouteConfirmed,
    OriginalFirmwareSha256,
    RustDriverSha256,
    LegacyPatchReceipt,
    PatchedFirmwareSha256,
    VendorFlashReceipt,
    FirmwareSettingsConfirmed,
    BootObserved,
    DriverStatus,
    ConfigurationReadback,
    ResizableBarObserved,
    NvidiaPolicyObserved,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepEvidence {
    pub kind: EvidenceKind,
    pub value: String,
}

impl StepEvidence {
    pub fn new(kind: EvidenceKind, value: impl Into<String>) -> Result<Self, PlanError> {
        let mut value = value.into().trim().to_owned();
        if value.is_empty() {
            return Err(PlanError::MissingEvidence);
        }
        if matches!(
            kind,
            EvidenceKind::OriginalFirmwareSha256
                | EvidenceKind::RustDriverSha256
                | EvidenceKind::PatchedFirmwareSha256
        ) {
            value = Sha256Digest::parse(value)
                .map_err(|_| PlanError::MalformedDigest(kind))?
                .to_string();
        }
        Ok(Self { kind, value })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentStep {
    pub id: StepId,
    pub kind: StepKind,
    pub title: String,
    pub state: StepState,
    pub evidence: Option<StepEvidence>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentPlan {
    pub schema_version: u8,
    pub profile_id: String,
    pub original_firmware_sha256: Sha256Digest,
    pub recovery_method: RecoveryMethod,
    pub revision: u32,
    pub steps: Vec<DeploymentStep>,
}

impl DeploymentPlan {
    pub fn for_profile(profile: &MachineProfile) -> Result<Self, ProfileError> {
        profile.validate()?;
        Ok(Self::build(profile))
    }

    fn build(profile: &MachineProfile) -> Self {
        let mut definitions = vec![
            step(
                StepId::VerifyProfile,
                StepKind::Automated,
                "Verify the pinned machine, topology, BIOS, and source image",
            ),
            step(
                StepId::ConfirmRecovery,
                StepKind::PhysicalConfirmation,
                "Confirm the pinned firmware recovery route",
            ),
            step(
                StepId::PreserveOriginalFirmware,
                StepKind::Automated,
                "Preserve and hash the exact original firmware image",
            ),
            step(
                StepId::PrepareRustDriver,
                StepKind::Automated,
                "Build and verify the Rust DXE driver",
            ),
        ];
        if profile.board_path == BoardPath::LegacyAbove4g {
            definitions.push(step(
                StepId::ApplyLegacyBoardPatches,
                StepKind::Automated,
                "Apply the profile's legacy-board patch bundle",
            ));
        }
        definitions.extend([
            step(
                StepId::VerifyPatchedArtifact,
                StepKind::Automated,
                "Verify and hash the patched firmware artifact",
            ),
            step(
                StepId::FlashWithVendorRoute,
                StepKind::ExternalTool,
                "Flash only through the pinned vendor route",
            ),
            step(
                StepId::ConfigureFirmwareSetup,
                StepKind::FirmwareManual,
                match profile.board_path {
                    BoardPath::NativeResizableBar => {
                        "Enable native ReBAR and Above 4G decoding; disable CSM"
                    }
                    BoardPath::LegacyAbove4g => "Enable Above 4G decoding and disable CSM",
                },
            ),
            step(
                StepId::RebootAfterFirmware,
                StepKind::Reboot,
                "Boot the patched firmware and return to Windows",
            ),
            step(
                StepId::VerifyDriverLoaded,
                StepKind::Automated,
                "Verify the Rust DXE status variable",
            ),
            step(
                StepId::WriteNvstrapsConfiguration,
                StepKind::Automated,
                "Validate, write, and read back the NvStraps configuration",
            ),
            step(
                StepId::RebootAfterConfiguration,
                StepKind::Reboot,
                "Reboot to apply the guarded configuration",
            ),
            step(
                StepId::VerifyResizableBar,
                StepKind::Automated,
                "Verify the applied BAR size from independent observations",
            ),
            step(
                StepId::ConfigureNvidiaApplications,
                StepKind::ExternalTool,
                "Configure and verify NVIDIA per-application ReBAR policy",
            ),
        ]);
        definitions[0].state = StepState::Ready;
        Self {
            schema_version: PLAN_SCHEMA_VERSION,
            profile_id: profile.profile_id.clone(),
            original_firmware_sha256: profile.original_firmware.sha256.clone(),
            recovery_method: profile.recovery.method,
            revision: 0,
            steps: definitions,
        }
    }

    pub fn active_step(&self) -> Option<&DeploymentStep> {
        self.steps
            .iter()
            .find(|step| step.state == StepState::Ready)
    }

    pub fn complete(&mut self, step_id: StepId, evidence: StepEvidence) -> Result<(), PlanError> {
        let active_index = self
            .steps
            .iter()
            .position(|step| step.state == StepState::Ready)
            .ok_or(PlanError::AlreadyComplete)?;
        let active = &self.steps[active_index];
        if active.id != step_id {
            return Err(PlanError::OutOfOrder {
                expected: active.id,
                actual: step_id,
            });
        }
        let expected_evidence = expected_evidence(step_id);
        if evidence.kind != expected_evidence {
            return Err(PlanError::WrongEvidence {
                step: step_id,
                expected: expected_evidence,
                actual: evidence.kind,
            });
        }
        self.validate_evidence(step_id, &evidence)?;

        self.steps[active_index].state = StepState::Completed;
        self.steps[active_index].evidence = Some(evidence);
        if let Some(next) = self.steps.get_mut(active_index + 1) {
            next.state = StepState::Ready;
        }
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    pub fn invalidate_from(&mut self, step_id: StepId) -> Result<(), PlanError> {
        let index = self
            .steps
            .iter()
            .position(|step| step.id == step_id)
            .ok_or(PlanError::UnknownStep(step_id))?;
        if let Some(active_index) = self
            .steps
            .iter()
            .position(|step| step.state == StepState::Ready)
            && index > active_index
        {
            return Err(PlanError::StepNotReached(step_id));
        }
        for (position, step) in self.steps.iter_mut().enumerate().skip(index) {
            step.state = if position == index {
                StepState::Ready
            } else {
                StepState::Pending
            };
            step.evidence = None;
        }
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    pub fn is_complete(&self) -> bool {
        self.steps
            .iter()
            .all(|step| step.state == StepState::Completed)
    }

    pub fn validate_for(&self, profile: &MachineProfile) -> Result<(), PlanError> {
        profile.validate().map_err(PlanError::InvalidProfile)?;
        if self.schema_version != PLAN_SCHEMA_VERSION {
            return Err(PlanError::UnsupportedSchema(self.schema_version));
        }
        if self.profile_id != profile.profile_id
            || self.original_firmware_sha256 != profile.original_firmware.sha256
            || self.recovery_method != profile.recovery.method
        {
            return Err(PlanError::ProfileMismatch);
        }

        let canonical = Self::build(profile);
        if self.steps.len() != canonical.steps.len()
            || self
                .steps
                .iter()
                .zip(&canonical.steps)
                .any(|(actual, expected)| {
                    actual.id != expected.id
                        || actual.kind != expected.kind
                        || actual.title != expected.title
                })
        {
            return Err(PlanError::InvalidStepSequence);
        }

        let mut pending_started = false;
        let mut ready_count = 0;
        for step in &self.steps {
            match step.state {
                StepState::Completed if !pending_started => {
                    let evidence = step.evidence.as_ref().ok_or(PlanError::MissingEvidence)?;
                    if evidence.kind != expected_evidence(step.id) {
                        return Err(PlanError::WrongEvidence {
                            step: step.id,
                            expected: expected_evidence(step.id),
                            actual: evidence.kind,
                        });
                    }
                    self.validate_evidence(step.id, evidence)?;
                }
                StepState::Completed => return Err(PlanError::InvalidStepState),
                StepState::Ready => {
                    pending_started = true;
                    ready_count += 1;
                    if step.evidence.is_some() {
                        return Err(PlanError::InvalidStepState);
                    }
                }
                StepState::Pending => {
                    pending_started = true;
                    if step.evidence.is_some() {
                        return Err(PlanError::InvalidStepState);
                    }
                }
            }
        }
        if ready_count > 1 || (ready_count == 0 && !self.is_complete()) {
            return Err(PlanError::InvalidStepState);
        }
        if let Some(ready_index) = self
            .steps
            .iter()
            .position(|step| step.state == StepState::Ready)
            && self.steps[..ready_index]
                .iter()
                .any(|step| step.state != StepState::Completed)
        {
            return Err(PlanError::InvalidStepState);
        }
        Ok(())
    }

    fn validate_evidence(&self, step_id: StepId, evidence: &StepEvidence) -> Result<(), PlanError> {
        match step_id {
            StepId::VerifyProfile if evidence.value != self.profile_id => {
                Err(PlanError::EvidenceValueMismatch(step_id))
            }
            StepId::PreserveOriginalFirmware
                if evidence.value != self.original_firmware_sha256.as_str() =>
            {
                Err(PlanError::EvidenceValueMismatch(step_id))
            }
            StepId::ConfirmRecovery if evidence.value != self.recovery_method.evidence_value() => {
                Err(PlanError::EvidenceValueMismatch(step_id))
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Error)]
pub enum ProfileError {
    #[error("SHA-256 must contain exactly 64 hexadecimal characters")]
    InvalidSha256,
    #[error("{0} must not be empty")]
    MissingField(&'static str),
    #[error("at least one GPU fingerprint is required")]
    NoGpuFingerprint,
    #[error("the firmware image is empty")]
    EmptyFirmwareImage,
    #[error("the firmware path has no Unicode file name")]
    MissingFirmwareFileName,
    #[error("failed to read the firmware image: {0}")]
    ReadFirmware(#[source] io::Error),
    #[error("a tested or documented recovery route is required before deployment")]
    RecoveryNotEstablished,
    #[error("profile schema version {0} is not supported")]
    UnsupportedSchema(u8),
    #[error("PCI device/function values are outside the encoded range")]
    InvalidPciLocation,
    #[error("GPU BAR0 end precedes its base")]
    InvalidBar0Range,
    #[error("machine identity must be trimmed, sorted, and deduplicated")]
    IdentityNotCanonical,
    #[error("profile ID does not match its pinned contents")]
    ProfileIdMismatch,
    #[error("legacy-board profiles require a pinned patch bundle")]
    LegacyPatchProfileRequired,
    #[error("native-ReBAR profiles cannot contain a legacy patch bundle")]
    LegacyPatchProfileForbidden,
    #[error("legacy patch upstream commit must contain exactly 40 hexadecimal characters")]
    InvalidUpstreamCommit,
    #[error("legacy patch bundles require at least one catalog and one selected rule")]
    EmptyLegacyPatchBundle,
    #[error("legacy patch catalogs must be unique")]
    DuplicateLegacyPatchCatalog,
    #[error("legacy patch rule IDs must contain exactly 64 hexadecimal characters")]
    InvalidLegacyRuleId,
    #[error("legacy patch expected match counts must be positive")]
    InvalidLegacyExpectedMatches,
    #[error("every selected legacy patch rule must have a pinned catalog")]
    MissingLegacyPatchCatalog,
    #[error("legacy patch rules cannot be selected more than once")]
    DuplicateLegacyPatchSelection,
    #[error("legacy patch catalog pins must be used by a selected rule")]
    UnusedLegacyPatchCatalog,
    #[error("legacy patch risks cannot be acknowledged more than once")]
    DuplicateLegacyRiskAcknowledgement,
    #[error("every selected legacy patch risk must be acknowledged")]
    LegacyRiskNotAcknowledged,
    #[error("legacy patch risk acknowledgements must correspond to a selected rule")]
    UnusedLegacyRiskAcknowledgement,
    #[error("legacy patch profile must be normalized, sorted, and deduplicated")]
    LegacyPatchProfileNotCanonical,
}

#[derive(Debug, Error)]
pub enum PlanError {
    #[error("deployment plan is already complete")]
    AlreadyComplete,
    #[error("step {actual:?} cannot run before {expected:?}")]
    OutOfOrder { expected: StepId, actual: StepId },
    #[error("step {step:?} requires {expected:?} evidence, not {actual:?}")]
    WrongEvidence {
        step: StepId,
        expected: EvidenceKind,
        actual: EvidenceKind,
    },
    #[error("step evidence must not be empty")]
    MissingEvidence,
    #[error("deployment plan does not contain step {0:?}")]
    UnknownStep(StepId),
    #[error("step {0:?} has not been reached and cannot be invalidated")]
    StepNotReached(StepId),
    #[error("profile is invalid: {0}")]
    InvalidProfile(#[source] ProfileError),
    #[error("deployment plan schema version {0} is not supported")]
    UnsupportedSchema(u8),
    #[error("deployment plan belongs to a different machine profile")]
    ProfileMismatch,
    #[error("deployment plan step sequence is not canonical")]
    InvalidStepSequence,
    #[error("deployment plan step states are inconsistent")]
    InvalidStepState,
    #[error("evidence value does not satisfy step {0:?}")]
    EvidenceValueMismatch(StepId),
    #[error("{0:?} evidence must be a SHA-256 digest")]
    MalformedDigest(EvidenceKind),
}

impl RecoveryMethod {
    pub const fn evidence_value(self) -> &'static str {
        match self {
            Self::DualBios => "dualBios",
            Self::UsbFlashback => "usbFlashback",
            Self::VendorRecovery => "vendorRecovery",
            Self::ExternalSpiProgrammer => "externalSpiProgrammer",
            Self::None => "none",
        }
    }
}

fn step(id: StepId, kind: StepKind, title: &str) -> DeploymentStep {
    DeploymentStep {
        id,
        kind,
        title: title.to_owned(),
        state: StepState::Pending,
        evidence: None,
    }
}

fn expected_evidence(step: StepId) -> EvidenceKind {
    match step {
        StepId::VerifyProfile => EvidenceKind::ExactProfileMatch,
        StepId::ConfirmRecovery => EvidenceKind::RecoveryRouteConfirmed,
        StepId::PreserveOriginalFirmware => EvidenceKind::OriginalFirmwareSha256,
        StepId::PrepareRustDriver => EvidenceKind::RustDriverSha256,
        StepId::ApplyLegacyBoardPatches => EvidenceKind::LegacyPatchReceipt,
        StepId::VerifyPatchedArtifact => EvidenceKind::PatchedFirmwareSha256,
        StepId::FlashWithVendorRoute => EvidenceKind::VendorFlashReceipt,
        StepId::ConfigureFirmwareSetup => EvidenceKind::FirmwareSettingsConfirmed,
        StepId::RebootAfterFirmware | StepId::RebootAfterConfiguration => {
            EvidenceKind::BootObserved
        }
        StepId::VerifyDriverLoaded => EvidenceKind::DriverStatus,
        StepId::WriteNvstrapsConfiguration => EvidenceKind::ConfigurationReadback,
        StepId::VerifyResizableBar => EvidenceKind::ResizableBarObserved,
        StepId::ConfigureNvidiaApplications => EvidenceKind::NvidiaPolicyObserved,
    }
}

fn required_text(field: &'static str, value: String) -> Result<String, ProfileError> {
    let value = value.trim().to_owned();
    if value.is_empty() {
        Err(ProfileError::MissingField(field))
    } else {
        Ok(value)
    }
}

fn compare_field(
    differences: &mut Vec<ProfileDifference>,
    field: &str,
    expected: &str,
    actual: &str,
) {
    if !expected.eq_ignore_ascii_case(actual) {
        differences.push(ProfileDifference::Field {
            field: field.to_owned(),
            expected: expected.to_owned(),
            actual: actual.to_owned(),
        });
    }
}

fn profile_id(
    board_path: BoardPath,
    identity: &MachineIdentity,
    firmware: &FirmwareFingerprint,
    legacy_patches: Option<&LegacyPatchProfile>,
) -> String {
    let mut hasher = Sha256::new();
    hash_field(
        &mut hasher,
        &[match board_path {
            BoardPath::NativeResizableBar => 1,
            BoardPath::LegacyAbove4g => 2,
        }],
    );
    for value in [
        &identity.board_manufacturer,
        &identity.board_product,
        &identity.board_version,
        &identity.bios_vendor,
        &identity.bios_version,
        &identity.bios_release_date,
        firmware.sha256.as_str(),
    ] {
        hash_field(&mut hasher, value.to_ascii_lowercase().as_bytes());
    }
    hash_field(&mut hasher, &firmware.byte_length.to_le_bytes());
    for gpu in &identity.gpus {
        hash_field(&mut hasher, &gpu.vendor_id.to_le_bytes());
        hash_field(&mut hasher, &gpu.device_id.to_le_bytes());
        hash_field(&mut hasher, &gpu.subsystem_vendor_id.to_le_bytes());
        hash_field(&mut hasher, &gpu.subsystem_device_id.to_le_bytes());
        for location in [gpu.location, gpu.bridge_location] {
            hash_field(
                &mut hasher,
                &[location.bus, location.device, location.function],
            );
        }
        hash_field(&mut hasher, &gpu.bar0_base.to_le_bytes());
        hash_field(&mut hasher, &gpu.bar0_top.to_le_bytes());
    }
    if let Some(legacy) = legacy_patches {
        hash_field(&mut hasher, legacy.upstream_commit.as_bytes());
        for pin in &legacy.catalogs {
            hash_field(&mut hasher, &[legacy_catalog_code(pin.catalog)]);
            hash_field(&mut hasher, pin.source_sha256.as_str().as_bytes());
        }
        for selection in &legacy.selections {
            hash_field(&mut hasher, &[legacy_catalog_code(selection.catalog)]);
            hash_field(&mut hasher, selection.rule_id.as_bytes());
            hash_field(&mut hasher, &selection.expected_matches.to_le_bytes());
            for risk in &selection.required_risks {
                hash_field(&mut hasher, &[legacy_risk_code(*risk)]);
            }
        }
        for acknowledgement in &legacy.acknowledgements {
            hash_field(&mut hasher, &[legacy_risk_code(acknowledgement.risk)]);
        }
    }
    let digest = hasher.finalize();
    format!("nvstraps-{}", hex(&digest[..12]))
}

const fn legacy_catalog_code(catalog: LegacyPatchCatalogFile) -> u8 {
    match catalog {
        LegacyPatchCatalogFile::General => 1,
        LegacyPatchCatalogFile::HaswellAbove4g => 2,
        LegacyPatchCatalogFile::IvyBridgeUsb3 => 3,
        LegacyPatchCatalogFile::HaswellUsb3 => 4,
        LegacyPatchCatalogFile::BroadwellUsb3 => 5,
    }
}

const fn legacy_risk_code(risk: LegacyPatchRisk) -> u8 {
    match risk {
        LegacyPatchRisk::DsdtModification => 1,
        LegacyPatchRisk::NvramWhitelist => 2,
        LegacyPatchRisk::UsbControllerBlacklist => 3,
        LegacyPatchRisk::ExperimentalX79 => 4,
    }
}

fn hash_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn hex(bytes: &[u8]) -> String {
    use fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("writing to a string cannot fail");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(device_id: u16, bus: u8) -> GpuFingerprint {
        GpuFingerprint {
            vendor_id: 0x10de,
            device_id,
            subsystem_vendor_id: 0x1462,
            subsystem_device_id: 0x3755,
            location: PciLocation {
                bus,
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
        }
    }

    fn identity(gpus: Vec<GpuFingerprint>) -> MachineIdentity {
        MachineIdentity {
            board_manufacturer: " Micro-Star International ".into(),
            board_product: "PRO Z690-A DDR4(MS-7D25)".into(),
            board_version: "1.0".into(),
            bios_vendor: "American Megatrends International, LLC.".into(),
            bios_version: "1.N0".into(),
            bios_release_date: "2026-03-12".into(),
            gpus,
        }
    }

    fn firmware() -> FirmwareFingerprint {
        FirmwareFingerprint {
            file_name: "E7D25IMS.1N0".into(),
            byte_length: 33_554_432,
            sha256: Sha256Digest::from_bytes(b"firmware"),
        }
    }

    fn legacy_patch_profile() -> LegacyPatchProfile {
        LegacyPatchProfile::create(
            "9c80fdb2cd3db94bdd19c58bd00d5ecf822f6430",
            vec![LegacyPatchCatalogPin {
                catalog: LegacyPatchCatalogFile::General,
                source_sha256: Sha256Digest::from_bytes(b"general catalog"),
            }],
            vec![LegacyPatchSelection {
                catalog: LegacyPatchCatalogFile::General,
                rule_id: "ab".repeat(32),
                expected_matches: 1,
                required_risks: vec![],
            }],
            vec![],
        )
        .unwrap()
    }

    fn profile(path: BoardPath) -> MachineProfile {
        let legacy = (path == BoardPath::LegacyAbove4g).then(legacy_patch_profile);
        MachineProfile::create_with_legacy(
            "Z690 test machine",
            path,
            identity(vec![gpu(0x1e81, 1)]),
            firmware(),
            RecoveryCapability {
                method: RecoveryMethod::UsbFlashback,
                tested_or_documented: true,
                note: "Rear-panel Flash BIOS button with a known-good USB drive".into(),
            },
            legacy,
        )
        .unwrap()
    }

    #[test]
    fn sha256_is_validated_and_normalized() {
        let uppercase = "AB".repeat(32);
        assert_eq!(
            Sha256Digest::parse(uppercase).unwrap().as_str(),
            "ab".repeat(32)
        );
        assert!(Sha256Digest::parse("not-a-hash").is_err());
        assert!(serde_json::from_str::<Sha256Digest>("\"1234\"").is_err());
    }

    #[test]
    fn profile_identity_is_stable_across_gpu_enumeration_order() {
        let first = MachineProfile::create(
            "machine",
            BoardPath::NativeResizableBar,
            identity(vec![gpu(0x1e81, 2), gpu(0x1e84, 1)]),
            firmware(),
            RecoveryCapability {
                method: RecoveryMethod::DualBios,
                tested_or_documented: true,
                note: "hardware selector tested".into(),
            },
        )
        .unwrap();
        let second = MachineProfile::create(
            "renamed machine",
            BoardPath::NativeResizableBar,
            identity(vec![gpu(0x1e84, 1), gpu(0x1e81, 2)]),
            firmware(),
            RecoveryCapability {
                method: RecoveryMethod::DualBios,
                tested_or_documented: true,
                note: "different human note".into(),
            },
        )
        .unwrap();

        assert_eq!(first.profile_id, second.profile_id);
        assert_eq!(first.identity.gpus, second.identity.gpus);
    }

    #[test]
    fn profile_requires_a_real_recovery_route() {
        let error = MachineProfile::create(
            "machine",
            BoardPath::LegacyAbove4g,
            identity(vec![gpu(0x1e81, 1)]),
            firmware(),
            RecoveryCapability {
                method: RecoveryMethod::None,
                tested_or_documented: false,
                note: String::new(),
            },
        )
        .unwrap_err();
        assert!(matches!(error, ProfileError::RecoveryNotEstablished));
    }

    #[test]
    fn legacy_patch_bundle_is_required_and_part_of_machine_identity() {
        let recovery = RecoveryCapability {
            method: RecoveryMethod::ExternalSpiProgrammer,
            tested_or_documented: true,
            note: "verified SPI restore".into(),
        };
        let missing = MachineProfile::create(
            "legacy machine",
            BoardPath::LegacyAbove4g,
            identity(vec![gpu(0x1e81, 1)]),
            firmware(),
            recovery.clone(),
        )
        .unwrap_err();
        assert!(matches!(missing, ProfileError::LegacyPatchProfileRequired));

        let forbidden = MachineProfile::create_with_legacy(
            "modern machine",
            BoardPath::NativeResizableBar,
            identity(vec![gpu(0x1e81, 1)]),
            firmware(),
            recovery.clone(),
            Some(legacy_patch_profile()),
        )
        .unwrap_err();
        assert!(matches!(
            forbidden,
            ProfileError::LegacyPatchProfileForbidden
        ));

        let first = profile(BoardPath::LegacyAbove4g);
        let mut changed_bundle = legacy_patch_profile();
        changed_bundle.selections[0].expected_matches = 2;
        let second = MachineProfile::create_with_legacy(
            "legacy machine",
            BoardPath::LegacyAbove4g,
            identity(vec![gpu(0x1e81, 1)]),
            firmware(),
            recovery,
            Some(changed_bundle),
        )
        .unwrap();
        assert_ne!(first.profile_id, second.profile_id);
    }

    #[test]
    fn native_schema_one_profiles_remain_loadable() {
        let mut legacy_schema = profile(BoardPath::NativeResizableBar);
        legacy_schema.schema_version = 1;

        legacy_schema.validate().unwrap();
        DeploymentPlan::for_profile(&legacy_schema).unwrap();
    }

    #[test]
    fn topology_or_source_image_changes_are_hard_mismatches() {
        let profile = profile(BoardPath::NativeResizableBar);
        let mut changed = identity(vec![gpu(0x1e81, 1)]);
        changed.gpus[0].bar0_base += 0x1000;
        let other_firmware = FirmwareFingerprint {
            sha256: Sha256Digest::from_bytes(b"other"),
            ..firmware()
        };
        let comparison = profile.compare(&changed, Some(&other_firmware));
        assert_eq!(
            comparison.differences,
            vec![
                ProfileDifference::GpuTopology,
                ProfileDifference::FirmwareImage
            ]
        );
    }

    #[test]
    fn legacy_plan_adds_one_explicit_patch_step() {
        let modern = DeploymentPlan::for_profile(&profile(BoardPath::NativeResizableBar)).unwrap();
        let legacy = DeploymentPlan::for_profile(&profile(BoardPath::LegacyAbove4g)).unwrap();
        assert!(
            !modern
                .steps
                .iter()
                .any(|step| step.id == StepId::ApplyLegacyBoardPatches)
        );
        assert!(
            legacy
                .steps
                .iter()
                .any(|step| step.id == StepId::ApplyLegacyBoardPatches)
        );
        assert_eq!(legacy.steps.len(), modern.steps.len() + 1);
        assert_eq!(legacy.active_step().unwrap().id, StepId::VerifyProfile);
    }

    #[test]
    fn plan_requires_ordered_typed_evidence_and_can_roll_back() {
        let machine = profile(BoardPath::NativeResizableBar);
        let mut plan = DeploymentPlan::for_profile(&machine).unwrap();
        let wrong = StepEvidence::new(EvidenceKind::RecoveryRouteConfirmed, "confirmed").unwrap();
        assert!(matches!(
            plan.complete(StepId::VerifyProfile, wrong),
            Err(PlanError::WrongEvidence { .. })
        ));
        let exact =
            StepEvidence::new(EvidenceKind::ExactProfileMatch, machine.profile_id.clone()).unwrap();
        plan.complete(StepId::VerifyProfile, exact).unwrap();
        assert_eq!(plan.active_step().unwrap().id, StepId::ConfirmRecovery);
        assert!(matches!(
            plan.complete(
                StepId::PrepareRustDriver,
                StepEvidence::new(EvidenceKind::RustDriverSha256, "ab".repeat(32)).unwrap()
            ),
            Err(PlanError::OutOfOrder { .. })
        ));

        plan.invalidate_from(StepId::VerifyProfile).unwrap();
        assert_eq!(plan.active_step().unwrap().id, StepId::VerifyProfile);
        assert!(plan.steps.iter().all(|step| step.evidence.is_none()));
        assert_eq!(plan.revision, 2);
    }

    #[test]
    fn deserialized_profiles_and_plans_must_revalidate() {
        let machine = profile(BoardPath::LegacyAbove4g);
        let mut plan = DeploymentPlan::for_profile(&machine).unwrap();
        plan.validate_for(&machine).unwrap();

        plan.steps[0].state = StepState::Pending;
        plan.steps[1].state = StepState::Ready;
        assert!(matches!(
            plan.validate_for(&machine),
            Err(PlanError::InvalidStepState)
        ));

        let mut tampered = machine.clone();
        tampered.identity.bios_version = "unexpected".into();
        assert!(matches!(
            tampered.validate(),
            Err(ProfileError::ProfileIdMismatch)
        ));
    }

    #[test]
    fn future_steps_cannot_create_a_second_ready_step() {
        let machine = profile(BoardPath::NativeResizableBar);
        let mut plan = DeploymentPlan::for_profile(&machine).unwrap();
        assert!(matches!(
            plan.invalidate_from(StepId::PrepareRustDriver),
            Err(PlanError::StepNotReached(StepId::PrepareRustDriver))
        ));
        plan.validate_for(&machine).unwrap();
    }
}
