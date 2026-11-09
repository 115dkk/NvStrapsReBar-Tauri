use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use nvstraps_core::{
    CONFIG_VARIABLE_ATTRIBUTES, CONFIG_VARIABLE_NAME, VARIABLE_VENDOR_GUID_STRING,
};

use crate::protocol::ErrorCode;
use crate::serve::{ConfigurationStore, StoreError};

pub const EFIVARS_DIRECTORY: &str = "/sys/firmware/efi/efivars";
// linux/fs.h: libc exports the ioctl requests on GNU and musl, but not this flag.
const FS_IMMUTABLE_FL: libc::c_int = 0x0000_0010;

pub struct EfiVarFs {
    directory: PathBuf,
}

impl EfiVarFs {
    pub fn system() -> Self {
        Self::at(EFIVARS_DIRECTORY)
    }

    pub fn at(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    pub fn variable_path(&self) -> PathBuf {
        let guid = VARIABLE_VENDOR_GUID_STRING
            .trim_matches(['{', '}'])
            .to_ascii_lowercase();
        self.directory
            .join(format!("{CONFIG_VARIABLE_NAME}-{guid}"))
    }

    fn require_directory(&self) -> Result<(), StoreError> {
        match fs::metadata(&self.directory) {
            Ok(metadata) if metadata.is_dir() => Ok(()),
            Ok(_) => Err(io_error(
                "open efivarfs directory",
                &self.directory,
                io::Error::new(io::ErrorKind::NotADirectory, "not a directory"),
            )),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Err(StoreError {
                code: ErrorCode::NotUefi,
                message: format!(
                    "efivarfs directory {} does not exist",
                    self.directory.display()
                ),
            }),
            Err(error) => Err(io_error(
                "inspect efivarfs directory",
                &self.directory,
                error,
            )),
        }
    }
}

impl ConfigurationStore for EfiVarFs {
    fn write(&mut self, data: &[u8]) -> Result<(), StoreError> {
        self.require_directory()?;
        let path = self.variable_path();
        clear_immutable(&path)?;
        let mut buffer = Vec::with_capacity(4 + data.len());
        buffer.extend_from_slice(&CONFIG_VARIABLE_ATTRIBUTES.to_le_bytes());
        buffer.extend_from_slice(data);
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| io_error("open for writing", &path, error))?;
        // Each efivarfs write is one SetVariable call: never retry a short write.
        let written = file
            .write(&buffer)
            .map_err(|error| io_error("write", &path, error))?;
        if written != buffer.len() {
            return Err(io_error(
                "write",
                &path,
                io::Error::new(
                    io::ErrorKind::WriteZero,
                    format!("short write: {written} of {} bytes", buffer.len()),
                ),
            ));
        }
        let readback = fs::read(&path).map_err(|error| io_error("read back", &path, error))?;
        if readback != buffer {
            return Err(StoreError {
                code: ErrorCode::ReadbackMismatch,
                message: format!(
                    "read back {}: contents differ from requested data",
                    path.display()
                ),
            });
        }
        Ok(())
    }

    fn delete(&mut self) -> Result<(), StoreError> {
        self.require_directory()?;
        let path = self.variable_path();
        clear_immutable(&path)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error("delete", &path, error)),
        }
    }
}

fn clear_immutable(path: &Path) -> Result<(), StoreError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error("open to inspect immutable flag", path, error)),
    };
    // These request numbers encode long, but the kernel actually transfers a C int.
    let mut flags: libc::c_int = 0;
    // SAFETY: file owns a live fd, and flags points to writable, aligned c_int storage.
    if unsafe { libc::ioctl(file.as_raw_fd(), libc::FS_IOC_GETFLAGS, &mut flags) } == -1 {
        let error = io::Error::last_os_error();
        if matches!(
            error.raw_os_error(),
            Some(libc::ENOTTY | libc::EOPNOTSUPP | libc::EINVAL)
        ) {
            return Ok(());
        }
        return Err(io_error("get immutable flag", path, error));
    }
    if flags & FS_IMMUTABLE_FL != 0 {
        flags &= !FS_IMMUTABLE_FL;
        // SAFETY: file owns a live fd, and flags points to readable, aligned c_int storage.
        if unsafe { libc::ioctl(file.as_raw_fd(), libc::FS_IOC_SETFLAGS, &flags) } == -1 {
            return Err(io_error(
                "clear immutable flag",
                path,
                io::Error::last_os_error(),
            ));
        }
    }
    Ok(())
}

fn io_error(operation: &str, path: &Path, error: io::Error) -> StoreError {
    StoreError {
        code: ErrorCode::Io,
        message: format!("{operation} {}: {error}", path.display()),
    }
}

pub fn effective_user_is_root() -> bool {
    // SAFETY: geteuid takes no arguments and has no pointer or lifetime requirements.
    unsafe { libc::geteuid() == 0 }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use nvstraps_core::config::Config;

    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            loop {
                let path = std::env::temp_dir().join(format!(
                    "nvstraps-linux-helper-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("create test directory: {error}"),
                }
            }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn data(target_pci_bar_size: u8) -> Vec<u8> {
        Config {
            target_pci_bar_size,
            ..Config::default()
        }
        .encode()
        .unwrap()
    }

    #[test]
    fn creates_replaces_and_deletes_only_the_fixed_variable() {
        let directory = TestDirectory::new();
        let mut store = EfiVarFs::at(&directory.0);
        let path = store.variable_path();
        assert_eq!(
            path.file_name().unwrap(),
            "NvStrapsReBar-e3ee4a27-e2a2-4435-bba3-184ccad935a8"
        );
        for bytes in [data(1), data(2)] {
            store.write(&bytes).unwrap();
            let mut expected = vec![7, 0, 0, 0];
            expected.extend_from_slice(&bytes);
            assert_eq!(fs::read(&path).unwrap(), expected);
        }
        store.delete().unwrap();
        assert!(!path.exists());
        store.delete().unwrap();
    }

    #[test]
    fn missing_directory_is_not_uefi_for_both_operations() {
        let directory = TestDirectory::new();
        let missing = directory.0.join("missing");
        let mut store = EfiVarFs::at(&missing);
        for error in [
            store.write(&data(1)).unwrap_err(),
            store.delete().unwrap_err(),
        ] {
            assert_eq!(error.code, ErrorCode::NotUefi);
            assert!(error.message.contains(missing.to_str().unwrap()));
        }
    }

    #[test]
    fn regular_file_trailing_bytes_are_a_readback_mismatch_not_truncated() {
        let directory = TestDirectory::new();
        let mut store = EfiVarFs::at(&directory.0);
        let path = store.variable_path();
        fs::write(&path, vec![0; 100]).unwrap();
        let error = store.write(&data(1)).unwrap_err();
        assert_eq!(error.code, ErrorCode::ReadbackMismatch);
        assert!(error.message.contains(path.to_str().unwrap()));
        assert_eq!(fs::metadata(path).unwrap().len(), 100);
    }

    #[test]
    fn non_directory_is_an_io_error_with_operation_and_path() {
        let directory = TestDirectory::new();
        let path = directory.0.join("file");
        fs::write(&path, []).unwrap();
        let mut store = EfiVarFs::at(&path);
        let error = store.delete().unwrap_err();
        assert_eq!(error.code, ErrorCode::Io);
        assert!(error.message.contains("open efivarfs directory"));
        assert!(error.message.contains(path.to_str().unwrap()));
    }
}
