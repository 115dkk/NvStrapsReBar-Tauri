use std::{collections::HashSet, fmt, io::Read};

use flate2::read::ZlibDecoder;
use lzma_sdk_rs::{LzmaProps, decoder_props, encode as lzma_sdk_encode};
use oxiarc_lzma::decompress_bytes as lzma_decompress;
use sha2::{Digest, Sha256};

use super::{
    EfiCompression, FFS_ATTRIBUTE_CHECKSUM, FFS_FILE_GUID_BYTES, FFS_FILE_STATE_VALID,
    FFS_HEADER_SIZE, LegacyPatchCatalog, LegacyPatchChange, LegacyPatchError, LegacyPatchRule,
    MAX_STANDARD_SIZE, PackError, PatchRuleId, checksum8, efi_compress, efi_decompress,
    inspect_bundled_ffs, inspect_ffs, write_u24,
};

const FV_SIGNATURE: &[u8; 4] = b"_FVH";
const FV_SIGNATURE_OFFSET: usize = 40;
const FV_LENGTH_OFFSET: usize = 32;
const FV_ATTRIBUTES_OFFSET: usize = 44;
const FV_HEADER_LENGTH_OFFSET: usize = 48;
const FV_CHECKSUM_OFFSET: usize = 50;
const FV_EXT_HEADER_OFFSET: usize = 52;
const FV_REVISION_OFFSET: usize = 55;
const FV_MINIMUM_HEADER_SIZE: usize = 56;
const FV_ERASE_POLARITY: u32 = 0x0000_0800;
const FV_EXT_HEADER_MINIMUM_SIZE: usize = 20;
const FV_EXT_ENTRY_USED_SIZE: u16 = 0x0003;
const FV_USED_SIZE_ENTRY_MINIMUM: usize = 8;
const FFS_LARGE_FILE_ATTRIBUTE: u8 = 0x01;
const FFS_FILE_TYPE_DXE_CORE: u8 = 0x05;
const FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE: u8 = 0x0b;
const FFS_FILE_TYPE_PAD: u8 = 0xf0;
const SECTION_TYPE_COMPRESSION: u8 = 0x01;
const SECTION_TYPE_GUID_DEFINED: u8 = 0x02;
const SECTION_TYPE_DISPOSABLE: u8 = 0x03;
const SECTION_TYPE_FIRMWARE_VOLUME_IMAGE: u8 = 0x17;
const GUIDED_SECTION_PROCESSING_REQUIRED: u16 = 0x0001;
const LZMA_GUID_BYTES: [u8; 16] = [
    0x98, 0x58, 0x4e, 0xee, 0x14, 0x39, 0x59, 0x42, 0x9d, 0x6e, 0xdc, 0x7b, 0xd7, 0x94, 0x03, 0xcf,
];
const AMD_ZLIB_GUID_BYTES: [u8; 16] = [
    0xf5, 0x33, 0x32, 0xce, 0xd6, 0x2c, 0x87, 0x4d, 0x91, 0x52, 0x4a, 0x23, 0x8b, 0xb6, 0xd1, 0xc4,
];
const AMD_ZLIB_HEADER_SIZE: usize = 0x100;
const FFS_FIXED_CHECKSUM: u8 = 0xaa;
const GUIDED_LZMA_FAST_BYTES: u32 = 128;
const GUIDED_LZMA_MATCH_CYCLES: u32 = 80;
const MAX_GUIDED_DEPTH: usize = 8;
const MAX_LZMA_DICTIONARY_SIZE: u32 = 64 * 1024 * 1024;
const MAX_LZMA_UNCOMPRESSED_SIZE: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_DECODED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_STRUCTURE_RECORDS: usize = 65_536;
const MAX_CENSUS_CONTAINERS: usize = 4_096;
const MAX_CENSUS_VOLUMES: usize = 65_536;
const MAX_DXE_TARGETS: usize = 16;
const MAX_DRIVER_LOCATIONS: usize = 16;
const FFS_FILE_DATA_VALID: u8 = 0x04;
const FFS_FILE_DELETED: u8 = 0x10;
const FFS_FILE_HEADER_INVALID: u8 = 0x20;
const UEFI_CAPSULE_HEADER_SIZE: usize = 28;
const APTIO_CAPSULE_HEADER_SIZE: usize = 32;
const UEFI_CAPSULE_ALLOWED_FLAGS: u32 = 0x0007_ffff;
const EFI_CAPSULE_GUID_BYTES: [u8; 16] = [
    0xbd, 0x86, 0x66, 0x3b, 0x76, 0x0d, 0x30, 0x40, 0xb7, 0x0e, 0xb5, 0x51, 0x9e, 0x2f, 0xc5, 0xa0,
];
const EFI_FMP_CAPSULE_GUID_BYTES: [u8; 16] = [
    0xed, 0xd5, 0xcb, 0x6d, 0x2d, 0xe8, 0x44, 0x4c, 0xbd, 0xa1, 0x71, 0x94, 0x19, 0x9a, 0xd9, 0x2a,
];
const INTEL_CAPSULE_GUID_BYTES: [u8; 16] = [
    0xb9, 0x82, 0x91, 0x53, 0xb5, 0xab, 0x91, 0x43, 0xb6, 0x9a, 0xe3, 0xa9, 0x43, 0xf7, 0x2f, 0xcc,
];
const LENOVO_CAPSULE_GUID_BYTES: [u8; 16] = [
    0xd3, 0xaf, 0x0b, 0xe2, 0x14, 0x99, 0x4f, 0x4f, 0x95, 0x37, 0x31, 0x29, 0xe0, 0x90, 0xeb, 0x3c,
];
const LENOVO2_CAPSULE_GUID_BYTES: [u8; 16] = [
    0x76, 0xfe, 0xb5, 0x25, 0x43, 0x82, 0x5c, 0x4a, 0xa9, 0xbd, 0x7e, 0xe3, 0x24, 0x61, 0x98, 0xb5,
];
const TOSHIBA_CAPSULE_GUID_BYTES: [u8; 16] = [
    0x62, 0x70, 0xe0, 0x3b, 0x51, 0x1d, 0xd2, 0x45, 0x83, 0x2b, 0xf0, 0x93, 0x25, 0x7e, 0xd4, 0x61,
];
const APTIO_SIGNED_CAPSULE_GUID_BYTES: [u8; 16] = [
    0x8b, 0xa6, 0x3c, 0x4a, 0x23, 0x77, 0xfb, 0x48, 0x80, 0x3d, 0x57, 0x8c, 0xc1, 0xfe, 0xc4, 0x4d,
];
const APTIO_UNSIGNED_CAPSULE_GUID_BYTES: [u8; 16] = [
    0x90, 0xbb, 0xee, 0x14, 0x0a, 0x89, 0xdb, 0x43, 0xae, 0xd1, 0x5d, 0x3c, 0x45, 0x88, 0xa4, 0x18,
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FirmwareEnvelope {
    RawOrVendorImage,
    UefiCapsule(UefiCapsuleHeader),
    MalformedCapsule(MalformedCapsuleHeader),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UefiCapsuleKind {
    Standard,
    Toshiba,
    AptioSigned,
    AptioUnsigned,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UefiCapsuleHeader {
    pub kind: UefiCapsuleKind,
    pub capsule_guid: [u8; 16],
    pub header_size: u32,
    pub flags: u32,
    pub capsule_image_size: u32,
    pub body_offset: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MalformedCapsuleHeader {
    pub kind: UefiCapsuleKind,
    pub capsule_guid: [u8; 16],
    pub reason: &'static str,
}

pub fn inspect_firmware_envelope(firmware: &[u8]) -> FirmwareEnvelope {
    let Some(capsule_guid) = firmware.get(..16).and_then(|bytes| bytes.try_into().ok()) else {
        return FirmwareEnvelope::RawOrVendorImage;
    };
    let recognized_kind = recognized_capsule_kind(capsule_guid);
    if firmware.len() < UEFI_CAPSULE_HEADER_SIZE {
        return recognized_kind.map_or(FirmwareEnvelope::RawOrVendorImage, |kind| {
            FirmwareEnvelope::MalformedCapsule(MalformedCapsuleHeader {
                kind,
                capsule_guid,
                reason: "capsule header is truncated",
            })
        });
    }
    let header_size = u32::from_le_bytes(
        firmware[16..20]
            .try_into()
            .expect("capsule header slice was checked"),
    );
    let kind = recognized_kind.unwrap_or(UefiCapsuleKind::Standard);
    let (flags, capsule_image_size) = if kind == UefiCapsuleKind::Toshiba {
        (
            u32::from_le_bytes(
                firmware[24..28]
                    .try_into()
                    .expect("capsule header slice was checked"),
            ),
            u32::from_le_bytes(
                firmware[20..24]
                    .try_into()
                    .expect("capsule header slice was checked"),
            ),
        )
    } else {
        (
            u32::from_le_bytes(
                firmware[20..24]
                    .try_into()
                    .expect("capsule header slice was checked"),
            ),
            u32::from_le_bytes(
                firmware[24..28]
                    .try_into()
                    .expect("capsule header slice was checked"),
            ),
        )
    };
    let malformed = if (header_size as usize) < UEFI_CAPSULE_HEADER_SIZE {
        Some("capsule header size is smaller than EFI_CAPSULE_HEADER")
    } else if header_size as usize > firmware.len() {
        Some("capsule header size exceeds the file")
    } else if capsule_image_size < header_size || capsule_image_size as usize > firmware.len() {
        Some("capsule image size is outside the file")
    } else if flags & !UEFI_CAPSULE_ALLOWED_FLAGS != 0 {
        Some("capsule flags contain reserved bits")
    } else {
        None
    };
    if let Some(reason) = malformed {
        return recognized_kind.map_or(FirmwareEnvelope::RawOrVendorImage, |_| {
            FirmwareEnvelope::MalformedCapsule(MalformedCapsuleHeader {
                kind,
                capsule_guid,
                reason,
            })
        });
    }

    let body_offset = match kind {
        UefiCapsuleKind::AptioSigned | UefiCapsuleKind::AptioUnsigned => {
            if firmware.len() < APTIO_CAPSULE_HEADER_SIZE {
                return FirmwareEnvelope::MalformedCapsule(MalformedCapsuleHeader {
                    kind,
                    capsule_guid,
                    reason: "AMI Aptio capsule header is truncated",
                });
            }
            let rom_image_offset = u16::from_le_bytes([firmware[28], firmware[29]]) as u32;
            if (rom_image_offset as usize) < APTIO_CAPSULE_HEADER_SIZE
                || rom_image_offset >= capsule_image_size
            {
                return FirmwareEnvelope::MalformedCapsule(MalformedCapsuleHeader {
                    kind,
                    capsule_guid,
                    reason: "AMI Aptio ROM image offset is outside the capsule",
                });
            }
            rom_image_offset
        }
        UefiCapsuleKind::Standard | UefiCapsuleKind::Toshiba => header_size,
    };

    FirmwareEnvelope::UefiCapsule(UefiCapsuleHeader {
        kind,
        capsule_guid,
        header_size,
        flags,
        capsule_image_size,
        body_offset,
    })
}

fn recognized_capsule_kind(capsule_guid: [u8; 16]) -> Option<UefiCapsuleKind> {
    if capsule_guid == APTIO_SIGNED_CAPSULE_GUID_BYTES {
        return Some(UefiCapsuleKind::AptioSigned);
    }
    if capsule_guid == APTIO_UNSIGNED_CAPSULE_GUID_BYTES {
        return Some(UefiCapsuleKind::AptioUnsigned);
    }
    if capsule_guid == TOSHIBA_CAPSULE_GUID_BYTES {
        return Some(UefiCapsuleKind::Toshiba);
    }
    [
        EFI_CAPSULE_GUID_BYTES,
        EFI_FMP_CAPSULE_GUID_BYTES,
        INTEL_CAPSULE_GUID_BYTES,
        LENOVO_CAPSULE_GUID_BYTES,
        LENOVO2_CAPSULE_GUID_BYTES,
    ]
    .contains(&capsule_guid)
    .then_some(UefiCapsuleKind::Standard)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FirmwareInjection {
    pub target: FirmwareVolumePath,
    pub driver_file_offset: usize,
    pub firmware_volume_offset: usize,
    pub file_offset: usize,
    pub replaced_pad_file: bool,
    pub erase_polarity: bool,
    pub encapsulated_volume_image: bool,
    pub recompressed_guided_section: bool,
    pub grew_firmware_volume: bool,
    pub firmware_volume_growth_bytes: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FirmwareInjectionBatch {
    pub plan: FirmwareInjectionPlan,
    pub targets: Vec<FirmwareInjection>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FirmwareInjectionPlan {
    pub policy_version: u8,
    pub source_sha256: [u8; 32],
    pub driver_sha256: [u8; 32],
    pub census_sha256: [u8; 32],
    pub targets: Vec<FirmwareVolumePath>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FirmwareVolumePath {
    pub container_file_offsets: Vec<usize>,
    pub firmware_volume_offset: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FirmwareFilePath {
    pub container_file_offsets: Vec<usize>,
    pub firmware_volume_offset: usize,
    pub file_offset: usize,
}

#[derive(Debug)]
pub enum InjectionError {
    InvalidFfs(PackError),
    InvalidFirmware(&'static str),
    DriverAlreadyPresent,
    Compression(String),
    UnsupportedCapsule(UefiCapsuleHeader),
    MalformedCapsule(MalformedCapsuleHeader),
    AmbiguousDxeTargets {
        candidates: Vec<FirmwareVolumePath>,
    },
    IncompleteDxeTargetCensus {
        uninspected_containers: Vec<FirmwareFilePath>,
    },
    UnsupportedDxeTarget {
        target: FirmwareVolumePath,
    },
    NoTopLevelDxeVolume,
    NoSpace {
        location: FirmwareVolumePath,
        available_bytes: usize,
        required_bytes: usize,
    },
    RecompressedContainerTooLarge {
        container_file_offsets: Vec<usize>,
        firmware_volume_offset: usize,
        file_offset: usize,
        available_bytes: usize,
        required_bytes: usize,
    },
}

impl fmt::Display for InjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFfs(error) => write!(formatter, "invalid driver FFS: {error}"),
            Self::InvalidFirmware(reason) => write!(formatter, "invalid firmware image: {reason}"),
            Self::DriverAlreadyPresent => formatter.write_str("driver GUID is already present"),
            Self::Compression(reason) => write!(formatter, "firmware compression failed: {reason}"),
            Self::UnsupportedCapsule(header) => write!(
                formatter,
                "{:?} capsule {:02x?} (header {}, body {}, flags {:#x}) cannot be modified without a vendor signing route",
                header.kind,
                header.capsule_guid,
                header.header_size,
                header.body_offset,
                header.flags
            ),
            Self::MalformedCapsule(header) => write!(
                formatter,
                "recognized {:?} capsule {:02x?} is malformed: {}",
                header.kind, header.capsule_guid, header.reason
            ),
            Self::AmbiguousDxeTargets { candidates } => {
                write!(
                    formatter,
                    "{} independently dispatchable DXE firmware targets require an explicit patch-every-domain policy bound to an independent recovery route",
                    candidates.len()
                )?;
                for candidate in candidates {
                    write!(formatter, "; {}", FirmwarePathDisplay(candidate))?;
                }
                Ok(())
            }
            Self::IncompleteDxeTargetCensus {
                uninspected_containers,
            } => {
                write!(
                    formatter,
                    "DXE target census could not inspect {} live firmware-volume image containers",
                    uninspected_containers.len()
                )?;
                for container in uninspected_containers {
                    write!(
                        formatter,
                        "; {} -> FV {:#x} -> FFS {:#x}",
                        OffsetPathDisplay(&container.container_file_offsets),
                        container.firmware_volume_offset,
                        container.file_offset
                    )?;
                }
                Ok(())
            }
            Self::UnsupportedDxeTarget { target } => write!(
                formatter,
                "the only DXE firmware target uses a read-only census layout that the injector cannot rebuild: {}",
                FirmwarePathDisplay(target)
            ),
            Self::NoTopLevelDxeVolume => {
                formatter.write_str("no DXE firmware volume was found through a supported layout")
            }
            Self::NoSpace {
                location,
                available_bytes,
                required_bytes,
            } => write!(
                formatter,
                "DXE firmware volume {} has {available_bytes} writable bytes but the aligned driver requires {required_bytes} bytes",
                FirmwarePathDisplay(location)
            ),
            Self::RecompressedContainerTooLarge {
                container_file_offsets,
                firmware_volume_offset,
                file_offset,
                available_bytes,
                required_bytes,
            } => write!(
                formatter,
                "recompressed firmware-volume container {} -> FV {firmware_volume_offset:#x} -> FFS {file_offset:#x} requires {required_bytes} bytes but its fixed extent provides {available_bytes} bytes",
                OffsetPathDisplay(container_file_offsets)
            ),
        }
    }
}

struct FirmwarePathDisplay<'a>(&'a FirmwareVolumePath);

impl fmt::Display for FirmwarePathDisplay<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} -> FV {:#x}",
            OffsetPathDisplay(&self.0.container_file_offsets),
            self.0.firmware_volume_offset
        )
    }
}

struct OffsetPathDisplay<'a>(&'a [usize]);

impl fmt::Display for OffsetPathDisplay<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0.is_empty() {
            return formatter.write_str("root image");
        }
        formatter.write_str("container FFS path")?;
        for offset in self.0 {
            write!(formatter, " {offset:#x}")?;
        }
        Ok(())
    }
}

impl std::error::Error for InjectionError {}

