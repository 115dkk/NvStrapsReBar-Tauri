use std::{
    fs::{self, File},
    io::{self, Read},
};

use super::{SystemRoots, process};
use crate::{
    error::{BackendError, BackendResult},
    firmware::FirmwareAccess,
};

pub(crate) fn inspect_access(roots: &SystemRoots) -> FirmwareAccess {
    let efi = roots.sys.join("firmware/efi");
    let is_uefi = efi.is_dir();
    FirmwareAccess {
        is_uefi,
        is_elevated: matches!(process::effective_uid(roots), Ok(0)),
        privilege_enabled: is_uefi
            && fs::read_dir(efi.join("efivars"))
                .is_ok_and(|mut entries| matches!(entries.next(), Some(Ok(_)))),
    }
}

pub(crate) fn read_variable(
    roots: &SystemRoots,
    name: &'static str,
) -> BackendResult<Option<Vec<u8>>> {
    let guid = nvstraps_core::VARIABLE_VENDOR_GUID_STRING
        .trim_matches(['{', '}'])
        .to_ascii_lowercase();
    let path = roots
        .sys
        .join("firmware/efi/efivars")
        .join(format!("{name}-{guid}"));
    let failure = |reason: String| BackendError::FirmwareUnavailable {
        name,
        reason: format!("{}: {reason}", path.display()),
    };
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failure(error.to_string())),
    };
    // efivarfs prefixes the variable data with four little-endian attribute bytes:
    // https://www.kernel.org/doc/html/latest/filesystems/efivarfs.html
    const MAX_FILE_SIZE: u64 = 4 + 4096;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_SIZE + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| failure(error.to_string()))?;
    if !(4..=MAX_FILE_SIZE as usize).contains(&bytes.len()) {
        return Err(failure(
            "expected four attribute bytes and at most 4096 data bytes".into(),
        ));
    }
    Ok(Some(bytes.split_off(4)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linux::tests::Fixture;

    #[test]
    fn variables_strip_attributes_and_enforce_bounds() {
        let fixture = Fixture::new();
        let name = nvstraps_core::CONFIG_VARIABLE_NAME;
        assert_eq!(read_variable(&fixture.roots, name).unwrap(), None);
        let guid = nvstraps_core::VARIABLE_VENDOR_GUID_STRING
            .trim_matches(['{', '}'])
            .to_ascii_lowercase();
        let path = fixture
            .roots
            .sys
            .join("firmware/efi/efivars")
            .join(format!("{name}-{guid}"));
        fixture.write(&path, [7, 0, 0, 0, 42, 99]);
        assert_eq!(
            read_variable(&fixture.roots, name).unwrap(),
            Some(vec![42, 99])
        );
        fixture.write(&path, [7, 0, 0, 0]);
        assert_eq!(read_variable(&fixture.roots, name).unwrap(), Some(vec![]));
        fixture.write(&path, vec![0; 4100]);
        assert_eq!(
            read_variable(&fixture.roots, name).unwrap().unwrap().len(),
            4096
        );
        for size in [3, 4101] {
            fixture.write(&path, vec![0; size]);
            assert!(matches!(
                read_variable(&fixture.roots, name),
                Err(BackendError::FirmwareUnavailable { .. })
            ));
        }
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(matches!(
            read_variable(&fixture.roots, name),
            Err(BackendError::FirmwareUnavailable { .. })
        ));
    }

    #[test]
    fn access_distinguishes_legacy_empty_and_populated_efivarfs() {
        let fixture = Fixture::new();
        fixture.write(
            fixture.roots.proc.join("self/status"),
            "Uid:\t1000\t1000\t1000\t1000\n",
        );
        let access = inspect_access(&fixture.roots);
        assert!(!access.is_uefi && !access.privilege_enabled && !access.is_elevated);
        let dir = fixture.roots.sys.join("firmware/efi/efivars");
        fs::create_dir_all(&dir).unwrap();
        let access = inspect_access(&fixture.roots);
        assert!(access.is_uefi && !access.privilege_enabled);
        fixture.write(dir.join("some-variable"), [7, 0, 0, 0]);
        fixture.write(
            fixture.roots.proc.join("self/status"),
            "Uid:\t1000\t0\t0\t0\n",
        );
        let access = inspect_access(&fixture.roots);
        assert!(access.is_uefi && access.privilege_enabled && access.is_elevated);
        fixture.write(fixture.roots.proc.join("self/status"), "invalid");
        assert!(!inspect_access(&fixture.roots).is_elevated);
    }
}
