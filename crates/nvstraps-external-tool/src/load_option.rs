use std::collections::HashSet;

pub const LOAD_OPTION_ACTIVE: u32 = 0x1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoadOption {
    pub attributes: u32,
    pub description: String,
    pub device_path: Vec<u8>,
    pub optional_data: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HardDrive {
    pub partition_number: u32,
    pub start_lba: u64,
    pub size_lba: u64,
    pub signature: [u8; 16],
    pub mbr_type: u8,
    pub signature_type: u8,
}

impl HardDrive {
    pub fn partition_guid(&self) -> Option<String> {
        if self.mbr_type != 0x02 || self.signature_type != 0x02 {
            return None;
        }
        let data1 = u32::from_le_bytes(self.signature[0..4].try_into().ok()?);
        let data2 = u16::from_le_bytes(self.signature[4..6].try_into().ok()?);
        let data3 = u16::from_le_bytes(self.signature[6..8].try_into().ok()?);
        Some(format!(
            "{data1:08x}-{data2:04x}-{data3:04x}-{:02x}{:02x}-{}",
            self.signature[8],
            self.signature[9],
            hex(&self.signature[10..])
        ))
    }
}

pub fn decode_load_option(bytes: &[u8]) -> Result<LoadOption, String> {
    let attributes = u32_at(bytes, 0).ok_or("load option header is truncated")?;
    let device_path_len = usize::from(u16_at(bytes, 4).ok_or("load option header is truncated")?);
    let mut description_units = Vec::new();
    let mut at = 6;
    loop {
        let unit = u16_at(bytes, at).ok_or("load option description is not NUL-terminated")?;
        at += 2;
        if unit == 0 {
            break;
        }
        description_units.push(unit);
    }
    let description = decode_ucs2(&description_units)
        .ok_or_else(|| "load option description is not valid UCS-2".to_owned())?;
    let path_end = at
        .checked_add(device_path_len)
        .filter(|end| *end <= bytes.len())
        .ok_or("load option device-path length exceeds the input")?;
    let device_path = bytes[at..path_end].to_vec();
    if !device_path.is_empty() && walk_device_path(&device_path).is_none() {
        return Err("load option device path is malformed".to_owned());
    }
    Ok(LoadOption {
        attributes,
        description,
        device_path,
        optional_data: bytes[path_end..].to_vec(),
    })
}

pub fn encode_load_option(option: &LoadOption) -> Vec<u8> {
    let description = encode_ucs2(&option.description);
    let path_len = u16::try_from(option.device_path.len())
        .expect("EFI load-option device path exceeds the u16 length field");
    let path = &option.device_path;
    let mut bytes =
        Vec::with_capacity(8 + description.len() * 2 + path.len() + option.optional_data.len());
    bytes.extend_from_slice(&option.attributes.to_le_bytes());
    bytes.extend_from_slice(&path_len.to_le_bytes());
    for unit in description.into_iter().chain([0]) {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes.extend_from_slice(path);
    bytes.extend_from_slice(&option.optional_data);
    bytes
}

pub fn hard_drive_node(device_path: &[u8]) -> Option<HardDrive> {
    let nodes = walk_device_path(device_path)?;
    nodes.into_iter().find_map(|node| {
        if node[0] != 0x04 || node[1] != 0x01 || node.len() != 42 {
            return None;
        }
        Some(HardDrive {
            partition_number: u32::from_le_bytes(node[4..8].try_into().ok()?),
            start_lba: u64::from_le_bytes(node[8..16].try_into().ok()?),
            size_lba: u64::from_le_bytes(node[16..24].try_into().ok()?),
            signature: node[24..40].try_into().ok()?,
            mbr_type: node[40],
            signature_type: node[41],
        })
    })
}

pub fn file_path(device_path: &[u8]) -> Option<String> {
    let nodes = walk_device_path(device_path)?;
    let mut path = String::new();
    let mut found = false;
    for node in nodes {
        if node[0] != 0x04 || node[1] != 0x04 {
            continue;
        }
        if node.len() < 6 || !(node.len() - 4).is_multiple_of(2) {
            return None;
        }
        let mut units = node[4..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|bytes| u16::from_le_bytes(*bytes))
            .collect::<Vec<_>>();
        if units.last() != Some(&0) || units[..units.len() - 1].contains(&0) {
            return None;
        }
        units.pop();
        path.push_str(&decode_ucs2(&units)?);
        found = true;
    }
    found.then_some(path)
}

pub fn partition_file_device_path(drive: &HardDrive, file: &str) -> Vec<u8> {
    let units = encode_ucs2(file);
    let Some(file_node_len) = units
        .len()
        .checked_add(1)
        .and_then(|len| len.checked_mul(2))
        .and_then(|len| len.checked_add(4))
        .and_then(|len| u16::try_from(len).ok())
    else {
        return Vec::new();
    };
    let mut bytes = Vec::with_capacity(42 + usize::from(file_node_len) + 4);
    bytes.extend_from_slice(&[0x04, 0x01, 42, 0]);
    bytes.extend_from_slice(&drive.partition_number.to_le_bytes());
    bytes.extend_from_slice(&drive.start_lba.to_le_bytes());
    bytes.extend_from_slice(&drive.size_lba.to_le_bytes());
    bytes.extend_from_slice(&drive.signature);
    bytes.push(drive.mbr_type);
    bytes.push(drive.signature_type);
    bytes.extend_from_slice(&[0x04, 0x04]);
    bytes.extend_from_slice(&file_node_len.to_le_bytes());
    for unit in units.into_iter().chain([0]) {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes.extend_from_slice(&[0x7f, 0xff, 0x04, 0x00]);
    bytes
}

pub fn parse_boot_order(bytes: &[u8]) -> Result<Vec<u16>, String> {
    if !bytes.len().is_multiple_of(2) {
        return Err("BootOrder has an odd byte length".to_owned());
    }
    let order = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|bytes| u16::from_le_bytes(*bytes))
        .collect::<Vec<_>>();
    let mut seen = HashSet::with_capacity(order.len());
    if order.iter().any(|number| !seen.insert(*number)) {
        return Err("BootOrder contains duplicate entries".to_owned());
    }
    Ok(order)
}

pub fn encode_boot_order(order: &[u16]) -> Vec<u8> {
    order
        .iter()
        .flat_map(|number| number.to_le_bytes())
        .collect()
}

pub fn boot_variable_name(number: u16) -> String {
    format!("Boot{number:04X}")
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn encode_ucs2(value: &str) -> Vec<u16> {
    value
        .chars()
        .map(|character| {
            let value = u32::from(character);
            u16::try_from(value).unwrap_or(char::REPLACEMENT_CHARACTER as u16)
        })
        .collect()
}

fn decode_ucs2(units: &[u16]) -> Option<String> {
    units
        .iter()
        .map(|unit| char::from_u32(u32::from(*unit)))
        .collect()
}

fn walk_device_path(device_path: &[u8]) -> Option<Vec<&[u8]>> {
    let mut nodes = Vec::new();
    let mut at = 0;
    let mut ended = false;
    while at < device_path.len() {
        let header = device_path.get(at..at + 4)?;
        let len = usize::from(u16::from_le_bytes([header[2], header[3]]));
        if len < 4 {
            return None;
        }
        let end = at.checked_add(len)?;
        let node = device_path.get(at..end)?;
        nodes.push(node);
        at = end;
        if header[0] == 0x7f {
            if len != 4 {
                return None;
            }
            match header[1] {
                0x01 => {}
                0xff => {
                    ended = true;
                    break;
                }
                _ => return None,
            }
        }
    }
    (ended && at == device_path.len()).then_some(nodes)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive() -> HardDrive {
        HardDrive {
            partition_number: 1,
            start_lba: 2048,
            size_lba: 1_000_000,
            signature: [
                0x33, 0x22, 0x11, 0x00, 0x55, 0x44, 0x77, 0x66, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
                0xee, 0xff,
            ],
            mbr_type: 2,
            signature_type: 2,
        }
    }

    fn windows_path_by_hand() -> Vec<u8> {
        let drive = drive();
        let file = "\\EFI\\Microsoft\\Boot\\bootmgfw.efi";
        let units = file.encode_utf16().collect::<Vec<_>>();
        let file_node_len = u16::try_from(4 + (units.len() + 1) * 2).unwrap();
        let mut path = vec![0x04, 0x01, 42, 0];
        path.extend_from_slice(&drive.partition_number.to_le_bytes());
        path.extend_from_slice(&drive.start_lba.to_le_bytes());
        path.extend_from_slice(&drive.size_lba.to_le_bytes());
        path.extend_from_slice(&drive.signature);
        path.push(drive.mbr_type);
        path.push(drive.signature_type);
        path.extend_from_slice(&[0x04, 0x04]);
        path.extend_from_slice(&file_node_len.to_le_bytes());
        for unit in units.into_iter().chain([0]) {
            path.extend_from_slice(&unit.to_le_bytes());
        }
        path.extend_from_slice(&[0x7f, 0xff, 4, 0]);
        path
    }

    #[test]
    fn load_option_round_trip_and_strict_rejections() {
        let option = LoadOption {
            attributes: LOAD_OPTION_ACTIVE,
            description: "Windows Boot Manager".to_owned(),
            device_path: partition_file_device_path(
                &drive(),
                "\\EFI\\Microsoft\\Boot\\bootmgfw.efi",
            ),
            optional_data: vec![1, 2, 3, 4],
        };
        let encoded = encode_load_option(&option);
        assert_eq!(decode_load_option(&encoded).unwrap(), option);
        for length in 0..6 {
            assert!(decode_load_option(&encoded[..length]).is_err());
        }
        let mut unterminated = encoded.clone();
        unterminated[6..8].copy_from_slice(&1_u16.to_le_bytes());
        unterminated.truncate(8);
        assert!(decode_load_option(&unterminated).is_err());
        let mut inconsistent = encoded.clone();
        inconsistent[4..6].copy_from_slice(&u16::MAX.to_le_bytes());
        assert!(decode_load_option(&inconsistent).is_err());
        let mut malformed_path = encoded;
        let path_start = 6 + ("Windows Boot Manager".encode_utf16().count() + 1) * 2;
        malformed_path[path_start + 2..path_start + 4].copy_from_slice(&3_u16.to_le_bytes());
        assert!(decode_load_option(&malformed_path).is_err());
    }

    #[test]
    fn parses_realistic_windows_device_path_and_skips_other_node_kinds() {
        let path = windows_path_by_hand();
        assert_eq!(hard_drive_node(&path), Some(drive()));
        assert_eq!(
            file_path(&path).as_deref(),
            Some("\\EFI\\Microsoft\\Boot\\bootmgfw.efi")
        );

        // Messaging/Vendor node with a 16-byte vendor GUID, followed by a BBS node.
        let mut vendor_and_bbs = vec![0x03, 0x0a, 0x14, 0x00];
        vendor_and_bbs.extend_from_slice(&[0x5a; 16]);
        vendor_and_bbs.extend_from_slice(&[
            0x05, 0x01, 0x0c, 0x00, 0x02, 0x00, 0x00, 0x00, b'B', b'B', b'S', 0,
        ]);
        vendor_and_bbs.extend_from_slice(&path[..path.len() - 4]);
        vendor_and_bbs.extend_from_slice(&[0x7f, 0xff, 4, 0]);
        assert_eq!(hard_drive_node(&vendor_and_bbs), Some(drive()));
        assert_eq!(
            file_path(&vendor_and_bbs).as_deref(),
            Some("\\EFI\\Microsoft\\Boot\\bootmgfw.efi")
        );
        vendor_and_bbs.pop();
        assert_eq!(hard_drive_node(&vendor_and_bbs), None);
        assert_eq!(file_path(&vendor_and_bbs), None);
    }

    #[test]
    fn partition_guid_converts_mixed_endian_fields() {
        assert_eq!(
            drive().partition_guid().as_deref(),
            Some("00112233-4455-6677-8899-aabbccddeeff")
        );
        let mut mbr = drive();
        mbr.mbr_type = 1;
        assert_eq!(mbr.partition_guid(), None);
    }

    #[test]
    fn boot_order_is_little_endian_unique_and_named_canonically() {
        let order = vec![0x1234, 0xabcd];
        assert_eq!(parse_boot_order(&encode_boot_order(&order)).unwrap(), order);
        assert!(parse_boot_order(&[1]).is_err());
        assert!(parse_boot_order(&[1, 0, 1, 0]).is_err());
        assert_eq!(boot_variable_name(0x00af), "Boot00AF");
    }
}
