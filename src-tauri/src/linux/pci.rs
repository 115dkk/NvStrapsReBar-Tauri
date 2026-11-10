use std::{
    fs::{self, File},
    io::Read,
    path::Path,
};

use super::SystemRoots;
use crate::{
    devices::{GpuDevice, PciBridge},
    error::{BackendError, BackendResult},
};
use nvstraps_core::registry::{NVIDIA_VENDOR_ID, automatic_bar_size, is_turing, registry_bar_size};

#[derive(Clone, Copy)]
struct Address {
    domain: u16,
    bus: u8,
    device: u8,
    function: u8,
}

fn address(value: &str) -> Option<Address> {
    let bytes = value.as_bytes();
    if bytes.len() != 12
        || bytes[4] != b':'
        || bytes[7] != b':'
        || bytes[10] != b'.'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [4, 7, 10].contains(&index) || byte.is_ascii_hexdigit())
    {
        return None;
    }
    let result = Address {
        domain: u16::from_str_radix(&value[..4], 16).ok()?,
        bus: u8::from_str_radix(&value[5..7], 16).ok()?,
        device: u8::from_str_radix(&value[8..10], 16).ok()?,
        function: u8::from_str_radix(&value[11..], 16).ok()?,
    };
    (result.device <= 31 && result.function <= 7).then_some(result)
}

fn failure(path: &Path, reason: impl std::fmt::Display) -> BackendError {
    BackendError::DeviceInventory(format!("{}: {reason}", path.display()))
}

fn hex(value: &str) -> Option<u64> {
    let digits = value.trim().strip_prefix("0x").unwrap_or(value.trim());
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(digits, 16).ok()
}

fn attribute(path: &Path, max: u64) -> BackendResult<u64> {
    let value = fs::read_to_string(path).map_err(|error| failure(path, error))?;
    hex(&value)
        .filter(|value| *value <= max)
        .ok_or_else(|| failure(path, "malformed hexadecimal PCI attribute"))
}

pub(crate) fn enumerate_gpus(roots: &SystemRoots) -> BackendResult<Vec<GpuDevice>> {
    let dir = roots.sys.join("bus/pci/devices");
    let entries = fs::read_dir(&dir).map_err(|error| failure(&dir, error))?;
    let database = pci_database(roots);
    let mut devices = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| failure(&dir, error))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(location) = address(name).filter(|value| value.domain == 0) else {
            continue;
        };
        let path = entry.path();
        let vendor_id = attribute(&path.join("vendor"), u16::MAX.into())? as u16;
        if vendor_id != NVIDIA_VENDOR_ID {
            continue;
        }
        let class = attribute(&path.join("class"), 0xff_ffff)?;
        if class >> 16 != 0x03 {
            continue;
        }
        let device_id = attribute(&path.join("device"), u16::MAX.into())? as u16;
        let subsystem_vendor_id =
            attribute(&path.join("subsystem_vendor"), u16::MAX.into())? as u16;
        let subsystem_device_id =
            attribute(&path.join("subsystem_device"), u16::MAX.into())? as u16;
        let canonical = fs::canonicalize(&path).map_err(|error| failure(&path, error))?;
        let parent = canonical
            .parent()
            .ok_or_else(|| failure(&path, "GPU has no parent PCI bridge"))?;
        let bridge_location = parent
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(address)
            .filter(|value| value.domain == 0)
            .ok_or_else(|| failure(&path, "GPU has no parent PCI bridge"))?;
        let bridge = PciBridge {
            vendor_id: attribute(&parent.join("vendor"), u16::MAX.into())? as u16,
            device_id: attribute(&parent.join("device"), u16::MAX.into())? as u16,
            bus: bridge_location.bus,
            device: bridge_location.device,
            function: bridge_location.function,
        };
        let (bar0_base, bar0_top, current_bar_size) = memory_resources(&path.join("resource"));
        let bus = location.bus;
        let device = location.device;
        let function = location.function;
        devices.push(GpuDevice {
            id: format!("pci-{bus:02x}-{device:02x}-{function}"),
            name: gpu_name(roots, name, database.as_deref(), vendor_id, device_id),
            vendor_id,
            device_id,
            subsystem_vendor_id,
            subsystem_device_id,
            bus,
            device,
            function,
            bridge,
            bar0_base,
            bar0_top,
            current_bar_size,
            // No unprivileged kernel source supplies dedicated VRAM; no backend consumer needs it.
            dedicated_video_memory: 0,
            is_turing: is_turing(device_id),
            recommended_bar_size_selector: automatic_bar_size(device_id),
            registry_bar_size_selector: registry_bar_size(device_id),
            effective_bar_size_selector: None,
        });
    }
    devices.sort_by_key(|gpu| (gpu.bus, gpu.device, gpu.function));
    Ok(devices)
}

