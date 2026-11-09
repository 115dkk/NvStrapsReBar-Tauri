use std::{
    fs, io,
    path::PathBuf,
    process::{Command, Stdio},
};

use super::{SystemRoots, trusted::trusted_executable};
use crate::error::{BackendError, BackendResult};

const OS_INDICATIONS_SUPPORTED: &str =
    "firmware/efi/efivars/OsIndicationsSupported-8be4df61-93ca-11d2-aa0d-00e098032b8c";
const EFI_OS_INDICATIONS_BOOT_TO_FW_UI: u64 = 1;

pub(crate) fn systemctl_path() -> BackendResult<PathBuf> {
    trusted_executable(&[
        PathBuf::from("/usr/bin/systemctl"),
        PathBuf::from("/bin/systemctl"),
    ])
    .ok_or_else(|| {
        BackendError::Deployment(
            "systemd's systemctl was not found; restart the computer yourself".into(),
        )
    })
}

/// UEFI boot, `OsIndicationsSupported` bit 0, and systemctl.
pub(crate) fn ensure_firmware_restart_available(roots: &SystemRoots) -> BackendResult<PathBuf> {
    if !roots.sys.join("firmware/efi").is_dir() {
        return Err(BackendError::Deployment(
            "the system was started in legacy BIOS mode; a restart into firmware setup is unavailable"
                .into(),
        ));
    }
    if !firmware_setup_supported(roots)? {
        return Err(BackendError::Deployment(
            "this firmware does not offer a restart into its setup screen; restart and press the setup key instead"
                .into(),
        ));
    }
    systemctl_path()
}

pub(crate) fn firmware_setup_supported(roots: &SystemRoots) -> BackendResult<bool> {
    let path = roots.sys.join(OS_INDICATIONS_SUPPORTED);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(BackendError::Deployment(format!(
                "failed to read {}: {error}",
                path.display()
            )));
        }
    };
    let value = bytes.get(4..12).and_then(|value| value.try_into().ok());
    if bytes.len() != 12 || value.is_none() {
        return Err(BackendError::Deployment(format!(
            "{} must contain four attribute bytes followed by an eight-byte OsIndicationsSupported value",
            path.display()
        )));
    }
    Ok(u64::from_le_bytes(value.unwrap()) & EFI_OS_INDICATIONS_BOOT_TO_FW_UI != 0)
}

pub(crate) fn restart(arguments: &[&str], description: &str) -> BackendResult<()> {
    let executable = systemctl_path()?;
    let output = Command::new(&executable)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| {
            BackendError::Deployment(format!(
                "failed to launch {}: {error}",
                executable.display()
            ))
        })?;
    if output.status.success() {
        return Ok(());
    }
    let code = output
        .status
        .code()
        .map_or_else(|| "unknown".into(), |code| code.to_string());
    let stderr: String = String::from_utf8_lossy(&output.stderr)
        .trim()
        .chars()
        .take(1024)
        .collect();
    Err(BackendError::Deployment(format!(
        "systemd refused the {description} restart with exit code {code}: {stderr}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linux::tests::Fixture;

    #[test]
    fn firmware_support_is_fixture_testable() {
        let fixture = Fixture::new();
        assert!(!firmware_setup_supported(&fixture.roots).unwrap());
        let path = fixture.roots.sys.join(OS_INDICATIONS_SUPPORTED);
        fixture.write(&path, [6, 0, 0, 0, 0x41, 0, 0, 0, 0, 0, 0, 0]);
        assert!(firmware_setup_supported(&fixture.roots).unwrap());
        fixture.write(&path, [6, 0, 0, 0, 0x40, 0, 0, 0, 0, 0, 0, 0]);
        assert!(!firmware_setup_supported(&fixture.roots).unwrap());
    }

    #[test]
    fn malformed_os_indications_supported_is_an_error() {
        let fixture = Fixture::new();
        let path = fixture.roots.sys.join(OS_INDICATIONS_SUPPORTED);
        for bytes in [vec![], vec![0; 11], vec![0; 13]] {
            fixture.write(&path, bytes);
            assert!(matches!(
                firmware_setup_supported(&fixture.roots),
                Err(BackendError::Deployment(_))
            ));
        }
    }

    #[test]
    fn availability_checks_uefi_before_support() {
        let fixture = Fixture::new();
        assert_eq!(
            ensure_firmware_restart_available(&fixture.roots)
                .unwrap_err()
                .to_string(),
            "deployment workflow failed: the system was started in legacy BIOS mode; a restart into firmware setup is unavailable"
        );
        fs::create_dir_all(fixture.roots.sys.join("firmware/efi")).unwrap();
        assert_eq!(
            ensure_firmware_restart_available(&fixture.roots)
                .unwrap_err()
                .to_string(),
            "deployment workflow failed: this firmware does not offer a restart into its setup screen; restart and press the setup key instead"
        );
    }
}
