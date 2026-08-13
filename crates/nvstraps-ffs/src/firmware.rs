use std::fmt;

use super::{FFS_FILE_GUID_BYTES, FFS_FILE_STATE_VALID, FFS_HEADER_SIZE, PackError, inspect_ffs};

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
const FFS_FILE_TYPE_PAD: u8 = 0xf0;
const FFS_FILE_DATA_VALID: u8 = 0x04;
const FFS_FILE_DELETED: u8 = 0x10;
const FFS_FILE_HEADER_INVALID: u8 = 0x20;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FirmwareInjection {
    pub firmware_volume_offset: usize,
    pub file_offset: usize,
    pub replaced_pad_file: bool,
    pub erase_polarity: bool,
}

#[derive(Debug)]
pub enum InjectionError {
    InvalidFfs(PackError),
    InvalidFirmware(&'static str),
    DriverAlreadyPresent,
    NoTopLevelDxeVolume,
    NoSpace,
}

impl fmt::Display for InjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFfs(error) => write!(formatter, "invalid driver FFS: {error}"),
            Self::InvalidFirmware(reason) => write!(formatter, "invalid firmware image: {reason}"),
            Self::DriverAlreadyPresent => formatter.write_str("driver GUID is already present"),
            Self::NoTopLevelDxeVolume => {
                formatter.write_str("no writable top-level DXE firmware volume was found")
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
    inspect_ffs(driver_ffs)?;
    let volumes = find_firmware_volumes(firmware)?;
    let top_level = volumes.iter().copied().filter(|candidate| {
        !volumes
            .iter()
            .any(|container| container.start < candidate.start && candidate.end <= container.end)
    });
    let needed = align_up(driver_ffs.len(), 8)
        .ok_or(InjectionError::InvalidFirmware("driver alignment overflow"))?;
    let mut scanned = Vec::new();
    for volume in top_level {
        scanned.push((volume, scan_volume(firmware, volume)?));
    }
    let mut saw_dxe_volume = false;

    for (volume, scan) in scanned {
        if scan.contains_dxe_core {
            saw_dxe_volume = true;
        } else {
            continue;
        }
        let slot = scan
            .raw_free
            .filter(|(start, end)| end - start >= needed)
            .map(|range| (range, false))
            .or_else(|| {
                scan.pad_free
                    .filter(|(start, end)| end - start >= needed)
                    .map(|range| (range, true))
            });
        let Some(((file_offset, slot_end), replaced_pad_file)) = slot else {
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
            return Ok(VolumeScan {
                contains_dxe_core,
                raw_free: Some((offset, volume.end)),
                pad_free,
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
        pad_free,
    })
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
    use crate::build_ffs;
    use crate::tests::synthetic_driver_image;

    #[test]
    fn injects_into_erased_space_after_a_dxe_core() {
        let firmware = synthetic_firmware(true, false);
        let ffs = build_ffs(&synthetic_driver_image()).unwrap();
        let (patched, report) = inject_ffs(&firmware, &ffs).unwrap();

        assert_eq!(report.firmware_volume_offset, 0);
        assert_eq!(report.file_offset, 96);
        assert!(!report.replaced_pad_file);
        assert!(report.erase_polarity);
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

    fn synthetic_firmware(with_dxe_core: bool, with_pad: bool) -> Vec<u8> {
        let length = 0x2000_usize;
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
}
