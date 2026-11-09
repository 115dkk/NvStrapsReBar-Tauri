use std::{fs, io, path::Path};

use super::SystemRoots;
use crate::{
    devices::GpuDevice,
    error::{BackendError, BackendResult},
    machine::{gpu_fingerprint, normalize_bios_date},
};
use nvstraps_deploy::MachineIdentity;

pub(crate) fn collect_machine_identity(
    roots: &SystemRoots,
    devices: &[GpuDevice],
) -> BackendResult<MachineIdentity> {
    let dir = roots.sys.join("class/dmi/id");
    Ok(MachineIdentity {
        board_manufacturer: read_first_string(&dir, &["board_vendor", "sys_vendor"])?,
        board_product: read_first_string(&dir, &["board_name", "product_name"])?,
        board_version: read_first_string(&dir, &["board_version", "product_version"])?,
        bios_vendor: read_first_string(&dir, &["bios_vendor"])?,
        bios_version: read_first_string(&dir, &["bios_version"])?,
        bios_release_date: normalize_bios_date(read_first_string(&dir, &["bios_date"])?),
        gpus: devices.iter().map(gpu_fingerprint).collect(),
    })
}

fn read_first_string(dir: &Path, names: &[&str]) -> BackendResult<String> {
    let mut last_error = None;
    for name in names {
        match fs::read_to_string(dir.join(name)) {
            Ok(value) if !value.trim().is_empty() => return Ok(value.trim().to_owned()),
            Ok(_) => {}
            Err(error) => last_error = Some((*name, error)),
        }
    }
    let (file, error) = last_error.unwrap_or_else(|| {
        (
            names[0],
            io::Error::new(io::ErrorKind::InvalidData, "DMI values were empty"),
        )
    });
    Err(BackendError::MachineIdentity(format!(
        "failed to read {file} from {}: {error}",
        dir.display()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linux::tests::Fixture;

    #[test]
    fn identity_falls_back_trims_and_normalizes_date() {
        let fixture = Fixture::new();
        let dir = fixture.roots.sys.join("class/dmi/id");
        for (name, value) in [
            ("board_vendor", "  \n"),
            ("sys_vendor", " MSI \n"),
            ("board_name", " Board \n"),
            ("board_version", " 1.0 \n"),
            ("bios_vendor", " AMI \n"),
            ("bios_version", " 123 \n"),
            ("bios_date", "07/10/2024\n"),
        ] {
            fixture.write(dir.join(name), value);
        }
        let identity = collect_machine_identity(&fixture.roots, &[]).unwrap();
        assert_eq!(identity.board_manufacturer, "MSI");
        assert_eq!(identity.board_product, "Board");
        assert_eq!(identity.board_version, "1.0");
        assert_eq!(identity.bios_vendor, "AMI");
        assert_eq!(identity.bios_version, "123");
        assert_eq!(identity.bios_release_date, "2024-07-10");
        assert!(identity.gpus.is_empty());
        fs::remove_file(dir.join("board_name")).unwrap();
        fixture.write(dir.join("product_name"), "Fallback product");
        fixture.write(dir.join("board_version"), "");
        fixture.write(dir.join("product_version"), "Fallback version");
        let identity = collect_machine_identity(&fixture.roots, &[]).unwrap();
        assert_eq!(identity.board_product, "Fallback product");
        assert_eq!(identity.board_version, "Fallback version");
    }

    #[test]
    fn missing_and_empty_identity_are_errors() {
        let fixture = Fixture::new();
        assert!(matches!(
            collect_machine_identity(&fixture.roots, &[]),
            Err(BackendError::MachineIdentity(_))
        ));
        let dir = fixture.roots.sys.join("class/dmi/id");
        fixture.write(dir.join("bios_vendor"), " \n");
        assert!(matches!(
            read_first_string(&dir, &["bios_vendor"]),
            Err(BackendError::MachineIdentity(_))
        ));
    }
}
