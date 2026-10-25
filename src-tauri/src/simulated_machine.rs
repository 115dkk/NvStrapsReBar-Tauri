use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use nvstraps_core::registry::{automatic_bar_size, is_turing, registry_bar_size};
use nvstraps_deploy::{FirmwareFingerprint, MachineIdentity, Sha256Digest};
use serde::{Deserialize, Serialize};

use crate::{
    devices::{GpuDevice, PciBridge},
    error::{BackendError, BackendResult},
    firmware::FirmwareAccess,
    resizable_bar::nvidia_smi::NvidiaSmiCapture,
};

const MACHINE_SCHEMA: u8 = 1;
const MIB: u64 = 1024 * 1024;
const SIMULATED_NVIDIA_SMI: &[u8] = b"simulated nvidia-smi";
static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MachineFile {
    schema: u8,
    platform: Platform,
    boot: Boot,
    identity: Identity,
    gpus: Vec<Gpu>,
    firmware_variables: BTreeMap<String, Option<String>>,
    nvidia_smi: NvidiaSmi,
    reboot_requests: Vec<RebootRequest>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Platform {
    uefi: bool,
    elevated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Boot {
    boot_time_unix_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    board_manufacturer: String,
    board_product: String,
    board_version: String,
    bios_vendor: String,
    bios_version: String,
    bios_release_date: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Gpu {
    name: String,
    vendor_id: u16,
    device_id: u16,
    subsystem_vendor_id: u16,
    subsystem_device_id: u16,
    location: PciLocation,
    bridge: Bridge,
    bar0_base: u64,
    bar0_top: u64,
    bar1_bytes: u64,
    dedicated_video_memory_bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PciLocation {
    bus: u8,
    device: u8,
    function: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bridge {
    vendor_id: u16,
    device_id: u16,
    location: PciLocation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NvidiaSmi {
    installed: bool,
    driver_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RebootRequest {
    kind: RebootKind,
    requested_at_unix_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RebootKind {
    FirmwareSetup,
    Configuration,
}

pub(crate) fn machine_file_path() -> BackendResult<PathBuf> {
    let path = std::env::var_os("NVSTRAPS_SIMULATED_MACHINE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(missing_machine_path)?;
    if !path.is_absolute() {
        return Err(missing_machine_path());
    }
    Ok(path)
}

pub(crate) fn load() -> BackendResult<MachineFile> {
    load_from(&machine_file_path()?)
}

fn load_from(path: &Path) -> BackendResult<MachineFile> {
    let bytes = fs::read(path).map_err(|error| {
        simulated_error(format!(
            "failed to read the machine file at {}: {error}",
            path.display()
        ))
    })?;
    let state: MachineFile = serde_json::from_slice(&bytes).map_err(|error| {
        simulated_error(format!(
            "the machine file at {} is invalid: {error}",
            path.display()
        ))
    })?;
    validate(&state)?;
    Ok(state)
}

fn store_at(path: &Path, state: &MachineFile) -> BackendResult<()> {
    validate(state)?;
    let mut bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| simulated_error(format!("failed to encode the machine file: {error}")))?;
    bytes.push(b'\n');

    let parent = path.parent().ok_or_else(|| {
        simulated_error(format!(
            "the machine-file path has no parent folder: {}",
            path.display()
        ))
    })?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("machine.json");
    let (temporary, mut file) = (0..100)
        .find_map(|_| {
            let sequence = TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let temporary = parent.join(format!(
                ".{file_name}.{}.{sequence}.tmp",
                std::process::id()
            ));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
            {
                Ok(file) => Some(Ok((temporary, file))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(simulated_error(format!(
                    "failed to create {}: {error}",
                    temporary.display()
                )))),
            }
        })
        .transpose()?
        .ok_or_else(|| simulated_error("could not allocate a temporary machine file"))?;

    let write_result = file
        .write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| {
            simulated_error(format!(
                "failed to write the temporary machine file at {}: {error}",
                temporary.display()
            ))
        });
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(simulated_error(format!(
            "failed to replace the machine file at {}: {error}",
            path.display()
        )));
    }
    Ok(())
}

pub(crate) fn enumerate_gpus() -> BackendResult<Vec<GpuDevice>> {
    enumerate_gpus_at(&machine_file_path()?)
}

fn enumerate_gpus_at(path: &Path) -> BackendResult<Vec<GpuDevice>> {
    let state = load_from(path)?;
    Ok(devices_from_state(&state))
}

fn devices_from_state(state: &MachineFile) -> Vec<GpuDevice> {
    state
        .gpus
        .iter()
        .map(|gpu| GpuDevice {
            id: format!(
                "pci-{:02x}-{:02x}-{}",
                gpu.location.bus, gpu.location.device, gpu.location.function
            ),
            name: gpu.name.clone(),
            vendor_id: gpu.vendor_id,
            device_id: gpu.device_id,
            subsystem_vendor_id: gpu.subsystem_vendor_id,
            subsystem_device_id: gpu.subsystem_device_id,
            bus: gpu.location.bus,
            device: gpu.location.device,
            function: gpu.location.function,
            bridge: PciBridge {
                vendor_id: gpu.bridge.vendor_id,
                device_id: gpu.bridge.device_id,
                bus: gpu.bridge.location.bus,
                device: gpu.bridge.location.device,
                function: gpu.bridge.location.function,
            },
            bar0_base: gpu.bar0_base,
            bar0_top: gpu.bar0_top,
            current_bar_size: gpu.bar1_bytes,
            dedicated_video_memory: gpu.dedicated_video_memory_bytes,
            is_turing: is_turing(gpu.device_id),
            recommended_bar_size_selector: automatic_bar_size(gpu.device_id),
            registry_bar_size_selector: registry_bar_size(gpu.device_id),
            effective_bar_size_selector: None,
        })
        .collect()
}

pub(crate) fn collect_machine_identity(devices: &[GpuDevice]) -> BackendResult<MachineIdentity> {
    collect_machine_identity_at(&machine_file_path()?, devices)
}

fn collect_machine_identity_at(
    path: &Path,
    devices: &[GpuDevice],
) -> BackendResult<MachineIdentity> {
    let state = load_from(path)?;
    Ok(MachineIdentity {
        board_manufacturer: state.identity.board_manufacturer,
        board_product: state.identity.board_product,
        board_version: state.identity.board_version,
        bios_vendor: state.identity.bios_vendor,
        bios_version: state.identity.bios_version,
        bios_release_date: crate::machine::normalize_bios_date(state.identity.bios_release_date),
        gpus: devices
            .iter()
            .map(crate::machine::gpu_fingerprint)
            .collect(),
    })
}

pub(crate) fn inspect_access() -> FirmwareAccess {
    let state = load().unwrap_or_else(|error| panic!("{error}"));
    FirmwareAccess {
        is_uefi: state.platform.uefi,
        is_elevated: state.platform.elevated,
        privilege_enabled: state.platform.uefi && state.platform.elevated,
    }
}

pub(crate) fn read_variable(name: &'static str) -> BackendResult<Option<Vec<u8>>> {
    read_variable_at(&machine_file_path()?, name)
}

fn read_variable_at(path: &Path, name: &str) -> BackendResult<Option<Vec<u8>>> {
    let state = load_from(path)?;
    state
        .firmware_variables
        .get(name)
        .and_then(Option::as_deref)
        .map(decode_variable)
        .transpose()
}

pub(crate) fn write_variable(name: &'static str, value: &[u8]) -> BackendResult<()> {
    write_variable_at(&machine_file_path()?, name, value)
}

fn write_variable_at(path: &Path, name: &str, value: &[u8]) -> BackendResult<()> {
    let mut state = load_from(path)?;
    let encoded = (!value.is_empty()).then(|| STANDARD.encode(value));
    state.firmware_variables.insert(name.to_owned(), encoded);
    store_at(path, &state)
}

pub(crate) fn relaunch_elevated() -> BackendResult<()> {
    Err(BackendError::Elevation(
        "elevation is not available on the simulated machine".into(),
    ))
}

pub(crate) fn current_boot_time_unix_ms() -> BackendResult<u64> {
    Ok(load_from(&machine_file_path()?)?.boot.boot_time_unix_ms)
}

pub(crate) fn ensure_reboot_available() -> BackendResult<PathBuf> {
    if load_from(&machine_file_path()?)?.platform.uefi {
        Ok(PathBuf::from(r"C:\Windows\System32\shutdown.exe"))
    } else {
        Err(BackendError::Deployment(
            "Windows reports legacy BIOS boot; a firmware UI reboot is unavailable".into(),
        ))
    }
}

pub(crate) fn execute_reboot(kind: RebootKind) -> BackendResult<()> {
    append_reboot_request_at(&machine_file_path()?, kind)
}

fn append_reboot_request_at(path: &Path, kind: RebootKind) -> BackendResult<()> {
    let mut state = load_from(path)?;
    let requested_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| simulated_error("the system clock predates the Unix epoch"))?
        .as_millis()
        .try_into()
        .map_err(|_| simulated_error("the system clock value is too large"))?;
    state.reboot_requests.push(RebootRequest {
        kind,
        requested_at_unix_ms,
    });
    store_at(path, &state)
}

pub(crate) fn capture_nvidia_smi() -> BackendResult<NvidiaSmiCapture> {
    capture_nvidia_smi_at(&machine_file_path()?)
}

fn capture_nvidia_smi_at(path: &Path) -> BackendResult<NvidiaSmiCapture> {
    let state = load_from(path)?;
    if !state.nvidia_smi.installed {
        return Err(BackendError::Deployment(
            "the NVIDIA driver did not install nvidia-smi.exe in the Windows system directory"
                .into(),
        ));
    }

    let mut xml = format!(
        "<?xml version=\"1.0\" ?>\n<nvidia_smi_log>\n  <timestamp>Sun Oct 25 00:00:00 2026</timestamp>\n  <driver_version>{}</driver_version>\n",
        xml_escape(&state.nvidia_smi.driver_version)
    );
    for gpu in &state.gpus {
        let framebuffer_mib = whole_mib(
            gpu.dedicated_video_memory_bytes,
            "dedicatedVideoMemoryBytes",
        )?;
        let bar1_mib = whole_mib(gpu.bar1_bytes, "bar1Bytes")?;
        let pci_bus_id = format!(
            "00000000:{:02X}:{:02X}.{}",
            gpu.location.bus, gpu.location.device, gpu.location.function
        );
        xml.push_str(&format!(
            "  <gpu id=\"{pci_bus_id}\">\n    <product_name>{}</product_name>\n    <pci><pci_bus_id>{pci_bus_id}</pci_bus_id></pci>\n    <fb_memory_usage><total>{framebuffer_mib} MiB</total><used>0 MiB</used><free>{framebuffer_mib} MiB</free></fb_memory_usage>\n    <bar1_memory_usage><total>{bar1_mib} MiB</total><used>0 MiB</used><free>{bar1_mib} MiB</free></bar1_memory_usage>\n  </gpu>\n",
            xml_escape(&gpu.name)
        ));
    }
    xml.push_str("</nvidia_smi_log>\n");

    Ok(NvidiaSmiCapture {
        executable: PathBuf::from(r"C:\Windows\System32\nvidia-smi.exe"),
        tool: FirmwareFingerprint {
            file_name: "nvidia-smi.exe".into(),
            byte_length: SIMULATED_NVIDIA_SMI.len() as u64,
            sha256: Sha256Digest::from_bytes(SIMULATED_NVIDIA_SMI),
        },
        xml: xml.into_bytes(),
    })
}

pub(crate) fn nvidia_driver_settings_unavailable<T>() -> BackendResult<T> {
    Err(BackendError::NvidiaDriverUnavailable(
        "NVIDIA driver settings are not available on the simulated machine".into(),
    ))
}

fn validate(state: &MachineFile) -> BackendResult<()> {
    if state.schema != MACHINE_SCHEMA {
        return Err(simulated_error(format!(
            "machine-file schema {} is unsupported; expected {MACHINE_SCHEMA}",
            state.schema
        )));
    }
    for gpu in &state.gpus {
        validate_location(gpu.location, "GPU")?;
        validate_location(gpu.bridge.location, "bridge")?;
        if gpu.bar0_base > gpu.bar0_top {
            return Err(simulated_error(format!(
                "{} has a BAR0 base above its top",
                gpu.name
            )));
        }
    }
    for (name, encoded) in &state.firmware_variables {
        if let Some(encoded) = encoded {
            decode_variable(encoded).map_err(|error| {
                simulated_error(format!(
                    "firmwareVariables.{name} is not standard base64: {error}"
                ))
            })?;
        }
    }
    Ok(())
}

fn validate_location(location: PciLocation, label: &str) -> BackendResult<()> {
    if location.device > 31 || location.function > 7 {
        return Err(simulated_error(format!(
            "{label} PCI location {:02X}:{:02X}.{} is outside the encoded range",
            location.bus, location.device, location.function
        )));
    }
    Ok(())
}

fn decode_variable(encoded: &str) -> BackendResult<Vec<u8>> {
    STANDARD
        .decode(encoded)
        .map_err(|error| simulated_error(format!("base64 decoding failed: {error}")))
}

fn whole_mib(bytes: u64, field: &str) -> BackendResult<u64> {
    if !bytes.is_multiple_of(MIB) {
        return Err(simulated_error(format!(
            "{field} must be a whole number of MiB for nvidia-smi evidence"
        )));
    }
    Ok(bytes / MIB)
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn missing_machine_path() -> BackendError {
    simulated_error(
        "the simulated build needs NVSTRAPS_SIMULATED_MACHINE set to an absolute machine-file path",
    )
}

fn simulated_error(message: impl Into<String>) -> BackendError {
    BackendError::Deployment(format!("simulated machine: {}", message.into()))
}

#[cfg(all(test, feature = "simulated-machine"))]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use nvstraps_deploy::{
        BoardPath, FirmwareInstallMethod, FirmwareInstallRoute, MachineProfile, RecoveryCapability,
        RecoveryMethod,
    };

    use super::*;
    use crate::firmware::{CONFIG_VARIABLE_NAME, STATUS_VARIABLE_NAME};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "nvstraps-simulated-machine-{}-{}",
                std::process::id(),
                TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn machine_file(&self) -> PathBuf {
            self.0.join("machine.json")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn state() -> MachineFile {
        MachineFile {
            schema: 1,
            platform: Platform {
                uefi: true,
                elevated: true,
            },
            boot: Boot {
                boot_time_unix_ms: 1_793_000_000_000,
            },
            identity: Identity {
                board_manufacturer: "Micro-Star International Co., Ltd.".into(),
                board_product: "MAG Z790 TOMAHAWK WIFI (MS-7D91)".into(),
                board_version: "1.0".into(),
                bios_vendor: "American Megatrends International, LLC.".into(),
                bios_version: "1.H0".into(),
                bios_release_date: "09/14/2026".into(),
            },
            gpus: vec![Gpu {
                name: "NVIDIA GeForce RTX 2080 SUPER".into(),
                vendor_id: 0x10de,
                device_id: 0x1e81,
                subsystem_vendor_id: 0x1462,
                subsystem_device_id: 0x3755,
                location: PciLocation {
                    bus: 1,
                    device: 0,
                    function: 0,
                },
                bridge: Bridge {
                    vendor_id: 0x8086,
                    device_id: 0xaa39,
                    location: PciLocation {
                        bus: 0,
                        device: 1,
                        function: 0,
                    },
                },
                bar0_base: 0x8000_0000,
                bar0_top: 0x80ff_ffff,
                bar1_bytes: 8 * 1024 * 1024 * 1024,
                dedicated_video_memory_bytes: 8 * 1024 * 1024 * 1024,
            }],
            firmware_variables: BTreeMap::from([
                (CONFIG_VARIABLE_NAME.into(), None),
                (STATUS_VARIABLE_NAME.into(), None),
            ]),
            nvidia_smi: NvidiaSmi {
                installed: true,
                driver_version: "596.36".into(),
            },
            reboot_requests: Vec::new(),
        }
    }

    fn write_state(directory: &TestDirectory) -> PathBuf {
        let path = directory.machine_file();
        store_at(&path, &state()).unwrap();
        path
    }

    #[test]
    fn machine_file_round_trips() {
        let directory = TestDirectory::new();
        let path = write_state(&directory);
        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded, state());
        store_at(&path, &loaded).unwrap();
        assert_eq!(load_from(&path).unwrap(), state());
    }

    #[test]
    fn schema_and_unknown_fields_are_rejected() {
        let directory = TestDirectory::new();
        let path = directory.machine_file();
        let mut value = serde_json::to_value(state()).unwrap();
        value["schema"] = 2.into();
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(
            load_from(&path)
                .unwrap_err()
                .to_string()
                .contains("schema 2")
        );

        value["schema"] = 1.into();
        value["platform"]["unexpected"] = true.into();
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(
            load_from(&path)
                .unwrap_err()
                .to_string()
                .contains("unknown field `unexpected`")
        );
    }

    #[test]
    fn variable_write_is_read_back_and_persisted() {
        let directory = TestDirectory::new();
        let path = write_state(&directory);
        let bytes = [0, 1, 2, 0xfc, 0xfd, 0xfe, 0xff];
        write_variable_at(&path, CONFIG_VARIABLE_NAME, &bytes).unwrap();
        assert_eq!(
            read_variable_at(&path, CONFIG_VARIABLE_NAME).unwrap(),
            Some(bytes.to_vec())
        );
        assert_eq!(
            load_from(&path).unwrap().firmware_variables[CONFIG_VARIABLE_NAME],
            Some(STANDARD.encode(bytes))
        );

        write_variable_at(&path, CONFIG_VARIABLE_NAME, &[]).unwrap();
        assert_eq!(read_variable_at(&path, CONFIG_VARIABLE_NAME).unwrap(), None);
        assert_eq!(
            load_from(&path).unwrap().firmware_variables[CONFIG_VARIABLE_NAME],
            None
        );
    }

    #[test]
    fn reboot_request_is_appended() {
        let directory = TestDirectory::new();
        let path = write_state(&directory);
        append_reboot_request_at(&path, RebootKind::FirmwareSetup).unwrap();
        append_reboot_request_at(&path, RebootKind::Configuration).unwrap();
        let requests = load_from(&path).unwrap().reboot_requests;
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].kind, RebootKind::FirmwareSetup);
        assert_eq!(requests[1].kind, RebootKind::Configuration);
        assert!(
            requests
                .iter()
                .all(|request| request.requested_at_unix_ms > 0)
        );
    }

    #[test]
    fn synthesized_nvidia_smi_xml_uses_the_machine_bar1_size() {
        let directory = TestDirectory::new();
        let path = write_state(&directory);
        let capture = capture_nvidia_smi_at(&path).unwrap();
        let parsed = crate::resizable_bar::nvidia_smi::decode_xml(&capture.xml).unwrap();
        assert_eq!(parsed.driver_version, "596.36");
        assert_eq!(parsed.gpu.len(), 1);
        assert_eq!(
            crate::resizable_bar::nvidia_smi::parse_memory_bytes(
                &parsed.gpu[0].bar1_memory_usage.total
            )
            .unwrap(),
            Some(state().gpus[0].bar1_bytes)
        );
        assert_eq!(
            capture.tool.sha256,
            Sha256Digest::from_bytes(SIMULATED_NVIDIA_SMI)
        );
    }

    #[test]
    fn simulated_inventory_and_identity_are_accepted_by_deploy() {
        let directory = TestDirectory::new();
        let path = write_state(&directory);
        let devices = enumerate_gpus_at(&path).unwrap();
        let identity = collect_machine_identity_at(&path, &devices).unwrap();
        let profile = MachineProfile::create(
            "simulated machine test",
            BoardPath::NativeResizableBar,
            identity,
            FirmwareFingerprint {
                file_name: "vendor.bin".into(),
                byte_length: 4,
                sha256: Sha256Digest::from_bytes(b"test"),
            },
            RecoveryCapability {
                method: RecoveryMethod::UsbFlashback,
                tested_or_documented: true,
                note: "documented recovery".into(),
            },
            FirmwareInstallRoute {
                method: FirmwareInstallMethod::FirmwareSetupUtility,
                artifact_file_name: "vendor.bin".into(),
                tested_or_documented: true,
                official_instructions_url: "https://vendor.invalid/manual".into(),
                note: "documented install route".into(),
            },
        )
        .unwrap();
        assert_eq!(profile.identity.bios_release_date, "2026-09-14");
        assert_eq!(devices[0].current_bar_size, state().gpus[0].bar1_bytes);
        assert_eq!(devices[0].recommended_bar_size_selector, Some(7));
    }
}
