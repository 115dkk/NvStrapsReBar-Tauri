use std::{collections::HashSet, fmt};

use oxiarc_lzma::{LzmaLevel, compress as lzma_compress, decompress_bytes as lzma_decompress};

use super::{
    FFS_ATTRIBUTE_CHECKSUM, FFS_FILE_GUID_BYTES, FFS_FILE_STATE_VALID, FFS_HEADER_SIZE,
    LegacyPatchCatalog, LegacyPatchChange, LegacyPatchError, LegacyPatchRule, MAX_STANDARD_SIZE,
    PackError, PatchRuleId, checksum8, inspect_ffs, write_u24,
};

const FV_SIGNATURE: &[u8; 4] = b"_FVH";
const FV_SIGNATURE_OFFSET: usize = 40;
const FV_LENGTH_OFFSET: usize = 32;
const FV_ATTRIBUTES_OFFSET: usize = 44;
const FV_HEADER_LENGTH_OFFSET: usize = 48;
#[cfg(test)]
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
const SECTION_TYPE_FIRMWARE_VOLUME_IMAGE: u8 = 0x17;
const LZMA_GUID_BYTES: [u8; 16] = [
    0x98, 0x58, 0x4e, 0xee, 0x14, 0x39, 0x59, 0x42, 0x9d, 0x6e, 0xdc, 0x7b, 0xd7, 0x94, 0x03, 0xcf,
];
const FFS_FIXED_CHECKSUM: u8 = 0xaa;
const GUIDED_LZMA_LEVEL: u8 = 3;
const MAX_GUIDED_DEPTH: usize = 8;
const MAX_LZMA_DICTIONARY_SIZE: u32 = 64 * 1024 * 1024;
const MAX_LZMA_UNCOMPRESSED_SIZE: u64 = 256 * 1024 * 1024;
const FFS_FILE_DATA_VALID: u8 = 0x04;
const FFS_FILE_DELETED: u8 = 0x10;
const FFS_FILE_HEADER_INVALID: u8 = 0x20;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FirmwareInjection {
    pub firmware_volume_offset: usize,
    pub file_offset: usize,
    pub replaced_pad_file: bool,
    pub erase_polarity: bool,
    pub encapsulated_volume_image: bool,
    pub recompressed_guided_section: bool,
}

#[derive(Debug)]
pub enum InjectionError {
    InvalidFfs(PackError),
    InvalidFirmware(&'static str),
    DriverAlreadyPresent,
    Compression(String),
    NoTopLevelDxeVolume,
    NoSpace,
}

impl fmt::Display for InjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFfs(error) => write!(formatter, "invalid driver FFS: {error}"),
            Self::InvalidFirmware(reason) => write!(formatter, "invalid firmware image: {reason}"),
            Self::DriverAlreadyPresent => formatter.write_str("driver GUID is already present"),
            Self::Compression(reason) => write!(formatter, "firmware compression failed: {reason}"),
            Self::NoTopLevelDxeVolume => {
                formatter.write_str("no writable DXE volume was found through a supported layout")
            }
            Self::NoSpace => formatter.write_str("DXE firmware volume has no suitable free space"),
        }
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
pub struct LegacyFirmwarePatchChange {
    pub firmware_volume_offset: usize,
    pub file_offset: usize,
    pub section_offset: usize,
    pub firmware_offset: usize,
    pub change: LegacyPatchChange,
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
    raw_free: Option<(usize, usize)>,
    pad_free: Option<(usize, usize)>,
}

pub fn inject_ffs(
    firmware: &[u8],
    driver_ffs: &[u8],
) -> Result<(Vec<u8>, FirmwareInjection), InjectionError> {
    inject_ffs_at_depth(firmware, driver_ffs, 0)
}

