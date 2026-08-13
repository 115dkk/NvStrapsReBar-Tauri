use nvstraps_deploy::{GpuFingerprint, MachineIdentity, PciLocation};

use crate::{
    devices::GpuDevice,
    error::{BackendError, BackendResult},
};

pub fn collect_machine_identity(devices: &[GpuDevice]) -> BackendResult<MachineIdentity> {
    #[cfg(windows)]
    {
        windows_impl::collect(devices)
    }

    #[cfg(not(windows))]
    {
        let _ = devices;
        Err(BackendError::UnsupportedPlatform)
    }
}

fn gpu_fingerprint(device: &GpuDevice) -> GpuFingerprint {
    GpuFingerprint {
        vendor_id: device.vendor_id,
        device_id: device.device_id,
        subsystem_vendor_id: device.subsystem_vendor_id,
        subsystem_device_id: device.subsystem_device_id,
        location: PciLocation {
            bus: device.bus,
            device: device.device,
            function: device.function,
        },
        bridge_location: PciLocation {
            bus: device.bridge.bus,
            device: device.bridge.device,
            function: device.bridge.function,
        },
        bar0_base: device.bar0_base,
        bar0_top: device.bar0_top,
    }
}

fn normalize_bios_date(value: String) -> String {
    let value = value.trim();
    let mut parts = value.split('/');
    let (Some(month), Some(day), Some(year), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return value.to_owned();
    };
    let (Ok(month), Ok(day), Ok(year)) =
        (month.parse::<u8>(), day.parse::<u8>(), year.parse::<u16>())
    else {
        return value.to_owned();
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return value.to_owned();
    }
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(windows)]
mod windows_impl {
    use winreg::{RegKey, enums::HKEY_LOCAL_MACHINE};

    use super::*;

    const BIOS_KEY: &str = r"HARDWARE\DESCRIPTION\System\BIOS";

    pub fn collect(devices: &[GpuDevice]) -> BackendResult<MachineIdentity> {
        let bios = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(BIOS_KEY)
            .map_err(|error| registry_error("open BIOS identity", error))?;
        Ok(MachineIdentity {
            board_manufacturer: read_first_string(
                &bios,
                &["BaseBoardManufacturer", "SystemManufacturer"],
            )?,
            board_product: read_first_string(&bios, &["BaseBoardProduct", "SystemProductName"])?,
            board_version: read_first_string(&bios, &["BaseBoardVersion", "SystemVersion"])?,
            bios_vendor: read_first_string(&bios, &["BIOSVendor"])?,
            bios_version: read_first_string(&bios, &["BIOSVersion"])?,
            bios_release_date: normalize_bios_date(read_first_string(&bios, &["BIOSReleaseDate"])?),
            gpus: devices.iter().map(gpu_fingerprint).collect(),
        })
    }

    fn read_first_string(key: &RegKey, names: &[&'static str]) -> BackendResult<String> {
        let mut last_error = None;
        for name in names {
            match key.get_value::<String, _>(name) {
                Ok(value) if !value.trim().is_empty() => return Ok(value),
                Ok(_) => {}
                Err(error) => last_error = Some(error),
            }
        }
        let operation = names.first().copied().unwrap_or("unknown BIOS value");
        Err(registry_error(
            operation,
            last_error.unwrap_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "registry values were empty",
                )
            }),
        ))
    }

    fn registry_error(operation: &'static str, error: std::io::Error) -> BackendError {
        BackendError::MachineIdentity(format!(
            "failed to {operation} from the Windows registry: {error}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use crate::devices::PciBridge;

    use super::*;

    fn device() -> GpuDevice {
        GpuDevice {
            id: "pci-01-00-0".into(),
            name: "RTX 2080 SUPER".into(),
            vendor_id: 0x10de,
            device_id: 0x1e81,
            subsystem_vendor_id: 0x1462,
            subsystem_device_id: 0x3755,
            bus: 1,
            device: 0,
            function: 0,
            bridge: PciBridge {
                vendor_id: 0x8086,
                device_id: 0x460d,
                bus: 0,
                device: 1,
                function: 0,
            },
            bar0_base: 0x8000_0000,
            bar0_top: 0x80ff_ffff,
            current_bar_size: 0x1000_0000,
            dedicated_video_memory: 8 * 1024 * 1024 * 1024,
            is_turing: true,
            recommended_bar_size_selector: Some(13),
            effective_bar_size_selector: None,
        }
    }

    #[test]
    fn machine_fingerprint_uses_the_exact_gpu_and_bridge_topology() {
        let fingerprint = gpu_fingerprint(&device());
        assert_eq!(fingerprint.device_id, 0x1e81);
        assert_eq!(fingerprint.location.bus, 1);
        assert_eq!(fingerprint.bridge_location.device, 1);
        assert_eq!(fingerprint.bar0_top, 0x80ff_ffff);
    }

    #[test]
    fn bios_date_is_canonical_when_the_registry_uses_american_order() {
        assert_eq!(normalize_bios_date("03/12/2026".into()), "2026-03-12");
        assert_eq!(normalize_bios_date("unknown".into()), "unknown");
        assert_eq!(normalize_bios_date("13/40/2026".into()), "13/40/2026");
    }

    #[cfg(windows)]
    #[test]
    fn current_windows_bios_identity_is_readable_without_elevation() {
        let identity = collect_machine_identity(&[device()]).unwrap();
        assert!(!identity.board_manufacturer.trim().is_empty());
        assert!(!identity.board_product.trim().is_empty());
        assert!(!identity.bios_version.trim().is_empty());
        assert_eq!(identity.gpus.len(), 1);
    }
}