impl From<PackError> for InjectionError {
    fn from(error: PackError) -> Self {
        Self::InvalidFfs(error)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyPatchSelection {
    pub rule_id: PatchRuleId,
    pub expected_matches: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyFirmwarePatch {
    pub catalog_sha256: String,
    pub applications: Vec<LegacyFirmwarePatchApplication>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyFirmwarePatchApplication {
    pub rule_id: PatchRuleId,
    pub expected_matches: usize,
    pub changes: Vec<LegacyFirmwarePatchChange>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyFirmwareCatalogAnalysis {
    pub catalog_sha256: String,
    pub rules: Vec<LegacyFirmwareRuleAnalysis>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyFirmwareRuleAnalysis {
    pub rule_id: PatchRuleId,
    pub disposition: LegacyFirmwareRuleDisposition,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LegacyFirmwareRuleDisposition {
    Applicable { expected_matches: usize },
    Absent,
    Blocked { reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyFirmwarePatchChange {
    pub path: Vec<LegacyFirmwarePatchPath>,
    pub change: LegacyPatchChange,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LegacyFirmwarePatchPath {
    FirmwareVolume {
        offset: usize,
    },
    FirmwareFile {
        offset: usize,
        file_guid: [u8; 16],
    },
    Section {
        offset: usize,
        content_offset: usize,
        section_type: u8,
    },
    LzmaPayload,
    UncompressedPayload,
    EfiCompressedPayload {
        compression: EfiCompression,
    },
}

#[derive(Debug)]
pub enum LegacyFirmwarePatchError {
    InvalidFirmware(InjectionError),
    InvalidRule(LegacyPatchError),
    EmptySelection,
    DuplicateSelection(PatchRuleId),
    UnknownRule(PatchRuleId),
    UnsupportedTargetFile {
        rule_id: PatchRuleId,
        file_offset: usize,
        reason: &'static str,
    },
}

impl fmt::Display for LegacyFirmwarePatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFirmware(error) => error.fmt(formatter),
            Self::InvalidRule(error) => error.fmt(formatter),
            Self::EmptySelection => {
                formatter.write_str("at least one legacy patch must be selected")
            }
            Self::DuplicateSelection(rule_id) => {
                write!(
                    formatter,
                    "legacy patch rule {rule_id} was selected more than once"
                )
            }
            Self::UnknownRule(rule_id) => {
                write!(
                    formatter,
                    "legacy patch rule {rule_id} is not in the pinned catalog"
                )
            }
            Self::UnsupportedTargetFile {
                rule_id,
                file_offset,
                reason,
            } => write!(
                formatter,
                "legacy patch rule {rule_id} targets unsupported FFS file {file_offset:#x}: {reason}"
            ),
        }
    }
}

impl std::error::Error for LegacyFirmwarePatchError {}

impl From<InjectionError> for LegacyFirmwarePatchError {
    fn from(error: InjectionError) -> Self {
        Self::InvalidFirmware(error)
    }
}

impl From<LegacyPatchError> for LegacyFirmwarePatchError {
    fn from(error: LegacyPatchError) -> Self {
        Self::InvalidRule(error)
    }
}

#[derive(Clone, Copy, Debug)]
struct FirmwareVolume {
    start: usize,
    end: usize,
    files_start: usize,
    erase_byte: u8,
    erase_polarity: bool,
    ext_header: Option<(usize, usize)>,
}

#[derive(Clone, Copy, Debug)]
struct VolumeScan {
    contains_dxe_core: bool,
    driver_count: usize,
    raw_free: Option<(usize, usize)>,
    pad_free: Option<(usize, usize)>,
}

#[derive(Default)]
struct InjectionLayout {
    volume_count: usize,
    dxe_targets: Vec<FirmwareVolumePath>,
    injectable_targets: Vec<FirmwareVolumePath>,
    driver_files: Vec<DriverFileCensus>,
    uninspected_containers: Vec<FirmwareFilePath>,
}

struct DriverFileCensus {
    location: FirmwareVolumePath,
    file_offset: usize,
    normalized_file: Vec<u8>,
}

impl InjectionLayout {
    fn charge_volumes(&mut self, count: usize) -> Result<(), InjectionError> {
        self.volume_count =
            self.volume_count
                .checked_add(count)
                .ok_or(InjectionError::InvalidFirmware(
                    "firmware-volume census count overflow",
                ))?;
        if self.volume_count > MAX_CENSUS_VOLUMES {
            return Err(InjectionError::InvalidFirmware(
                "aggregate firmware-volume census exceeds the safety limit",
            ));
        }
        Ok(())
    }

    fn push_dxe_target(
        &mut self,
        location: FirmwareVolumePath,
        injectable: bool,
    ) -> Result<(), InjectionError> {
        if self.dxe_targets.len() >= MAX_DXE_TARGETS {
            return Err(InjectionError::InvalidFirmware(
                "DXE target census exceeds the safety limit",
            ));
        }
        self.dxe_targets.push(location.clone());
        if injectable {
            if self.injectable_targets.len() >= MAX_DXE_TARGETS {
                return Err(InjectionError::InvalidFirmware(
                    "injectable DXE target census exceeds the safety limit",
                ));
            }
            self.injectable_targets.push(location);
        }
        Ok(())
    }

    fn push_driver(&mut self, driver: DriverFileCensus) -> Result<(), InjectionError> {
        if self.driver_files.len() >= MAX_DRIVER_LOCATIONS {
            return Err(InjectionError::InvalidFirmware(
                "driver-file census exceeds the safety limit",
            ));
        }
        self.driver_files.push(driver);
        Ok(())
    }

    fn push_uninspected(&mut self, file: FirmwareFilePath) -> Result<(), InjectionError> {
        if self.uninspected_containers.len() >= MAX_CENSUS_CONTAINERS {
            return Err(InjectionError::InvalidFirmware(
                "uninspected container census exceeds the safety limit",
            ));
        }
        self.uninspected_containers.push(file);
        Ok(())
    }
}

#[derive(Default)]
struct TraversalBudget {
    decoded_bytes: u64,
    containers: usize,
}

impl TraversalBudget {
    fn charge_container(&mut self) -> Result<(), InjectionError> {
        self.containers = self
            .containers
            .checked_add(1)
            .ok_or(InjectionError::InvalidFirmware(
                "firmware-container census count overflow",
            ))?;
        if self.containers > MAX_CENSUS_CONTAINERS {
            return Err(InjectionError::InvalidFirmware(
                "firmware-container census exceeds the safety limit",
            ));
        }
        Ok(())
    }

    fn charge_decoded(&mut self, bytes: u64) -> Result<(), InjectionError> {
        if bytes > MAX_LZMA_UNCOMPRESSED_SIZE {
            return Err(InjectionError::InvalidFirmware(
                "decoded firmware stream exceeds the per-stream safety limit",
            ));
        }
        self.decoded_bytes =
            self.decoded_bytes
                .checked_add(bytes)
                .ok_or(InjectionError::InvalidFirmware(
                    "decoded firmware byte budget overflow",
                ))?;
        if self.decoded_bytes > MAX_TOTAL_DECODED_BYTES {
            return Err(InjectionError::InvalidFirmware(
                "decoded firmware streams exceed the cumulative safety limit",
            ));
        }
        Ok(())
    }

    fn remaining_decoded_bytes(&self) -> u64 {
        MAX_TOTAL_DECODED_BYTES.saturating_sub(self.decoded_bytes)
    }
}

fn require_decode_depth(guided_depth: usize) -> Result<(), InjectionError> {
    if guided_depth >= MAX_GUIDED_DEPTH {
        return Err(InjectionError::InvalidFirmware(
            "guided-section nesting exceeds the safety limit",
        ));
    }
    Ok(())
}

pub fn inject_ffs(
    firmware: &[u8],
    driver_ffs: &[u8],
) -> Result<(Vec<u8>, FirmwareInjectionBatch), InjectionError> {
    let plan = plan_ffs_injection(firmware, driver_ffs)?;
    if plan.targets.len() > 1 {
        return Err(InjectionError::AmbiguousDxeTargets {
            candidates: plan.targets,
        });
    }
    inject_ffs_with_verified_plan(firmware, driver_ffs, plan)
}

pub fn inject_ffs_all_targets(
    firmware: &[u8],
    driver_ffs: &[u8],
) -> Result<(Vec<u8>, FirmwareInjectionBatch), InjectionError> {
    let plan = plan_ffs_injection(firmware, driver_ffs)?;
    inject_ffs_with_verified_plan(firmware, driver_ffs, plan)
}

pub fn inject_ffs_with_plan(
    firmware: &[u8],
    driver_ffs: &[u8],
    expected: &FirmwareInjectionPlan,
) -> Result<(Vec<u8>, FirmwareInjectionBatch), InjectionError> {
    let current = plan_ffs_injection(firmware, driver_ffs)?;
    if &current != expected {
        return Err(InjectionError::InvalidFirmware(
            "firmware injection plan no longer matches the exact source, driver, and DXE census",
        ));
    }
    inject_ffs_with_verified_plan(firmware, driver_ffs, current)
}

pub fn plan_ffs_injection(
    firmware: &[u8],
    driver_ffs: &[u8],
) -> Result<FirmwareInjectionPlan, InjectionError> {
    reject_uefi_capsule(firmware)?;
    inspect_bundled_ffs(driver_ffs)?;
    let mut layout = InjectionLayout::default();
    let mut census_budget = TraversalBudget::default();
    let _ = discover_injection_layout(firmware, &[], true, 0, &mut layout, &mut census_budget)?;
    if !layout.uninspected_containers.is_empty() {
        return Err(InjectionError::IncompleteDxeTargetCensus {
            uninspected_containers: layout.uninspected_containers,
        });
    }
    if !layout.driver_files.is_empty() {
        return Err(InjectionError::DriverAlreadyPresent);
    }
    if layout.dxe_targets.is_empty() {
        return Err(InjectionError::NoTopLevelDxeVolume);
    }
    if let Some(target) = target_sharing_an_outer_container(&layout.dxe_targets) {
        return Err(InjectionError::UnsupportedDxeTarget {
            target: target.clone(),
        });
    }
    if let Some(target) =
        first_unmatched_firmware_volume_path(&layout.dxe_targets, &layout.injectable_targets)
    {
        return Err(InjectionError::UnsupportedDxeTarget {
            target: target.clone(),
        });
    }

    let mut targets = layout.dxe_targets;
    targets.sort_unstable_by(|left, right| {
        left.container_file_offsets
            .cmp(&right.container_file_offsets)
            .then_with(|| {
                left.firmware_volume_offset
                    .cmp(&right.firmware_volume_offset)
            })
    });
    let mut census = Sha256::new();
    census.update(b"NvStrapsReBar DXE census v1\0");
    census.update(
        u64::try_from(targets.len())
            .map_err(|_| InjectionError::InvalidFirmware("DXE target count exceeds 64 bits"))?
            .to_le_bytes(),
    );
    for target in &targets {
        census.update(
            u64::try_from(target.container_file_offsets.len())
                .map_err(|_| {
                    InjectionError::InvalidFirmware("DXE target path length exceeds 64 bits")
                })?
                .to_le_bytes(),
        );
        for offset in &target.container_file_offsets {
            census.update(
                u64::try_from(*offset)
                    .map_err(|_| {
                        InjectionError::InvalidFirmware("DXE target offset exceeds 64 bits")
                    })?
                    .to_le_bytes(),
            );
        }
        census.update(
            u64::try_from(target.firmware_volume_offset)
                .map_err(|_| {
                    InjectionError::InvalidFirmware("DXE firmware-volume offset exceeds 64 bits")
                })?
                .to_le_bytes(),
        );
    }
    Ok(FirmwareInjectionPlan {
        policy_version: 1,
        source_sha256: Sha256::digest(firmware).into(),
        driver_sha256: Sha256::digest(driver_ffs).into(),
        census_sha256: census.finalize().into(),
        targets,
    })
}

fn inject_ffs_with_verified_plan(
    firmware: &[u8],
    driver_ffs: &[u8],
    plan: FirmwareInjectionPlan,
) -> Result<(Vec<u8>, FirmwareInjectionBatch), InjectionError> {
    // A multi-bank image gives us no trustworthy active-bank bit. Patch every independently
    // dispatchable DXE domain into a local copy, or return no artifact at all. Offset order is
    // used only to make the output deterministic; it is never treated as a bank-role signal.
    let original_targets = plan.targets.clone();
    let mut output = firmware.to_vec();
    let mut injections = Vec::with_capacity(original_targets.len());
    let mut previous_driver_locations: Vec<FirmwareVolumePath> = Vec::new();
    let mut mutation_budget = TraversalBudget::default();
    for expected_driver_count in 1..=original_targets.len() {
        let (candidate, injection) =
            inject_ffs_at_depth(&output, driver_ffs, &[], 0, &mut mutation_budget)?;
        if candidate.len() != firmware.len() {
            return Err(InjectionError::InvalidFirmware(
                "firmware injection changed the outer image length",
            ));
        }

        let mut post_layout = InjectionLayout::default();
        let mut post_budget = TraversalBudget::default();
        let _ = discover_injection_layout(
            &candidate,
            &[],
            true,
            0,
            &mut post_layout,
            &mut post_budget,
        )?;
        if !post_layout.uninspected_containers.is_empty()
            || !same_firmware_volume_paths(&post_layout.dxe_targets, &original_targets)
            || !same_firmware_volume_paths(&post_layout.injectable_targets, &original_targets)
        {
            return Err(InjectionError::InvalidFirmware(
                "firmware injection changed the proven DXE target census",
            ));
        }
        if post_layout.driver_files.len() != expected_driver_count
            || post_layout
                .driver_files
                .iter()
                .any(|driver| !original_targets.contains(&driver.location))
            || original_targets.iter().any(|target| {
                post_layout
                    .driver_files
                    .iter()
                    .filter(|driver| &driver.location == target)
                    .count()
                    > 1
            })
            || post_layout
                .driver_files
                .iter()
                .any(|driver| driver.normalized_file != driver_ffs)
        {
            return Err(InjectionError::InvalidFirmware(
                "firmware injection did not add exactly one driver to one proven DXE target",
            ));
        }
        let new_drivers: Vec<_> = post_layout
            .driver_files
            .iter()
            .filter(|driver| !previous_driver_locations.contains(&driver.location))
            .collect();
        if new_drivers.len() != 1
            || new_drivers[0].location != injection.target
            || new_drivers[0].file_offset != injection.driver_file_offset
        {
            return Err(InjectionError::InvalidFirmware(
                "firmware injection target receipt does not match the post-injection census",
            ));
        }

        output = candidate;
        previous_driver_locations = post_layout
            .driver_files
            .into_iter()
            .map(|driver| driver.location)
            .collect();
        injections.push(injection);
    }

    if original_targets.iter().any(|target| {
        previous_driver_locations
            .iter()
            .filter(|location| *location == target)
            .count()
            != 1
    }) {
        return Err(InjectionError::InvalidFirmware(
            "firmware injection did not cover every proven DXE target",
        ));
    }
    Ok((
        output,
        FirmwareInjectionBatch {
            plan,
            targets: injections,
        },
    ))
}

fn same_firmware_volume_paths(left: &[FirmwareVolumePath], right: &[FirmwareVolumePath]) -> bool {
    left.len() == right.len() && first_unmatched_firmware_volume_path(left, right).is_none()
}

fn first_unmatched_firmware_volume_path<'a>(
    required: &'a [FirmwareVolumePath],
    available: &[FirmwareVolumePath],
) -> Option<&'a FirmwareVolumePath> {
    let mut matched = vec![false; available.len()];
    for required_path in required {
        let Some(index) = available
            .iter()
            .enumerate()
            .position(|(index, candidate)| !matched[index] && candidate == required_path)
        else {
            return Some(required_path);
        };
        matched[index] = true;
    }
    None
}

fn target_sharing_an_outer_container(
    targets: &[FirmwareVolumePath],
) -> Option<&FirmwareVolumePath> {
    targets.iter().enumerate().find_map(|(index, target)| {
        let outer = target.container_file_offsets.first()?;
        targets[..index]
            .iter()
            .any(|candidate| candidate.container_file_offsets.first() == Some(outer))
            .then_some(target)
    })
}

pub fn patch_legacy_firmware(
    firmware: &[u8],
    catalog: &LegacyPatchCatalog,
    selections: &[LegacyPatchSelection],
) -> Result<(Vec<u8>, LegacyFirmwarePatch), LegacyFirmwarePatchError> {
    reject_uefi_capsule(firmware)?;
    if selections.is_empty() {
        return Err(LegacyFirmwarePatchError::EmptySelection);
    }
    let mut selected = HashSet::new();
    let mut output = firmware.to_vec();
    let mut applications = Vec::with_capacity(selections.len());

    for selection in selections {
        if selection.expected_matches == 0 {
            return Err(LegacyPatchError::ExpectedMatchesMustBePositive {
                rule_id: selection.rule_id.clone(),
            }
            .into());
        }
        if !selected.insert(selection.rule_id.clone()) {
            return Err(LegacyFirmwarePatchError::DuplicateSelection(
                selection.rule_id.clone(),
            ));
        }
        let rule = catalog
            .rule(&selection.rule_id)
            .ok_or_else(|| LegacyFirmwarePatchError::UnknownRule(selection.rule_id.clone()))?;
        let (patched, changes) = patch_rule_in_firmware(&output, rule, &[], 0)?;
        if changes.len() != selection.expected_matches {
            return Err(LegacyPatchError::MatchCount {
                rule_id: rule.id.clone(),
                expected: selection.expected_matches,
                actual: changes.len(),
            }
            .into());
        }
        output = patched;
        applications.push(LegacyFirmwarePatchApplication {
            rule_id: rule.id.clone(),
            expected_matches: selection.expected_matches,
            changes,
        });
    }

    Ok((
        output,
        LegacyFirmwarePatch {
            catalog_sha256: catalog.source_sha256.clone(),
            applications,
        },
    ))
}

pub fn analyze_legacy_firmware(
    firmware: &[u8],
    catalog: &LegacyPatchCatalog,
) -> Result<LegacyFirmwareCatalogAnalysis, LegacyFirmwarePatchError> {
    reject_uefi_capsule(firmware)?;
    // Refuse a non-firmware input before turning individual scan failures into rule-level results.
    // A blocked rule means that its target could not be proved safe, not that the image itself was
    // accepted without a parseable top-level firmware volume.
    top_level_firmware_volumes(firmware)?;

    let rules = catalog
        .rules
        .iter()
        .map(|rule| {
            let disposition = match patch_rule_in_firmware(firmware, rule, &[], 0) {
                Ok((_, changes)) if changes.is_empty() => LegacyFirmwareRuleDisposition::Absent,
                Ok((_, changes)) => LegacyFirmwareRuleDisposition::Applicable {
                    expected_matches: changes.len(),
                },
                Err(error) => LegacyFirmwareRuleDisposition::Blocked {
                    reason: error.to_string(),
                },
            };
            LegacyFirmwareRuleAnalysis {
                rule_id: rule.id.clone(),
                disposition,
            }
        })
        .collect();

    Ok(LegacyFirmwareCatalogAnalysis {
        catalog_sha256: catalog.source_sha256.clone(),
        rules,
    })
}

fn reject_uefi_capsule(firmware: &[u8]) -> Result<(), InjectionError> {
    match inspect_firmware_envelope(firmware) {
        FirmwareEnvelope::RawOrVendorImage => Ok(()),
        FirmwareEnvelope::UefiCapsule(header) => Err(InjectionError::UnsupportedCapsule(header)),
        FirmwareEnvelope::MalformedCapsule(header) => Err(InjectionError::MalformedCapsule(header)),
    }
}

fn patch_rule_in_firmware(
    firmware: &[u8],
    rule: &LegacyPatchRule,
    path: &[LegacyFirmwarePatchPath],
    depth: usize,
) -> Result<(Vec<u8>, Vec<LegacyFirmwarePatchChange>), LegacyFirmwarePatchError> {
    if depth > MAX_GUIDED_DEPTH {
        return Err(InjectionError::InvalidFirmware(
            "legacy patch encapsulation exceeds the safety limit",
        )
        .into());
    }
    let top_level = top_level_firmware_volumes(firmware)?;
    let mut output = firmware.to_vec();
    let mut changes = Vec::new();

    for volume in top_level {
        let records = firmware_files(&output, volume)?;
        for record in records {
            if !record.is_live {
                continue;
            }
            let file_guid: [u8; 16] = output[record.offset..record.offset + 16]
                .try_into()
                .expect("FFS header length was checked");
            let target_file = file_guid == rule.file_guid;
            let volume_container = record.file_type == FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE;
            if !target_file && !volume_container {
                continue;
            }
            if record.header_size != FFS_HEADER_SIZE {
                return Err(LegacyFirmwarePatchError::UnsupportedTargetFile {
                    rule_id: rule.id.clone(),
                    file_offset: record.offset,
                    reason: "large-file headers are not yet supported",
                });
            }
            let mut normalized = output[record.offset..record.offset + record.size].to_vec();
            if volume.erase_polarity {
                normalized[23] = !normalized[23];
            }
            verify_generic_file(&normalized)?;
            let mut file_path = path.to_vec();
            file_path.push(LegacyFirmwarePatchPath::FirmwareVolume {
                offset: volume.start,
            });
            file_path.push(LegacyFirmwarePatchPath::FirmwareFile {
                offset: record.offset,
                file_guid,
            });
            let (patched_body, file_changes) = patch_section_stream(
                &normalized[record.header_size..],
                rule,
                target_file,
                volume_container,
                &file_path,
                depth,
            )?;
            if file_changes.is_empty() {
                continue;
            }

            let rebuilt = build_generic_file(&normalized[..record.header_size], &patched_body)?;
            let Some(mut replaced) = replace_firmware_file(&output, volume, record, &rebuilt)?
            else {
                return Err(LegacyFirmwarePatchError::UnsupportedTargetFile {
                    rule_id: rule.id.clone(),
                    file_offset: record.offset,
                    reason: "re-encoded encapsulation does not fit without moving another FFS file",
                });
            };
            update_used_size(
                &mut replaced,
                volume,
                record.offset
                    + align_up(rebuilt.len(), 8).ok_or(InjectionError::InvalidFirmware(
                        "legacy patch file alignment overflow",
                    ))?,
            )?;
            output = replaced;
            changes.extend(file_changes);
        }
    }
    Ok((output, changes))
}

fn patch_section_stream(
    stream: &[u8],
    rule: &LegacyPatchRule,
    target_file: bool,
    volume_container: bool,
    path: &[LegacyFirmwarePatchPath],
    depth: usize,
) -> Result<(Vec<u8>, Vec<LegacyFirmwarePatchChange>), LegacyFirmwarePatchError> {
    let sections = parse_section_stream(stream)?;
    let mut output = Vec::with_capacity(stream.len());
    let mut cursor = 0;
    let mut changes = Vec::new();

    for section in sections {
        output.extend_from_slice(&stream[cursor..section.offset]);
        let content = &stream[section.content_start..section.end];
        let mut section_path = path.to_vec();
        section_path.push(LegacyFirmwarePatchPath::Section {
            offset: section.offset,
            content_offset: section.content_start,
            section_type: section.section_type,
        });
        let (patched_content, mut section_changes) = patch_section_content(
            content,
            section,
            rule,
            target_file,
            volume_container,
            &section_path,
            depth,
        )?;

        if patched_content == content {
            output.extend_from_slice(&stream[section.offset..section.next_offset]);
        } else {
            output.extend(build_firmware_section(section, &patched_content)?);
            if section.next_offset < stream.len() || section.next_offset > section.end {
                let aligned = align_up(output.len(), 4).ok_or(InjectionError::InvalidFirmware(
                    "rebuilt FFS section alignment overflow",
                ))?;
                output.resize(aligned, 0);
            }
        }
        cursor = section.next_offset;
        changes.append(&mut section_changes);
    }
    output.extend_from_slice(&stream[cursor..]);
    Ok((output, changes))
}

fn patch_section_content(
    content: &[u8],
    section: FirmwareSectionRecord,
    rule: &LegacyPatchRule,
    target_file: bool,
    volume_container: bool,
    path: &[LegacyFirmwarePatchPath],
    depth: usize,
) -> Result<(Vec<u8>, Vec<LegacyFirmwarePatchChange>), LegacyFirmwarePatchError> {
    let mut output = content.to_vec();
    let mut changes = Vec::new();

    if target_file && section.section_type == rule.section_type {
        let matches = rule.matching_offsets(&output);
        if !matches.is_empty() {
            let (patched, application) = rule.apply_exact(&output, matches.len())?;
            output = patched;
            changes.extend(application.changes.into_iter().map(|change| {
                LegacyFirmwarePatchChange {
                    path: path.to_vec(),
                    change,
                }
            }));
        }
    }

    match section.section_type {
        SECTION_TYPE_COMPRESSION if target_file || volume_container => {
            if output.len() < 5 {
                return Err(InjectionError::InvalidFirmware(
                    "compression section header is truncated",
                )
                .into());
            }
            let declared_size = read_u32(&output, 0)? as usize;
            let compression_type = output[4];
            match compression_type {
                0 => {
                    let payload = &output[5..];
                    if declared_size != payload.len() {
                        return Err(InjectionError::InvalidFirmware(
                            "uncompressed section size does not match its payload",
                        )
                        .into());
                    }
                    let mut payload_path = path.to_vec();
                    payload_path.push(LegacyFirmwarePatchPath::UncompressedPayload);
                    let (patched, mut nested_changes) = patch_decoded_payload(
                        payload,
                        rule,
                        target_file,
                        volume_container,
                        &payload_path,
                        depth + 1,
                    )?;
                    if !nested_changes.is_empty() {
                        output.truncate(5);
                        output[..4].copy_from_slice(
                            &u32::try_from(patched.len())
                                .map_err(|_| {
                                    InjectionError::InvalidFirmware(
                                        "uncompressed section size exceeds 32 bits",
                                    )
                                })?
                                .to_le_bytes(),
                        );
                        output.extend_from_slice(&patched);
                        changes.append(&mut nested_changes);
                    }
                }
                1 => {
                    let (patched, mut nested_changes) = patch_efi_compressed_payload(
                        &output,
                        declared_size,
                        rule,
                        target_file,
                        volume_container,
                        path,
                        depth,
                    )?;
                    if !nested_changes.is_empty() {
                        output = patched;
                        changes.append(&mut nested_changes);
                    }
                }
                _ => {
                    return Err(InjectionError::InvalidFirmware(
                        "compression section uses an unknown compression type",
                    )
                    .into());
                }
            }
        }
        SECTION_TYPE_GUID_DEFINED if target_file || volume_container => {
            let (patched, mut nested_changes) = patch_guided_section_payload(
                &output,
                section.header_size,
                rule,
                target_file,
                volume_container,
                path,
                depth,
            )?;
            if !nested_changes.is_empty() {
                output = patched;
                changes.append(&mut nested_changes);
            }
        }
        SECTION_TYPE_FIRMWARE_VOLUME_IMAGE if volume_container => {
            let (patched, mut nested_changes) =
                patch_rule_in_firmware(&output, rule, path, depth + 1)?;
            if !nested_changes.is_empty() {
                output = patched;
                changes.append(&mut nested_changes);
            }
        }
        _ => {}
    }

    Ok((output, changes))
}

fn patch_guided_section_payload(
    content: &[u8],
    section_header_size: usize,
    rule: &LegacyPatchRule,
    target_file: bool,
    volume_container: bool,
    path: &[LegacyFirmwarePatchPath],
    depth: usize,
) -> Result<(Vec<u8>, Vec<LegacyFirmwarePatchChange>), LegacyFirmwarePatchError> {
    if content.len() < 20 {
        return Err(
            InjectionError::InvalidFirmware("GUID-defined section header is truncated").into(),
        );
    }
    let data_offset = read_u16(content, 16)? as usize;
    let attributes = read_u16(content, 18)?;
    if data_offset < section_header_size + 20 {
        return Err(InjectionError::InvalidFirmware(
            "GUID-defined section data offset is malformed",
        )
        .into());
    }
    let payload_offset = data_offset - section_header_size;
    if payload_offset > content.len() {
        return Err(InjectionError::InvalidFirmware(
            "GUID-defined section data extends beyond its section",
        )
        .into());
    }
    if content[..16] != LZMA_GUID_BYTES {
        let reason = if attributes & 1 != 0 {
            "unknown processing-required GUID-defined section"
        } else {
            "unknown GUID-defined section may hide additional matches"
        };
        return Err(LegacyFirmwarePatchError::UnsupportedTargetFile {
            rule_id: rule.id.clone(),
            file_offset: current_file_offset(path),
            reason,
        });
    }
    if section_header_size != 4
        || data_offset != 24
        || attributes != GUIDED_SECTION_PROCESSING_REQUIRED
    {
        return Err(LegacyFirmwarePatchError::UnsupportedTargetFile {
            rule_id: rule.id.clone(),
            file_offset: current_file_offset(path),
            reason: "LZMA section uses authentication or vendor metadata that cannot be rebuilt",
        });
    }

    let lzma = &content[payload_offset..];
    validate_lzma_header(lzma)?;
    let decompressed =
        lzma_decompress(lzma).map_err(|error| InjectionError::Compression(error.to_string()))?;
    let mut payload_path = path.to_vec();
    payload_path.push(LegacyFirmwarePatchPath::LzmaPayload);
    let (patched_payload, mut changes) = patch_decoded_payload(
        &decompressed,
        rule,
        target_file,
        volume_container,
        &payload_path,
        depth + 1,
    )?;
    if changes.is_empty() {
        return Ok((content.to_vec(), changes));
    }

    let recompressed = compress_uefi_lzma(&patched_payload, lzma)?;
    let round_trip = lzma_decompress(&recompressed)
        .map_err(|error| InjectionError::Compression(error.to_string()))?;
    if round_trip != patched_payload {
        return Err(InjectionError::InvalidFirmware(
            "recompressed legacy patch section failed its round trip",
        )
        .into());
    }
    let mut output = content[..payload_offset].to_vec();
    output.extend_from_slice(&recompressed);
    Ok((output, std::mem::take(&mut changes)))
}

fn patch_efi_compressed_payload(
    content: &[u8],
    declared_size: usize,
    rule: &LegacyPatchRule,
    target_file: bool,
    volume_container: bool,
    path: &[LegacyFirmwarePatchPath],
    depth: usize,
) -> Result<(Vec<u8>, Vec<LegacyFirmwarePatchChange>), LegacyFirmwarePatchError> {
    struct Candidate {
        compression: EfiCompression,
        decoded: Vec<u8>,
        patched: Vec<u8>,
        changes: Vec<LegacyFirmwarePatchChange>,
        exactly_reencodes_original: bool,
    }

    let compressed = &content[5..];
    let mut candidates = Vec::new();
    let mut first_structure_error = None;
    for compression in [EfiCompression::EfiStandard, EfiCompression::Tiano] {
        let Ok(decoded) = efi_decompress(compressed, compression) else {
            continue;
        };
        if decoded.len() != declared_size {
            continue;
        }
        let mut payload_path = path.to_vec();
        payload_path.push(LegacyFirmwarePatchPath::EfiCompressedPayload { compression });
        let (patched, changes) = match patch_decoded_payload(
            &decoded,
            rule,
            target_file,
            volume_container,
            &payload_path,
            depth + 1,
        ) {
            Ok(result) => result,
            Err(error) => {
                first_structure_error.get_or_insert(error);
                continue;
            }
        };
        let exactly_reencodes_original =
            efi_compress(&decoded, compression).is_ok_and(|encoded| encoded == compressed);
        candidates.push(Candidate {
            compression,
            decoded,
            patched,
            changes,
            exactly_reencodes_original,
        });
    }

    if candidates.is_empty() {
        if let Some(error) = first_structure_error {
            return Err(error);
        }
        return Err(LegacyFirmwarePatchError::UnsupportedTargetFile {
            rule_id: rule.id.clone(),
            file_offset: current_file_offset(path),
            reason: "neither EFI nor Tiano decoding produced a valid section tree",
        });
    }
    let exact_count = candidates
        .iter()
        .filter(|candidate| candidate.exactly_reencodes_original)
        .count();
    let selected = if candidates.len() == 1 {
        candidates.pop().expect("one candidate")
    } else if exact_count == 1 {
        let index = candidates
            .iter()
            .position(|candidate| candidate.exactly_reencodes_original)
            .expect("exact candidate was counted");
        candidates.swap_remove(index)
    } else {
        return Err(LegacyFirmwarePatchError::UnsupportedTargetFile {
            rule_id: rule.id.clone(),
            file_offset: current_file_offset(path),
            reason: "EFI and Tiano compression variants are ambiguous",
        });
    };

    if selected.changes.is_empty() {
        return Ok((content.to_vec(), selected.changes));
    }
    let recompressed = efi_compress(&selected.patched, selected.compression)
        .map_err(|error| InjectionError::Compression(error.to_string()))?;
    let round_trip = efi_decompress(&recompressed, selected.compression)
        .map_err(|error| InjectionError::Compression(error.to_string()))?;
    if round_trip != selected.patched || selected.decoded.len() != declared_size {
        return Err(InjectionError::InvalidFirmware(
            "recompressed EFI/Tiano section failed its round trip",
        )
        .into());
    }
    let mut output = content[..5].to_vec();
    output[..4].copy_from_slice(
        &u32::try_from(selected.patched.len())
            .map_err(|_| {
                InjectionError::InvalidFirmware("compressed section size exceeds 32 bits")
            })?
            .to_le_bytes(),
    );
    output.extend_from_slice(&recompressed);
    Ok((output, selected.changes))
}

fn patch_decoded_payload(
    payload: &[u8],
    rule: &LegacyPatchRule,
    target_file: bool,
    volume_container: bool,
    path: &[LegacyFirmwarePatchPath],
    depth: usize,
) -> Result<(Vec<u8>, Vec<LegacyFirmwarePatchChange>), LegacyFirmwarePatchError> {
    if !top_level_firmware_volumes(payload)?.is_empty() {
        patch_rule_in_firmware(payload, rule, path, depth)
    } else {
        patch_section_stream(payload, rule, target_file, volume_container, path, depth)
    }
}

fn top_level_firmware_volumes(firmware: &[u8]) -> Result<Vec<FirmwareVolume>, InjectionError> {
    let mut volumes = find_firmware_volumes(firmware)?;
    volumes.sort_unstable_by(|left, right| {
        left.start
            .cmp(&right.start)
            .then_with(|| right.end.cmp(&left.end))
    });
    let mut top_level = Vec::new();
    let mut containing_end = 0;
    for volume in volumes {
        if volume.start < containing_end {
            if volume.end <= containing_end {
                continue;
            }
            return Err(InjectionError::InvalidFirmware(
                "firmware volumes partially overlap",
            ));
        }
        containing_end = volume.end;
        top_level.push(volume);
    }
    Ok(top_level)
}

fn discover_injection_layout(
    firmware: &[u8],
    container_file_offsets: &[usize],
    mutator_supported: bool,
    guided_depth: usize,
    layout: &mut InjectionLayout,
    budget: &mut TraversalBudget,
) -> Result<usize, InjectionError> {
    if guided_depth > MAX_GUIDED_DEPTH {
        return Err(InjectionError::InvalidFirmware(
            "guided-section nesting exceeds the safety limit",
        ));
    }
    let volumes = top_level_firmware_volumes(firmware)?;
    let volume_count = volumes.len();
    layout.charge_volumes(volume_count)?;
    for volume in volumes {
        let scan = scan_volume(firmware, volume)?;
        let location = FirmwareVolumePath {
            container_file_offsets: container_file_offsets.to_vec(),
            firmware_volume_offset: volume.start,
        };
        if scan.contains_dxe_core {
            layout.push_dxe_target(location.clone(), mutator_supported)?;
        }
        let records = firmware_files(firmware, volume)?;
        for record in records.iter().copied().filter(|record| {
            record.is_live && firmware[record.offset..record.offset + 16] == FFS_FILE_GUID_BYTES
        }) {
            let mut normalized_file = firmware[record.offset..record.offset + record.size].to_vec();
            if volume.erase_polarity {
                normalized_file[23] = !normalized_file[23];
            }
            layout.push_driver(DriverFileCensus {
                location: location.clone(),
                file_offset: record.offset,
                normalized_file,
            })?;
        }

        for record in records {
            if !record.is_live || record.file_type != FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE {
                continue;
            }
            budget.charge_container()?;
            if record.header_size != FFS_HEADER_SIZE {
                layout.push_uninspected(FirmwareFilePath {
                    container_file_offsets: container_file_offsets.to_vec(),
                    firmware_volume_offset: volume.start,
                    file_offset: record.offset,
                })?;
                continue;
            }
            let mut normalized = firmware[record.offset..record.offset + record.size].to_vec();
            if volume.erase_polarity {
                normalized[23] = !normalized[23];
            }
            let mut nested_offsets = container_file_offsets.to_vec();
            nested_offsets.push(record.offset);
            if !discover_fv_image_file(
                &normalized,
                &nested_offsets,
                mutator_supported,
                guided_depth,
                layout,
                budget,
            )? {
                layout.push_uninspected(FirmwareFilePath {
                    container_file_offsets: container_file_offsets.to_vec(),
                    firmware_volume_offset: volume.start,
                    file_offset: record.offset,
                })?;
            }
        }
    }
    Ok(volume_count)
}

fn discover_fv_image_file(
    file: &[u8],
    nested_offsets: &[usize],
    mutator_supported: bool,
    guided_depth: usize,
    layout: &mut InjectionLayout,
    budget: &mut TraversalBudget,
) -> Result<bool, InjectionError> {
    verify_generic_file(file)?;
    let injectable_targets_before = layout.injectable_targets.len();
    let body = file
        .get(FFS_HEADER_SIZE..)
        .ok_or(InjectionError::InvalidFirmware(
            "firmware-volume image file header is truncated",
        ))?;
    let mut decoded_payloads = 0;
    let mut complete = true;
    let mut lzma_sections = 0;
    for section in parse_section_stream(body)? {
        let content = &body[section.content_start..section.end];
        match section.section_type {
            SECTION_TYPE_GUID_DEFINED => {
                if content.len() < 20 {
                    return Err(InjectionError::InvalidFirmware(
                        "GUID-defined section header is truncated",
                    ));
                }
                if content[..16] != LZMA_GUID_BYTES && content[..16] != AMD_ZLIB_GUID_BYTES {
                    complete = false;
                    continue;
                }
                let data_offset = read_u16(content, 16)? as usize;
                let attributes = read_u16(content, 18)?;
                let minimum_data_offset = section.header_size + 20;
                if data_offset < minimum_data_offset {
                    return Err(InjectionError::InvalidFirmware(
                        "guided LZMA data offset is malformed",
                    ));
                }
                let payload_offset = data_offset - section.header_size;
                let encoded =
                    content
                        .get(payload_offset..)
                        .ok_or(InjectionError::InvalidFirmware(
                            "guided section data extends beyond its section",
                        ))?;
                require_decode_depth(guided_depth)?;
                let decompressed = if content[..16] == LZMA_GUID_BYTES {
                    let declared_size = validate_lzma_header(encoded)?;
                    budget.charge_decoded(declared_size)?;
                    lzma_sections += 1;
                    let decompressed = lzma_decompress(encoded)
                        .map_err(|error| InjectionError::Compression(error.to_string()))?;
                    if decompressed.len() as u64 != declared_size {
                        return Err(InjectionError::InvalidFirmware(
                            "guided LZMA output size does not match its header",
                        ));
                    }
                    decompressed
                } else {
                    decompress_amd_zlib(encoded, budget)?
                };
                if discover_decoded_payload(
                    &decompressed,
                    nested_offsets,
                    mutator_supported
                        && content[..16] == LZMA_GUID_BYTES
                        && section.header_size == 4
                        && data_offset == 24
                        && attributes == GUIDED_SECTION_PROCESSING_REQUIRED
                        && lzma_sections == 1,
                    guided_depth + 1,
                    layout,
                    budget,
                )? {
                    decoded_payloads += 1;
                } else {
                    complete = false;
                }
            }
            SECTION_TYPE_FIRMWARE_VOLUME_IMAGE => {
                if discover_decoded_payload(
                    content,
                    nested_offsets,
                    false,
                    guided_depth + 1,
                    layout,
                    budget,
                )? {
                    decoded_payloads += 1;
                } else {
                    complete = false;
                }
            }
            SECTION_TYPE_COMPRESSION => {
                if content.len() < 5 {
                    return Err(InjectionError::InvalidFirmware(
                        "compression section header is truncated",
                    ));
                }
                let declared_size = read_u32(content, 0)? as usize;
                let decoded = match content[4] {
                    0 if declared_size == content[5..].len() => content[5..].to_vec(),
                    1 => {
                        let Some(decoded) = decode_efi_compression_section(
                            content,
                            declared_size,
                            guided_depth,
                            budget,
                        )?
                        else {
                            complete = false;
                            continue;
                        };
                        decoded
                    }
                    _ => {
                        complete = false;
                        continue;
                    }
                };
                if discover_decoded_payload(
                    &decoded,
                    nested_offsets,
                    false,
                    guided_depth + 1,
                    layout,
                    budget,
                )? {
                    decoded_payloads += 1;
                } else {
                    complete = false;
                }
            }
            section_type if is_non_encapsulating_leaf_section(section_type) => {}
            SECTION_TYPE_DISPOSABLE => complete = false,
            _ => complete = false,
        }
    }
    if decoded_payloads != 1 {
        // File-offset paths are authoritative only when exactly one encapsulating payload in
        // this FFS can contain live firmware volumes. Multiple decoded siblings need section-hop
        // pins and a one-pass bottom-up rebuilder before any of them may be mutated.
        layout
            .injectable_targets
            .truncate(injectable_targets_before);
    }
    Ok(complete && decoded_payloads > 0)
}

fn discover_decoded_payload(
    payload: &[u8],
    container_file_offsets: &[usize],
    mutator_supported: bool,
    guided_depth: usize,
    layout: &mut InjectionLayout,
    budget: &mut TraversalBudget,
) -> Result<bool, InjectionError> {
    let volume_count_before = layout.volume_count;
    let direct_volume_count = discover_injection_layout(
        payload,
        container_file_offsets,
        mutator_supported,
        guided_depth,
        layout,
        budget,
    )?;

    let complete = match parse_section_stream(payload) {
        Ok(sections) if !sections.is_empty() => discover_hidden_section_payloads(
            payload,
            &sections,
            container_file_offsets,
            guided_depth,
            layout,
            budget,
        )?,
        _ => direct_volume_count > 0 && raw_firmware_layout_is_complete(payload)?,
    };
    Ok(complete && layout.volume_count > volume_count_before)
}

fn discover_hidden_section_payloads(
    stream: &[u8],
    sections: &[FirmwareSectionRecord],
    container_file_offsets: &[usize],
    guided_depth: usize,
    layout: &mut InjectionLayout,
    budget: &mut TraversalBudget,
) -> Result<bool, InjectionError> {
    let mut complete = true;
    for section in sections {
        let content = &stream[section.content_start..section.end];
        match section.section_type {
            SECTION_TYPE_GUID_DEFINED => {
                if content.len() < 20 {
                    return Err(InjectionError::InvalidFirmware(
                        "GUID-defined section header is truncated",
                    ));
                }
                let data_offset = read_u16(content, 16)? as usize;
                let minimum_data_offset = section.header_size + 20;
                if data_offset < minimum_data_offset {
                    return Err(InjectionError::InvalidFirmware(
                        "guided section data offset is malformed",
                    ));
                }
                let payload_offset = data_offset - section.header_size;
                let encoded =
                    content
                        .get(payload_offset..)
                        .ok_or(InjectionError::InvalidFirmware(
                            "guided section data extends beyond its section",
                        ))?;
                require_decode_depth(guided_depth)?;
                let decoded = if content[..16] == LZMA_GUID_BYTES {
                    let declared_size = validate_lzma_header(encoded)?;
                    budget.charge_decoded(declared_size)?;
                    let decoded = lzma_decompress(encoded)
                        .map_err(|error| InjectionError::Compression(error.to_string()))?;
                    if decoded.len() as u64 != declared_size {
                        return Err(InjectionError::InvalidFirmware(
                            "guided LZMA output size does not match its header",
                        ));
                    }
                    decoded
                } else if content[..16] == AMD_ZLIB_GUID_BYTES {
                    decompress_amd_zlib(encoded, budget)?
                } else {
                    complete = false;
                    continue;
                };
                complete &= discover_decoded_payload(
                    &decoded,
                    container_file_offsets,
                    false,
                    guided_depth + 1,
                    layout,
                    budget,
                )?;
            }
            SECTION_TYPE_COMPRESSION => {
                if content.len() < 5 {
                    return Err(InjectionError::InvalidFirmware(
                        "compression section header is truncated",
                    ));
                }
                let declared_size = read_u32(content, 0)? as usize;
                if content[4] != 1 {
                    complete = false;
                    continue;
                }
                let Some(decoded) =
                    decode_efi_compression_section(content, declared_size, guided_depth, budget)?
                else {
                    complete = false;
                    continue;
                };
                complete &= discover_decoded_payload(
                    &decoded,
                    container_file_offsets,
                    false,
                    guided_depth + 1,
                    layout,
                    budget,
                )?;
            }
            SECTION_TYPE_FIRMWARE_VOLUME_IMAGE => {
                complete &= raw_firmware_layout_is_complete(content)?;
            }
            0x10..=0x16 | 0x18 | 0x19 | 0x1b | 0x1c => {}
            SECTION_TYPE_DISPOSABLE => complete = false,
            _ => complete = false,
        }
    }
    Ok(complete)
}

fn decode_efi_compression_section(
    content: &[u8],
    declared_size: usize,
    guided_depth: usize,
    budget: &mut TraversalBudget,
) -> Result<Option<Vec<u8>>, InjectionError> {
    require_decode_depth(guided_depth)?;
    budget.charge_decoded(declared_size as u64)?;
    let mut decoded = None;
    for compression in [EfiCompression::EfiStandard, EfiCompression::Tiano] {
        let Ok(candidate) = efi_decompress(&content[5..], compression) else {
            continue;
        };
        if candidate.len() != declared_size {
            continue;
        }
        if decoded
            .as_ref()
            .is_some_and(|existing: &Vec<u8>| existing != &candidate)
        {
            return Ok(None);
        }
        decoded = Some(candidate);
    }
    Ok(decoded)
}

fn raw_firmware_layout_is_complete(payload: &[u8]) -> Result<bool, InjectionError> {
    let mut volumes = top_level_firmware_volumes(payload)?;
    if volumes.is_empty() {
        return Ok(false);
    }
    volumes.sort_unstable_by_key(|volume| volume.start);
    let mut cursor = 0;
    for volume in volumes {
        if volume.start < cursor {
            return Err(InjectionError::InvalidFirmware(
                "top-level firmware volumes overlap",
            ));
        }
        if payload[cursor..volume.start]
            .iter()
            .any(|byte| *byte != 0 && *byte != 0xff)
        {
            return Ok(false);
        }
        cursor = volume.end;
    }
    Ok(payload[cursor..]
        .iter()
        .all(|byte| *byte == 0 || *byte == 0xff))
}

fn decompress_amd_zlib(
    encoded: &[u8],
    budget: &mut TraversalBudget,
) -> Result<Vec<u8>, InjectionError> {
    if encoded.len() < AMD_ZLIB_HEADER_SIZE {
        return Err(InjectionError::InvalidFirmware(
            "AMD zlib section header is truncated",
        ));
    }
    if encoded[..0x14].iter().any(|byte| *byte != 0)
        || encoded[0x18..AMD_ZLIB_HEADER_SIZE]
            .iter()
            .any(|byte| *byte != 0)
    {
        return Err(InjectionError::InvalidFirmware(
            "AMD zlib section reserved header bytes are not zero",
        ));
    }
    let compressed_size = read_u32(encoded, 0x14)? as usize;
    let compressed_end = AMD_ZLIB_HEADER_SIZE.checked_add(compressed_size).ok_or(
        InjectionError::InvalidFirmware("AMD zlib compressed size overflows its section"),
    )?;
    if compressed_size == 0 || compressed_end != encoded.len() {
        return Err(InjectionError::InvalidFirmware(
            "AMD zlib compressed size does not match its section",
        ));
    }
    let decoder = ZlibDecoder::new(&encoded[AMD_ZLIB_HEADER_SIZE..]);
    let decode_limit = MAX_LZMA_UNCOMPRESSED_SIZE.min(budget.remaining_decoded_bytes());
    let mut limited = decoder.take(decode_limit + 1);
    let mut decompressed = Vec::new();
    limited
        .read_to_end(&mut decompressed)
        .map_err(|error| InjectionError::Compression(error.to_string()))?;
    let decoder = limited.into_inner();
    if decoder.total_in() != compressed_size as u64 {
        return Err(InjectionError::InvalidFirmware(
            "AMD zlib decoder did not consume the declared stream",
        ));
    }
    if decompressed.len() as u64 > MAX_LZMA_UNCOMPRESSED_SIZE {
        return Err(InjectionError::InvalidFirmware(
            "AMD zlib output exceeds the safety limit",
        ));
    }
    budget.charge_decoded(decompressed.len() as u64)?;
    Ok(decompressed)
}

fn is_non_encapsulating_leaf_section(section_type: u8) -> bool {
    matches!(section_type, 0x10..=0x16 | 0x18 | 0x19 | 0x1b | 0x1c)
}

fn current_file_offset(path: &[LegacyFirmwarePatchPath]) -> usize {
    path.iter()
        .rev()
        .find_map(|part| match part {
            LegacyFirmwarePatchPath::FirmwareFile { offset, .. } => Some(*offset),
            _ => None,
        })
        .unwrap_or(0)
}

fn inject_ffs_at_depth(
    firmware: &[u8],
    driver_ffs: &[u8],
    container_file_offsets: &[usize],
    guided_depth: usize,
    budget: &mut TraversalBudget,
) -> Result<(Vec<u8>, FirmwareInjection), InjectionError> {
    if guided_depth > MAX_GUIDED_DEPTH {
        return Err(InjectionError::InvalidFirmware(
            "guided-section nesting exceeds the safety limit",
        ));
    }
    inspect_ffs(driver_ffs)?;
    let top_level = top_level_firmware_volumes(firmware)?;
    let mut scanned = Vec::new();
    for volume in top_level.iter().copied() {
        scanned.push((volume, scan_volume(firmware, volume)?));
    }
    if !scanned
        .iter()
        .any(|(_, scan)| scan.contains_dxe_core && scan.driver_count == 0)
        && let Some(injected) = try_inject_lzma_guided(
            firmware,
            driver_ffs,
            &top_level,
            container_file_offsets,
            guided_depth,
            budget,
        )?
    {
        return Ok(injected);
    }
    let mut saw_dxe_volume = false;
    let mut no_space = None;

    for (volume, scan) in scanned {
        if !scan.contains_dxe_core {
            continue;
        }
        if scan.driver_count > 0 {
            continue;
        }
        saw_dxe_volume = true;
        let needed = align_up(driver_ffs.len(), 8)
            .ok_or(InjectionError::InvalidFirmware("driver alignment overflow"))?;
        let mut selected = None;
        let mut available_bytes = 0;
        let mut growth_slot = (volume.end, volume.end, false);
        for (slot, replaced_pad_file) in [(scan.raw_free, false), (scan.pad_free, true)] {
            let Some((file_offset, slot_end)) = slot else {
                continue;
            };
            let slot_size = slot_end - file_offset;
            if slot_size > available_bytes {
                available_bytes = slot_size;
                growth_slot = (file_offset, slot_end, replaced_pad_file);
            }
            if slot_size >= needed {
                selected = Some((file_offset, slot_end, replaced_pad_file));
                break;
            }
        }
        let Some((file_offset, slot_end, replaced_pad_file)) = selected else {
            if guided_depth > 0 {
                let (file_offset, _, replaced_pad_file) = growth_slot;
                let required_end =
                    file_offset
                        .checked_add(needed)
                        .ok_or(InjectionError::InvalidFirmware(
                            "nested driver allocation overflow",
                        ))?;
                let (output, grown_volume, growth_bytes) =
                    grow_nested_firmware_volume(firmware, volume, required_end)?;
                return inject_driver_at_slot(
                    output,
                    container_file_offsets,
                    driver_ffs,
                    DriverSlot {
                        volume: grown_volume,
                        file_offset,
                        slot_end: grown_volume.end,
                        replaced_pad_file,
                        growth_bytes,
                    },
                );
            }
            no_space = Some(InjectionError::NoSpace {
                location: FirmwareVolumePath {
                    container_file_offsets: container_file_offsets.to_vec(),
                    firmware_volume_offset: volume.start,
                },
                available_bytes,
                required_bytes: needed,
            });
            continue;
        };
        return inject_driver_at_slot(
            firmware.to_vec(),
            container_file_offsets,
            driver_ffs,
            DriverSlot {
                volume,
                file_offset,
                slot_end,
                replaced_pad_file,
                growth_bytes: 0,
            },
        );
    }

    Err(if saw_dxe_volume {
        no_space.expect("a DXE volume without a selected slot records its capacity")
    } else {
        InjectionError::NoTopLevelDxeVolume
    })
}

struct DriverSlot {
    volume: FirmwareVolume,
    file_offset: usize,
    slot_end: usize,
    replaced_pad_file: bool,
    growth_bytes: usize,
}

fn inject_driver_at_slot(
    mut output: Vec<u8>,
    container_file_offsets: &[usize],
    driver_ffs: &[u8],
    slot: DriverSlot,
) -> Result<(Vec<u8>, FirmwareInjection), InjectionError> {
    let DriverSlot {
        volume,
        file_offset,
        slot_end,
        replaced_pad_file,
        growth_bytes,
    } = slot;
    let needed = align_up(driver_ffs.len(), 8)
        .ok_or(InjectionError::InvalidFirmware("driver alignment overflow"))?;
    let allocation_end = file_offset
        .checked_add(needed)
        .ok_or(InjectionError::InvalidFirmware(
            "driver allocation overflow",
        ))?;
    if allocation_end > slot_end || slot_end > volume.end {
        return Err(InjectionError::InvalidFirmware(
            "driver allocation exceeds the selected firmware-volume slot",
        ));
    }
    if replaced_pad_file {
        output[file_offset..slot_end].fill(volume.erase_byte);
    }
    output[file_offset..file_offset + driver_ffs.len()].copy_from_slice(driver_ffs);
    output[file_offset + 23] = if volume.erase_polarity {
        !FFS_FILE_STATE_VALID
    } else {
        FFS_FILE_STATE_VALID
    };
    output[file_offset + driver_ffs.len()..allocation_end].fill(volume.erase_byte);
    update_used_size(&mut output, volume, allocation_end)?;

    let embedded = &output[file_offset..file_offset + driver_ffs.len()];
    let mut normalized = embedded.to_vec();
    if volume.erase_polarity {
        normalized[23] = !normalized[23];
    }
    inspect_ffs(&normalized)?;
    Ok((
        output,
        FirmwareInjection {
            target: FirmwareVolumePath {
                container_file_offsets: container_file_offsets.to_vec(),
                firmware_volume_offset: volume.start,
            },
            driver_file_offset: file_offset,
            firmware_volume_offset: volume.start,
            file_offset,
            replaced_pad_file,
            erase_polarity: volume.erase_polarity,
            encapsulated_volume_image: false,
            recompressed_guided_section: false,
            grew_firmware_volume: growth_bytes > 0,
            firmware_volume_growth_bytes: growth_bytes,
        },
    ))
}

fn grow_nested_firmware_volume(
    firmware: &[u8],
    volume: FirmwareVolume,
    required_end: usize,
) -> Result<(Vec<u8>, FirmwareVolume, usize), InjectionError> {
    if required_end <= volume.end {
        return Err(InjectionError::InvalidFirmware(
            "nested firmware-volume growth was requested without a size increase",
        ));
    }
    if firmware[volume.start..volume.start + 16]
        .iter()
        .any(|byte| *byte != 0)
    {
        return Err(InjectionError::InvalidFirmware(
            "nested firmware-volume growth does not support nonzero zero-vector metadata",
        ));
    }
    let section_wrapper = parse_section_stream(firmware).ok().and_then(|sections| {
        sections.into_iter().find(|section| {
            section.section_type == SECTION_TYPE_FIRMWARE_VOLUME_IMAGE
                && section.content_start == volume.start
                && section.end == volume.end
        })
    });
    if section_wrapper.is_some_and(|section| section.next_offset != firmware.len())
        || section_wrapper.is_none()
            && firmware[volume.end..]
                .iter()
                .any(|byte| *byte != 0 && *byte != volume.erase_byte)
    {
        return Err(InjectionError::InvalidFirmware(
            "nested firmware-volume growth requires a terminal structural target",
        ));
    }
    let header_length = read_u16(firmware, volume.start + FV_HEADER_LENGTH_OFFSET)? as usize;
    let block_map_size = header_length.checked_sub(FV_MINIMUM_HEADER_SIZE).ok_or(
        InjectionError::InvalidFirmware("firmware-volume block map is truncated"),
    )?;
    if !block_map_size.is_multiple_of(8) || block_map_size / 8 != 2 {
        return Err(InjectionError::InvalidFirmware(
            "nested firmware-volume growth requires one block-map entry and its terminator",
        ));
    }
    let block_map = volume.start + FV_MINIMUM_HEADER_SIZE;
    let old_num_blocks = read_u32(firmware, block_map)? as usize;
    let block_length = read_u32(firmware, block_map + 4)? as usize;
    let terminator_num = read_u32(firmware, block_map + 8)?;
    let terminator_length = read_u32(firmware, block_map + 12)?;
    if old_num_blocks == 0
        || block_length == 0
        || terminator_num != 0
        || terminator_length != 0
        || old_num_blocks.checked_mul(block_length) != Some(volume.end - volume.start)
    {
        return Err(InjectionError::InvalidFirmware(
            "nested firmware-volume block map is inconsistent",
        ));
    }

    let minimum_length = required_end - volume.start;
    let remainder = minimum_length % block_length;
    let growth_rounding = block_length - remainder;
    let new_length =
        minimum_length
            .checked_add(growth_rounding)
            .ok_or(InjectionError::InvalidFirmware(
                "nested firmware-volume growth overflows its length",
            ))?;
    let new_num_blocks = u32::try_from(new_length / block_length).map_err(|_| {
        InjectionError::InvalidFirmware("nested firmware-volume block count exceeds 32 bits")
    })?;
    let growth_bytes = new_length - (volume.end - volume.start);
    let new_end = volume
        .end
        .checked_add(growth_bytes)
        .ok_or(InjectionError::InvalidFirmware(
            "nested firmware-volume end overflows",
        ))?;
    let mut output = Vec::with_capacity(firmware.len().checked_add(growth_bytes).ok_or(
        InjectionError::InvalidFirmware("grown firmware payload length overflows"),
    )?);
    output.extend_from_slice(&firmware[..volume.end]);
    output.resize(new_end, volume.erase_byte);
    output.extend_from_slice(&firmware[volume.end..]);
    if let Some(section) = section_wrapper {
        let new_section_size = (section.end - section.offset)
            .checked_add(growth_bytes)
            .ok_or(InjectionError::InvalidFirmware(
                "grown firmware-volume section size overflows",
            ))?;
        if section.header_size == 4 {
            if new_section_size >= MAX_STANDARD_SIZE {
                return Err(InjectionError::InvalidFirmware(
                    "grown firmware-volume section requires an extended header",
                ));
            }
            write_u24(
                &mut output[section.offset..section.offset + 3],
                new_section_size as u32,
            );
        } else {
            output[section.offset + 4..section.offset + 8].copy_from_slice(
                &u32::try_from(new_section_size)
                    .map_err(|_| {
                        InjectionError::InvalidFirmware(
                            "grown firmware-volume section size exceeds 32 bits",
                        )
                    })?
                    .to_le_bytes(),
            );
        }
    }
    output[volume.start + FV_LENGTH_OFFSET..volume.start + FV_LENGTH_OFFSET + 8]
        .copy_from_slice(&(new_length as u64).to_le_bytes());
    output[block_map..block_map + 4].copy_from_slice(&new_num_blocks.to_le_bytes());
    output[volume.start + FV_CHECKSUM_OFFSET..volume.start + FV_CHECKSUM_OFFSET + 2].fill(0);
    let checksum = output[volume.start..volume.start + header_length]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|word| u16::from_le_bytes(*word))
        .fold(0_u16, u16::wrapping_add);
    output[volume.start + FV_CHECKSUM_OFFSET..volume.start + FV_CHECKSUM_OFFSET + 2]
        .copy_from_slice(&0_u16.wrapping_sub(checksum).to_le_bytes());

    let grown = parse_firmware_volume(&output, volume.start)?.ok_or(
        InjectionError::InvalidFirmware("grown firmware volume failed structural validation"),
    )?;
    if grown.end != new_end {
        return Err(InjectionError::InvalidFirmware(
            "grown firmware-volume length did not round trip",
        ));
    }
    if section_wrapper.is_some() {
        parse_section_stream(&output)?;
    }
    Ok((output, grown, growth_bytes))
}

fn find_firmware_volumes(firmware: &[u8]) -> Result<Vec<FirmwareVolume>, InjectionError> {
    let mut volumes = Vec::new();
    for (signature_offset, bytes) in firmware.windows(FV_SIGNATURE.len()).enumerate() {
        if bytes != FV_SIGNATURE || signature_offset < FV_SIGNATURE_OFFSET {
            continue;
        }
        let start = signature_offset - FV_SIGNATURE_OFFSET;
        let Some(volume) = parse_firmware_volume(firmware, start)? else {
            continue;
        };
        if volumes.len() >= MAX_STRUCTURE_RECORDS {
            return Err(InjectionError::InvalidFirmware(
                "firmware-volume count exceeds the safety limit",
            ));
        }
        volumes.push(volume);
    }
    Ok(volumes)
}

fn parse_firmware_volume(
    firmware: &[u8],
    start: usize,
) -> Result<Option<FirmwareVolume>, InjectionError> {
    let header_prefix = match firmware.get(start..start.saturating_add(FV_MINIMUM_HEADER_SIZE)) {
        Some(header) => header,
        None => return Ok(None),
    };
    if header_prefix[FV_REVISION_OFFSET] != 2 {
        return Ok(None);
    }
    let length = read_u64(header_prefix, FV_LENGTH_OFFSET)?;
    let Ok(length) = usize::try_from(length) else {
        return Ok(None);
    };
    let Some(end) = start.checked_add(length) else {
        return Ok(None);
    };
    if length < FV_MINIMUM_HEADER_SIZE || end > firmware.len() {
        return Ok(None);
    }
    let header_length = read_u16(header_prefix, FV_HEADER_LENGTH_OFFSET)? as usize;
    if header_length < FV_MINIMUM_HEADER_SIZE
        || header_length > length
        || !header_length.is_multiple_of(2)
    {
        return Ok(None);
    }
    let header = &firmware[start..start + header_length];
    if !header_checksum_is_valid(header) {
        return Ok(None);
    }
    let attributes = read_u32(header_prefix, FV_ATTRIBUTES_OFFSET)?;
    let erase_polarity = attributes & FV_ERASE_POLARITY != 0;
    let erase_byte = if erase_polarity { 0xff } else { 0x00 };
    let ext_offset = read_u16(header_prefix, FV_EXT_HEADER_OFFSET)? as usize;
    let ext_header = if ext_offset == 0 {
        None
    } else {
        let ext_size_offset = start
            .checked_add(ext_offset)
            .and_then(|offset| offset.checked_add(16))
            .ok_or(InjectionError::InvalidFirmware("extension offset overflow"))?;
        let ext_size = read_u32(firmware, ext_size_offset)? as usize;
        if ext_size < FV_EXT_HEADER_MINIMUM_SIZE || ext_offset + ext_size > length {
            return Ok(None);
        }
        Some((start + ext_offset, ext_size))
    };
    let files_relative = ext_header
        .map(|(offset, size)| offset - start + size)
        .unwrap_or(header_length)
        .max(header_length);
    let files_start = start
        .checked_add(
            align_up(files_relative, 8).ok_or(InjectionError::InvalidFirmware(
                "file-area alignment overflow",
            ))?,
        )
        .ok_or(InjectionError::InvalidFirmware("file-area offset overflow"))?;
    if files_start > end {
        return Ok(None);
    }
    Ok(Some(FirmwareVolume {
        start,
        end,
        files_start,
        erase_byte,
        erase_polarity,
        ext_header,
    }))
}

fn scan_volume(firmware: &[u8], volume: FirmwareVolume) -> Result<VolumeScan, InjectionError> {
    let mut offset = volume.files_start;
    let mut contains_dxe_core = false;
    let mut driver_count = 0;
    let mut pad_free = None;
    while offset < volume.end {
        let remaining = volume.end - offset;
        if firmware[offset..volume.end]
            .iter()
            .all(|byte| *byte == volume.erase_byte)
        {
            let terminal_pad = pad_free
                .filter(|(_, end)| align_volume_offset(volume.start, *end) == Some(offset))
                .map(|(start, _)| (start, volume.end));
            return Ok(VolumeScan {
                contains_dxe_core,
                driver_count,
                raw_free: Some((offset, volume.end)),
                pad_free: terminal_pad,
            });
        }
        if remaining < FFS_HEADER_SIZE {
            return Err(InjectionError::InvalidFirmware(
                "non-erased trailing bytes follow the final FFS file",
            ));
        }
        let attributes = firmware[offset + 19];
        let standard_size = read_u24(firmware, offset + 20)? as usize;
        let (header_size, file_size) = if attributes & FFS_LARGE_FILE_ATTRIBUTE != 0 {
            (
                32,
                usize::try_from(read_u64(firmware, offset + 24)?).map_err(|_| {
                    InjectionError::InvalidFirmware("large FFS file size is not representable")
                })?,
            )
        } else {
            (FFS_HEADER_SIZE, standard_size)
        };
        if file_size < header_size || file_size > remaining {
            return Err(InjectionError::InvalidFirmware(
                "FFS file extends beyond its firmware volume",
            ));
        }
        let logical_state = if volume.erase_polarity {
            !firmware[offset + 23]
        } else {
            firmware[offset + 23]
        };
        let is_live = logical_state & FFS_FILE_DATA_VALID != 0
            && logical_state & (FFS_FILE_DELETED | FFS_FILE_HEADER_INVALID) == 0;
        let file_type = firmware[offset + 18];
        if is_live && firmware[offset..offset + 16] == FFS_FILE_GUID_BYTES {
            driver_count = driver_count
                .checked_add(1)
                .ok_or(InjectionError::InvalidFirmware(
                    "driver-file census count overflow",
                ))?;
        }
        contains_dxe_core |= is_live && file_type == FFS_FILE_TYPE_DXE_CORE;
        if is_live && file_type == FFS_FILE_TYPE_PAD {
            let end = offset + file_size;
            pad_free = Some((offset, end));
        }
        offset = align_volume_offset(volume.start, offset + file_size)
            .ok_or(InjectionError::InvalidFirmware("FFS alignment overflow"))?;
        if offset > volume.end {
            return Err(InjectionError::InvalidFirmware(
                "FFS alignment extends beyond its firmware volume",
            ));
        }
    }
    Ok(VolumeScan {
        contains_dxe_core,
        driver_count,
        raw_free: None,
        pad_free: pad_free
            .filter(|(_, end)| align_volume_offset(volume.start, *end) == Some(volume.end))
            .map(|(start, _)| (start, volume.end)),
    })
}

#[derive(Clone, Copy, Debug)]
struct FirmwareFileRecord {
    offset: usize,
    size: usize,
    header_size: usize,
    file_type: u8,
    is_live: bool,
}

#[derive(Clone, Copy, Debug)]
struct GuidedSection {
    offset: usize,
    size: usize,
    data_offset: usize,
}

fn try_inject_lzma_guided(
    firmware: &[u8],
    driver_ffs: &[u8],
    volumes: &[FirmwareVolume],
    container_file_offsets: &[usize],
    guided_depth: usize,
    budget: &mut TraversalBudget,
) -> Result<Option<(Vec<u8>, FirmwareInjection)>, InjectionError> {
    for volume in volumes.iter().copied() {
        for record in firmware_files(firmware, volume)? {
            if !record.is_live
                || record.header_size != FFS_HEADER_SIZE
                || record.file_type != FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE
            {
                continue;
            }
            let mut normalized = firmware[record.offset..record.offset + record.size].to_vec();
            if volume.erase_polarity {
                normalized[23] = !normalized[23];
            }
            let Some(section) = find_lzma_guided_section(&normalized)? else {
                continue;
            };
            let compressed_start = section.offset + section.data_offset;
            let compressed_end = section.offset + section.size;
            let lzma = &normalized[compressed_start..compressed_end];
            require_decode_depth(guided_depth)?;
            let declared_size = validate_lzma_header(lzma)?;
            budget.charge_decoded(declared_size)?;
            let decompressed = lzma_decompress(lzma)
                .map_err(|error| InjectionError::Compression(error.to_string()))?;
            if decompressed.len() as u64 != declared_size {
                return Err(InjectionError::InvalidFirmware(
                    "guided LZMA output size does not match its header",
                ));
            }
            let mut nested_offsets = container_file_offsets.to_vec();
            nested_offsets.push(record.offset);
            let (patched_inner, inner_injection) = match inject_ffs_at_depth(
                &decompressed,
                driver_ffs,
                &nested_offsets,
                guided_depth + 1,
                budget,
            ) {
                Ok(injected) => injected,
                Err(InjectionError::NoTopLevelDxeVolume) => continue,
                Err(error) => return Err(error),
            };
            let recompressed = compress_uefi_lzma(&patched_inner, lzma)?;
            let round_trip = lzma_decompress(&recompressed)
                .map_err(|error| InjectionError::Compression(error.to_string()))?;
            if round_trip != patched_inner {
                return Err(InjectionError::InvalidFirmware(
                    "recompressed guided section failed its round trip",
                ));
            }
            let rebuilt = rebuild_guided_file(&normalized, section, &recompressed)?;
            let rebuilt = preserve_nonterminal_file_extent(firmware, volume, record, &rebuilt)?;
            let available_bytes = firmware_file_capacity(firmware, volume, record)?;
            let required_bytes = align_up(rebuilt.len(), 8).ok_or(
                InjectionError::InvalidFirmware("replacement FFS alignment overflow"),
            )?;
            let Some(mut output) = replace_firmware_file(firmware, volume, record, &rebuilt)?
            else {
                return Err(InjectionError::RecompressedContainerTooLarge {
                    container_file_offsets: nested_offsets,
                    firmware_volume_offset: volume.start,
                    file_offset: record.offset,
                    available_bytes,
                    required_bytes,
                });
            };
            update_used_size(
                &mut output,
                volume,
                record.offset
                    + align_up(rebuilt.len(), 8).ok_or(InjectionError::InvalidFirmware(
                        "guided file alignment overflow",
                    ))?,
            )?;
            return Ok(Some((
                output,
                FirmwareInjection {
                    target: inner_injection.target.clone(),
                    driver_file_offset: inner_injection.driver_file_offset,
                    firmware_volume_offset: volume.start,
                    file_offset: record.offset,
                    replaced_pad_file: false,
                    erase_polarity: volume.erase_polarity,
                    encapsulated_volume_image: true,
                    recompressed_guided_section: true,
                    grew_firmware_volume: inner_injection.grew_firmware_volume,
                    firmware_volume_growth_bytes: inner_injection.firmware_volume_growth_bytes,
                },
            )));
        }
    }
    Ok(None)
}

fn compress_uefi_lzma(input: &[u8], template: &[u8]) -> Result<Vec<u8>, InjectionError> {
    // PI GUID-defined LZMA sections carry the classic 13-byte LZMA-alone header,
    // but firmware streams conventionally omit the optional end marker because
    // the exact decoded length is present in that header. Match the 7-Zip SDK
    // encoder used by firmware tooling. Preserve the original decoder properties so mutation
    // never increases a platform's boot-time dictionary requirement.
    if input.len() as u64 > MAX_LZMA_UNCOMPRESSED_SIZE {
        return Err(InjectionError::InvalidFirmware(
            "guided LZMA input exceeds the safety limit",
        ));
    }
    validate_lzma_header(template)?;
    let property = template[0];
    if property >= 9 * 5 * 5 {
        return Err(InjectionError::InvalidFirmware(
            "guided LZMA property byte is invalid",
        ));
    }
    let lc = property % 9;
    let remainder = property / 9;
    let lp = remainder % 5;
    let pb = remainder / 5;
    let dictionary_size = u32::from_le_bytes(
        template[1..5]
            .try_into()
            .expect("validated LZMA header contains five property bytes"),
    );
    let mut properties = LzmaProps::for_level(9, dictionary_size);
    properties.lc = lc;
    properties.lp = lp;
    properties.pb = pb;
    properties.dict_size = dictionary_size;
    properties.fb = GUIDED_LZMA_FAST_BYTES;
    properties.mc = GUIDED_LZMA_MATCH_CYCLES;
    if decoder_props(&properties) != template[..5] {
        return Err(InjectionError::InvalidFirmware(
            "guided LZMA decoder properties cannot be reproduced exactly",
        ));
    }
    let compressed = lzma_sdk_encode(input, &properties);
    let capacity = compressed
        .len()
        .checked_add(13)
        .ok_or(InjectionError::InvalidFirmware(
            "guided LZMA output length overflows",
        ))?;
    let mut output = Vec::with_capacity(capacity);
    output.extend_from_slice(&decoder_props(&properties));
    output.extend_from_slice(&(input.len() as u64).to_le_bytes());
    output.extend_from_slice(&compressed);
    let declared_size = validate_lzma_header(&output)?;
    if declared_size != input.len() as u64 {
        return Err(InjectionError::InvalidFirmware(
            "recompressed guided LZMA header size does not match its input",
        ));
    }
    Ok(output)
}

fn validate_lzma_header(lzma: &[u8]) -> Result<u64, InjectionError> {
    if lzma.len() < 13 {
        return Err(InjectionError::InvalidFirmware(
            "guided LZMA stream has a truncated header",
        ));
    }
    let dictionary_size = u32::from_le_bytes([lzma[1], lzma[2], lzma[3], lzma[4]]);
    if lzma[0] >= 9 * 5 * 5 {
        return Err(InjectionError::InvalidFirmware(
            "guided LZMA property byte is invalid",
        ));
    }
    let uncompressed_size = u64::from_le_bytes(
        lzma[5..13]
            .try_into()
            .expect("thirteen-byte header was checked"),
    );
    if !(4 * 1024..=MAX_LZMA_DICTIONARY_SIZE).contains(&dictionary_size) {
        return Err(InjectionError::InvalidFirmware(
            "guided LZMA dictionary is outside the supported safety range",
        ));
    }
    if uncompressed_size > MAX_LZMA_UNCOMPRESSED_SIZE {
        return Err(InjectionError::InvalidFirmware(
            "guided LZMA output exceeds the safety limit",
        ));
    }
    Ok(uncompressed_size)
}

fn firmware_files(
    firmware: &[u8],
    volume: FirmwareVolume,
) -> Result<Vec<FirmwareFileRecord>, InjectionError> {
    let mut files = Vec::new();
    let mut offset = volume.files_start;
    while offset < volume.end {
        let remaining = volume.end - offset;
        if firmware[offset..volume.end]
            .iter()
            .all(|byte| *byte == volume.erase_byte)
        {
            break;
        }
        if remaining < FFS_HEADER_SIZE {
            return Err(InjectionError::InvalidFirmware(
                "non-erased trailing bytes follow the final FFS file",
            ));
        }
        let attributes = firmware[offset + 19];
        let standard_size = read_u24(firmware, offset + 20)? as usize;
        let (header_size, file_size) = if attributes & FFS_LARGE_FILE_ATTRIBUTE != 0 {
            (
                32,
                usize::try_from(read_u64(firmware, offset + 24)?).map_err(|_| {
                    InjectionError::InvalidFirmware("large FFS file size is not representable")
                })?,
            )
        } else {
            (FFS_HEADER_SIZE, standard_size)
        };
        if file_size < header_size || file_size > remaining {
            return Err(InjectionError::InvalidFirmware(
                "FFS file extends beyond its firmware volume",
            ));
        }
        let logical_state = if volume.erase_polarity {
            !firmware[offset + 23]
        } else {
            firmware[offset + 23]
        };
        let is_live = logical_state & FFS_FILE_DATA_VALID != 0
            && logical_state & (FFS_FILE_DELETED | FFS_FILE_HEADER_INVALID) == 0;
        if files.len() >= MAX_STRUCTURE_RECORDS {
            return Err(InjectionError::InvalidFirmware(
                "FFS file count exceeds the safety limit",
            ));
        }
        files.push(FirmwareFileRecord {
            offset,
            size: file_size,
            header_size,
            file_type: firmware[offset + 18],
            is_live,
        });
        offset = align_volume_offset(volume.start, offset + file_size)
            .ok_or(InjectionError::InvalidFirmware("FFS alignment overflow"))?;
        if offset > volume.end {
            return Err(InjectionError::InvalidFirmware(
                "FFS alignment extends beyond its firmware volume",
            ));
        }
    }
    Ok(files)
}

fn find_lzma_guided_section(file: &[u8]) -> Result<Option<GuidedSection>, InjectionError> {
    let mut offset = FFS_HEADER_SIZE;
    while offset < file.len() {
        let size = read_u24(file, offset)? as usize;
        if size < 4 || offset + size > file.len() {
            return Err(InjectionError::InvalidFirmware(
                "guided FFS section extends beyond its file",
            ));
        }
        if file[offset + 3] == SECTION_TYPE_GUID_DEFINED
            && size >= 24
            && file[offset + 4..offset + 20] == LZMA_GUID_BYTES
        {
            let data_offset = read_u16(file, offset + 20)? as usize;
            let attributes = read_u16(file, offset + 22)?;
            if data_offset != 24 || data_offset > size {
                return Err(InjectionError::InvalidFirmware(
                    "guided LZMA mutation requires the standard 24-byte data offset",
                ));
            }
            if attributes != GUIDED_SECTION_PROCESSING_REQUIRED {
                return Err(InjectionError::InvalidFirmware(
                    "guided LZMA mutation does not support authentication or vendor metadata",
                ));
            }
            verify_generic_file(file)?;
            return Ok(Some(GuidedSection {
                offset,
                size,
                data_offset,
            }));
        }
        let end = offset + size;
        offset = if end == file.len() {
            end
        } else {
            align_up(end, 4).ok_or(InjectionError::InvalidFirmware(
                "guided section alignment overflow",
            ))?
        };
    }
    Ok(None)
}

fn rebuild_guided_file(
    original: &[u8],
    section: GuidedSection,
    compressed: &[u8],
) -> Result<Vec<u8>, InjectionError> {
    let new_section_size = section.data_offset.checked_add(compressed.len()).ok_or(
        InjectionError::InvalidFirmware("guided section size overflow"),
    )?;
    if new_section_size >= MAX_STANDARD_SIZE {
        return Err(InjectionError::InvalidFirmware(
            "guided section requires an extended header",
        ));
    }
    let old_section_end = section.offset + section.size;
    let old_next = if old_section_end == original.len() {
        old_section_end
    } else {
        align_up(old_section_end, 4).ok_or(InjectionError::InvalidFirmware(
            "guided section alignment overflow",
        ))?
    };
    let data_start = section.offset + section.data_offset;
    let mut body = original[FFS_HEADER_SIZE..section.offset].to_vec();
    let mut header = [0_u8; 4];
    write_u24(&mut header[..3], new_section_size as u32);
    header[3] = SECTION_TYPE_GUID_DEFINED;
    body.extend_from_slice(&header);
    body.extend_from_slice(&original[section.offset + 4..data_start]);
    body.extend_from_slice(compressed);
    if old_next < original.len() {
        body.resize(
            align_up(body.len(), 4).ok_or(InjectionError::InvalidFirmware(
                "rebuilt section alignment overflow",
            ))?,
            0,
        );
        body.extend_from_slice(&original[old_next..]);
    }
    build_generic_file(&original[..FFS_HEADER_SIZE], &body)
}

fn build_generic_file(header: &[u8], body: &[u8]) -> Result<Vec<u8>, InjectionError> {
    let file_size =
        FFS_HEADER_SIZE
            .checked_add(body.len())
            .ok_or(InjectionError::InvalidFirmware(
                "rebuilt FFS file size overflow",
            ))?;
    if file_size >= MAX_STANDARD_SIZE {
        return Err(InjectionError::InvalidFirmware(
            "rebuilt FFS file requires a large-file header",
        ));
    }
    let mut rebuilt = header.to_vec();
    rebuilt[16] = 0;
    rebuilt[17] = 0;
    rebuilt[23] = 0;
    write_u24(&mut rebuilt[20..23], file_size as u32);
    rebuilt[16] = checksum8(&rebuilt);
    rebuilt[17] = if rebuilt[19] & FFS_ATTRIBUTE_CHECKSUM != 0 {
        checksum8(body)
    } else {
        FFS_FIXED_CHECKSUM
    };
    rebuilt[23] = FFS_FILE_STATE_VALID;
    rebuilt.extend_from_slice(body);
    verify_generic_file(&rebuilt)?;
    Ok(rebuilt)
}

fn verify_generic_file(file: &[u8]) -> Result<(), InjectionError> {
    if file.len() < FFS_HEADER_SIZE
        || read_u24(file, 20)? as usize != file.len()
        || file[23] != FFS_FILE_STATE_VALID
    {
        return Err(InjectionError::InvalidFirmware(
            "FFS file header is malformed",
        ));
    }
    let state = file[23];
    let file_checksum = file[17];
    let header_sum = file[..FFS_HEADER_SIZE]
        .iter()
        .fold(0_u8, |sum, byte| sum.wrapping_add(*byte))
        .wrapping_sub(state)
        .wrapping_sub(file_checksum);
    if header_sum != 0 {
        return Err(InjectionError::InvalidFirmware(
            "FFS header checksum is invalid",
        ));
    }
    if file[19] & FFS_ATTRIBUTE_CHECKSUM != 0 {
        let body_sum = file[FFS_HEADER_SIZE..]
            .iter()
            .fold(0_u8, |sum, byte| sum.wrapping_add(*byte));
        if body_sum.wrapping_add(file_checksum) != 0 {
            return Err(InjectionError::InvalidFirmware(
                "FFS data checksum is invalid",
            ));
        }
    } else if file_checksum != FFS_FIXED_CHECKSUM {
        return Err(InjectionError::InvalidFirmware(
            "FFS fixed checksum marker is invalid",
        ));
    }
    Ok(())
}

fn replace_firmware_file(
    firmware: &[u8],
    volume: FirmwareVolume,
    original: FirmwareFileRecord,
    replacement: &[u8],
) -> Result<Option<Vec<u8>>, InjectionError> {
    let capacity = firmware_file_capacity(firmware, volume, original)?;
    let needed = align_up(replacement.len(), 8).ok_or(InjectionError::InvalidFirmware(
        "replacement FFS alignment overflow",
    ))?;
    if needed > capacity {
        return Ok(None);
    }
    let capacity_end = original.offset + capacity;
    let mut output = firmware.to_vec();
    output[original.offset..capacity_end].fill(volume.erase_byte);
    output[original.offset..original.offset + replacement.len()].copy_from_slice(replacement);
    output[original.offset + 23] = if volume.erase_polarity {
        !FFS_FILE_STATE_VALID
    } else {
        FFS_FILE_STATE_VALID
    };
    Ok(Some(output))
}

fn preserve_nonterminal_file_extent(
    firmware: &[u8],
    volume: FirmwareVolume,
    original: FirmwareFileRecord,
    replacement: &[u8],
) -> Result<Vec<u8>, InjectionError> {
    let old_end = align_volume_offset(volume.start, original.offset + original.size).ok_or(
        InjectionError::InvalidFirmware("original FFS alignment overflow"),
    )?;
    let replacement_end =
        original
            .offset
            .checked_add(replacement.len())
            .ok_or(InjectionError::InvalidFirmware(
                "replacement FFS end overflows",
            ))?;
    let replacement_aligned = align_volume_offset(volume.start, replacement_end).ok_or(
        InjectionError::InvalidFirmware("replacement FFS alignment overflow"),
    )?;
    if replacement_aligned >= old_end
        || firmware[old_end..volume.end]
            .iter()
            .all(|byte| *byte == volume.erase_byte)
    {
        return Ok(replacement.to_vec());
    }

    let target_size = old_end - original.offset;
    if target_size >= MAX_STANDARD_SIZE {
        return Err(InjectionError::InvalidFirmware(
            "nonterminal FFS extent preservation requires a large-file header",
        ));
    }
    let body = replacement
        .get(FFS_HEADER_SIZE..)
        .ok_or(InjectionError::InvalidFirmware(
            "replacement FFS header is truncated",
        ))?;
    let aligned_body_size = align_up(body.len(), 4).ok_or(InjectionError::InvalidFirmware(
        "replacement FFS section alignment overflow",
    ))?;
    let raw_section_size = target_size
        .checked_sub(FFS_HEADER_SIZE)
        .and_then(|size| size.checked_sub(aligned_body_size))
        .ok_or(InjectionError::InvalidFirmware(
            "replacement FFS exceeds its nonterminal extent",
        ))?;
    if !(4..MAX_STANDARD_SIZE).contains(&raw_section_size) {
        return Err(InjectionError::InvalidFirmware(
            "nonterminal FFS padding cannot be represented as a RAW section",
        ));
    }

    let mut padded_body = body.to_vec();
    padded_body.resize(aligned_body_size, 0);
    let mut raw_header = [0_u8; 4];
    write_u24(&mut raw_header[..3], raw_section_size as u32);
    raw_header[3] = 0x19;
    padded_body.extend_from_slice(&raw_header);
    padded_body.resize(target_size - FFS_HEADER_SIZE, volume.erase_byte);
    let padded = build_generic_file(&replacement[..FFS_HEADER_SIZE], &padded_body)?;
    if padded.len() != target_size {
        return Err(InjectionError::InvalidFirmware(
            "nonterminal FFS padding did not preserve its extent",
        ));
    }
    Ok(padded)
}

fn firmware_file_capacity(
    firmware: &[u8],
    volume: FirmwareVolume,
    original: FirmwareFileRecord,
) -> Result<usize, InjectionError> {
    let old_end = align_volume_offset(volume.start, original.offset + original.size).ok_or(
        InjectionError::InvalidFirmware("original FFS alignment overflow"),
    )?;
    let capacity_end = if firmware[old_end..volume.end]
        .iter()
        .all(|byte| *byte == volume.erase_byte)
    {
        volume.end
    } else {
        old_end
    };
    Ok(capacity_end - original.offset)
}

fn update_used_size(
    firmware: &mut [u8],
    volume: FirmwareVolume,
    used_end: usize,
) -> Result<(), InjectionError> {
    let Some((ext_start, ext_size)) = volume.ext_header else {
        return Ok(());
    };
    let mut entry = ext_start + FV_EXT_HEADER_MINIMUM_SIZE;
    let ext_end = ext_start + ext_size;
    while entry + 4 <= ext_end {
        let size = read_u16(firmware, entry)? as usize;
        let entry_type = read_u16(firmware, entry + 2)?;
        if size < 4 || entry + size > ext_end {
            return Err(InjectionError::InvalidFirmware(
                "firmware-volume extension entry is malformed",
            ));
        }
        if entry_type == FV_EXT_ENTRY_USED_SIZE && size >= FV_USED_SIZE_ENTRY_MINIMUM {
            let relative_end = used_end - volume.start;
            let current = read_u32(firmware, entry + 4)? as usize;
            if relative_end > current {
                let relative_end = u32::try_from(relative_end).map_err(|_| {
                    InjectionError::InvalidFirmware("used-size value exceeds 32 bits")
                })?;
                firmware[entry + 4..entry + 8].copy_from_slice(&relative_end.to_le_bytes());
            }
            break;
        }
        entry += size;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FirmwareSectionRecord {
    offset: usize,
    end: usize,
    content_start: usize,
    next_offset: usize,
    header_size: usize,
    section_type: u8,
}

fn parse_section_stream(stream: &[u8]) -> Result<Vec<FirmwareSectionRecord>, InjectionError> {
    let mut sections = Vec::new();
    let mut offset = 0;
    while offset < stream.len() {
        let remaining = stream.len() - offset;
        if remaining < 4 {
            return Err(InjectionError::InvalidFirmware(
                "truncated bytes follow the final FFS section",
            ));
        }
        let standard_size = read_u24(stream, offset)? as usize;
        let section_type = stream[offset + 3];
        let (header_size, size) = if standard_size == MAX_STANDARD_SIZE {
            if remaining < 8 {
                return Err(InjectionError::InvalidFirmware(
                    "extended FFS section header is truncated",
                ));
            }
            (8, read_u32(stream, offset + 4)? as usize)
        } else {
            (4, standard_size)
        };
        if size < header_size || size > remaining {
            return Err(InjectionError::InvalidFirmware(
                "FFS section extends beyond its file",
            ));
        }
        let end = offset + size;
        let next_offset = if end == stream.len() {
            end
        } else {
            let aligned = align_up(end, 4).ok_or(InjectionError::InvalidFirmware(
                "FFS section alignment overflow",
            ))?;
            if aligned > stream.len() {
                return Err(InjectionError::InvalidFirmware(
                    "FFS section padding extends beyond its file",
                ));
            }
            aligned
        };
        if sections.len() >= MAX_STRUCTURE_RECORDS {
            return Err(InjectionError::InvalidFirmware(
                "FFS section count exceeds the safety limit",
            ));
        }
        sections.push(FirmwareSectionRecord {
            offset,
            end,
            content_start: offset + header_size,
            next_offset,
            header_size,
            section_type,
        });
        offset = next_offset;
    }
    Ok(sections)
}

fn build_firmware_section(
    original: FirmwareSectionRecord,
    content: &[u8],
) -> Result<Vec<u8>, InjectionError> {
    let standard_size =
        4_usize
            .checked_add(content.len())
            .ok_or(InjectionError::InvalidFirmware(
                "rebuilt FFS section size overflow",
            ))?;
    let extended = original.header_size == 8 || standard_size >= MAX_STANDARD_SIZE;
    let header_size: usize = if extended { 8 } else { 4 };
    let size = header_size
        .checked_add(content.len())
        .ok_or(InjectionError::InvalidFirmware(
            "rebuilt FFS section size overflow",
        ))?;
    let mut section = vec![0_u8; header_size];
    section[3] = original.section_type;
    if extended {
        section[..3].fill(0xff);
        section[4..8].copy_from_slice(
            &u32::try_from(size)
                .map_err(|_| {
                    InjectionError::InvalidFirmware("rebuilt FFS section size exceeds 32 bits")
                })?
                .to_le_bytes(),
        );
    } else {
        write_u24(&mut section[..3], size as u32);
    }
    section.extend_from_slice(content);
    Ok(section)
}

fn header_checksum_is_valid(header: &[u8]) -> bool {
    header
        .as_chunks::<2>()
        .0
        .iter()
        .map(|word| u16::from_le_bytes(*word))
        .fold(0_u16, u16::wrapping_add)
        == 0
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, InjectionError> {
    let raw = bytes
        .get(offset..offset.saturating_add(2))
        .ok_or(InjectionError::InvalidFirmware("truncated 16-bit field"))?;
    Ok(u16::from_le_bytes([raw[0], raw[1]]))
}

fn read_u24(bytes: &[u8], offset: usize) -> Result<u32, InjectionError> {
    let raw = bytes
        .get(offset..offset.saturating_add(3))
        .ok_or(InjectionError::InvalidFirmware("truncated 24-bit field"))?;
    Ok(u32::from_le_bytes([raw[0], raw[1], raw[2], 0]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, InjectionError> {
    let raw = bytes
        .get(offset..offset.saturating_add(4))
        .ok_or(InjectionError::InvalidFirmware("truncated 32-bit field"))?;
    Ok(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, InjectionError> {
    let raw = bytes
        .get(offset..offset.saturating_add(8))
        .ok_or(InjectionError::InvalidFirmware("truncated 64-bit field"))?;
    Ok(u64::from_le_bytes(
        raw.try_into().expect("eight-byte slice"),
    ))
}

fn align_up(value: usize, alignment: usize) -> Option<usize> {
    value
        .checked_add(alignment - 1)
        .map(|value| value & !(alignment - 1))
}

fn align_volume_offset(volume_start: usize, absolute: usize) -> Option<usize> {
    absolute
        .checked_sub(volume_start)
        .and_then(|relative| align_up(relative, 8))
        .and_then(|relative| volume_start.checked_add(relative))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::synthetic_driver_image;
    use crate::{LegacyPatchCatalog, build_ffs};

    fn compress_test_lzma(input: &[u8]) -> Vec<u8> {
        let mut template = [0_u8; 13];
        template[0] = 0x5d;
        template[1..5].copy_from_slice(&(16 * 1024 * 1024_u32).to_le_bytes());
        compress_uefi_lzma(input, &template).unwrap()
    }

    #[test]
    fn injects_into_erased_space_after_a_dxe_core() {
        let firmware = synthetic_firmware(true, false);
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let (patched, report) = inject_ffs(&firmware, &ffs).unwrap();
        assert_eq!(report.targets.len(), 1);
        let report = &report.targets[0];

        assert_eq!(report.firmware_volume_offset, 0);
        assert_eq!(report.file_offset, 96);
        assert!(!report.replaced_pad_file);
        assert!(report.erase_polarity);
        assert!(!report.encapsulated_volume_image);
        assert!(!report.recompressed_guided_section);
        assert_eq!(patched[report.file_offset + 23], !FFS_FILE_STATE_VALID);
        assert!(matches!(
            inject_ffs(&patched, &ffs),
            Err(InjectionError::DriverAlreadyPresent)
        ));
    }

    #[test]
    fn replaces_a_pad_file_but_requires_a_dxe_core() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let (patched, report) = inject_ffs(&synthetic_firmware(true, true), &ffs).unwrap();
        let report = &report.targets[0];
        assert!(report.replaced_pad_file);
        assert_eq!(
            &patched[report.file_offset..report.file_offset + 16],
            &FFS_FILE_GUID_BYTES
        );

        assert!(matches!(
            inject_ffs(&synthetic_firmware(false, false), &ffs),
            Err(InjectionError::NoTopLevelDxeVolume)
        ));
    }

    #[test]
    fn refuses_a_nonterminal_pad_that_would_hide_later_files() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let mut firmware = synthetic_firmware(true, false);
        let pad = 96;
        let pad_size = 0x1000;
        firmware[pad..pad + 16].fill(0x22);
        firmware[pad + 16..pad + 18].fill(0);
        firmware[pad + 18] = FFS_FILE_TYPE_PAD;
        firmware[pad + 19] = 0;
        firmware[pad + 20..pad + 23].copy_from_slice(&(pad_size as u32).to_le_bytes()[..3]);
        firmware[pad + 23] = !FFS_FILE_STATE_VALID;
        let trailing = pad + pad_size;
        let trailing_size = firmware.len() - trailing;
        firmware[trailing..trailing + 16].fill(0x44);
        firmware[trailing + 16..trailing + 18].fill(0);
        firmware[trailing + 18] = 0x06;
        firmware[trailing + 19] = 0;
        firmware[trailing + 20..trailing + 23]
            .copy_from_slice(&(trailing_size as u32).to_le_bytes()[..3]);
        firmware[trailing + 23] = !FFS_FILE_STATE_VALID;

        assert!(matches!(
            inject_ffs(&firmware, &ffs),
            Err(InjectionError::NoSpace { .. })
        ));
    }

    #[test]
    fn combines_a_terminal_pad_with_its_adjacent_erased_tail() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let mut firmware = synthetic_firmware(true, false);
        let filler_offset = 96;
        let combined_free = align_up(ffs.len(), 8).unwrap();
        let pad_size = combined_free / 2 + 4;
        let filler_size = firmware.len() - filler_offset - combined_free;
        write_live_test_file(&mut firmware, filler_offset, filler_size, 0x06);
        let pad_offset = filler_offset + filler_size;
        write_live_test_file(&mut firmware, pad_offset, pad_size, FFS_FILE_TYPE_PAD);

        let (_, report) = inject_ffs(&firmware, &ffs).unwrap();
        let report = &report.targets[0];
        assert_eq!(report.file_offset, pad_offset);
        assert!(report.replaced_pad_file);
    }

    #[test]
    fn uses_the_actual_terminal_pad_after_a_larger_nonterminal_pad() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let mut firmware = synthetic_firmware(true, false);
        let first_pad_offset = 96;
        let first_pad_size = 1_024;
        write_live_test_file(
            &mut firmware,
            first_pad_offset,
            first_pad_size,
            FFS_FILE_TYPE_PAD,
        );
        let filler_offset = first_pad_offset + first_pad_size;
        let terminal_pad_size = align_up(ffs.len(), 8).unwrap();
        let filler_size = firmware.len() - filler_offset - terminal_pad_size;
        write_live_test_file(&mut firmware, filler_offset, filler_size, 0x06);
        let terminal_pad_offset = filler_offset + filler_size;
        write_live_test_file(
            &mut firmware,
            terminal_pad_offset,
            terminal_pad_size,
            FFS_FILE_TYPE_PAD,
        );

        let (_, report) = inject_ffs(&firmware, &ffs).unwrap();
        let report = &report.targets[0];
        assert_eq!(report.file_offset, terminal_pad_offset);
        assert!(report.replaced_pad_file);
    }

    #[test]
    fn refuses_an_unverified_sibling_of_an_encapsulated_dxe_volume() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let firmware = synthetic_opaque_fv_image_firmware();

        assert!(matches!(
            inject_ffs(&firmware, &ffs),
            Err(InjectionError::IncompleteDxeTargetCensus { .. })
        ));
    }

    #[test]
    fn refuses_a_known_target_with_an_uninspected_volume_image_sibling() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let first = synthetic_firmware(true, false);
        let opaque_sibling = synthetic_opaque_fv_image_firmware();

        let error = inject_ffs(&[first, opaque_sibling].concat(), &ffs).unwrap_err();
        let InjectionError::IncompleteDxeTargetCensus {
            uninspected_containers,
        } = error
        else {
            panic!("an incomplete target census was not refused: {error}");
        };
        assert_eq!(uninspected_containers.len(), 1);
        assert_eq!(
            uninspected_containers[0].file_offset,
            synthetic_firmware(true, false).len() + 72
        );
    }

    #[test]
    fn incomplete_census_precedes_driver_present_for_a_partial_artifact() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let mut first = synthetic_firmware(true, false);
        first[96..96 + ffs.len()].copy_from_slice(&ffs);
        first[96 + 23] = !FFS_FILE_STATE_VALID;
        let opaque_sibling = synthetic_opaque_fv_image_firmware();

        assert!(matches!(
            inject_ffs(&[first, opaque_sibling].concat(), &ffs),
            Err(InjectionError::IncompleteDxeTargetCensus { .. })
        ));
    }

    #[test]
    fn refuses_a_known_target_with_a_large_header_volume_image_sibling() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let first = synthetic_firmware(true, false);
        let first_len = first.len();
        let mut large_sibling = synthetic_firmware(false, false);
        large_sibling[72 + 18] = FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE;
        large_sibling[72 + 19] = FFS_LARGE_FILE_ATTRIBUTE;
        large_sibling[72 + 24..72 + 32].copy_from_slice(&32_u64.to_le_bytes());

        let error = inject_ffs(&[first, large_sibling].concat(), &ffs).unwrap_err();
        let InjectionError::IncompleteDxeTargetCensus {
            uninspected_containers,
        } = error
        else {
            panic!("a large-header container bypassed the census: {error}");
        };
        assert_eq!(uninspected_containers.len(), 1);
        assert_eq!(uninspected_containers[0].file_offset, first_len + 72);
    }

    #[test]
    fn census_proves_a_raw_volume_image_sibling_has_no_dxe_core() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let first = synthetic_firmware(true, false);
        let raw_sibling =
            synthetic_raw_fv_image_firmware(&synthetic_firmware_of_length(0x2000, false, false));

        let (_, injection) = inject_ffs(&[first, raw_sibling].concat(), &ffs).unwrap();
        let injection = &injection.targets[0];
        assert_eq!(injection.firmware_volume_offset, 0);
        assert_eq!(injection.file_offset, 96);
    }

    #[test]
    fn census_counts_a_dxe_core_inside_a_raw_volume_image_sibling() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let first = synthetic_firmware(true, false);
        let raw_sibling =
            synthetic_raw_fv_image_firmware(&synthetic_firmware_of_length(0x2000, true, false));

        assert!(matches!(
            inject_ffs(&[first, raw_sibling].concat(), &ffs),
            Err(InjectionError::UnsupportedDxeTarget { .. })
        ));
    }

    #[test]
    fn reports_a_unique_raw_volume_target_as_read_only_for_the_mutator() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let firmware =
            synthetic_raw_fv_image_firmware(&synthetic_firmware_of_length(0x2000, true, false));

        assert!(matches!(
            inject_ffs(&firmware, &ffs),
            Err(InjectionError::UnsupportedDxeTarget { .. })
        ));
    }

    #[test]
    fn census_decodes_amd_zlib_volume_image_siblings() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let first = synthetic_firmware(true, false);
        let without_dxe = synthetic_amd_zlib_fv_image_firmware(&synthetic_firmware(false, false));
        let (_, injection) = inject_ffs(&[first.clone(), without_dxe].concat(), &ffs).unwrap();
        let injection = &injection.targets[0];
        assert_eq!(injection.firmware_volume_offset, 0);

        let with_dxe = synthetic_amd_zlib_fv_image_firmware(&synthetic_firmware(true, false));
        assert!(matches!(
            inject_ffs(&[first, with_dxe].concat(), &ffs),
            Err(InjectionError::UnsupportedDxeTarget { .. })
        ));
    }

