use core::fmt;

const SDT_HEADER_LEN: usize = 36;
const RSDP_V1_LEN: usize = 20;
const RSDP_V2_MIN_LEN: usize = 36;
const FADT_FIRMWARE_CTRL: usize = 36;
const FADT_DSDT: usize = 40;
const FADT_PM1A_CNT_BLK: usize = 64;
const FADT_X_FIRMWARE_CTRL: usize = 132;
const FADT_X_DSDT: usize = 140;
const FADT_X_PM1A_CNT_BLK: usize = 172;
const GAS_ADDRESS_SPACE_SYSTEM_IO: u8 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    BadSignature(&'static str),
    BadChecksum(&'static str),
    Truncated(&'static str),
    Missing(&'static str),
    Unsupported(&'static str),
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadSignature(table) => write!(formatter, "{table} signature is invalid"),
            Self::BadChecksum(table) => write!(formatter, "{table} checksum is invalid"),
            Self::Truncated(table) => write!(formatter, "{table} is truncated"),
            Self::Missing(field) => write!(formatter, "{field} is missing"),
            Self::Unsupported(field) => write!(formatter, "{field} is unsupported"),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RootTable {
    Xsdt(u64),
    Rsdt(u32),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FadtInfo {
    pub facs: u64,
    pub dsdt: u64,
    pub pm1a_cnt: u16,
}

pub fn parse_rsdp(bytes: &[u8]) -> Result<RootTable, Error> {
    if bytes.len() < RSDP_V1_LEN {
        return Err(Error::Truncated("RSDP"));
    }
    if &bytes[..8] != b"RSD PTR " {
        return Err(Error::BadSignature("RSDP"));
    }
    if !checksum_ok(&bytes[..RSDP_V1_LEN]) {
        return Err(Error::BadChecksum("RSDP"));
    }

    if bytes[15] >= 2 {
        if bytes.len() < RSDP_V2_MIN_LEN {
            return Err(Error::Truncated("RSDP"));
        }
        let length = read_u32(bytes, 20, "RSDP")? as usize;
        if length < RSDP_V2_MIN_LEN || bytes.len() < length {
            return Err(Error::Truncated("RSDP"));
        }
        if !checksum_ok(&bytes[..length]) {
            return Err(Error::BadChecksum("RSDP"));
        }
        let xsdt = read_u64(bytes, 24, "RSDP")?;
        if xsdt != 0 {
            return Ok(RootTable::Xsdt(xsdt));
        }
    }

    let rsdt = read_u32(bytes, 16, "RSDP")?;
    if rsdt == 0 {
        Err(Error::Missing("RSDT address"))
    } else {
        Ok(RootTable::Rsdt(rsdt))
    }
}

pub fn sdt_length(header: &[u8], expected_signature: &[u8; 4]) -> Result<usize, Error> {
    if header.len() < SDT_HEADER_LEN {
        return Err(Error::Truncated("ACPI table header"));
    }
    if &header[..4] != expected_signature {
        return Err(Error::BadSignature("ACPI table"));
    }
    let length = read_u32(header, 4, "ACPI table header")? as usize;
    if length < SDT_HEADER_LEN {
        return Err(Error::Truncated("ACPI table"));
    }
    Ok(length)
}

pub fn root_entries<'a>(table: &'a [u8], signature: &[u8; 4]) -> Result<RootEntries<'a>, Error> {
    let length = sdt_length(table, signature)?;
    if table.len() < length {
        return Err(Error::Truncated("root table"));
    }
    if !checksum_ok(&table[..length]) {
        return Err(Error::BadChecksum("root table"));
    }
    let entry_size = if signature == b"XSDT" { 8 } else { 4 };
    let payload = &table[SDT_HEADER_LEN..length];
    if !payload.len().is_multiple_of(entry_size) {
        return Err(Error::Truncated("root table entries"));
    }
    Ok(RootEntries {
        bytes: payload,
        entry_size,
        offset: 0,
    })
}

pub fn parse_fadt(table: &[u8]) -> Result<FadtInfo, Error> {
    let length = sdt_length(table, b"FACP")?;
    if table.len() < length {
        return Err(Error::Truncated("FADT"));
    }
    let table = &table[..length];
    if !checksum_ok(table) {
        return Err(Error::BadChecksum("FADT"));
    }

    let facs = optional_u64(table, FADT_X_FIRMWARE_CTRL)
        .filter(|address| *address != 0)
        .unwrap_or(u64::from(read_u32(
            table,
            FADT_FIRMWARE_CTRL,
            "FADT FIRMWARE_CTRL",
        )?));
    if facs == 0 {
        return Err(Error::Missing("FACS address"));
    }

    let dsdt = optional_u64(table, FADT_X_DSDT)
        .filter(|address| *address != 0)
        .unwrap_or(u64::from(read_u32(table, FADT_DSDT, "FADT DSDT")?));
    if dsdt == 0 {
        return Err(Error::Missing("DSDT address"));
    }

    let extended_port = if table.len() >= FADT_X_PM1A_CNT_BLK + 12 {
        let gas = &table[FADT_X_PM1A_CNT_BLK..FADT_X_PM1A_CNT_BLK + 12];
        let address = u64::from_le_bytes(gas[4..12].try_into().expect("fixed GAS width"));
        if address == 0 {
            None
        } else if gas[0] != GAS_ADDRESS_SPACE_SYSTEM_IO {
            return Err(Error::Unsupported("X_PM1a_CNT_BLK address space"));
        } else {
            Some(u16::try_from(address).map_err(|_| Error::Unsupported("PM1a control port"))?)
        }
    } else {
        None
    };

    let legacy_port = read_u32(table, FADT_PM1A_CNT_BLK, "FADT PM1a_CNT_BLK")?;
    let pm1a_cnt = extended_port.unwrap_or(
        u16::try_from(legacy_port).map_err(|_| Error::Unsupported("PM1a control port"))?,
    );
    if pm1a_cnt == 0 {
        return Err(Error::Missing("PM1a control port"));
    }

    Ok(FadtInfo {
        facs,
        dsdt,
        pm1a_cnt,
    })
}

pub fn table_checksum(table: &[u8], signature: &[u8; 4]) -> Result<(), Error> {
    let length = sdt_length(table, signature)?;
    if table.len() < length {
        return Err(Error::Truncated("ACPI table"));
    }
    if checksum_ok(&table[..length]) {
        Ok(())
    } else {
        Err(Error::BadChecksum("ACPI table"))
    }
}

pub struct RootEntries<'a> {
    bytes: &'a [u8],
    entry_size: usize,
    offset: usize,
}

impl Iterator for RootEntries<'_> {
    type Item = u64;

    fn next(&mut self) -> Option<Self::Item> {
        let entry = self.bytes.get(self.offset..self.offset + self.entry_size)?;
        self.offset += self.entry_size;
        Some(if self.entry_size == 8 {
            u64::from_le_bytes(entry.try_into().expect("entry width checked"))
        } else {
            u64::from(u32::from_le_bytes(
                entry.try_into().expect("entry width checked"),
            ))
        })
    }
}

fn checksum_ok(bytes: &[u8]) -> bool {
    bytes.iter().fold(0_u8, |sum, byte| sum.wrapping_add(*byte)) == 0
}

fn optional_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    bytes
        .get(offset..offset + 8)
        .map(|value| u64::from_le_bytes(value.try_into().expect("slice width checked")))
}

fn read_u32(bytes: &[u8], offset: usize, name: &'static str) -> Result<u32, Error> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or(Error::Truncated(name))?;
    Ok(u32::from_le_bytes(
        value.try_into().expect("slice width checked"),
    ))
}

fn read_u64(bytes: &[u8], offset: usize, name: &'static str) -> Result<u64, Error> {
    let value = bytes
        .get(offset..offset + 8)
        .ok_or(Error::Truncated(name))?;
    Ok(u64::from_le_bytes(
        value.try_into().expect("slice width checked"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_checksum(bytes: &mut [u8], checksum_offset: usize) {
        bytes[checksum_offset] = 0;
        bytes[checksum_offset] =
            0_u8.wrapping_sub(bytes.iter().fold(0_u8, |sum, byte| sum.wrapping_add(*byte)));
    }

    #[test]
    fn parses_xsdt_from_valid_rsdp() {
        let mut rsdp = [0_u8; 36];
        rsdp[..8].copy_from_slice(b"RSD PTR ");
        rsdp[15] = 2;
        rsdp[20..24].copy_from_slice(&36_u32.to_le_bytes());
        rsdp[24..32].copy_from_slice(&0x1234_5678_9abc_def0_u64.to_le_bytes());
        set_checksum(&mut rsdp[..20], 8);
        set_checksum(&mut rsdp, 32);
        assert_eq!(
            parse_rsdp(&rsdp),
            Ok(RootTable::Xsdt(0x1234_5678_9abc_def0))
        );
    }

    #[test]
    fn rejects_bad_rsdp_checksum() {
        let mut rsdp = [0_u8; 20];
        rsdp[..8].copy_from_slice(b"RSD PTR ");
        rsdp[16..20].copy_from_slice(&0x1234_u32.to_le_bytes());
        assert_eq!(parse_rsdp(&rsdp), Err(Error::BadChecksum("RSDP")));
    }

    #[test]
    fn parses_root_entries_and_fadt_fields() {
        let mut xsdt = [0_u8; 52];
        xsdt[..4].copy_from_slice(b"XSDT");
        xsdt[4..8].copy_from_slice(&52_u32.to_le_bytes());
        xsdt[36..44].copy_from_slice(&0x1000_u64.to_le_bytes());
        xsdt[44..52].copy_from_slice(&0x2000_u64.to_le_bytes());
        set_checksum(&mut xsdt, 9);
        assert_eq!(
            root_entries(&xsdt, b"XSDT").unwrap().collect::<Vec<_>>(),
            vec![0x1000, 0x2000]
        );

        let mut fadt = [0_u8; 244];
        fadt[..4].copy_from_slice(b"FACP");
        fadt[4..8].copy_from_slice(&244_u32.to_le_bytes());
        fadt[36..40].copy_from_slice(&0x1111_u32.to_le_bytes());
        fadt[40..44].copy_from_slice(&0x2222_u32.to_le_bytes());
        fadt[64..68].copy_from_slice(&0x604_u32.to_le_bytes());
        fadt[132..140].copy_from_slice(&0x3333_u64.to_le_bytes());
        fadt[140..148].copy_from_slice(&0x4444_u64.to_le_bytes());
        fadt[172] = 1;
        fadt[176..184].copy_from_slice(&0x1234_u64.to_le_bytes());
        set_checksum(&mut fadt, 9);
        assert_eq!(
            parse_fadt(&fadt),
            Ok(FadtInfo {
                facs: 0x3333,
                dsdt: 0x4444,
                pm1a_cnt: 0x1234,
            })
        );
    }
}
