//! Canonical authority for the pinned UEFIPatch catalogs used by legacy-board
//! deployments.
//!
//! Parsing and firmware traversal remain in `nvstraps-ffs`. This Module owns
//! which catalog sources are trusted, their upstream revision, risk policy,
//! profile validation, application ordering, and the durable receipt contract.

use std::collections::BTreeSet;

use nvstraps_deploy::{LegacyPatchCatalogFile, LegacyPatchProfile, LegacyPatchRisk, Sha256Digest};
use nvstraps_ffs::{
    EfiCompression, LegacyFirmwarePatchChange, LegacyFirmwarePatchPath,
    LegacyFirmwareRuleDisposition, LegacyPatchCatalog, LegacyPatchSelection,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const LEGACY_PATCH_UPSTREAM_COMMIT: &str = "9c80fdb2cd3db94bdd19c58bd00d5ecf822f6430";

const BUILTIN_SOURCES: [(LegacyPatchCatalogFile, &str); 5] = [
    (
        LegacyPatchCatalogFile::General,
        include_str!("../../../UEFIPatch/patches.txt"),
    ),
    (
        LegacyPatchCatalogFile::HaswellAbove4g,
        include_str!("../../../UEFIPatch/HswAbove4G.txt"),
    ),
    (
        LegacyPatchCatalogFile::IvyBridgeUsb3,
        include_str!("../../../UEFIPatch/IvyUSB3.txt"),
    ),
    (
        LegacyPatchCatalogFile::HaswellUsb3,
        include_str!("../../../UEFIPatch/HswUSB3.txt"),
    ),
    (
        LegacyPatchCatalogFile::BroadwellUsb3,
        include_str!("../../../UEFIPatch/BdwUSB3.txt"),
    ),
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPatchCatalogView {
    pub catalog: LegacyPatchCatalogFile,
    pub upstream_commit: String,
    pub source_sha256: Sha256Digest,
    pub rules: Vec<LegacyPatchRuleView>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPatchRuleView {
    pub rule_id: String,
    pub description: Option<String>,
    pub section_type: u8,
    pub required_risks: Vec<LegacyPatchRisk>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyFirmwareAnalysis {
    pub upstream_commit: String,
    pub catalogs: Vec<LegacyFirmwareCatalogAnalysis>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyFirmwareCatalogAnalysis {
    pub catalog: LegacyPatchCatalogFile,
    pub source_sha256: Sha256Digest,
    pub rules: Vec<LegacyFirmwareRuleAnalysis>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyFirmwareRuleStatus {
    Applicable,
    Absent,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyFirmwareRuleAnalysis {
    pub rule_id: String,
    pub description: Option<String>,
    pub section_type: u8,
    pub required_risks: Vec<LegacyPatchRisk>,
    pub status: LegacyFirmwareRuleStatus,
    pub expected_matches: Option<u16>,
    pub blocked_reason: Option<String>,
    pub recommended: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPatchReceipt {
    pub upstream_commit: String,
    pub original_firmware_sha256: Sha256Digest,
    pub patched_firmware_sha256: Sha256Digest,
    pub catalogs: Vec<LegacyCatalogPatchReceipt>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyCatalogPatchReceipt {
    pub catalog: LegacyPatchCatalogFile,
    pub source_sha256: Sha256Digest,
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyPatchApplication {
    pub patched_firmware: Vec<u8>,
    pub receipt: LegacyPatchReceipt,
}

struct BuiltinCatalog {
    catalog: LegacyPatchCatalogFile,
    parsed: LegacyPatchCatalog,
}

/// Deep Module for every decision that depends on the pinned legacy catalogs.
pub struct LegacyCatalogAuthority {
    catalogs: Vec<BuiltinCatalog>,
}

impl LegacyCatalogAuthority {
    pub fn load() -> Result<Self, LegacyCatalogError> {
        let catalogs = BUILTIN_SOURCES
            .into_iter()
            .map(|(catalog, source)| {
                LegacyPatchCatalog::parse(source)
                    .map(|parsed| BuiltinCatalog { catalog, parsed })
                    .map_err(|error| LegacyCatalogError::InvalidBuiltinCatalog {
                        catalog,
                        reason: error.to_string(),
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { catalogs })
    }

    pub fn catalog_views(&self) -> Result<Vec<LegacyPatchCatalogView>, LegacyCatalogError> {
        self.catalogs
            .iter()
            .map(|catalog| {
                Ok(LegacyPatchCatalogView {
                    catalog: catalog.catalog,
                    upstream_commit: LEGACY_PATCH_UPSTREAM_COMMIT.to_owned(),
                    source_sha256: digest(&catalog.parsed.source_sha256)?,
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
            })
            .collect()
    }

    pub fn validate_profile(&self, profile: &LegacyPatchProfile) -> Result<(), LegacyCatalogError> {
        profile
            .validate()
            .map_err(|error| LegacyCatalogError::InvalidProfile(error.to_string()))?;
        if profile.upstream_commit != LEGACY_PATCH_UPSTREAM_COMMIT {
            return Err(LegacyCatalogError::UnsupportedUpstreamCommit {
                actual: profile.upstream_commit.clone(),
            });
        }
        for pin in &profile.catalogs {
            let catalog = self.catalog(pin.catalog)?;
            if pin.source_sha256 != digest(&catalog.parsed.source_sha256)? {
                return Err(LegacyCatalogError::CatalogDigestMismatch {
                    catalog: pin.catalog,
                });
            }
        }
        for selection in &profile.selections {
            let catalog = self.catalog(selection.catalog)?;
            let rule = catalog
                .parsed
                .rules
                .iter()
                .find(|rule| rule.id.as_str() == selection.rule_id)
                .ok_or_else(|| LegacyCatalogError::RuleNotBuiltin {
                    catalog: selection.catalog,
                    rule_id: selection.rule_id.clone(),
                })?;
            if selection.required_risks
                != required_risks(selection.catalog, rule.description.as_deref())
            {
                return Err(LegacyCatalogError::RiskDeclarationMismatch {
                    rule_id: selection.rule_id.clone(),
                });
            }
        }
        Ok(())
    }

    pub fn analyze(&self, firmware: &[u8]) -> Result<LegacyFirmwareAnalysis, LegacyCatalogError> {
        let catalogs = self
            .catalogs
            .iter()
            .map(|catalog| {
                let analysis = nvstraps_ffs::analyze_legacy_firmware(firmware, &catalog.parsed)
                    .map_err(|error| LegacyCatalogError::Analysis {
                        catalog: catalog.catalog,
                        reason: error.to_string(),
                    })?;
                let rules = analysis
                    .rules
                    .into_iter()
                    .map(|analysis_rule| {
                        let rule = catalog
                            .parsed
                            .rule(&analysis_rule.rule_id)
                            .expect("analysis rules originate from the same parsed catalog");
                        let risks = required_risks(catalog.catalog, rule.description.as_deref());
                        let (status, expected_matches, blocked_reason) =
                            match analysis_rule.disposition {
                                LegacyFirmwareRuleDisposition::Applicable { expected_matches } => {
                                    match u16::try_from(expected_matches) {
                                        Ok(expected_matches) => (
                                            LegacyFirmwareRuleStatus::Applicable,
                                            Some(expected_matches),
                                            None,
                                        ),
                                        Err(_) => (
                                            LegacyFirmwareRuleStatus::Blocked,
                                            None,
                                            Some(
                                                "match count exceeds the deployment profile limit"
                                                    .into(),
                                            ),
                                        ),
                                    }
                                }
                                LegacyFirmwareRuleDisposition::Absent => {
                                    (LegacyFirmwareRuleStatus::Absent, None, None)
                                }
                                LegacyFirmwareRuleDisposition::Blocked { reason } => {
                                    (LegacyFirmwareRuleStatus::Blocked, None, Some(reason))
                                }
                            };
                        LegacyFirmwareRuleAnalysis {
                            rule_id: analysis_rule.rule_id.as_str().to_owned(),
                            description: rule.description.clone(),
                            section_type: rule.section_type,
                            recommended: status == LegacyFirmwareRuleStatus::Applicable
                                && risks.is_empty(),
                            required_risks: risks,
                            status,
                            expected_matches,
                            blocked_reason,
                        }
                    })
                    .collect();
                Ok(LegacyFirmwareCatalogAnalysis {
                    catalog: catalog.catalog,
                    source_sha256: digest(&analysis.catalog_sha256)?,
                    rules,
                })
            })
            .collect::<Result<Vec<_>, LegacyCatalogError>>()?;
        Ok(LegacyFirmwareAnalysis {
            upstream_commit: LEGACY_PATCH_UPSTREAM_COMMIT.to_owned(),
            catalogs,
        })
    }

    pub fn apply(
        &self,
        original: &[u8],
        profile: &LegacyPatchProfile,
    ) -> Result<LegacyPatchApplication, LegacyCatalogError> {
        self.validate_profile(profile)?;
        let mut patched = original.to_vec();
        let mut catalog_receipts = Vec::with_capacity(profile.catalogs.len());

        for pin in &profile.catalogs {
            let catalog = self.catalog(pin.catalog)?;
            let selections = catalog
                .parsed
                .rules
                .iter()
                .filter_map(|rule| {
                    profile
                        .selections
                        .iter()
                        .find(|selection| {
                            selection.catalog == pin.catalog
                                && selection.rule_id == rule.id.as_str()
                        })
                        .map(|selection| LegacyPatchSelection {
                            rule_id: rule.id.clone(),
                            expected_matches: usize::from(selection.expected_matches),
                        })
                })
                .collect::<Vec<_>>();
            let (next, report) =
                nvstraps_ffs::patch_legacy_firmware(&patched, &catalog.parsed, &selections)
                    .map_err(|error| LegacyCatalogError::Patch {
                        catalog: pin.catalog,
                        reason: error.to_string(),
                    })?;
            patched = next;
            catalog_receipts.push(LegacyCatalogPatchReceipt {
                catalog: pin.catalog,
                source_sha256: digest(&report.catalog_sha256)?,
                applications: report
                    .applications
                    .into_iter()
                    .map(|application| LegacyRulePatchReceipt {
                        rule_id: application.rule_id.as_str().to_owned(),
                        expected_matches: application.expected_matches,
                        changes: application
                            .changes
                            .into_iter()
                            .map(map_patch_change)
                            .collect(),
                    })
                    .collect(),
            });
        }

        let original_sha256 = Sha256Digest::from_bytes(original);
        let patched_firmware_sha256 = Sha256Digest::from_bytes(&patched);
        let receipt = LegacyPatchReceipt {
            upstream_commit: LEGACY_PATCH_UPSTREAM_COMMIT.to_owned(),
            original_firmware_sha256: original_sha256.clone(),
            patched_firmware_sha256: patched_firmware_sha256.clone(),
            catalogs: catalog_receipts,
        };
        self.validate_receipt(
            profile,
            &original_sha256,
            &patched_firmware_sha256,
            &receipt,
        )?;
        Ok(LegacyPatchApplication {
            patched_firmware: patched,
            receipt,
        })
    }

    pub fn validate_receipt(
        &self,
        profile: &LegacyPatchProfile,
        original_sha256: &Sha256Digest,
        patched_sha256: &Sha256Digest,
        receipt: &LegacyPatchReceipt,
    ) -> Result<(), LegacyCatalogError> {
        self.validate_profile(profile)?;
        if receipt.upstream_commit != profile.upstream_commit
            || receipt.original_firmware_sha256 != *original_sha256
            || receipt.patched_firmware_sha256 != *patched_sha256
            || receipt.catalogs.len() != profile.catalogs.len()
        {
            return Err(LegacyCatalogError::ReceiptMismatch(
                "receipt identity does not match its profile and firmware artifacts",
            ));
        }

        let mut recorded_catalogs = BTreeSet::new();
        let mut recorded_rules = Vec::new();
        for catalog_receipt in &receipt.catalogs {
            if !recorded_catalogs.insert(catalog_receipt.catalog) {
                return Err(LegacyCatalogError::ReceiptMismatch(
                    "receipt contains a duplicate catalog",
                ));
            }
            let pin = profile
                .catalogs
                .iter()
                .find(|pin| pin.catalog == catalog_receipt.catalog)
                .ok_or(LegacyCatalogError::ReceiptMismatch(
                    "receipt contains an unpinned catalog",
                ))?;
            if pin.source_sha256 != catalog_receipt.source_sha256 {
                return Err(LegacyCatalogError::ReceiptMismatch(
                    "receipt catalog hash does not match its profile",
                ));
            }
            for application in &catalog_receipt.applications {
                let selection = profile
                    .selections
                    .iter()
                    .find(|selection| {
                        selection.catalog == catalog_receipt.catalog
                            && selection.rule_id == application.rule_id
                    })
                    .ok_or(LegacyCatalogError::ReceiptMismatch(
                        "receipt contains an unselected rule",
                    ))?;
                if usize::from(selection.expected_matches) != application.expected_matches
                    || application.changes.len() != application.expected_matches
                {
                    return Err(LegacyCatalogError::ReceiptMismatch(
                        "receipt has an unexpected match count",
                    ));
                }
                for change in &application.changes {
                    validate_change(change)?;
                }
                recorded_rules.push((
                    catalog_receipt.catalog,
                    application.rule_id.as_str(),
                    application.expected_matches,
                ));
            }
        }
        recorded_rules.sort_unstable();
        let mut expected_rules = profile
            .selections
            .iter()
            .map(|selection| {
                (
                    selection.catalog,
                    selection.rule_id.as_str(),
                    usize::from(selection.expected_matches),
                )
            })
            .collect::<Vec<_>>();
        expected_rules.sort_unstable();
        if recorded_rules != expected_rules {
            return Err(LegacyCatalogError::ReceiptMismatch(
                "receipt does not cover every selected rule exactly once",
            ));
        }
        Ok(())
    }

    fn catalog(
        &self,
        catalog: LegacyPatchCatalogFile,
    ) -> Result<&BuiltinCatalog, LegacyCatalogError> {
        self.catalogs
            .iter()
            .find(|candidate| candidate.catalog == catalog)
            .ok_or(LegacyCatalogError::CatalogNotBuiltin { catalog })
    }
}

#[derive(Debug, Error)]
pub enum LegacyCatalogError {
    #[error("built-in legacy patch catalog {catalog:?} is invalid: {reason}")]
    InvalidBuiltinCatalog {
        catalog: LegacyPatchCatalogFile,
        reason: String,
    },
    #[error("legacy catalog authority contains an invalid SHA-256 digest: {0}")]
    InvalidAuthorityDigest(String),
    #[error("legacy patch profile is invalid: {0}")]
    InvalidProfile(String),
    #[error(
        "legacy patch bundle pins unsupported upstream commit {actual}; expected {LEGACY_PATCH_UPSTREAM_COMMIT}"
    )]
    UnsupportedUpstreamCommit { actual: String },
    #[error("legacy patch catalog {catalog:?} is not built into this application")]
    CatalogNotBuiltin { catalog: LegacyPatchCatalogFile },
    #[error("legacy patch catalog {catalog:?} digest does not match the built-in source")]
    CatalogDigestMismatch { catalog: LegacyPatchCatalogFile },
    #[error("legacy patch rule {rule_id} is not in built-in catalog {catalog:?}")]
    RuleNotBuiltin {
        catalog: LegacyPatchCatalogFile,
        rule_id: String,
    },
    #[error("legacy patch rule {rule_id} has an incorrect risk declaration")]
    RiskDeclarationMismatch { rule_id: String },
    #[error("legacy firmware analysis failed for catalog {catalog:?}: {reason}")]
    Analysis {
        catalog: LegacyPatchCatalogFile,
        reason: String,
    },
    #[error("legacy firmware patching failed in catalog {catalog:?}: {reason}")]
    Patch {
        catalog: LegacyPatchCatalogFile,
        reason: String,
    },
    #[error("legacy patch {0}")]
    ReceiptMismatch(&'static str),
}

fn digest(value: &str) -> Result<Sha256Digest, LegacyCatalogError> {
    Sha256Digest::parse(value.to_owned())
        .map_err(|error| LegacyCatalogError::InvalidAuthorityDigest(error.to_string()))
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

fn map_patch_change(change: LegacyFirmwarePatchChange) -> LegacyPatchChangeReceipt {
    LegacyPatchChangeReceipt {
        path: change
            .path
            .into_iter()
            .map(|part| match part {
                LegacyFirmwarePatchPath::FirmwareVolume { offset } => {
                    LegacyPatchPathReceipt::FirmwareVolume { offset }
                }
                LegacyFirmwarePatchPath::FirmwareFile { offset, file_guid } => {
                    LegacyPatchPathReceipt::FirmwareFile {
                        offset,
                        file_guid_hex: hex_bytes(&file_guid),
                    }
                }
                LegacyFirmwarePatchPath::Section {
                    offset,
                    content_offset,
                    section_type,
                } => LegacyPatchPathReceipt::Section {
                    offset,
                    content_offset,
                    section_type,
                },
                LegacyFirmwarePatchPath::LzmaPayload => LegacyPatchPathReceipt::LzmaPayload,
                LegacyFirmwarePatchPath::UncompressedPayload => {
                    LegacyPatchPathReceipt::UncompressedPayload
                }
                LegacyFirmwarePatchPath::EfiCompressedPayload { compression } => {
                    LegacyPatchPathReceipt::EfiCompressedPayload {
                        compression: match compression {
                            EfiCompression::EfiStandard => "efiStandard",
                            EfiCompression::Tiano => "tiano",
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

fn validate_change(change: &LegacyPatchChangeReceipt) -> Result<(), LegacyCatalogError> {
    if change.path.is_empty()
        || change.before_hex.is_empty()
        || change.before_hex.len() != change.after_hex.len()
        || change.before_hex == change.after_hex
        || !is_hex(&change.before_hex)
        || !is_hex(&change.after_hex)
    {
        return Err(LegacyCatalogError::ReceiptMismatch(
            "receipt contains a malformed patch change",
        ));
    }
    Ok(())
}

fn is_hex(value: &str) -> bool {
    value.len().is_multiple_of(2) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hex_bytes(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("writing to a string cannot fail");
    }
    output
}

#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub mod test_support {
    use nvstraps_deploy::{
        LegacyPatchCatalogPin, LegacyPatchProfile, LegacyPatchSelection as ProfileSelection,
    };

    use super::*;

    pub fn selected_profile() -> LegacyPatchProfile {
        let authority = LegacyCatalogAuthority::load().unwrap();
        let view = authority
            .catalog_views()
            .unwrap()
            .into_iter()
            .find(|view| view.catalog == LegacyPatchCatalogFile::General)
            .unwrap();
        let rule = view
            .rules
            .iter()
            .find(|rule| rule.required_risks.is_empty())
            .unwrap();
        LegacyPatchProfile::create(
            LEGACY_PATCH_UPSTREAM_COMMIT,
            vec![LegacyPatchCatalogPin {
                catalog: view.catalog,
                source_sha256: view.source_sha256,
            }],
            vec![ProfileSelection {
                catalog: view.catalog,
                rule_id: rule.rule_id.clone(),
                expected_matches: 1,
                required_risks: rule.required_risks.clone(),
            }],
            vec![],
        )
        .unwrap()
    }

    pub fn synthetic_legacy_firmware() -> Vec<u8> {
        let authority = LegacyCatalogAuthority::load().unwrap();
        let catalog = authority.catalog(LegacyPatchCatalogFile::General).unwrap();
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
        let sum = firmware[..72]
            .as_chunks::<2>()
            .0
            .iter()
            .fold(0_u16, |sum, pair| {
                sum.wrapping_add(u16::from_le_bytes(*pair))
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

    fn decode_hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| {
                u8::from_str_radix(std::str::from_utf8(pair.as_slice()).unwrap(), 16).unwrap()
            })
            .collect()
    }

    fn checksum8(bytes: &[u8]) -> u8 {
        0_u8.wrapping_sub(bytes.iter().fold(0_u8, |sum, byte| sum.wrapping_add(*byte)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{selected_profile, synthetic_legacy_firmware};

    #[test]
    fn one_authority_owns_all_pins_rules_and_risks() {
        let authority = LegacyCatalogAuthority::load().unwrap();
        let views = authority.catalog_views().unwrap();

        assert_eq!(views.len(), 5);
        assert!(views.iter().all(|view| {
            view.upstream_commit == LEGACY_PATCH_UPSTREAM_COMMIT
                && !view.rules.is_empty()
                && view.source_sha256.as_str().len() == 64
        }));
        assert!(views.iter().flat_map(|view| &view.rules).any(|rule| {
            rule.required_risks
                .contains(&LegacyPatchRisk::DsdtModification)
        }));
        assert!(views.iter().flat_map(|view| &view.rules).any(|rule| {
            rule.required_risks
                .contains(&LegacyPatchRisk::NvramWhitelist)
        }));
    }

    #[test]
    fn profile_validation_rejects_every_forged_authority_field() {
        let authority = LegacyCatalogAuthority::load().unwrap();
        let profile = selected_profile();
        authority.validate_profile(&profile).unwrap();

        let mut commit = profile.clone();
        commit.upstream_commit = "0".repeat(40);
        assert!(matches!(
            authority.validate_profile(&commit),
            Err(LegacyCatalogError::UnsupportedUpstreamCommit { .. })
        ));

        let mut digest = profile.clone();
        digest.catalogs[0].source_sha256 = Sha256Digest::from_bytes(b"forged");
        assert!(matches!(
            authority.validate_profile(&digest),
            Err(LegacyCatalogError::CatalogDigestMismatch { .. })
        ));

        let mut rule = profile.clone();
        rule.selections[0].rule_id = "0".repeat(64);
        assert!(matches!(
            authority.validate_profile(&rule),
            Err(LegacyCatalogError::RuleNotBuiltin { .. })
        ));
    }

    #[test]
    fn analysis_application_and_receipt_share_the_same_catalog_authority() {
        let authority = LegacyCatalogAuthority::load().unwrap();
        let original = synthetic_legacy_firmware();
        let profile = selected_profile();
        let analysis = authority.analyze(&original).unwrap();
        let applicable = analysis
            .catalogs
            .iter()
            .flat_map(|catalog| &catalog.rules)
            .filter(|rule| rule.status == LegacyFirmwareRuleStatus::Applicable)
            .collect::<Vec<_>>();
        assert_eq!(applicable.len(), 1);
        assert!(applicable[0].recommended);

        let application = authority.apply(&original, &profile).unwrap();
        assert_ne!(application.patched_firmware, original);
        authority
            .validate_receipt(
                &profile,
                &Sha256Digest::from_bytes(&original),
                &Sha256Digest::from_bytes(&application.patched_firmware),
                &application.receipt,
            )
            .unwrap();

        let mut forged = application.receipt;
        let duplicate = forged.catalogs[0].applications[0].clone();
        forged.catalogs[0].applications.push(duplicate);
        assert!(matches!(
            authority.validate_receipt(
                &profile,
                &Sha256Digest::from_bytes(&original),
                &Sha256Digest::from_bytes(&application.patched_firmware),
                &forged,
            ),
            Err(LegacyCatalogError::ReceiptMismatch(_))
        ));
    }
}