    #[test]
    fn census_decodes_direct_efi_and_tiano_volume_image_siblings() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        for compression in [EfiCompression::EfiStandard, EfiCompression::Tiano] {
            let first = synthetic_firmware(true, false);
            let without_dxe_file = synthetic_efi_compressed_file(
                [0x41; 16],
                FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE,
                &synthetic_firmware_of_length(0x2000, false, false),
                compression,
            );
            let without_dxe = synthetic_firmware_with_file(&without_dxe_file);
            assert!(inject_ffs(&[first.clone(), without_dxe].concat(), &ffs).is_ok());

            let with_dxe_file = synthetic_efi_compressed_file(
                [0x42; 16],
                FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE,
                &synthetic_firmware_of_length(0x2000, true, false),
                compression,
            );
            let with_dxe = synthetic_firmware_with_file(&with_dxe_file);
            assert!(matches!(
                inject_ffs(&[first, with_dxe].concat(), &ffs),
                Err(InjectionError::UnsupportedDxeTarget { .. })
            ));
        }
    }

    #[test]
    fn refuses_a_disposable_section_that_can_hide_another_volume_image() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let file = synthetic_guided_file_with_disposable(
            &synthetic_firmware_of_length(0x2000, true, false),
            &synthetic_firmware_of_length(0x2000, true, false),
        );
        let firmware = synthetic_firmware_with_file(&file);

        assert!(matches!(
            inject_ffs(&firmware, &ffs),
            Err(InjectionError::IncompleteDxeTargetCensus { .. })
        ));
    }

    #[test]
    fn refuses_an_opaque_compressed_sibling_inside_a_decoded_section_stream() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let inner = synthetic_firmware_of_length(0x2000, true, false);
        let mut decoded = synthetic_section(SECTION_TYPE_FIRMWARE_VOLUME_IMAGE, &inner);
        decoded.resize(align_up(decoded.len(), 4).unwrap(), 0);
        let mut opaque = 4_u32.to_le_bytes().to_vec();
        opaque.push(2);
        opaque.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        decoded.extend(synthetic_section(SECTION_TYPE_COMPRESSION, &opaque));
        let file = synthetic_guided_file([0x39; 16], FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE, &decoded);
        let firmware = synthetic_firmware_with_file(&file);

        assert!(matches!(
            inject_ffs(&firmware, &ffs),
            Err(InjectionError::IncompleteDxeTargetCensus { .. })
        ));
    }

    #[test]
    fn patches_and_round_trips_a_guided_lzma_dxe_volume() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let firmware = synthetic_guided_firmware();

        let (patched, report) = inject_ffs(&firmware, &ffs).unwrap();
        let report = &report.targets[0];
        assert_eq!(report.file_offset, 72);
        assert!(report.encapsulated_volume_image);
        assert!(report.recompressed_guided_section);
        assert!(matches!(
            inject_ffs(&patched, &ffs),
            Err(InjectionError::DriverAlreadyPresent)
        ));
    }

    #[test]
    fn refuses_authenticated_guided_lzma_metadata_instead_of_leaving_it_stale() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let mut guided = synthetic_guided_file(
            [0x33; 16],
            FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE,
            &synthetic_firmware(true, false),
        );
        guided[FFS_HEADER_SIZE + 22..FFS_HEADER_SIZE + 24]
            .copy_from_slice(&0x0003_u16.to_le_bytes());
        let firmware = synthetic_firmware_with_file(&guided);

        assert!(matches!(
            inject_ffs(&firmware, &ffs),
            Err(InjectionError::UnsupportedDxeTarget { .. })
        ));
    }

    #[test]
    fn refuses_multiple_mutations_that_would_rebuild_one_outer_container_twice() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let first = synthetic_guided_file(
            [0x33; 16],
            FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE,
            &synthetic_firmware_of_length(0x2000, true, false),
        );
        let second = synthetic_guided_file(
            [0x34; 16],
            FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE,
            &synthetic_firmware_of_length(0x2000, true, false),
        );
        let mut body = first[FFS_HEADER_SIZE..].to_vec();
        body.resize(align_up(body.len(), 4).unwrap(), 0);
        body.extend_from_slice(&second[FFS_HEADER_SIZE..]);
        let mut file = build_generic_file(&first[..FFS_HEADER_SIZE], &body).unwrap();
        file[23] = !FFS_FILE_STATE_VALID;
        let firmware = synthetic_firmware_with_file(&file);

        assert!(matches!(
            inject_ffs(&firmware, &ffs),
            Err(InjectionError::UnsupportedDxeTarget { .. })
        ));
    }

    #[test]
    fn recompression_preserves_original_lzma_decoder_properties() {
        let input = b"firmware decoder properties must stay stable".repeat(256);
        let mut template = [0_u8; 13];
        template[0] = 0x5e;
        template[1..5].copy_from_slice(&(8 * 1024 * 1024_u32).to_le_bytes());

        let compressed = compress_uefi_lzma(&input, &template).unwrap();
        assert_eq!(&compressed[..5], &template[..5]);
        assert_eq!(lzma_decompress(&compressed).unwrap(), input);
    }

    #[test]
    fn emits_the_pinned_liblzma_validated_golden_vector() {
        let input = b"NvStrapsReBar LZMA golden vector\n".repeat(4);
        let mut template = [0_u8; 13];
        template[0] = 0x5d;
        template[1..5].copy_from_slice(&(16 * 1024 * 1024_u32).to_le_bytes());
        let compressed = compress_uefi_lzma(&input, &template).unwrap();
        let liblzma_validated = [
            0x5d, 0x00, 0x00, 0x00, 0x01, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x27, 0x1d, 0x86, 0x67, 0x6b, 0x32, 0x20, 0xdc, 0x4a, 0x24, 0xb8, 0xc6, 0x48, 0x70,
            0xe0, 0x06, 0x3e, 0xf4, 0x77, 0xa0, 0x04, 0xd2, 0xb9, 0x87, 0xed, 0x1f, 0xca, 0x1e,
            0x7d, 0x8f, 0xe4, 0x6f, 0x94, 0x8a, 0xa7, 0xd9, 0x4c, 0x8f, 0x88, 0x00, 0x00,
        ];
        assert_eq!(compressed, liblzma_validated);
        assert_eq!(
            lzma_decompress(&liblzma_validated).unwrap(),
            input,
            "the repository decoder must also accept the independently validated stream"
        );
    }

    #[test]
    fn grows_a_nested_dxe_volume_by_uefitool_block_map_rules() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let inner = synthetic_full_dxe_firmware();
        let guided = synthetic_guided_file([0x33; 16], FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE, &inner);
        let firmware = synthetic_firmware_with_file(&guided);

        let (patched, injection) = inject_ffs(&firmware, &ffs).unwrap();
        let injection = &injection.targets[0];
        assert!(injection.grew_firmware_volume);
        assert_eq!(injection.firmware_volume_growth_bytes, 0x1000);
        assert!(patched.len() >= firmware.len());
        assert!(matches!(
            inject_ffs(&patched, &ffs),
            Err(InjectionError::DriverAlreadyPresent)
        ));
    }

    #[test]
    fn growth_updates_the_enclosing_firmware_volume_section_size() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let inner = synthetic_full_dxe_firmware();
        let mut decoded = synthetic_section(0x19, &[0; 8]);
        decoded.resize(align_up(decoded.len(), 4).unwrap(), 0);
        decoded.extend(synthetic_section(
            SECTION_TYPE_FIRMWARE_VOLUME_IMAGE,
            &inner,
        ));
        let file = synthetic_guided_file([0x43; 16], FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE, &decoded);
        let firmware = synthetic_firmware_with_file(&file);

        let (patched, injection) = inject_ffs(&firmware, &ffs).unwrap();
        let injection = &injection.targets[0];
        assert!(injection.grew_firmware_volume);
        assert!(matches!(
            inject_ffs(&patched, &ffs),
            Err(InjectionError::DriverAlreadyPresent)
        ));
    }

    #[test]
    fn distinguishes_recompressed_container_capacity_from_inner_space() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let guided = synthetic_guided_file(
            [0x33; 16],
            FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE,
            &synthetic_firmware(true, false),
        );
        let mut firmware = synthetic_firmware_with_file(&guided);
        let sibling = align_up(72 + guided.len(), 8).unwrap();
        firmware[sibling..sibling + 16].fill(0x44);
        firmware[sibling + 16..sibling + 18].fill(0);
        firmware[sibling + 18] = 0x06;
        firmware[sibling + 19] = 0;
        firmware[sibling + 20..sibling + 23].copy_from_slice(&[24, 0, 0]);
        firmware[sibling + 23] = !FFS_FILE_STATE_VALID;

        let error = inject_ffs(&firmware, &ffs).unwrap_err();
        let InjectionError::RecompressedContainerTooLarge {
            container_file_offsets,
            firmware_volume_offset,
            file_offset,
            available_bytes,
            required_bytes,
        } = error
        else {
            panic!("unexpected error: {error}");
        };
        assert_eq!(container_file_offsets, [72]);
        assert_eq!(firmware_volume_offset, 0);
        assert_eq!(file_offset, 72);
        assert_eq!(available_bytes, sibling - 72);
        assert!(required_bytes > available_bytes);
    }

    #[test]
    fn preserves_a_shrunken_nonterminal_container_with_a_raw_section() {
        let guided = synthetic_guided_file(
            [0x33; 16],
            FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE,
            &synthetic_firmware(true, false),
        );
        let mut firmware = synthetic_firmware_with_file(&guided);
        let sibling = align_up(72 + guided.len(), 8).unwrap();
        write_live_test_file(&mut firmware, sibling, 24, 0x06);
        let volume = parse_firmware_volume(&firmware, 0).unwrap().unwrap();
        let original = firmware_files(&firmware, volume).unwrap()[0];

        let mut normalized = guided.clone();
        normalized[23] = !normalized[23];
        let replacement = build_generic_file(
            &normalized[..FFS_HEADER_SIZE],
            &synthetic_section(0x19, b"smaller"),
        )
        .unwrap();
        let padded =
            preserve_nonterminal_file_extent(&firmware, volume, original, &replacement).unwrap();
        assert_eq!(padded.len(), sibling - original.offset);
        verify_generic_file(&padded).unwrap();
        assert_eq!(
            parse_section_stream(&padded[FFS_HEADER_SIZE..])
                .unwrap()
                .last()
                .unwrap()
                .section_type,
            0x19
        );

        let replaced = replace_firmware_file(&firmware, volume, original, &padded)
            .unwrap()
            .unwrap();
        let records = firmware_files(&replaced, volume).unwrap();
        assert_eq!(records[0].offset, 72);
        assert_eq!(records[1].offset, sibling);
        let mut embedded = replaced[72..72 + padded.len()].to_vec();
        embedded[23] = !embedded[23];
        verify_generic_file(&embedded).unwrap();
    }

    #[test]
    fn bounds_guided_lzma_resources_and_nesting() {
        let mut header = [0_u8; 13];
        header[1..5].copy_from_slice(&(MAX_LZMA_DICTIONARY_SIZE + 1).to_le_bytes());
        assert!(validate_lzma_header(&header).is_err());

        header[1..5].copy_from_slice(&0x1000_u32.to_le_bytes());
        header[5..13].copy_from_slice(&(MAX_LZMA_UNCOMPRESSED_SIZE + 1).to_le_bytes());
        assert!(validate_lzma_header(&header).is_err());

        let firmware = synthetic_firmware(true, false);
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        assert!(
            inject_ffs_at_depth(
                &firmware,
                &ffs,
                &[],
                MAX_GUIDED_DEPTH + 1,
                &mut TraversalBudget::default(),
            )
            .is_err()
        );
    }

    #[test]
    fn bounds_materialized_section_and_file_records() {
        let mut sections = Vec::with_capacity((MAX_STRUCTURE_RECORDS + 1) * 4);
        for _ in 0..=MAX_STRUCTURE_RECORDS {
            sections.extend_from_slice(&[4, 0, 0, 0x15]);
        }
        assert!(matches!(
            parse_section_stream(&sections),
            Err(InjectionError::InvalidFirmware(
                "FFS section count exceeds the safety limit"
            ))
        ));

        let length = 72 + (MAX_STRUCTURE_RECORDS + 1) * FFS_HEADER_SIZE;
        let mut firmware = synthetic_firmware_of_length(length, false, false);
        for index in 0..=MAX_STRUCTURE_RECORDS {
            let offset = 72 + index * FFS_HEADER_SIZE;
            write_live_test_file(&mut firmware, offset, FFS_HEADER_SIZE, 0x06);
        }
        let volume = top_level_firmware_volumes(&firmware).unwrap()[0];
        assert!(matches!(
            firmware_files(&firmware, volume),
            Err(InjectionError::InvalidFirmware(
                "FFS file count exceeds the safety limit"
            ))
        ));
    }

    #[test]
    fn bounds_cumulative_decode_and_container_budgets() {
        let mut budget = TraversalBudget::default();
        budget.charge_decoded(MAX_LZMA_UNCOMPRESSED_SIZE).unwrap();
        budget.charge_decoded(MAX_LZMA_UNCOMPRESSED_SIZE).unwrap();
        assert!(budget.charge_decoded(1).is_err());

        let mut budget = TraversalBudget::default();
        for _ in 0..MAX_CENSUS_CONTAINERS {
            budget.charge_container().unwrap();
        }
        assert!(budget.charge_container().is_err());
        assert!(require_decode_depth(MAX_GUIDED_DEPTH).is_err());
    }

    #[test]
    fn bounds_aggregate_dxe_targets_across_decoded_containers() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let guided = synthetic_guided_firmware();
        let firmware = guided.repeat(MAX_DXE_TARGETS + 1);

        assert!(matches!(
            plan_ffs_injection(&firmware, &ffs),
            Err(InjectionError::InvalidFirmware(
                "DXE target census exceeds the safety limit"
            ))
        ));
    }

    #[test]
    fn refuses_a_partially_patched_multi_target_image() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let first = synthetic_firmware(true, false);
        let mut second = synthetic_firmware(true, false);
        second[96..96 + ffs.len()].copy_from_slice(&ffs);
        second[96 + 23] = !FFS_FILE_STATE_VALID;
        let firmware = [first, second].concat();

        assert!(matches!(
            inject_ffs(&firmware, &ffs),
            Err(InjectionError::DriverAlreadyPresent)
        ));
    }

    #[test]
    fn atomically_patches_every_direct_dxe_target() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let volume_length = synthetic_firmware(true, false).len();
        let firmware = [
            synthetic_firmware(true, false),
            synthetic_firmware(true, false),
        ]
        .concat();

        assert!(matches!(
            inject_ffs(&firmware, &ffs),
            Err(InjectionError::AmbiguousDxeTargets { .. })
        ));
        let (patched, injection) = inject_ffs_all_targets(&firmware, &ffs).unwrap();
        assert_eq!(injection.targets.len(), 2);
        assert_eq!(injection.targets[0].target.firmware_volume_offset, 0);
        assert_eq!(
            injection.targets[1].target.firmware_volume_offset,
            volume_length
        );
        assert!(matches!(
            inject_ffs(&patched, &ffs),
            Err(InjectionError::DriverAlreadyPresent)
        ));
    }

    #[test]
    fn injection_plan_is_bound_to_the_exact_source_driver_and_census() {
        let firmware = synthetic_firmware(true, false);
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let plan = plan_ffs_injection(&firmware, &ffs).unwrap();
        let (_, injection) = inject_ffs_with_plan(&firmware, &ffs, &plan).unwrap();
        assert_eq!(injection.plan, plan);

        let mut changed_source = firmware;
        changed_source[72] ^= 1;
        assert!(matches!(
            inject_ffs_with_plan(&changed_source, &ffs, &plan),
            Err(InjectionError::InvalidFirmware(
                "firmware injection plan no longer matches the exact source, driver, and DXE census"
            ))
        ));
    }

    #[test]
    fn atomically_patches_every_guided_dxe_target() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let first = synthetic_guided_firmware();
        let second = synthetic_guided_firmware();
        let second_container = first.len() + 72;

        let (patched, injection) = inject_ffs_all_targets(&[first, second].concat(), &ffs).unwrap();
        assert_eq!(injection.targets.len(), 2);
        assert_eq!(injection.targets[0].target.container_file_offsets, [72]);
        assert_eq!(
            injection.targets[1].target.container_file_offsets,
            [second_container]
        );
        assert!(matches!(
            inject_ffs(&patched, &ffs),
            Err(InjectionError::DriverAlreadyPresent)
        ));
    }

    #[test]
    fn atomically_patches_mixed_direct_and_guided_dxe_targets() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let firmware = [synthetic_firmware(true, false), synthetic_guided_firmware()].concat();

        let (patched, injection) = inject_ffs_all_targets(&firmware, &ffs).unwrap();
        assert_eq!(injection.targets.len(), 2);
        assert!(matches!(
            inject_ffs(&patched, &ffs),
            Err(InjectionError::DriverAlreadyPresent)
        ));
    }

    #[test]
    fn detects_and_refuses_standard_uefi_capsules() {
        let mut capsule = vec![0_u8; 64];
        capsule[..16].copy_from_slice(&EFI_CAPSULE_GUID_BYTES);
        capsule[16..20].copy_from_slice(&28_u32.to_le_bytes());
        capsule[20..24].copy_from_slice(&0x0005_0000_u32.to_le_bytes());
        let capsule_size = capsule.len() as u32;
        capsule[24..28].copy_from_slice(&capsule_size.to_le_bytes());

        let FirmwareEnvelope::UefiCapsule(header) = inspect_firmware_envelope(&capsule) else {
            panic!("capsule was not detected");
        };
        assert_eq!(header.kind, UefiCapsuleKind::Standard);
        assert_eq!(header.header_size, 28);
        assert_eq!(header.body_offset, 28);
        assert_eq!(header.flags, 0x0005_0000);
        assert!(matches!(
            inject_ffs(&capsule, &build_ffs(&synthetic_driver_image()).unwrap()),
            Err(InjectionError::UnsupportedCapsule(_))
        ));

        capsule[24..28].copy_from_slice(&63_u32.to_le_bytes());
        assert!(matches!(
            inspect_firmware_envelope(&capsule),
            FirmwareEnvelope::UefiCapsule(_)
        ));
        assert!(matches!(
            inject_ffs(&capsule, &build_ffs(&synthetic_driver_image()).unwrap()),
            Err(InjectionError::UnsupportedCapsule(_))
        ));

        capsule[24..28].copy_from_slice(&65_u32.to_le_bytes());
        assert!(matches!(
            inspect_firmware_envelope(&capsule),
            FirmwareEnvelope::MalformedCapsule(_)
        ));
        assert!(matches!(
            inject_ffs(&capsule, &build_ffs(&synthetic_driver_image()).unwrap()),
            Err(InjectionError::MalformedCapsule(_))
        ));
    }

    #[test]
    fn detects_unknown_and_toshiba_capsules_with_trailing_wrapper_bytes() {
        let mut unknown = vec![0_u8; 64];
        unknown[..16].fill(0x42);
        unknown[16..20].copy_from_slice(&28_u32.to_le_bytes());
        unknown[20..24].copy_from_slice(&0x0001_0000_u32.to_le_bytes());
        unknown[24..28].copy_from_slice(&63_u32.to_le_bytes());
        let FirmwareEnvelope::UefiCapsule(header) = inspect_firmware_envelope(&unknown) else {
            panic!("generic capsule with trailing wrapper bytes was not detected");
        };
        assert_eq!(header.kind, UefiCapsuleKind::Standard);
        assert_eq!(header.capsule_image_size, 63);

        let mut toshiba = vec![0_u8; 64];
        toshiba[..16].copy_from_slice(&TOSHIBA_CAPSULE_GUID_BYTES);
        toshiba[16..20].copy_from_slice(&28_u32.to_le_bytes());
        toshiba[20..24].copy_from_slice(&63_u32.to_le_bytes());
        toshiba[24..28].copy_from_slice(&0x0001_0000_u32.to_le_bytes());
        let FirmwareEnvelope::UefiCapsule(header) = inspect_firmware_envelope(&toshiba) else {
            panic!("Toshiba capsule was not detected");
        };
        assert_eq!(header.kind, UefiCapsuleKind::Toshiba);
        assert_eq!(header.flags, 0x0001_0000);
        assert_eq!(header.capsule_image_size, 63);
    }

    #[test]
    fn detects_realistic_aptio_capsules_and_honors_rom_image_offset() {
        for (guid, kind) in [
            (
                APTIO_SIGNED_CAPSULE_GUID_BYTES,
                UefiCapsuleKind::AptioSigned,
            ),
            (
                APTIO_UNSIGNED_CAPSULE_GUID_BYTES,
                UefiCapsuleKind::AptioUnsigned,
            ),
        ] {
            let capsule = synthetic_aptio_capsule(guid, 40, 64);
            let FirmwareEnvelope::UefiCapsule(header) = inspect_firmware_envelope(&capsule) else {
                panic!("Aptio capsule was not detected");
            };
            assert_eq!(header.kind, kind);
            assert_eq!(header.flags, 0x0001_0001);
            assert_eq!(header.header_size, 40);
            assert_eq!(header.body_offset, 64);
            assert!(matches!(
                inject_ffs(&capsule, &build_ffs(&synthetic_driver_image()).unwrap()),
                Err(InjectionError::UnsupportedCapsule(_))
            ));
        }
    }

    #[test]
    fn recognized_malformed_aptio_capsules_fail_closed() {
        for rom_image_offset in [0, 128] {
            let capsule =
                synthetic_aptio_capsule(APTIO_SIGNED_CAPSULE_GUID_BYTES, 40, rom_image_offset);
            assert!(matches!(
                inspect_firmware_envelope(&capsule),
                FirmwareEnvelope::MalformedCapsule(_)
            ));
            assert!(matches!(
                inject_ffs(&capsule, &build_ffs(&synthetic_driver_image()).unwrap()),
                Err(InjectionError::MalformedCapsule(_))
            ));
        }
    }

    #[test]
    fn applies_selected_rules_to_exact_uncompressed_ffs_sections() {
        let catalog = synthetic_legacy_catalog();
        let rule = &catalog.rules[0];
        let firmware = synthetic_legacy_firmware(rule, 0x10, &[0x00, 0xaa, 0xbb, 0x00]);
        let selection = LegacyPatchSelection {
            rule_id: rule.id.clone(),
            expected_matches: 1,
        };

        let (patched, report) =
            patch_legacy_firmware(&firmware, &catalog, std::slice::from_ref(&selection)).unwrap();

        assert_eq!(report.catalog_sha256, catalog.source_sha256);
        assert_eq!(report.applications.len(), 1);
        assert_eq!(report.applications[0].changes.len(), 1);
        let change = &report.applications[0].changes[0];
        assert_eq!(
            change.path,
            [
                LegacyFirmwarePatchPath::FirmwareVolume { offset: 0 },
                LegacyFirmwarePatchPath::FirmwareFile {
                    offset: 72,
                    file_guid: rule.file_guid,
                },
                LegacyFirmwarePatchPath::Section {
                    offset: 0,
                    content_offset: 4,
                    section_type: 0x10,
                },
            ]
        );
        assert_eq!(change.change.before, [0xaa, 0xbb]);
        assert_eq!(change.change.after, [0xcc, 0xdd]);
        assert_eq!(&patched[101..103], &[0xcc, 0xdd]);
        assert_eq!(&firmware[101..103], &[0xaa, 0xbb]);

        assert!(matches!(
            patch_legacy_firmware(&patched, &catalog, &[selection]),
            Err(LegacyFirmwarePatchError::InvalidRule(
                LegacyPatchError::MatchCount {
                    expected: 1,
                    actual: 0,
                    ..
                }
            ))
        ));
    }

    #[test]
    fn analyzes_legacy_matches_without_mutating_and_reports_unprovable_rules() {
        let catalog = synthetic_legacy_catalog();
        let rule = &catalog.rules[0];
        let firmware = synthetic_legacy_firmware(rule, 0x10, &[0x00, 0xaa, 0xbb, 0x00]);

        let analysis = analyze_legacy_firmware(&firmware, &catalog).unwrap();
        assert_eq!(analysis.catalog_sha256, catalog.source_sha256);
        assert_eq!(
            analysis.rules[0].disposition,
            LegacyFirmwareRuleDisposition::Applicable {
                expected_matches: 1
            }
        );
        assert_eq!(&firmware[101..103], &[0xaa, 0xbb]);

        let (patched, _) = patch_legacy_firmware(
            &firmware,
            &catalog,
            &[LegacyPatchSelection {
                rule_id: rule.id.clone(),
                expected_matches: 1,
            }],
        )
        .unwrap();
        assert_eq!(
            analyze_legacy_firmware(&patched, &catalog).unwrap().rules[0].disposition,
            LegacyFirmwareRuleDisposition::Absent
        );

        let unsupported =
            synthetic_legacy_firmware(rule, SECTION_TYPE_COMPRESSION, &[0, 0, 0, 0, 1, 0]);
        assert!(matches!(
            analyze_legacy_firmware(&unsupported, &catalog)
                .unwrap()
                .rules[0]
                .disposition,
            LegacyFirmwareRuleDisposition::Blocked { .. }
        ));
    }

    #[test]
    fn rejects_zero_duplicate_and_unsupported_legacy_selections() {
        let catalog = synthetic_legacy_catalog();
        let rule = &catalog.rules[0];
        let firmware = synthetic_legacy_firmware(rule, 0x10, &[0xaa, 0xbb]);
        let zero = LegacyPatchSelection {
            rule_id: rule.id.clone(),
            expected_matches: 0,
        };
        assert!(matches!(
            patch_legacy_firmware(&firmware, &catalog, &[zero]),
            Err(LegacyFirmwarePatchError::InvalidRule(
                LegacyPatchError::ExpectedMatchesMustBePositive { .. }
            ))
        ));

        let selected = LegacyPatchSelection {
            rule_id: rule.id.clone(),
            expected_matches: 1,
        };
        assert!(matches!(
            patch_legacy_firmware(&firmware, &catalog, &[selected.clone(), selected]),
            Err(LegacyFirmwarePatchError::DuplicateSelection(_))
        ));

        let encapsulated =
            synthetic_legacy_firmware(rule, SECTION_TYPE_COMPRESSION, &[0, 0, 0, 0, 1, 0]);
        let selected = LegacyPatchSelection {
            rule_id: rule.id.clone(),
            expected_matches: 1,
        };
        assert!(matches!(
            patch_legacy_firmware(&encapsulated, &catalog, &[selected]),
            Err(LegacyFirmwarePatchError::UnsupportedTargetFile { .. })
        ));
    }

    #[test]
    fn patches_and_round_trips_lzma_section_streams_and_nested_volumes() {
        let catalog = synthetic_legacy_catalog();
        let rule = &catalog.rules[0];
        let selected = LegacyPatchSelection {
            rule_id: rule.id.clone(),
            expected_matches: 1,
        };

        let target_stream = synthetic_section(0x10, &[0xaa, 0xbb]);
        let target_file = synthetic_guided_file(rule.file_guid, 0x06, &target_stream);
        let target_firmware = synthetic_firmware_with_file(&target_file);
        let (patched_target, target_report) =
            patch_legacy_firmware(&target_firmware, &catalog, std::slice::from_ref(&selected))
                .unwrap();
        assert!(
            target_report.applications[0].changes[0]
                .path
                .contains(&LegacyFirmwarePatchPath::LzmaPayload)
        );
        assert!(matches!(
            patch_legacy_firmware(&patched_target, &catalog, std::slice::from_ref(&selected)),
            Err(LegacyFirmwarePatchError::InvalidRule(
                LegacyPatchError::MatchCount { actual: 0, .. }
            ))
        ));

        let inner = synthetic_legacy_firmware(rule, 0x10, &[0xaa, 0xbb]);
        let volume_file =
            synthetic_guided_file([0x33; 16], FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE, &inner);
        let nested_firmware = synthetic_firmware_with_file(&volume_file);
        let (patched_nested, nested_report) =
            patch_legacy_firmware(&nested_firmware, &catalog, std::slice::from_ref(&selected))
                .unwrap();
        let path = &nested_report.applications[0].changes[0].path;
        assert_eq!(
            path.iter()
                .filter(|part| matches!(part, LegacyFirmwarePatchPath::FirmwareVolume { .. }))
                .count(),
            2
        );
        assert!(path.contains(&LegacyFirmwarePatchPath::LzmaPayload));
        assert!(matches!(
            patch_legacy_firmware(&patched_nested, &catalog, &[selected]),
            Err(LegacyFirmwarePatchError::InvalidRule(
                LegacyPatchError::MatchCount { actual: 0, .. }
            ))
        ));
    }

    #[test]
    fn patches_and_round_trips_efi_and_tiano_compression_sections() {
        let catalog = synthetic_legacy_catalog();
        let rule = &catalog.rules[0];
        let selected = LegacyPatchSelection {
            rule_id: rule.id.clone(),
            expected_matches: 1,
        };
        let target_stream = synthetic_section(0x10, &[0xaa, 0xbb]);

        for compression in [EfiCompression::EfiStandard, EfiCompression::Tiano] {
            let target_file =
                synthetic_efi_compressed_file(rule.file_guid, 0x06, &target_stream, compression);
            let firmware = synthetic_firmware_with_file(&target_file);
            let (patched, report) =
                patch_legacy_firmware(&firmware, &catalog, std::slice::from_ref(&selected))
                    .unwrap();
            assert!(
                report.applications[0].changes[0]
                    .path
                    .contains(&LegacyFirmwarePatchPath::EfiCompressedPayload { compression })
            );
            assert!(matches!(
                patch_legacy_firmware(&patched, &catalog, std::slice::from_ref(&selected)),
                Err(LegacyFirmwarePatchError::InvalidRule(
                    LegacyPatchError::MatchCount { actual: 0, .. }
                ))
            ));
        }

        let inner = synthetic_legacy_firmware(rule, 0x10, &[0xaa, 0xbb]);
        let nested_stream = synthetic_section(SECTION_TYPE_FIRMWARE_VOLUME_IMAGE, &inner);
        let volume_file = synthetic_efi_compressed_file(
            [0x44; 16],
            FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE,
            &nested_stream,
            EfiCompression::Tiano,
        );
        let firmware = synthetic_firmware_with_file(&volume_file);
        let (_, report) =
            patch_legacy_firmware(&firmware, &catalog, std::slice::from_ref(&selected)).unwrap();
        assert_eq!(
            report.applications[0].changes[0]
                .path
                .iter()
                .filter(|part| matches!(part, LegacyFirmwarePatchPath::FirmwareVolume { .. }))
                .count(),
            2
        );
    }

    fn synthetic_firmware(with_dxe_core: bool, with_pad: bool) -> Vec<u8> {
        synthetic_firmware_of_length(0x2_0000, with_dxe_core, with_pad)
    }

    fn synthetic_firmware_of_length(length: usize, with_dxe_core: bool, with_pad: bool) -> Vec<u8> {
        let mut firmware = vec![0xff; length];
        firmware[..16].fill(0);
        firmware[16..32].copy_from_slice(&[
            0x78, 0xe5, 0x8c, 0x8c, 0x3d, 0x8a, 0x1c, 0x4f, 0x99, 0x35, 0x89, 0x61, 0x85, 0xc3,
            0x2d, 0xd3,
        ]);
        firmware[32..40].copy_from_slice(&(length as u64).to_le_bytes());
        firmware[40..44].copy_from_slice(FV_SIGNATURE);
        firmware[44..48].copy_from_slice(&FV_ERASE_POLARITY.to_le_bytes());
        firmware[48..50].copy_from_slice(&72_u16.to_le_bytes());
        firmware[FV_CHECKSUM_OFFSET..FV_CHECKSUM_OFFSET + 2].fill(0);
        firmware[52..54].copy_from_slice(&0_u16.to_le_bytes());
        firmware[54] = 0;
        firmware[55] = 2;
        let block_length = if length.is_multiple_of(0x1000) {
            0x1000
        } else {
            length
        };
        firmware[56..60]
            .copy_from_slice(&u32::try_from(length / block_length).unwrap().to_le_bytes());
        firmware[60..64].copy_from_slice(&u32::try_from(block_length).unwrap().to_le_bytes());
        firmware[64..72].fill(0);
        let sum = firmware[..72]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|word| u16::from_le_bytes(*word))
            .fold(0_u16, u16::wrapping_add);
        firmware[FV_CHECKSUM_OFFSET..FV_CHECKSUM_OFFSET + 2]
            .copy_from_slice(&0_u16.wrapping_sub(sum).to_le_bytes());

        let first_file = 72;
        firmware[first_file..first_file + 16].fill(0x11);
        firmware[first_file + 16..first_file + 18].fill(0);
        firmware[first_file + 18] = if with_dxe_core {
            FFS_FILE_TYPE_DXE_CORE
        } else {
            0x06
        };
        firmware[first_file + 19] = 0;
        firmware[first_file + 20..first_file + 23].copy_from_slice(&[24, 0, 0]);
        firmware[first_file + 23] = !FFS_FILE_STATE_VALID;
        if with_pad {
            let pad = 96;
            let pad_size = length - pad;
            firmware[pad..pad + 16].fill(0x22);
            firmware[pad + 16..pad + 18].fill(0);
            firmware[pad + 18] = FFS_FILE_TYPE_PAD;
            firmware[pad + 19] = 0;
            firmware[pad + 20..pad + 23].copy_from_slice(&(pad_size as u32).to_le_bytes()[..3]);
            firmware[pad + 23] = !FFS_FILE_STATE_VALID;
        }
        firmware
    }

    fn write_live_test_file(firmware: &mut [u8], offset: usize, size: usize, file_type: u8) {
        firmware[offset..offset + size].fill(0);
        firmware[offset..offset + 16].fill(file_type);
        firmware[offset + 18] = file_type;
        firmware[offset + 20..offset + 23].copy_from_slice(&(size as u32).to_le_bytes()[..3]);
        firmware[offset + 23] = !FFS_FILE_STATE_VALID;
    }

    fn synthetic_full_dxe_firmware() -> Vec<u8> {
        let mut firmware = synthetic_firmware(true, false);
        let trailing = 96;
        let trailing_size = firmware.len() - trailing;
        firmware[trailing..].fill(0);
        firmware[trailing..trailing + 16].fill(0x44);
        firmware[trailing + 18] = 0x06;
        firmware[trailing + 20..trailing + 23]
            .copy_from_slice(&(trailing_size as u32).to_le_bytes()[..3]);
        firmware[trailing + 23] = !FFS_FILE_STATE_VALID;
        firmware
    }

    fn synthetic_aptio_capsule(
        capsule_guid: [u8; 16],
        header_size: u32,
        rom_image_offset: u16,
    ) -> Vec<u8> {
        let mut capsule = vec![0_u8; 128];
        capsule[..16].copy_from_slice(&capsule_guid);
        capsule[16..20].copy_from_slice(&header_size.to_le_bytes());
        capsule[20..24].copy_from_slice(&0x0001_0001_u32.to_le_bytes());
        let capsule_size = capsule.len() as u32;
        capsule[24..28].copy_from_slice(&capsule_size.to_le_bytes());
        capsule[28..30].copy_from_slice(&rom_image_offset.to_le_bytes());
        capsule
    }

    fn synthetic_guided_firmware() -> Vec<u8> {
        let inner = synthetic_firmware(true, false);
        let compressed = compress_test_lzma(&inner);
        let section_size = 24 + compressed.len();
        let mut section = vec![0_u8; 24];
        write_u24(&mut section[..3], section_size as u32);
        section[3] = SECTION_TYPE_GUID_DEFINED;
        section[4..20].copy_from_slice(&LZMA_GUID_BYTES);
        section[20..22].copy_from_slice(&24_u16.to_le_bytes());
        section[22..24].copy_from_slice(&1_u16.to_le_bytes());
        section.extend_from_slice(&compressed);
        section.resize(align_up(section.len(), 4).unwrap(), 0);
        section.extend(synthetic_section(0x15, b"sentinel"));

        let mut header = vec![0_u8; FFS_HEADER_SIZE];
        header[..16].fill(0x33);
        header[18] = FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE;
        let mut guided_file = build_generic_file(&header, &section).unwrap();
        guided_file[23] = !FFS_FILE_STATE_VALID;

        let mut outer = synthetic_firmware(false, false);
        outer[72..].fill(0xff);
        outer[72..72 + guided_file.len()].copy_from_slice(&guided_file);
        outer
    }

    fn synthetic_raw_fv_image_firmware(inner: &[u8]) -> Vec<u8> {
        let section = synthetic_section(SECTION_TYPE_FIRMWARE_VOLUME_IMAGE, inner);
        let mut header = vec![0_u8; FFS_HEADER_SIZE];
        header[..16].fill(0x35);
        header[18] = FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE;
        let mut file = build_generic_file(&header, &section).unwrap();
        file[23] = !FFS_FILE_STATE_VALID;
        synthetic_firmware_with_file(&file)
    }

    fn synthetic_opaque_fv_image_firmware() -> Vec<u8> {
        let section = synthetic_section(0x15, b"opaque");
        let mut header = vec![0_u8; FFS_HEADER_SIZE];
        header[..16].fill(0x38);
        header[18] = FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE;
        let mut file = build_generic_file(&header, &section).unwrap();
        file[23] = !FFS_FILE_STATE_VALID;
        synthetic_firmware_with_file(&file)
    }

    fn synthetic_guided_file_with_disposable(lzma_payload: &[u8], hidden_volume: &[u8]) -> Vec<u8> {
        let file = synthetic_guided_file(
            [0x36; 16],
            FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE,
            lzma_payload,
        );
        let mut body = file[FFS_HEADER_SIZE..].to_vec();
        body.resize(align_up(body.len(), 4).unwrap(), 0);
        let nested_volume = synthetic_section(SECTION_TYPE_FIRMWARE_VOLUME_IMAGE, hidden_volume);
        body.extend(synthetic_section(SECTION_TYPE_DISPOSABLE, &nested_volume));
        let mut rebuilt = build_generic_file(&file[..FFS_HEADER_SIZE], &body).unwrap();
        rebuilt[23] = !FFS_FILE_STATE_VALID;
        rebuilt
    }

    fn synthetic_amd_zlib_fv_image_firmware(inner: &[u8]) -> Vec<u8> {
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, inner).unwrap();
        let compressed = encoder.finish().unwrap();
        let mut amd_payload = vec![0_u8; AMD_ZLIB_HEADER_SIZE];
        amd_payload[0x14..0x18].copy_from_slice(&(compressed.len() as u32).to_le_bytes());
        amd_payload.extend_from_slice(&compressed);

        let mut content = Vec::with_capacity(20 + amd_payload.len());
        content.extend_from_slice(&AMD_ZLIB_GUID_BYTES);
        content.extend_from_slice(&24_u16.to_le_bytes());
        content.extend_from_slice(&1_u16.to_le_bytes());
        content.extend_from_slice(&amd_payload);
        let section = synthetic_section(SECTION_TYPE_GUID_DEFINED, &content);
        let mut header = vec![0_u8; FFS_HEADER_SIZE];
        header[..16].fill(0x37);
        header[18] = FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE;
        let mut file = build_generic_file(&header, &section).unwrap();
        file[23] = !FFS_FILE_STATE_VALID;
        synthetic_firmware_with_file(&file)
    }

    fn synthetic_legacy_catalog() -> LegacyPatchCatalog {
        LegacyPatchCatalog::parse("8D6756B9-E55E-4D6A-A3A5-5E4D72DDF772 10 P:AABB:CCDD\n").unwrap()
    }

    fn synthetic_legacy_firmware(
        rule: &LegacyPatchRule,
        section_type: u8,
        section_body: &[u8],
    ) -> Vec<u8> {
        let section = synthetic_section(section_type, section_body);

        let mut header = vec![0_u8; FFS_HEADER_SIZE];
        header[..16].copy_from_slice(&rule.file_guid);
        header[18] = 0x06;
        header[19] = FFS_ATTRIBUTE_CHECKSUM;
        let mut file = build_generic_file(&header, &section).unwrap();
        file[23] = !FFS_FILE_STATE_VALID;

        synthetic_firmware_with_file(&file)
    }

    fn synthetic_section(section_type: u8, section_body: &[u8]) -> Vec<u8> {
        let mut section = vec![0_u8; 4];
        let section_size = u32::try_from(section.len() + section_body.len()).unwrap();
        write_u24(&mut section[..3], section_size);
        section[3] = section_type;
        section.extend_from_slice(section_body);
        section
    }

    fn synthetic_guided_file(file_guid: [u8; 16], file_type: u8, decompressed: &[u8]) -> Vec<u8> {
        let compressed = compress_test_lzma(decompressed);
        let section_size = 24 + compressed.len();
        let mut section = vec![0_u8; 24];
        write_u24(&mut section[..3], section_size as u32);
        section[3] = SECTION_TYPE_GUID_DEFINED;
        section[4..20].copy_from_slice(&LZMA_GUID_BYTES);
        section[20..22].copy_from_slice(&24_u16.to_le_bytes());
        section[22..24].copy_from_slice(&1_u16.to_le_bytes());
        section.extend_from_slice(&compressed);
        section.resize(align_up(section.len(), 4).unwrap(), 0);
        section.extend(synthetic_section(0x15, b"sentinel"));

        let mut header = vec![0_u8; FFS_HEADER_SIZE];
        header[..16].copy_from_slice(&file_guid);
        header[18] = file_type;
        let mut file = build_generic_file(&header, &section).unwrap();
        file[23] = !FFS_FILE_STATE_VALID;
        file
    }

    fn synthetic_efi_compressed_file(
        file_guid: [u8; 16],
        file_type: u8,
        decompressed: &[u8],
        compression: EfiCompression,
    ) -> Vec<u8> {
        let compressed = efi_compress(decompressed, compression).unwrap();
        let mut content = Vec::with_capacity(5 + compressed.len());
        content.extend_from_slice(&(decompressed.len() as u32).to_le_bytes());
        content.push(1);
        content.extend_from_slice(&compressed);
        let mut sections = synthetic_section(SECTION_TYPE_COMPRESSION, &content);
        sections.resize(align_up(sections.len(), 4).unwrap(), 0);
        sections.extend(synthetic_section(0x15, b"sentinel"));

        let mut header = vec![0_u8; FFS_HEADER_SIZE];
        header[..16].copy_from_slice(&file_guid);
        header[18] = file_type;
        let mut file = build_generic_file(&header, &sections).unwrap();
        file[23] = !FFS_FILE_STATE_VALID;
        file
    }

    fn synthetic_firmware_with_file(file: &[u8]) -> Vec<u8> {
        let mut firmware = synthetic_firmware(false, false);
        firmware[72..].fill(0xff);
        firmware[72..72 + file.len()].copy_from_slice(file);
        firmware
    }
}