fn memory_resources(path: &Path) -> (u64, u64, u64) {
    const IORESOURCE_MEM: u64 = 0x200;
    const IORESOURCE_UNSET: u64 = 0x2000_0000;
    let Ok(text) = fs::read_to_string(path) else {
        return (0, 0, 0);
    };
    let (mut bar0_base, mut bar0_top, mut max_size) = (0, 0, 0);
    for (index, line) in text.lines().take(6).enumerate() {
        let mut fields = line.split_whitespace();
        let (Some(start), Some(end), Some(flags)) = (
            fields.next().and_then(hex),
            fields.next().and_then(hex),
            fields.next().and_then(hex),
        ) else {
            continue;
        };
        if fields.next().is_some()
            || flags & IORESOURCE_MEM == 0
            || flags & IORESOURCE_UNSET != 0
            || (start == 0 && end == 0)
            || end < start
        {
            continue;
        }
        let Some(size) = (end - start).checked_add(1) else {
            continue;
        };
        max_size = max_size.max(size);
        if index == 0 {
            bar0_base = start;
            bar0_top = end;
        }
    }
    (bar0_base, bar0_top, max_size)
}

fn pci_database(roots: &SystemRoots) -> Option<String> {
    const LIMIT: u64 = 8 * 1024 * 1024;
    for path in &roots.pci_ids {
        let Ok(file) = File::open(path) else {
            continue;
        };
        if file.metadata().ok()?.len() > LIMIT {
            return None;
        }
        let mut bytes = Vec::new();
        if file.take(LIMIT + 1).read_to_end(&mut bytes).is_err() {
            continue;
        }
        if bytes.len() as u64 > LIMIT {
            return None;
        }
        return String::from_utf8(bytes).ok();
    }
    None
}

