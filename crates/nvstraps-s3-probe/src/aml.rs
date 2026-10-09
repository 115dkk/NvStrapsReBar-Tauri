use core::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Missing(&'static str),
    Truncated,
    InvalidPackage,
    UnsupportedInteger(u8),
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing(name) => write!(formatter, "AML sleep package {name} is missing"),
            Self::Truncated => formatter.write_str("AML sleep package is truncated"),
            Self::InvalidPackage => formatter.write_str("AML sleep package is invalid"),
            Self::UnsupportedInteger(opcode) => {
                write!(
                    formatter,
                    "AML sleep type uses unsupported opcode 0x{opcode:02X}"
                )
            }
        }
    }
}

pub fn sleep_type(aml: &[u8], name: &'static [u8; 4]) -> Result<u8, Error> {
    for offset in 0..=aml.len().saturating_sub(name.len()) {
        if &aml[offset..offset + name.len()] != name {
            continue;
        }
        let package_offset = offset + name.len();
        if aml.get(package_offset) != Some(&0x12) {
            continue;
        }
        let (package_length, length_bytes) =
            decode_pkg_length(aml.get(package_offset + 1..).ok_or(Error::Truncated)?)?;
        let body_offset = package_offset + 1 + length_bytes;
        let package_end = package_offset
            .checked_add(1 + package_length)
            .ok_or(Error::InvalidPackage)?;
        if package_end > aml.len() || body_offset >= package_end {
            return Err(Error::Truncated);
        }
        let elements = aml[body_offset];
        if elements == 0 {
            return Err(Error::InvalidPackage);
        }
        return parse_integer(&aml[body_offset + 1..package_end]);
    }

    Err(Error::Missing(if name == b"_S3_" {
        "_S3_"
    } else {
        "_S5_"
    }))
}

fn decode_pkg_length(bytes: &[u8]) -> Result<(usize, usize), Error> {
    let lead = *bytes.first().ok_or(Error::Truncated)?;
    let following = usize::from(lead >> 6);
    if bytes.len() < following + 1 {
        return Err(Error::Truncated);
    }
    if following == 0 {
        return Ok((usize::from(lead & 0x3f), 1));
    }

    let mut length = usize::from(lead & 0x0f);
    for index in 0..following {
        length |= usize::from(bytes[index + 1]) << (4 + index * 8);
    }
    Ok((length, following + 1))
}

fn parse_integer(bytes: &[u8]) -> Result<u8, Error> {
    match bytes.first().copied().ok_or(Error::Truncated)? {
        0x00 => Ok(0),
        0x01 => Ok(1),
        0x0a => bytes.get(1).copied().ok_or(Error::Truncated),
        opcode => Err(Error::UnsupportedInteger(opcode)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_zero_one_and_byte_sleep_types() {
        assert_eq!(sleep_type(b"xxxx_S3_\x12\x04\x02\x01\x01", b"_S3_"), Ok(1));
        assert_eq!(sleep_type(b"_S5_\x12\x04\x02\x00\x00", b"_S5_"), Ok(0));
        assert_eq!(sleep_type(b"_S3_\x12\x05\x02\x0a\x05\x00", b"_S3_"), Ok(5));
    }

    #[test]
    fn decodes_multibyte_package_length() {
        let mut aml = vec![0_u8; 72];
        aml[..4].copy_from_slice(b"_S3_");
        aml[4] = 0x12;
        aml[5] = 0x41;
        aml[6] = 0x04;
        aml[7] = 2;
        aml[8] = 1;
        assert_eq!(sleep_type(&aml, b"_S3_"), Ok(1));
    }

    #[test]
    fn ignores_names_not_followed_by_package() {
        assert_eq!(
            sleep_type(b"_S3_\x00", b"_S3_"),
            Err(Error::Missing("_S3_"))
        );
    }
}
