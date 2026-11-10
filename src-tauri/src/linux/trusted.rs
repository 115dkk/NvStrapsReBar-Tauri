use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

/// The first candidate that only root can have put there: a regular file owned by root that
/// nobody else can write, reached through directories in which nobody else can replace it.
pub(crate) fn trusted_executable(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find_map(|candidate| {
        let path = fs::canonicalize(candidate).ok()?;
        let metadata = fs::metadata(&path).ok()?;
        (metadata.is_file()
            && trusted_owner_and_mode(metadata.uid(), metadata.mode())
            && path.ancestors().skip(1).all(trusted_directory))
        .then_some(path)
    })
}

fn trusted_owner_and_mode(uid: u32, mode: u32) -> bool {
    uid == 0 && mode & 0o022 == 0
}

fn trusted_directory(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| {
        metadata.is_dir() && trusted_directory_owner_and_mode(metadata.uid(), metadata.mode())
    })
}

/// Root-owned, and either closed to group and others or sticky: in a sticky directory (as
/// `/nix/store` and `/tmp` are) only an entry's owner can rename or remove it.
fn trusted_directory_owner_and_mode(uid: u32, mode: u32) -> bool {
    uid == 0 && (mode & 0o022 == 0 || mode & 0o1000 != 0)
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
    fn a_directory_is_trusted_only_when_others_cannot_swap_its_entries() {
        assert!(trusted_directory_owner_and_mode(0, 0o040755));
        assert!(trusted_directory_owner_and_mode(0, 0o040555));
        // /nix/store and /tmp: writable by others, but sticky.
        assert!(trusted_directory_owner_and_mode(0, 0o041775));
        assert!(trusted_directory_owner_and_mode(0, 0o041777));
        assert!(!trusted_directory_owner_and_mode(0, 0o040775));
        assert!(!trusted_directory_owner_and_mode(0, 0o040757));
        assert!(!trusted_directory_owner_and_mode(1000, 0o040755));
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