pub fn patch_legacy_firmware(
    firmware: &[u8],
    catalog: &LegacyPatchCatalog,
    selections: &[LegacyPatchSelection],
) -> Result<(Vec<u8>, LegacyFirmwarePatch), LegacyFirmwarePatchError> {
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
        let (patched, changes) = patch_direct_sections(&output, rule)?;
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

fn patch_direct_sections(
    firmware: &[u8],
    rule: &LegacyPatchRule,
) -> Result<(Vec<u8>, Vec<LegacyFirmwarePatchChange>), LegacyFirmwarePatchError> {
    let volumes = find_firmware_volumes(firmware)?;
    let top_level: Vec<_> = volumes
        .iter()
        .copied()
        .filter(|candidate| {
            !volumes.iter().any(|container| {
                container.start < candidate.start && candidate.end <= container.end
            })
        })
        .collect();
    let mut output = firmware.to_vec();
    let mut changes = Vec::new();

    for volume in top_level {
        for record in firmware_files(&output, volume)? {
            if !record.is_live || output[record.offset..record.offset + 16] != rule.file_guid {
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
            let sections = parse_firmware_sections(&normalized, record.header_size)?;
            if sections.iter().any(|section| {
                matches!(
                    section.section_type,
                    SECTION_TYPE_COMPRESSION
                        | SECTION_TYPE_GUID_DEFINED
                        | SECTION_TYPE_FIRMWARE_VOLUME_IMAGE
                )
            }) {
                return Err(LegacyFirmwarePatchError::UnsupportedTargetFile {
                    rule_id: rule.id.clone(),
                    file_offset: record.offset,
                    reason: "an encapsulated section must be decoded before exact matching",
                });
            }

            let mut file_changes = Vec::new();
            for section in sections
                .iter()
                .filter(|section| section.section_type == rule.section_type)
            {
                let section_body = &normalized[section.content_start..section.end];
                let matches = rule.matching_offsets(section_body);
                if matches.is_empty() {
                    continue;
                }
                let (patched_body, application) = rule.apply_exact(section_body, matches.len())?;
                normalized[section.content_start..section.end].copy_from_slice(&patched_body);
                for change in application.changes {
                    file_changes.push(LegacyFirmwarePatchChange {
                        firmware_volume_offset: volume.start,
                        file_offset: record.offset,
                        section_offset: record.offset + section.offset,
                        firmware_offset: record.offset + section.content_start + change.offset,
                        change,
                    });
                }
            }
            if file_changes.is_empty() {
                continue;
            }

            let rebuilt = build_generic_file(
                &normalized[..record.header_size],
                &normalized[record.header_size..],
            )?;
            if rebuilt.len() != record.size {
                return Err(LegacyFirmwarePatchError::UnsupportedTargetFile {
                    rule_id: rule.id.clone(),
                    file_offset: record.offset,
                    reason: "same-length pattern patch unexpectedly changed the FFS file size",
                });
            }
            let mut stored = rebuilt;
            if volume.erase_polarity {
                stored[23] = !stored[23];
            }
            output[record.offset..record.offset + record.size].copy_from_slice(&stored);
            changes.extend(file_changes);
        }
    }
    Ok((output, changes))
}

fn inject_ffs_at_depth(
    firmware: &[u8],
    driver_ffs: &[u8],
    guided_depth: usize,
) -> Result<(Vec<u8>, FirmwareInjection), InjectionError> {
    if guided_depth > MAX_GUIDED_DEPTH {
        return Err(InjectionError::InvalidFirmware(
            "guided-section nesting exceeds the safety limit",
        ));
    }
    inspect_ffs(driver_ffs)?;
    let volumes = find_firmware_volumes(firmware)?;
    let top_level: Vec<_> = volumes
        .iter()
        .copied()
        .filter(|candidate| {
            !volumes.iter().any(|container| {
                container.start < candidate.start && candidate.end <= container.end
            })
        })
        .collect();
    let mut scanned = Vec::new();
    for volume in top_level.iter().copied() {
        scanned.push((volume, scan_volume(firmware, volume)?));
    }
    if !scanned.iter().any(|(_, scan)| scan.contains_dxe_core)
        && let Some(injected) =
            try_inject_lzma_guided(firmware, driver_ffs, &top_level, guided_depth)?
    {
        return Ok(injected);
    }
    let mut saw_dxe_volume = false;

    for (volume, scan) in scanned {
        if !scan.contains_dxe_core {
            continue;
        }
        saw_dxe_volume = true;
        let needed = align_up(driver_ffs.len(), 8)
            .ok_or(InjectionError::InvalidFirmware("driver alignment overflow"))?;
        let mut selected = None;
        for (slot, replaced_pad_file) in [(scan.raw_free, false), (scan.pad_free, true)] {
            let Some((file_offset, slot_end)) = slot else {
                continue;
            };
            if slot_end - file_offset >= needed {
                selected = Some((file_offset, slot_end, replaced_pad_file));
                break;
            }
        }
        let Some((file_offset, slot_end, replaced_pad_file)) = selected else {
            continue;
        };

        let mut output = firmware.to_vec();
        if replaced_pad_file {
            output[file_offset..slot_end].fill(volume.erase_byte);
        }
        output[file_offset..file_offset + driver_ffs.len()].copy_from_slice(driver_ffs);
        output[file_offset + 23] = if volume.erase_polarity {
            !FFS_FILE_STATE_VALID
        } else {
            FFS_FILE_STATE_VALID
        };
        output[file_offset + driver_ffs.len()..file_offset + needed].fill(volume.erase_byte);
        update_used_size(&mut output, volume, file_offset + needed)?;

        let embedded = &output[file_offset..file_offset + driver_ffs.len()];
        let mut normalized = embedded.to_vec();
        if volume.erase_polarity {
            normalized[23] = !normalized[23];
        }
        inspect_ffs(&normalized)?;
        return Ok((
            output,
            FirmwareInjection {
                firmware_volume_offset: volume.start,
                file_offset,
                replaced_pad_file,
                erase_polarity: volume.erase_polarity,
                encapsulated_volume_image: false,
                recompressed_guided_section: false,
            },
        ));
    }

    Err(if saw_dxe_volume {
        InjectionError::NoSpace
    } else {
        InjectionError::NoTopLevelDxeVolume
    })
}

fn find_firmware_volumes(firmware: &[u8]) -> Result<Vec<FirmwareVolume>, InjectionError> {
    let mut volumes = Vec::new();
    for (signature_offset, bytes) in firmware.windows(FV_SIGNATURE.len()).enumerate() {
        if bytes != FV_SIGNATURE || signature_offset < FV_SIGNATURE_OFFSET {
            continue;
        }
        let start = signature_offset - FV_SIGNATURE_OFFSET;
        if volumes
            .iter()
            .any(|volume: &FirmwareVolume| volume.start == start)
        {
            continue;
        }
        let Some(volume) = parse_firmware_volume(firmware, start)? else {
            continue;
        };
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
    let mut pad_free = None;
    while offset < volume.end {
        let remaining = volume.end - offset;
        if firmware[offset..volume.end]
            .iter()
            .all(|byte| *byte == volume.erase_byte)
        {
            let terminal_pad = pad_free.filter(|(_, end)| *end == offset);
            return Ok(VolumeScan {
                contains_dxe_core,
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
            return Err(InjectionError::DriverAlreadyPresent);
        }
        contains_dxe_core |= is_live && file_type == FFS_FILE_TYPE_DXE_CORE;
        if is_live && file_type == FFS_FILE_TYPE_PAD {
            let end = offset + file_size;
            if pad_free.is_none_or(|(start, previous_end)| end - offset > previous_end - start) {
                pad_free = Some((offset, end));
            }
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
        raw_free: None,
        pad_free: pad_free.filter(|(_, end)| *end == volume.end),
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
    guided_depth: usize,
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
            validate_lzma_header(lzma)?;
            let decompressed = lzma_decompress(lzma)
                .map_err(|error| InjectionError::Compression(error.to_string()))?;
            let (patched_inner, _) =
                match inject_ffs_at_depth(&decompressed, driver_ffs, guided_depth + 1) {
                    Ok(injected) => injected,
                    Err(InjectionError::NoTopLevelDxeVolume | InjectionError::NoSpace) => continue,
                    Err(error) => return Err(error),
                };
            let recompressed = lzma_compress(&patched_inner, LzmaLevel::new(GUIDED_LZMA_LEVEL))
                .map_err(|error| InjectionError::Compression(error.to_string()))?;
            let round_trip = lzma_decompress(&recompressed)
                .map_err(|error| InjectionError::Compression(error.to_string()))?;
            if round_trip != patched_inner {
                return Err(InjectionError::InvalidFirmware(
                    "recompressed guided section failed its round trip",
                ));
            }
            let rebuilt = rebuild_guided_file(&normalized, section, &recompressed)?;
            let Some(mut output) = replace_firmware_file(firmware, volume, record, &rebuilt)?
            else {
                continue;
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
                    firmware_volume_offset: volume.start,
                    file_offset: record.offset,
                    replaced_pad_file: false,
                    erase_polarity: volume.erase_polarity,
                    encapsulated_volume_image: true,
                    recompressed_guided_section: true,
                },
            )));
        }
    }
    Ok(None)
}

fn validate_lzma_header(lzma: &[u8]) -> Result<(), InjectionError> {
    if lzma.len() < 13 {
        return Err(InjectionError::InvalidFirmware(
            "guided LZMA stream has a truncated header",
        ));
    }
    let dictionary_size = u32::from_le_bytes([lzma[1], lzma[2], lzma[3], lzma[4]]);
    let uncompressed_size = u64::from_le_bytes(
        lzma[5..13]
            .try_into()
            .expect("thirteen-byte header was checked"),
    );
    if dictionary_size > MAX_LZMA_DICTIONARY_SIZE {
        return Err(InjectionError::InvalidFirmware(
            "guided LZMA dictionary exceeds the safety limit",
        ));
    }
    if uncompressed_size > MAX_LZMA_UNCOMPRESSED_SIZE {
        return Err(InjectionError::InvalidFirmware(
            "guided LZMA output exceeds the safety limit",
        ));
    }
    Ok(())
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
            if data_offset < 24 || data_offset > size {
                return Err(InjectionError::InvalidFirmware(
                    "guided LZMA data offset is malformed",
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
    let needed = align_up(replacement.len(), 8).ok_or(InjectionError::InvalidFirmware(
        "replacement FFS alignment overflow",
    ))?;
    if needed > capacity_end - original.offset {
        return Ok(None);
    }
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
    section_type: u8,
}

fn parse_firmware_sections(
    file: &[u8],
    file_header_size: usize,
) -> Result<Vec<FirmwareSectionRecord>, InjectionError> {
    if file_header_size > file.len() || !file_header_size.is_multiple_of(4) {
        return Err(InjectionError::InvalidFirmware(
            "FFS section area starts at an invalid offset",
        ));
    }
    let mut sections = Vec::new();
    let mut offset = file_header_size;
    while offset < file.len() {
        let remaining = file.len() - offset;
        if remaining < 4 {
            return Err(InjectionError::InvalidFirmware(
                "truncated bytes follow the final FFS section",
            ));
        }
        let standard_size = read_u24(file, offset)? as usize;
        let section_type = file[offset + 3];
        let (header_size, size) = if standard_size == MAX_STANDARD_SIZE {
            if remaining < 8 {
                return Err(InjectionError::InvalidFirmware(
                    "extended FFS section header is truncated",
                ));
            }
            (8, read_u32(file, offset + 4)? as usize)
        } else {
            (4, standard_size)
        };
        if size < header_size || size > remaining {
            return Err(InjectionError::InvalidFirmware(
                "FFS section extends beyond its file",
            ));
        }
        let end = offset + size;
        sections.push(FirmwareSectionRecord {
            offset,
            end,
            content_start: offset + header_size,
            section_type,
        });
        if end == file.len() {
            offset = end;
        } else {
            offset = align_up(end, 4).ok_or(InjectionError::InvalidFirmware(
                "FFS section alignment overflow",
            ))?;
            if offset > file.len() {
                return Err(InjectionError::InvalidFirmware(
                    "FFS section padding extends beyond its file",
                ));
            }
        }
    }
    Ok(sections)
}

fn header_checksum_is_valid(header: &[u8]) -> bool {
    header
        .chunks_exact(2)
        .map(|word| u16::from_le_bytes([word[0], word[1]]))
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

    #[test]
    fn injects_into_erased_space_after_a_dxe_core() {
        let firmware = synthetic_firmware(true, false);
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let (patched, report) = inject_ffs(&firmware, &ffs).unwrap();

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
            Err(InjectionError::NoSpace)
        ));
    }

    #[test]
    fn refuses_an_unverified_sibling_of_an_encapsulated_dxe_volume() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let mut firmware = synthetic_firmware(false, false);
        firmware[72 + 18] = FFS_FILE_TYPE_FIRMWARE_VOLUME_IMAGE;

        assert!(matches!(
            inject_ffs(&firmware, &ffs),
            Err(InjectionError::NoTopLevelDxeVolume)
        ));
    }

    #[test]
    fn patches_and_round_trips_a_guided_lzma_dxe_volume() {
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let firmware = synthetic_guided_firmware();

        let (patched, report) = inject_ffs(&firmware, &ffs).unwrap();
        assert_eq!(report.file_offset, 72);
        assert!(report.encapsulated_volume_image);
        assert!(report.recompressed_guided_section);
        assert!(matches!(
            inject_ffs(&patched, &ffs),
            Err(InjectionError::DriverAlreadyPresent)
        ));
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
        assert!(inject_ffs_at_depth(&firmware, &ffs, MAX_GUIDED_DEPTH + 1).is_err());
    }

    #[test]
    fn refuses_to_duplicate_a_driver_in_a_later_top_level_volume() {
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
        assert_eq!(change.firmware_volume_offset, 0);
        assert_eq!(change.file_offset, 72);
        assert_eq!(change.section_offset, 96);
        assert_eq!(change.firmware_offset, 101);
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

        let encapsulated = synthetic_legacy_firmware(rule, SECTION_TYPE_COMPRESSION, &[0; 8]);
        let selected = LegacyPatchSelection {
            rule_id: rule.id.clone(),
            expected_matches: 1,
        };
        assert!(matches!(
            patch_legacy_firmware(&encapsulated, &catalog, &[selected]),
            Err(LegacyFirmwarePatchError::UnsupportedTargetFile { .. })
        ));
    }

    fn synthetic_firmware(with_dxe_core: bool, with_pad: bool) -> Vec<u8> {
        let length = 0x2_0000_usize;
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
        firmware[56..60].copy_from_slice(&1_u32.to_le_bytes());
        firmware[60..64].copy_from_slice(&(length as u32).to_le_bytes());
        firmware[64..72].fill(0);
        let sum = firmware[..72]
            .chunks_exact(2)
            .map(|word| u16::from_le_bytes([word[0], word[1]]))
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

    fn synthetic_guided_firmware() -> Vec<u8> {
        let inner = synthetic_firmware(true, false);
        let compressed = lzma_compress(&inner, LzmaLevel::new(GUIDED_LZMA_LEVEL)).unwrap();
        let section_size = 24 + compressed.len();
        let mut section = vec![0_u8; 24];
        write_u24(&mut section[..3], section_size as u32);
        section[3] = SECTION_TYPE_GUID_DEFINED;
        section[4..20].copy_from_slice(&LZMA_GUID_BYTES);
        section[20..22].copy_from_slice(&24_u16.to_le_bytes());
        section[22..24].copy_from_slice(&1_u16.to_le_bytes());
        section.extend_from_slice(&compressed);

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

    fn synthetic_legacy_catalog() -> LegacyPatchCatalog {
        LegacyPatchCatalog::parse("8D6756B9-E55E-4D6A-A3A5-5E4D72DDF772 10 P:AABB:CCDD\n").unwrap()
    }

    fn synthetic_legacy_firmware(
        rule: &LegacyPatchRule,
        section_type: u8,
        section_body: &[u8],
    ) -> Vec<u8> {
        let mut section = vec![0_u8; 4];
        let section_size = u32::try_from(section.len() + section_body.len()).unwrap();
        write_u24(&mut section[..3], section_size);
        section[3] = section_type;
        section.extend_from_slice(section_body);

        let mut header = vec![0_u8; FFS_HEADER_SIZE];
        header[..16].copy_from_slice(&rule.file_guid);
        header[18] = 0x06;
        header[19] = FFS_ATTRIBUTE_CHECKSUM;
        let mut file = build_generic_file(&header, &section).unwrap();
        file[23] = !FFS_FILE_STATE_VALID;

        let mut firmware = synthetic_firmware(false, false);
        firmware[72..].fill(0xff);
        firmware[72..72 + file.len()].copy_from_slice(&file);
        firmware
    }
}
