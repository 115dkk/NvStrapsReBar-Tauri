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
mod workflow;

pub use store::{
    ArtifactKind, DeploymentPackageFile, DeploymentPackageManifest, DeploymentPackageReceipt,
    DeploymentStore, PackageFilePurpose, ProvisionedDeployment, StoreError, StoredArtifact,
};
pub use workflow::DeploymentWorkflow;

pub const PROFILE_SCHEMA_VERSION: u8 = 4;
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

    /// Compares every pinned identity field, including the firmware-assigned BAR0 ranges.
    pub fn compare_exact(&self, current: &Self) -> ProfileMatch {
        compare_machine_identity(self, current, AllowedIdentityChange::None)
    }

    /// Compares stable machine identity while allowing firmware to relocate BAR0 during a
    /// controlled configuration reboot boundary.
    pub fn compare_allowing_bar0_relocation(&self, current: &Self) -> ProfileMatch {
        compare_machine_identity(self, current, AllowedIdentityChange::Bar0Relocation)
    }

    /// Compares stable machine identity while allowing the pinned vendor firmware transition to
    /// update its revision metadata and relocate BAR0. BIOS vendor, board identity, and GPU
    /// topology remain exact.
    pub fn compare_allowing_firmware_transition(&self, current: &Self) -> ProfileMatch {
        compare_machine_identity(
            self,
            current,
            AllowedIdentityChange::FirmwareRevisionAndBar0,
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootObservation {
    pub observed_at_unix_ms: u64,
    pub identity: MachineIdentity,
}

impl BootObservation {
    pub fn new(observed_at_unix_ms: u64, identity: MachineIdentity) -> Result<Self, PlanError> {
        if observed_at_unix_ms == 0 {
            return Err(PlanError::MalformedBootObservation);
        }
        let identity = identity
            .normalized()
            .map_err(|_| PlanError::MalformedBootObservation)?;
        Ok(Self {
            observed_at_unix_ms,
            identity,
        })
    }

    pub fn to_evidence_value(&self) -> Result<String, PlanError> {
        serde_json::to_string(self).map_err(|_| PlanError::MalformedBootObservation)
    }

    pub fn parse(value: &str) -> Result<Self, PlanError> {
        let decoded: Self =
            serde_json::from_str(value).map_err(|_| PlanError::MalformedBootObservation)?;
        let canonical = Self::new(decoded.observed_at_unix_ms, decoded.identity)?;
        if canonical.to_evidence_value()? != value {
            return Err(PlanError::MalformedBootObservation);
        }
        Ok(canonical)
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FirmwareTargetPolicy {
    #[default]
    RequireUnique,
    PatchEveryDxeDomain,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FirmwareInstallMethod {
    FirmwareSetupUtility,
    UsbFlashback,
    VendorWindowsUtility,
    ExternalSpiProgrammer,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareInstallRoute {
    pub method: FirmwareInstallMethod,
    pub artifact_file_name: String,
    pub tested_or_documented: bool,
    pub official_instructions_url: String,
    pub note: String,
}

impl FirmwareInstallRoute {
    fn normalized(mut self) -> Result<Self, ProfileError> {
        self.artifact_file_name = required_text(
            "firmware install artifact file name",
            self.artifact_file_name,
        )?;
        if !is_safe_windows_file_name(&self.artifact_file_name) {
            return Err(ProfileError::InvalidInstallArtifactFileName);
        }
        if !self.tested_or_documented {
            return Err(ProfileError::FirmwareInstallRouteNotEstablished);
        }
        self.official_instructions_url = required_text(
            "official firmware install instructions URL",
            self.official_instructions_url,
        )?;
        if !self.official_instructions_url.starts_with("https://")
            || self
                .official_instructions_url
                .chars()
                .any(char::is_whitespace)
        {
            return Err(ProfileError::InvalidOfficialInstructionsUrl);
        }
        self.note = required_text("firmware install note", self.note)?;
        Ok(self)
    }
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
    #[serde(default)]
    pub firmware_target_policy: FirmwareTargetPolicy,
    #[serde(default)]
    pub firmware_install: Option<FirmwareInstallRoute>,
}

struct MachineProfileCreationOptions {
    legacy_patches: Option<LegacyPatchProfile>,
    firmware_target_policy: FirmwareTargetPolicy,
}

impl MachineProfile {
    pub fn create(
        display_name: impl Into<String>,
        board_path: BoardPath,
        identity: MachineIdentity,
        original_firmware: FirmwareFingerprint,
        recovery: RecoveryCapability,
        firmware_install: FirmwareInstallRoute,
    ) -> Result<Self, ProfileError> {
        Self::create_with_target_policy(
            display_name,
            board_path,
            identity,
            original_firmware,
            recovery,
            firmware_install,
            FirmwareTargetPolicy::RequireUnique,
        )
    }

    pub fn create_with_target_policy(
        display_name: impl Into<String>,
        board_path: BoardPath,
        identity: MachineIdentity,
        original_firmware: FirmwareFingerprint,
        recovery: RecoveryCapability,
        firmware_install: FirmwareInstallRoute,
        firmware_target_policy: FirmwareTargetPolicy,
    ) -> Result<Self, ProfileError> {
        Self::create_with_options(
            display_name,
            board_path,
            identity,
            original_firmware,
            recovery,
            firmware_install,
            MachineProfileCreationOptions {
                legacy_patches: None,
                firmware_target_policy,
            },
        )
    }

    pub fn create_with_legacy(
        display_name: impl Into<String>,
        board_path: BoardPath,
        identity: MachineIdentity,
        original_firmware: FirmwareFingerprint,
        recovery: RecoveryCapability,
        firmware_install: FirmwareInstallRoute,
        legacy_patches: Option<LegacyPatchProfile>,
    ) -> Result<Self, ProfileError> {
        Self::create_with_options(
            display_name,
            board_path,
            identity,
            original_firmware,
            recovery,
            firmware_install,
            MachineProfileCreationOptions {
                legacy_patches,
                firmware_target_policy: FirmwareTargetPolicy::RequireUnique,
            },
        )
    }

    pub fn create_legacy_with_target_policy(
        display_name: impl Into<String>,
        identity: MachineIdentity,
        original_firmware: FirmwareFingerprint,
        recovery: RecoveryCapability,
        firmware_install: FirmwareInstallRoute,
        legacy_patches: LegacyPatchProfile,
        firmware_target_policy: FirmwareTargetPolicy,
    ) -> Result<Self, ProfileError> {
        Self::create_with_options(
            display_name,
            BoardPath::LegacyAbove4g,
            identity,
            original_firmware,
            recovery,
            firmware_install,
            MachineProfileCreationOptions {
                legacy_patches: Some(legacy_patches),
                firmware_target_policy,
            },
        )
    }

    fn create_with_options(
        display_name: impl Into<String>,
        board_path: BoardPath,
        identity: MachineIdentity,
        mut original_firmware: FirmwareFingerprint,
        mut recovery: RecoveryCapability,
        firmware_install: FirmwareInstallRoute,
        options: MachineProfileCreationOptions,
    ) -> Result<Self, ProfileError> {
        let MachineProfileCreationOptions {
            legacy_patches,
            firmware_target_policy,
        } = options;
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
        validate_firmware_target_policy(firmware_target_policy, &recovery)?;
        let firmware_install = firmware_install.normalized()?;
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
            Some(ProfileIdRecovery::Full(&recovery)),
            Some(&firmware_install),
            Some(firmware_target_policy),
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
            firmware_target_policy,
            firmware_install: Some(firmware_install),
        };
        profile.validate()?;
        Ok(profile)
    }

    pub fn validate(&self) -> Result<(), ProfileError> {
        if !matches!(self.schema_version, 1 | 2 | 3 | PROFILE_SCHEMA_VERSION) {
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
        let normalized_recovery_note = required_text("recovery note", self.recovery.note.clone())?;
        if self.schema_version == PROFILE_SCHEMA_VERSION
            && normalized_recovery_note != self.recovery.note
        {
            return Err(ProfileError::RecoveryCapabilityNotCanonical);
        }
        if self.schema_version != PROFILE_SCHEMA_VERSION
            && self.firmware_target_policy != FirmwareTargetPolicy::RequireUnique
        {
            return Err(ProfileError::FirmwareTargetPolicyRequiresCurrentSchema);
        }
        validate_firmware_target_policy(self.firmware_target_policy, &self.recovery)?;
        match (self.schema_version, &self.firmware_install) {
            (3 | PROFILE_SCHEMA_VERSION, Some(route)) => {
                if route.clone().normalized()? != *route {
                    return Err(ProfileError::FirmwareInstallRouteNotCanonical);
                }
            }
            (3 | PROFILE_SCHEMA_VERSION, None) => {
                return Err(ProfileError::FirmwareInstallRouteRequired);
            }
            (1 | 2, None) => {}
            (1 | 2, Some(_)) => return Err(ProfileError::UnsupportedSchema(self.schema_version)),
            _ => return Err(ProfileError::UnsupportedSchema(self.schema_version)),
        }
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
        let (recovery, firmware_install, firmware_target_policy) = match self.schema_version {
            1 | 2 => (None, None, None),
            3 => (
                Some(ProfileIdRecovery::MethodOnly(self.recovery.method)),
                self.firmware_install.as_ref(),
                None,
            ),
            PROFILE_SCHEMA_VERSION => (
                Some(ProfileIdRecovery::Full(&self.recovery)),
                self.firmware_install.as_ref(),
                Some(self.firmware_target_policy),
            ),
            _ => return Err(ProfileError::UnsupportedSchema(self.schema_version)),
        };
        let expected = profile_id(
            self.board_path,
            &self.identity,
            &self.original_firmware,
            self.legacy_patches.as_ref(),
            recovery,
            firmware_install,
            firmware_target_policy,
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
        let mut differences = self.identity.compare_exact(current).differences;
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
                | EvidenceKind::LegacyPatchReceipt
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

    pub fn require_active(&self, expected: StepId) -> Result<(), PlanError> {
        match self.active_step() {
            Some(step) if step.id == expected => Ok(()),
            Some(step) => Err(PlanError::OutOfOrder {
                expected: step.id,
                actual: expected,
            }),
            None => Err(PlanError::AlreadyComplete),
        }
    }

    pub fn is_step_completed(&self, step_id: StepId) -> bool {
        self.steps
            .iter()
            .any(|step| step.id == step_id && step.state == StepState::Completed)
    }

    pub fn completed_evidence(&self, step_id: StepId) -> Result<&StepEvidence, PlanError> {
        let step = self
            .steps
            .iter()
            .find(|step| step.id == step_id)
            .ok_or(PlanError::UnknownStep(step_id))?;
        if step.state != StepState::Completed {
            return Err(PlanError::StepNotCompleted(step_id));
        }
        let evidence = step.evidence.as_ref().ok_or(PlanError::MissingEvidence)?;
        let expected = expected_evidence(step_id);
        if evidence.kind != expected {
            return Err(PlanError::WrongEvidence {
                step: step_id,
                expected,
                actual: evidence.kind,
            });
        }
        Ok(evidence)
    }

    pub fn latest_boot_observation(&self) -> Result<Option<BootObservation>, PlanError> {
        self.steps
            .iter()
            .rev()
            .find(|step| {
                step.state == StepState::Completed
                    && matches!(
                        step.id,
                        StepId::RebootAfterFirmware | StepId::RebootAfterConfiguration
                    )
            })
            .map(|step| {
                let evidence = step.evidence.as_ref().ok_or(PlanError::MissingEvidence)?;
                BootObservation::parse(&evidence.value)
            })
            .transpose()
    }

    pub fn require_completed_value(
        &self,
        step_id: StepId,
        expected: &str,
    ) -> Result<(), PlanError> {
        if self.completed_evidence(step_id)?.value == expected {
            Ok(())
        } else {
            Err(PlanError::EvidenceValueMismatch(step_id))
        }
    }

    pub fn complete_with_value(
        &mut self,
        step_id: StepId,
        value: impl Into<String>,
    ) -> Result<(), PlanError> {
        let evidence = StepEvidence::new(expected_evidence(step_id), value)?;
        self.complete(step_id, evidence)
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
            StepId::RebootAfterFirmware | StepId::RebootAfterConfiguration => {
                BootObservation::parse(&evidence.value).map(|_| ())
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
    #[error("the recovery capability note must be trimmed and canonical")]
    RecoveryCapabilityNotCanonical,
    #[error(
        "patching every DXE domain requires USB Flashback or an external SPI programmer as a tested or documented boot-independent recovery route"
    )]
    FirmwareTargetPolicyRequiresBootIndependentRecovery,
    #[error("non-default firmware target policies require the current profile schema")]
    FirmwareTargetPolicyRequiresCurrentSchema,
    #[error("a tested or documented firmware install route is required before deployment")]
    FirmwareInstallRouteNotEstablished,
    #[error("new machine profiles require a pinned firmware install route")]
    FirmwareInstallRouteRequired,
    #[error("the firmware install route must be trimmed and canonical")]
    FirmwareInstallRouteNotCanonical,
    #[error("the firmware install artifact must be a safe Windows file name, not a path")]
    InvalidInstallArtifactFileName,
    #[error("official firmware install instructions must use an HTTPS URL without whitespace")]
    InvalidOfficialInstructionsUrl,
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
    #[error("step {0:?} is not completed")]
    StepNotCompleted(StepId),
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
    #[error("boot evidence must be a canonical observed time and machine identity")]
    MalformedBootObservation,
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

fn is_safe_windows_file_name(value: &str) -> bool {
    if value.len() > 255
        || value.ends_with(['.', ' '])
        || value.bytes().any(|byte| byte < 32)
        || value.chars().any(|character| {
            matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
        })
    {
        return false;
    }
    let stem = value
        .split_once('.')
        .map_or(value, |(stem, _)| stem)
        .to_ascii_uppercase();
    !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
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

#[derive(Clone, Copy)]
enum AllowedIdentityChange {
    None,
    Bar0Relocation,
    FirmwareRevisionAndBar0,
}

fn compare_machine_identity(
    expected: &MachineIdentity,
    current: &MachineIdentity,
    allowed_change: AllowedIdentityChange,
) -> ProfileMatch {
    let mut differences = Vec::new();
    let Ok(expected) = expected.clone().normalized() else {
        differences.push(ProfileDifference::InvalidCurrentIdentity);
        return ProfileMatch { differences };
    };
    let Ok(current) = current.clone().normalized() else {
        differences.push(ProfileDifference::InvalidCurrentIdentity);
        return ProfileMatch { differences };
    };
    for (field, expected, actual) in [
        (
            "boardManufacturer",
            &expected.board_manufacturer,
            &current.board_manufacturer,
        ),
        (
            "boardProduct",
            &expected.board_product,
            &current.board_product,
        ),
        (
            "boardVersion",
            &expected.board_version,
            &current.board_version,
        ),
        ("biosVendor", &expected.bios_vendor, &current.bios_vendor),
    ] {
        compare_field(&mut differences, field, expected, actual);
    }
    if !matches!(
        allowed_change,
        AllowedIdentityChange::FirmwareRevisionAndBar0
    ) {
        compare_field(
            &mut differences,
            "biosVersion",
            &expected.bios_version,
            &current.bios_version,
        );
        compare_field(
            &mut differences,
            "biosReleaseDate",
            &expected.bios_release_date,
            &current.bios_release_date,
        );
    }
    let allow_bar0_relocation = !matches!(allowed_change, AllowedIdentityChange::None);
    let gpu_topology_matches = expected.gpus.len() == current.gpus.len()
        && expected.gpus.iter().all(|expected_gpu| {
            current.gpus.iter().any(|current_gpu| {
                expected_gpu.vendor_id == current_gpu.vendor_id
                    && expected_gpu.device_id == current_gpu.device_id
                    && expected_gpu.subsystem_vendor_id == current_gpu.subsystem_vendor_id
                    && expected_gpu.subsystem_device_id == current_gpu.subsystem_device_id
                    && expected_gpu.location == current_gpu.location
                    && expected_gpu.bridge_location == current_gpu.bridge_location
                    && (allow_bar0_relocation
                        || (expected_gpu.bar0_base == current_gpu.bar0_base
                            && expected_gpu.bar0_top == current_gpu.bar0_top))
            })
        });
    if !gpu_topology_matches {
        differences.push(ProfileDifference::GpuTopology);
    }
    ProfileMatch { differences }
}

fn validate_firmware_target_policy(
    policy: FirmwareTargetPolicy,
    recovery: &RecoveryCapability,
) -> Result<(), ProfileError> {
    if policy == FirmwareTargetPolicy::PatchEveryDxeDomain
        && !(recovery.tested_or_documented
            && matches!(
                recovery.method,
                RecoveryMethod::UsbFlashback | RecoveryMethod::ExternalSpiProgrammer
            ))
    {
        return Err(ProfileError::FirmwareTargetPolicyRequiresBootIndependentRecovery);
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum ProfileIdRecovery<'a> {
    MethodOnly(RecoveryMethod),
    Full(&'a RecoveryCapability),
}

fn profile_id(
    board_path: BoardPath,
    identity: &MachineIdentity,
    firmware: &FirmwareFingerprint,
    legacy_patches: Option<&LegacyPatchProfile>,
    recovery: Option<ProfileIdRecovery<'_>>,
    firmware_install: Option<&FirmwareInstallRoute>,
    firmware_target_policy: Option<FirmwareTargetPolicy>,
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
    match recovery {
        Some(ProfileIdRecovery::MethodOnly(method)) => {
            // Schema 3 bound only the recovery method. Keep that byte stream exact.
            hash_field(&mut hasher, &[recovery_method_code(method)]);
        }
        Some(ProfileIdRecovery::Full(recovery)) => {
            hash_field(&mut hasher, b"recovery-capability-v1");
            hash_field(&mut hasher, &[recovery_method_code(recovery.method)]);
            hash_field(&mut hasher, &[u8::from(recovery.tested_or_documented)]);
            hash_field(&mut hasher, recovery.note.as_bytes());
        }
        None => {}
    }
    if let Some(route) = firmware_install {
        hash_field(&mut hasher, &[firmware_install_method_code(route.method)]);
        hash_field(&mut hasher, route.artifact_file_name.as_bytes());
        hash_field(&mut hasher, route.official_instructions_url.as_bytes());
        hash_field(&mut hasher, route.note.as_bytes());
    }
    if let Some(firmware_target_policy) = firmware_target_policy {
        hash_field(&mut hasher, b"firmware-target-policy");
        hash_field(
            &mut hasher,
            &[firmware_target_policy_code(firmware_target_policy)],
        );
    }
    let digest = hasher.finalize();
    format!("nvstraps-{}", hex(&digest[..12]))
}

const fn firmware_target_policy_code(policy: FirmwareTargetPolicy) -> u8 {
    match policy {
        FirmwareTargetPolicy::RequireUnique => 1,
        FirmwareTargetPolicy::PatchEveryDxeDomain => 2,
    }
}

const fn recovery_method_code(method: RecoveryMethod) -> u8 {
    match method {
        RecoveryMethod::DualBios => 1,
        RecoveryMethod::UsbFlashback => 2,
        RecoveryMethod::VendorRecovery => 3,
        RecoveryMethod::ExternalSpiProgrammer => 4,
        RecoveryMethod::None => 5,
    }
}

const fn firmware_install_method_code(method: FirmwareInstallMethod) -> u8 {
    match method {
        FirmwareInstallMethod::FirmwareSetupUtility => 1,
        FirmwareInstallMethod::UsbFlashback => 2,
        FirmwareInstallMethod::VendorWindowsUtility => 3,
        FirmwareInstallMethod::ExternalSpiProgrammer => 4,
    }
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
            "a".repeat(40),
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

    fn firmware_install() -> FirmwareInstallRoute {
        FirmwareInstallRoute {
            method: FirmwareInstallMethod::FirmwareSetupUtility,
            artifact_file_name: "E7D25IMS.1N0".into(),
            tested_or_documented: true,
            official_instructions_url:
                "https://download.msi.com/archive/mnu_exe/mb/PROZ690-AWIFIDDR4_PROZ690-ADDR4100x150.pdf"
                    .into(),
            note: "Select the pinned image in M-FLASH".into(),
        }
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
            firmware_install(),
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
            firmware_install(),
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
                note: "hardware selector tested".into(),
            },
            firmware_install(),
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
            firmware_install(),
        )
        .unwrap_err();
        assert!(matches!(error, ProfileError::RecoveryNotEstablished));
    }

    #[test]
    fn existing_profile_constructors_require_a_unique_dxe_target() {
        let modern = MachineProfile::create(
            "modern machine",
            BoardPath::NativeResizableBar,
            identity(vec![gpu(0x1e81, 1)]),
            firmware(),
            RecoveryCapability {
                method: RecoveryMethod::UsbFlashback,
                tested_or_documented: true,
                note: "rear-panel flashback tested".into(),
            },
            firmware_install(),
        )
        .unwrap();
        let legacy = profile(BoardPath::LegacyAbove4g);

        assert_eq!(
            modern.firmware_target_policy,
            FirmwareTargetPolicy::RequireUnique
        );
        assert_eq!(
            legacy.firmware_target_policy,
            FirmwareTargetPolicy::RequireUnique
        );
    }

    #[test]
    fn missing_serialized_target_policy_defaults_without_changing_the_profile_id() {
        let profile = profile(BoardPath::NativeResizableBar);
        let mut serialized = serde_json::to_value(&profile).unwrap();
        serialized
            .as_object_mut()
            .unwrap()
            .remove("firmwareTargetPolicy");

        let loaded: MachineProfile = serde_json::from_value(serialized).unwrap();

        assert_eq!(
            loaded.firmware_target_policy,
            FirmwareTargetPolicy::RequireUnique
        );
        assert_eq!(loaded.profile_id, profile.profile_id);
        loaded.validate().unwrap();
    }

    #[test]
    fn patch_every_dxe_domain_is_profile_bound_and_requires_boot_independent_recovery() {
        for method in [
            RecoveryMethod::UsbFlashback,
            RecoveryMethod::ExternalSpiProgrammer,
        ] {
            MachineProfile::create_with_target_policy(
                "multi-domain machine",
                BoardPath::NativeResizableBar,
                identity(vec![gpu(0x1e81, 1)]),
                firmware(),
                RecoveryCapability {
                    method,
                    tested_or_documented: true,
                    note: "boot-independent recovery established".into(),
                },
                firmware_install(),
                FirmwareTargetPolicy::PatchEveryDxeDomain,
            )
            .unwrap();
        }
        MachineProfile::create_legacy_with_target_policy(
            "legacy multi-domain machine",
            identity(vec![gpu(0x1e81, 1)]),
            firmware(),
            RecoveryCapability {
                method: RecoveryMethod::ExternalSpiProgrammer,
                tested_or_documented: true,
                note: "verified external restore".into(),
            },
            firmware_install(),
            legacy_patch_profile(),
            FirmwareTargetPolicy::PatchEveryDxeDomain,
        )
        .unwrap();

        for method in [RecoveryMethod::DualBios, RecoveryMethod::VendorRecovery] {
            let error = MachineProfile::create_with_target_policy(
                "unsafe multi-domain machine",
                BoardPath::NativeResizableBar,
                identity(vec![gpu(0x1e81, 1)]),
                firmware(),
                RecoveryCapability {
                    method,
                    tested_or_documented: true,
                    note: "recovery route established".into(),
                },
                firmware_install(),
                FirmwareTargetPolicy::PatchEveryDxeDomain,
            )
            .unwrap_err();
            assert!(matches!(
                error,
                ProfileError::FirmwareTargetPolicyRequiresBootIndependentRecovery
            ));
        }

        let untested_flashback = MachineProfile::create_with_target_policy(
            "untested flashback machine",
            BoardPath::NativeResizableBar,
            identity(vec![gpu(0x1e81, 1)]),
            firmware(),
            RecoveryCapability {
                method: RecoveryMethod::UsbFlashback,
                tested_or_documented: false,
                note: "not yet verified".into(),
            },
            firmware_install(),
            FirmwareTargetPolicy::PatchEveryDxeDomain,
        )
        .unwrap_err();
        assert!(matches!(
            untested_flashback,
            ProfileError::RecoveryNotEstablished
        ));

        let recovery = RecoveryCapability {
            method: RecoveryMethod::ExternalSpiProgrammer,
            tested_or_documented: true,
            note: "verified external restore".into(),
        };
        let unique = MachineProfile::create_with_target_policy(
            "same machine",
            BoardPath::NativeResizableBar,
            identity(vec![gpu(0x1e81, 1)]),
            firmware(),
            recovery.clone(),
            firmware_install(),
            FirmwareTargetPolicy::RequireUnique,
        )
        .unwrap();
        let every = MachineProfile::create_with_target_policy(
            "same machine",
            BoardPath::NativeResizableBar,
            identity(vec![gpu(0x1e81, 1)]),
            firmware(),
            recovery,
            firmware_install(),
            FirmwareTargetPolicy::PatchEveryDxeDomain,
        )
        .unwrap();
        assert_ne!(unique.profile_id, every.profile_id);

        let mut tampered = every.clone();
        tampered.firmware_target_policy = FirmwareTargetPolicy::RequireUnique;
        assert!(matches!(
            tampered.validate(),
            Err(ProfileError::ProfileIdMismatch)
        ));

        let mut changed_note = every.clone();
        changed_note.recovery.note = "different verified external restore".into();
        assert!(matches!(
            changed_note.validate(),
            Err(ProfileError::ProfileIdMismatch)
        ));

        let mut changed_authority = every;
        changed_authority.recovery.method = RecoveryMethod::UsbFlashback;
        assert!(matches!(
            changed_authority.validate(),
            Err(ProfileError::ProfileIdMismatch)
        ));
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
            firmware_install(),
        )
        .unwrap_err();
        assert!(matches!(missing, ProfileError::LegacyPatchProfileRequired));

        let forbidden = MachineProfile::create_with_legacy(
            "modern machine",
            BoardPath::NativeResizableBar,
            identity(vec![gpu(0x1e81, 1)]),
            firmware(),
            recovery.clone(),
            firmware_install(),
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
            firmware_install(),
            Some(changed_bundle),
        )
        .unwrap();
        assert_ne!(first.profile_id, second.profile_id);
    }

    #[test]
    fn earlier_profile_schemas_remain_loadable_with_their_historical_id_rules() {
        for (schema_version, path) in [
            (1, BoardPath::NativeResizableBar),
            (2, BoardPath::LegacyAbove4g),
        ] {
            let mut legacy_schema = profile(path);
            legacy_schema.schema_version = schema_version;
            legacy_schema.firmware_install = None;
            legacy_schema.profile_id = profile_id(
                legacy_schema.board_path,
                &legacy_schema.identity,
                &legacy_schema.original_firmware,
                legacy_schema.legacy_patches.as_ref(),
                None,
                None,
                None,
            );

            legacy_schema.validate().unwrap();
            DeploymentPlan::for_profile(&legacy_schema).unwrap();
        }

        for path in [BoardPath::NativeResizableBar, BoardPath::LegacyAbove4g] {
            let mut schema_three = profile(path);
            schema_three.schema_version = 3;
            schema_three.profile_id = profile_id(
                schema_three.board_path,
                &schema_three.identity,
                &schema_three.original_firmware,
                schema_three.legacy_patches.as_ref(),
                Some(ProfileIdRecovery::MethodOnly(schema_three.recovery.method)),
                schema_three.firmware_install.as_ref(),
                None,
            );
            let historical_profile_id = match path {
                BoardPath::NativeResizableBar => "nvstraps-62725843391e03ffc99cbbec",
                BoardPath::LegacyAbove4g => "nvstraps-a1e7b0aa82608f4ce6f7e4f8",
            };
            assert_eq!(schema_three.profile_id, historical_profile_id);

            schema_three.validate().unwrap();
            DeploymentPlan::for_profile(&schema_three).unwrap();

            let mut serialized = serde_json::to_value(&schema_three).unwrap();
            serialized
                .as_object_mut()
                .unwrap()
                .remove("firmwareTargetPolicy");
            let loaded: MachineProfile = serde_json::from_value(serialized).unwrap();
            loaded.validate().unwrap();

            let mut forbidden_policy = schema_three;
            forbidden_policy.firmware_target_policy = FirmwareTargetPolicy::PatchEveryDxeDomain;
            assert!(matches!(
                forbidden_policy.validate(),
                Err(ProfileError::FirmwareTargetPolicyRequiresCurrentSchema)
            ));
        }
    }

    #[test]
    fn install_route_is_safe_canonical_and_part_of_the_profile_id() {
        let first = profile(BoardPath::NativeResizableBar);
        let mut route = firmware_install();
        route.method = FirmwareInstallMethod::UsbFlashback;
        route.artifact_file_name = "MSI.ROM".into();
        route.note = "Use only the rear Flash BIOS port".into();
        let second = MachineProfile::create(
            "same machine",
            BoardPath::NativeResizableBar,
            identity(vec![gpu(0x1e81, 1)]),
            firmware(),
            first.recovery.clone(),
            route,
        )
        .unwrap();
        assert_ne!(first.profile_id, second.profile_id);

        let mut unsafe_route = firmware_install();
        unsafe_route.artifact_file_name = "../MSI.ROM".into();
        let error = MachineProfile::create(
            "unsafe route",
            BoardPath::NativeResizableBar,
            identity(vec![gpu(0x1e81, 1)]),
            firmware(),
            first.recovery,
            unsafe_route,
        )
        .unwrap_err();
        assert!(matches!(
            error,
            ProfileError::InvalidInstallArtifactFileName
        ));
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
    fn controlled_boot_identity_distinguishes_firmware_and_bar0_transitions() {
        let expected = profile(BoardPath::NativeResizableBar).identity;
        let mut relocated = expected.clone();
        relocated.gpus[0].bar0_base = 0x1_8000_0000;
        relocated.gpus[0].bar0_top = 0x1_80ff_ffff;

        assert!(!expected.compare_exact(&relocated).is_exact());
        assert!(
            expected
                .compare_allowing_bar0_relocation(&relocated)
                .is_exact()
        );
        let mut firmware_transition = relocated.clone();
        firmware_transition.bios_version = "1.O0".into();
        firmware_transition.bios_release_date = "2026-08-14".into();
        assert!(
            !expected
                .compare_allowing_bar0_relocation(&firmware_transition)
                .is_exact()
        );
        assert!(
            expected
                .compare_allowing_firmware_transition(&firmware_transition)
                .is_exact()
        );
        let mut different_vendor = firmware_transition.clone();
        different_vendor.bios_vendor = "Different firmware vendor".into();
        assert!(
            !expected
                .compare_allowing_firmware_transition(&different_vendor)
                .is_exact()
        );
        let mut different_gpu = firmware_transition.clone();
        different_gpu.gpus[0].device_id ^= 1;
        assert!(
            !expected
                .compare_allowing_firmware_transition(&different_gpu)
                .is_exact()
        );

        let observation = BootObservation::new(1_786_654_321_000, firmware_transition).unwrap();
        let encoded = observation.to_evidence_value().unwrap();
        assert_eq!(BootObservation::parse(&encoded).unwrap(), observation);
        assert!(BootObservation::parse(&format!(" {encoded}")).is_err());
        assert!(BootObservation::new(0, expected).is_err());
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
    fn plan_interface_owns_step_queries_values_and_canonical_evidence() {
        let machine = profile(BoardPath::NativeResizableBar);
        let mut plan = DeploymentPlan::for_profile(&machine).unwrap();

        plan.require_active(StepId::VerifyProfile).unwrap();
        assert!(matches!(
            plan.require_active(StepId::ConfirmRecovery),
            Err(PlanError::OutOfOrder { .. })
        ));
        assert!(!plan.is_step_completed(StepId::VerifyProfile));
        assert!(matches!(
            plan.completed_evidence(StepId::VerifyProfile),
            Err(PlanError::StepNotCompleted(StepId::VerifyProfile))
        ));

        plan.complete_with_value(StepId::VerifyProfile, machine.profile_id.clone())
            .unwrap();
        assert!(plan.is_step_completed(StepId::VerifyProfile));
        assert_eq!(
            plan.completed_evidence(StepId::VerifyProfile).unwrap().kind,
            EvidenceKind::ExactProfileMatch
        );
        plan.require_completed_value(StepId::VerifyProfile, &machine.profile_id)
            .unwrap();
        assert!(matches!(
            plan.require_completed_value(StepId::VerifyProfile, "another profile"),
            Err(PlanError::EvidenceValueMismatch(StepId::VerifyProfile))
        ));

        plan.complete_with_value(
            StepId::ConfirmRecovery,
            machine.recovery.method.evidence_value(),
        )
        .unwrap();
        assert!(matches!(
            plan.complete_with_value(StepId::PreserveOriginalFirmware, "not-a-digest"),
            Err(PlanError::MalformedDigest(
                EvidenceKind::OriginalFirmwareSha256
            ))
        ));
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
