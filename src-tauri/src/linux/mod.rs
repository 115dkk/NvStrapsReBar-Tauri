use std::path::PathBuf;

/// Where the kernel's virtual filesystems are. Tests point these at a fixture tree.
#[derive(Clone, Debug)]
pub(crate) struct SystemRoots {
    pub sys: PathBuf,
    pub proc: PathBuf,
    /// pci.ids databases, first readable one wins.
    pub pci_ids: Vec<PathBuf>,
}

impl SystemRoots {
    pub(crate) fn host() -> Self {
        Self {
            sys: "/sys".into(),
            proc: "/proc".into(),
            pci_ids: vec![
                "/usr/share/hwdata/pci.ids".into(),
                "/usr/share/misc/pci.ids".into(),
            ],
        }
    }
}

pub(crate) mod desktop;
pub(crate) mod dmi;
pub(crate) mod efivars;
pub(crate) mod helper;
#[cfg_attr(feature = "simulated-machine", allow(dead_code))]
pub(crate) mod nvidia_smi;
pub(crate) mod pci;
pub(crate) mod process;
pub(crate) mod restart;
pub(crate) mod trusted;
#[cfg(not(feature = "simulated-machine"))]
pub(crate) mod window_size;

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::{
        fs,
        path::Path,
        sync::atomic::{AtomicU64, Ordering},
    };

    pub(super) struct Fixture {
        pub roots: SystemRoots,
        root: PathBuf,
    }

    impl Fixture {
        pub fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "nvstraps-linux-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self {
                roots: SystemRoots {
                    sys: root.join("sys"),
                    proc: root.join("proc"),
                    pci_ids: vec![root.join("pci.ids")],
                },
                root,
            }
        }

        pub fn write(&self, path: impl AsRef<Path>, value: impl AsRef<[u8]>) {
            let path = path.as_ref();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, value).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    #[ignore = "read-only inspection of the current Linux machine"]
    fn current_machine_inventory_identity_and_firmware_access_are_readable() {
        let roots = SystemRoots::host();
        let devices = pci::enumerate_gpus(&roots).expect("GPU inventory");
        eprintln!("{devices:#?}");
        let identity = dmi::collect_machine_identity(&roots, &devices).expect("machine identity");
        eprintln!("{identity:#?}");
        eprintln!("{:#?}", efivars::inspect_access(&roots));
    }
}
