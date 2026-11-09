use std::{fs, os::unix::fs::MetadataExt, path::PathBuf};

use crate::error::{BackendError, BackendResult};

/// The driver's own nvidia-smi from fixed system locations, never from PATH.
pub(crate) fn nvidia_smi_path() -> BackendResult<PathBuf> {
    let candidates = [
        PathBuf::from("/usr/bin/nvidia-smi"),
        PathBuf::from("/usr/local/bin/nvidia-smi"),
        PathBuf::from("/run/current-system/sw/bin/nvidia-smi"),
    ];
    trusted_executable(&candidates).ok_or_else(|| BackendError::Deployment(
        "nvidia-smi was not found in /usr/bin, /usr/local/bin or /run/current-system/sw/bin; the NVIDIA driver provides it".into()
    ))
}

pub(crate) fn trusted_executable(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find_map(|candidate| {
        let path = fs::canonicalize(candidate).ok()?;
        let metadata = fs::metadata(&path).ok()?;
        (metadata.is_file() && trusted_owner_and_mode(metadata.uid(), metadata.mode()))
            .then_some(path)
    })
}

fn trusted_owner_and_mode(uid: u32, mode: u32) -> bool {
    uid == 0 && mode & 0o022 == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linux::tests::Fixture;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn ownership_and_mode_rule_is_independent_of_test_user() {
        assert!(trusted_owner_and_mode(0, 0o100755));
        assert!(!trusted_owner_and_mode(1000, 0o100755));
        assert!(!trusted_owner_and_mode(0, 0o100775));
        assert!(!trusted_owner_and_mode(0, 0o100757));
    }

    #[test]
    fn candidates_are_canonical_regular_files_with_safe_permissions() {
        let fixture = Fixture::new();
        let path = fixture.roots.sys.join("driver/nvidia-smi");
        fixture.write(&path, "fixture, never executed");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        let link = fixture.roots.sys.join("smi-link");
        symlink(&path, &link).unwrap();
        let expected =
            (fs::metadata(&path).unwrap().uid() == 0).then(|| fs::canonicalize(&path).unwrap());
        assert_eq!(
            trusted_executable(&[
                fixture.roots.sys.join("absent"),
                fixture.roots.sys.clone(),
                link.clone()
            ]),
            expected
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(trusted_executable(&[link]), None);
    }
}