fn pci_name(database: &str, device: u16) -> Option<&str> {
    let mut nvidia = false;
    for line in database.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if !line.starts_with('\t') {
            if nvidia {
                break;
            }
            nvidia = line
                .strip_prefix("10de")
                .is_some_and(|rest| rest.starts_with(char::is_whitespace));
            continue;
        }
        if !nvidia {
            continue;
        }
        let Some(rest) = line.strip_prefix('\t') else {
            continue;
        };
        let bytes = rest.as_bytes();
        if bytes.len() >= 6
            && bytes[..4].iter().all(u8::is_ascii_hexdigit)
            && &bytes[4..6] == b"  "
            && u16::from_str_radix(&rest[..4], 16).ok() == Some(device)
        {
            let name = rest[6..].trim();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

fn gpu_name(
    roots: &SystemRoots,
    entry: &str,
    database: Option<&str>,
    vendor: u16,
    device: u16,
) -> String {
    let information = roots
        .proc
        .join("driver/nvidia/gpus")
        .join(entry)
        .join("information");
    if let Ok(text) = fs::read_to_string(information)
        && let Some(model) = text
            .lines()
            .filter_map(|line| line.strip_prefix("Model:"))
            .map(str::trim)
            .find(|value| !value.is_empty())
    {
        return if model.starts_with("NVIDIA") {
            model.into()
        } else {
            format!("NVIDIA {model}")
        };
    }
    if let Some(name) = database.and_then(|text| pci_name(text, device)) {
        return format!("NVIDIA {name}");
    }
    format!("NVIDIA GPU {vendor:04X}:{device:04X}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linux::tests::Fixture;
    use std::os::unix::fs::symlink;

    const RESOURCE: &str = "0x00000000a3000000 0x00000000a3ffffff 0x0000000000040200\n0x0000000090000000 0x000000009fffffff 0x000000000014220c\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n";

    fn gpu(fixture: &Fixture, entry: &str, bridge: Option<&str>) -> std::path::PathBuf {
        let parent = fixture.roots.sys.join("devices/pci0000:00");
        let parent = bridge.map_or(parent.clone(), |bridge| parent.join(bridge));
        fixture.write(parent.join("vendor"), "0x8086\n");
        fixture.write(parent.join("device"), "0x1901\n");
        let path = parent.join(entry);
        for (file, value) in [
            ("vendor", "0x10de\n"),
            ("device", "0x1e07\n"),
            ("subsystem_vendor", "0x1462\n"),
            ("subsystem_device", "0x3715\n"),
            ("class", "0x030000\n"),
            ("resource", RESOURCE),
        ] {
            fixture.write(path.join(file), value);
        }
        let dir = fixture.roots.sys.join("bus/pci/devices");
        fs::create_dir_all(&dir).unwrap();
        let target = std::path::PathBuf::from("../../../devices/pci0000:00");
        let target = bridge
            .map_or(target.clone(), |bridge| target.join(bridge))
            .join(entry);
        symlink(target, dir.join(entry)).unwrap();
        path
    }

    #[test]
    fn turing_inventory_matches_every_field_and_name_priority() {
        let fixture = Fixture::new();
        gpu(&fixture, "0000:01:00.0", Some("0000:00:01.0"));
        let mut expected = GpuDevice {
            id: "pci-01-00-0".into(),
            name: "NVIDIA GPU 10DE:1E07".into(),
            vendor_id: 0x10de,
            device_id: 0x1e07,
            subsystem_vendor_id: 0x1462,
            subsystem_device_id: 0x3715,
            bus: 1,
            device: 0,
            function: 0,
            bridge: PciBridge {
                vendor_id: 0x8086,
                device_id: 0x1901,
                bus: 0,
                device: 1,
                function: 0,
            },
            bar0_base: 0xa300_0000,
            bar0_top: 0xa3ff_ffff,
            current_bar_size: 0x1000_0000,
            dedicated_video_memory: 0,
            is_turing: true,
            recommended_bar_size_selector: automatic_bar_size(0x1e07),
            registry_bar_size_selector: registry_bar_size(0x1e07),
            effective_bar_size_selector: None,
        };
        assert_eq!(
            enumerate_gpus(&fixture.roots).unwrap(),
            vec![expected.clone()]
        );
        fixture.write(&fixture.roots.pci_ids[0], "8086  Intel\n\t1e07  Wrong\n10de  NVIDIA Corporation\n# comment\n\n\t\t1462 3715  Subsystem\n\t1e07  GeForce RTX 2080 Ti\n1234  Next\n\t1e07  Wrong\n");
        expected.name = "NVIDIA GeForce RTX 2080 Ti".into();
        assert_eq!(
            enumerate_gpus(&fixture.roots).unwrap(),
            vec![expected.clone()]
        );
        let information = fixture
            .roots
            .proc
            .join("driver/nvidia/gpus/0000:01:00.0/information");
        for model in ["GeForce Driver Name", "NVIDIA GeForce Driver Name"] {
            fixture.write(&information, format!("Other: value\nModel:  {model}  \n"));
            expected.name = "NVIDIA GeForce Driver Name".into();
            assert_eq!(
                enumerate_gpus(&fixture.roots).unwrap(),
                vec![expected.clone()]
            );
        }
    }

    #[test]
    fn inventory_filters_other_devices_and_sorts_locations() {
        let fixture = Fixture::new();
        gpu(&fixture, "0000:03:00.0", Some("0000:00:03.0"));
        gpu(&fixture, "0000:01:00.0", Some("0000:00:01.0"));
        let other = gpu(&fixture, "0000:02:00.0", Some("0000:00:02.0"));
        fixture.write(other.join("vendor"), "0x1002");
        let audio = gpu(&fixture, "0000:01:00.1", Some("0000:00:01.0"));
        fixture.write(audio.join("class"), "0x040300");
        gpu(&fixture, "0001:01:00.0", Some("0001:00:01.0"));
        fs::create_dir(fixture.roots.sys.join("bus/pci/devices/not-pci")).unwrap();
        let devices = enumerate_gpus(&fixture.roots).unwrap();
        assert_eq!(
            devices
                .iter()
                .map(|gpu| gpu.id.as_str())
                .collect::<Vec<_>>(),
            ["pci-01-00-0", "pci-03-00-0"]
        );
    }

    #[test]
    fn root_bus_gpu_and_missing_inventory_fail_closed() {
        let fixture = Fixture::new();
        assert!(matches!(
            enumerate_gpus(&fixture.roots),
            Err(BackendError::DeviceInventory(_))
        ));
        gpu(&fixture, "0000:00:02.0", None);
        let error = enumerate_gpus(&fixture.roots).unwrap_err();
        assert!(matches!(error, BackendError::DeviceInventory(_)));
        assert!(error.to_string().contains("no parent PCI bridge"));
    }

    #[test]
    fn invalid_or_missing_gpu_attributes_name_the_file() {
        for field in [
            "vendor",
            "device",
            "subsystem_vendor",
            "subsystem_device",
            "class",
        ] {
            let fixture = Fixture::new();
            gpu(&fixture, "0000:01:00.0", Some("0000:00:01.0"));
            let path = fixture
                .roots
                .sys
                .join("bus/pci/devices/0000:01:00.0")
                .join(field);
            fixture.write(&path, "invalid");
            let error = enumerate_gpus(&fixture.roots).unwrap_err();
            assert!(matches!(error, BackendError::DeviceInventory(_)));
            assert!(error.to_string().contains(path.to_str().unwrap()));
            fs::remove_file(&path).unwrap();
            assert!(
                enumerate_gpus(&fixture.roots)
                    .unwrap_err()
                    .to_string()
                    .contains(path.to_str().unwrap())
            );
        }
    }

    #[test]
    fn resource_rules_exclude_unassigned_io_rom_and_bad_ranges() {
        let fixture = Fixture::new();
        let path = gpu(&fixture, "0000:01:00.0", Some("0000:00:01.0")).join("resource");
        for first in ["0xa3000000 0xa3ffffff 0x20000200", "0 0 0"] {
            fixture.write(&path, format!("{first}\n0x90000000 0x9fffffff 0x200\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n0x100000000 0x1ffffffff 0x200\n"));
            let devices = enumerate_gpus(&fixture.roots).unwrap();
            assert_eq!(
                (
                    devices[0].bar0_base,
                    devices[0].bar0_top,
                    devices[0].current_bar_size
                ),
                (0, 0, 0x1000_0000)
            );
        }
        fixture.write(
            &path,
            "1 2 100\n20 10 200\n0 ffffffffffffffff 200\nmalformed\n",
        );
        assert_eq!(memory_resources(&path), (0, 0, 0));
        fs::remove_file(&path).unwrap();
        assert_eq!(memory_resources(&path), (0, 0, 0));
    }

    #[test]
    fn database_is_bounded_and_first_readable_wins() {
        let mut fixture = Fixture::new();
        let first = fixture.roots.pci_ids[0].clone();
        let second = first.with_file_name("other.ids");
        fixture.roots.pci_ids.push(second.clone());
        fixture.write(&second, "10de  NVIDIA\n\t1e07  Second");
        assert_eq!(
            pci_database(&fixture.roots).as_deref(),
            Some("10de  NVIDIA\n\t1e07  Second")
        );
        fixture.write(&first, "10de  NVIDIA\n\t1e07  First");
        assert_eq!(
            pci_name(&pci_database(&fixture.roots).unwrap(), 0x1e07),
            Some("First")
        );
        fs::OpenOptions::new()
            .write(true)
            .open(&first)
            .unwrap()
            .set_len(8 * 1024 * 1024 + 1)
            .unwrap();
        assert!(pci_database(&fixture.roots).is_none());
        assert_eq!(
            pci_name("10de  NVIDIA\n1234  Other\n\t1e07  Wrong", 0x1e07),
            None
        );
        assert_eq!(pci_name("10de  NVIDIA\n\t\t1e07  Wrong", 0x1e07), None);
    }

    #[test]
    fn pci_addresses_require_fixed_width_and_valid_device_function() {
        for text in ["0000:01:00.0", "0000:FF:1f.7"] {
            assert!(address(text).is_some());
        }
        for text in [
            "0:01:00.0",
            "0000:01:20.0",
            "0000:01:00.8",
            "0000:01:00.f",
            "0000:01:0é.0",
        ] {
            assert!(address(text).is_none());
        }
    }
}
