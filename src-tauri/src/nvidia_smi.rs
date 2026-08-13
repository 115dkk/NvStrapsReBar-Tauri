use std::{
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use nvstraps_deploy::{FirmwareFingerprint, Sha256Digest};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::{
    deployment::load_exact_deployment,
    devices::GpuDevice,
    error::{ApiError, BackendError, BackendResult, CommandResult},
};

const NVIDIA_SMI_ARGUMENTS: [&str; 2] = ["-q", "-x"];
const NVIDIA_SMI_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CAPTURE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NvidiaSmiEvidence {
    pub profile_id: String,
    pub tool_path: String,
    pub tool: FirmwareFingerprint,
    pub raw_xml_sha256: Sha256Digest,
    pub driver_version: String,
    pub captured_at: String,
    pub gpus: Vec<NvidiaBar1Observation>,
    pub all_profile_gpus_observed: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NvidiaBar1Observation {
    pub pci_bus_id: String,
    pub product_name: String,
    pub bus: u8,
    pub device: u8,
    pub function: u8,
    pub framebuffer_total_bytes: Option<String>,
    pub bar1_total_bytes: Option<String>,
    pub bar1_used_bytes: Option<String>,
    pub bar1_free_bytes: Option<String>,
    pub matched_profile_gpu: bool,
    pub matches_windows_bar_size: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct NvidiaSmiLog {
    driver_version: String,
    timestamp: String,
    #[serde(default)]
    gpu: Vec<NvidiaSmiGpu>,
}

#[derive(Debug, Deserialize)]
struct NvidiaSmiGpu {
    product_name: String,
    pci: NvidiaSmiPci,
    fb_memory_usage: NvidiaSmiMemory,
    bar1_memory_usage: NvidiaSmiMemory,
}

#[derive(Debug, Deserialize)]
struct NvidiaSmiPci {
    pci_bus_id: String,
}

#[derive(Debug, Deserialize)]
struct NvidiaSmiMemory {
    total: String,
    used: String,
    free: String,
}

#[tauri::command]
pub async fn collect_nvidia_smi_evidence(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<NvidiaSmiEvidence> {
    tauri::async_runtime::spawn_blocking(move || collect_command(&app, &profile_id))
        .await
        .map_err(|error| {
            ApiError::from(BackendError::Deployment(format!(
                "nvidia-smi evidence worker failed: {error}"
            )))
        })?
        .map_err(ApiError::from)
}

fn collect_command(app: &AppHandle, profile_id: &str) -> BackendResult<NvidiaSmiEvidence> {
    let exact = load_exact_deployment(app, profile_id, "nvidia-smi evidence collection")?;
    let executable = nvidia_smi_path()?;
    let tool = FirmwareFingerprint::inspect(&executable)?;
    let xml = run_nvidia_smi(&executable)?;
    build_evidence(
        exact.profile.profile_id,
        executable,
        tool,
        &xml,
        &exact.devices,
    )
}

fn build_evidence(
    profile_id: String,
    executable: PathBuf,
    tool: FirmwareFingerprint,
    xml: &[u8],
    devices: &[GpuDevice],
) -> BackendResult<NvidiaSmiEvidence> {
    let text = std::str::from_utf8(xml).map_err(|error| {
        BackendError::Deployment(format!("nvidia-smi XML is not valid UTF-8: {error}"))
    })?;
    let parsed: NvidiaSmiLog = quick_xml::de::from_str(text).map_err(|error| {
        BackendError::Deployment(format!("nvidia-smi XML could not be decoded: {error}"))
    })?;
    if parsed.gpu.is_empty() {
        return Err(BackendError::Deployment(
            "nvidia-smi returned no GPU observations".into(),
        ));
    }

    let mut warnings = Vec::new();
    let mut observations = Vec::with_capacity(parsed.gpu.len());
    for gpu in parsed.gpu {
        let (bus, device, function) = parse_pci_bus_id(&gpu.pci.pci_bus_id)?;
        let windows_gpu = devices.iter().find(|candidate| {
            candidate.bus == bus && candidate.device == device && candidate.function == function
        });
        let framebuffer_total = parse_memory_bytes(&gpu.fb_memory_usage.total)?;
        let bar1_total = parse_memory_bytes(&gpu.bar1_memory_usage.total)?;
        let bar1_used = parse_memory_bytes(&gpu.bar1_memory_usage.used)?;
        let bar1_free = parse_memory_bytes(&gpu.bar1_memory_usage.free)?;
        if let (Some(total), Some(used), Some(free)) = (bar1_total, bar1_used, bar1_free)
            && used.checked_add(free) != Some(total)
        {
            warnings.push(format!(
                "{} reported BAR1 total that does not equal used plus free",
                gpu.pci.pci_bus_id
            ));
        }
        if windows_gpu.is_none() {
            warnings.push(format!(
                "{} was reported by nvidia-smi but not by the Windows PCI inventory",
                gpu.pci.pci_bus_id
            ));
        }
        let matches_windows_bar_size = windows_gpu
            .and_then(|candidate| bar1_total.map(|total| candidate.current_bar_size == total));
        if matches_windows_bar_size == Some(false) {
            warnings.push(format!(
                "{} BAR1 total disagrees with the Windows PCI resource size",
                gpu.pci.pci_bus_id
            ));
        }
        observations.push(NvidiaBar1Observation {
            pci_bus_id: gpu.pci.pci_bus_id,
            product_name: gpu.product_name,
            bus,
            device,
            function,
            framebuffer_total_bytes: decimal(framebuffer_total),
            bar1_total_bytes: decimal(bar1_total),
            bar1_used_bytes: decimal(bar1_used),
            bar1_free_bytes: decimal(bar1_free),
            matched_profile_gpu: windows_gpu.is_some(),
            matches_windows_bar_size,
        });
    }
    observations.sort_by_key(|gpu| (gpu.bus, gpu.device, gpu.function));
    let all_profile_gpus_observed = devices.iter().all(|device| {
        observations.iter().any(|observation| {
            observation.bus == device.bus
                && observation.device == device.device
                && observation.function == device.function
        })
    });
    if !all_profile_gpus_observed {
        warnings.push("nvidia-smi did not report every GPU pinned by the machine profile".into());
    }

    Ok(NvidiaSmiEvidence {
        profile_id,
        tool_path: executable.to_string_lossy().into_owned(),
        tool,
        raw_xml_sha256: Sha256Digest::from_bytes(xml),
        driver_version: parsed.driver_version,
        captured_at: parsed.timestamp,
        gpus: observations,
        all_profile_gpus_observed,
        warnings,
    })
}

fn decimal(value: Option<u64>) -> Option<String> {
    value.map(|value| value.to_string())
}

fn parse_memory_bytes(value: &str) -> BackendResult<Option<u64>> {
    let value = value.trim();
    if value.eq_ignore_ascii_case("N/A") {
        return Ok(None);
    }
    let mut parts = value.split_whitespace();
    let amount = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| {
            BackendError::Deployment(format!("nvidia-smi memory value is malformed: {value}"))
        })?;
    let multiplier = match parts.next() {
        Some("B") => 1,
        Some("KiB") => 1024,
        Some("MiB") => 1024 * 1024,
        Some("GiB") => 1024 * 1024 * 1024,
        _ => {
            return Err(BackendError::Deployment(format!(
                "nvidia-smi memory unit is unsupported: {value}"
            )));
        }
    };
    if parts.next().is_some() {
        return Err(BackendError::Deployment(format!(
            "nvidia-smi memory value has trailing data: {value}"
        )));
    }
    amount
        .checked_mul(multiplier)
        .map(Some)
        .ok_or_else(|| BackendError::Deployment("nvidia-smi memory value overflowed".into()))
}

fn parse_pci_bus_id(value: &str) -> BackendResult<(u8, u8, u8)> {
    let parts: Vec<_> = value.trim().split(':').collect();
    if parts.len() < 2 {
        return Err(BackendError::Deployment(format!(
            "nvidia-smi PCI bus ID is malformed: {value}"
        )));
    }
    let bus = u8::from_str_radix(parts[parts.len() - 2], 16).map_err(|_| {
        BackendError::Deployment(format!("nvidia-smi PCI bus ID is malformed: {value}"))
    })?;
    let (device, function) = parts[parts.len() - 1].split_once('.').ok_or_else(|| {
        BackendError::Deployment(format!("nvidia-smi PCI bus ID is malformed: {value}"))
    })?;
    let device = u8::from_str_radix(device, 16).map_err(|_| {
        BackendError::Deployment(format!("nvidia-smi PCI bus ID is malformed: {value}"))
    })?;
    let function = u8::from_str_radix(function, 16).map_err(|_| {
        BackendError::Deployment(format!("nvidia-smi PCI bus ID is malformed: {value}"))
    })?;
    if device > 31 || function > 7 {
        return Err(BackendError::Deployment(format!(
            "nvidia-smi PCI bus ID is outside the encoded range: {value}"
        )));
    }
    Ok((bus, device, function))
}

#[cfg(windows)]
fn nvidia_smi_path() -> BackendResult<PathBuf> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};

    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

    let mut buffer = [0_u16; 32_768];
    // SAFETY: the buffer is writable and its capacity is passed exactly.
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 {
        return Err(BackendError::windows("GetSystemDirectoryW"));
    }
    if length >= buffer.len() {
        return Err(BackendError::Deployment(
            "Windows system directory path exceeded the guarded buffer".into(),
        ));
    }
    let path = PathBuf::from(OsString::from_wide(&buffer[..length])).join("nvidia-smi.exe");
    if !path.is_file() {
        return Err(BackendError::Deployment(
            "the NVIDIA driver did not install nvidia-smi.exe in the Windows system directory"
                .into(),
        ));
    }
    Ok(path)
}

#[cfg(not(windows))]
fn nvidia_smi_path() -> BackendResult<PathBuf> {
    Err(BackendError::UnsupportedPlatform)
}

#[cfg(windows)]
fn run_nvidia_smi(executable: &std::path::Path) -> BackendResult<Vec<u8>> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut child = Command::new(executable)
        .args(NVIDIA_SMI_ARGUMENTS)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            BackendError::Deployment(format!("failed to start nvidia-smi: {error}"))
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| BackendError::Deployment("nvidia-smi stdout pipe was unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| BackendError::Deployment("nvidia-smi stderr pipe was unavailable".into()))?;
    let stdout_reader = thread::spawn(move || read_limited(stdout));
    let stderr_reader = thread::spawn(move || read_limited(stderr));

    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| {
            BackendError::Deployment(format!("nvidia-smi process status failed: {error}"))
        })? {
            break status;
        }
        if started.elapsed() >= NVIDIA_SMI_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(BackendError::Deployment(
                "nvidia-smi exceeded the 10-second evidence timeout".into(),
            ));
        }
        thread::sleep(Duration::from_millis(25));
    };
    let stdout = join_reader(stdout_reader, "stdout")?;
    let stderr = join_reader(stderr_reader, "stderr")?;
    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr);
        let diagnostic: String = stderr.chars().take(1024).collect();
        return Err(BackendError::Deployment(format!(
            "nvidia-smi failed with exit code {}: {}",
            status
                .code()
                .map_or_else(|| "unknown".into(), |code| code.to_string()),
            diagnostic.trim()
        )));
    }
    Ok(stdout)
}

#[cfg(not(windows))]
fn run_nvidia_smi(_executable: &std::path::Path) -> BackendResult<Vec<u8>> {
    Err(BackendError::UnsupportedPlatform)
}

fn read_limited(reader: impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(MAX_CAPTURE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CAPTURE_BYTES {
        return Err(std::io::Error::other(
            "nvidia-smi output exceeded the 8 MiB limit",
        ));
    }
    Ok(bytes)
}

fn join_reader(
    reader: thread::JoinHandle<std::io::Result<Vec<u8>>>,
    stream: &str,
) -> BackendResult<Vec<u8>> {
    reader
        .join()
        .map_err(|_| BackendError::Deployment(format!("nvidia-smi {stream} reader panicked")))?
        .map_err(|error| {
            BackendError::Deployment(format!("nvidia-smi {stream} capture failed: {error}"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &str = r#"<?xml version="1.0" ?>
<!DOCTYPE nvidia_smi_log SYSTEM "nvsmi_device_v13.dtd">
<nvidia_smi_log>
  <timestamp>Fri Aug 14 02:00:00 2026</timestamp>
  <driver_version>596.36</driver_version>
  <gpu id="00000000:01:00.0">
    <product_name>NVIDIA GeForce RTX 2080 SUPER</product_name>
    <pci><pci_bus_id>00000000:01:00.0</pci_bus_id></pci>
    <fb_memory_usage><total>8192 MiB</total><used>1 MiB</used><free>8191 MiB</free></fb_memory_usage>
    <bar1_memory_usage><total>8192 MiB</total><used>8165 MiB</used><free>27 MiB</free></bar1_memory_usage>
  </gpu>
</nvidia_smi_log>"#;

    #[test]
    fn xml_parser_extracts_bar1_and_matches_the_windows_pci_inventory() {
        let device = GpuDevice {
            id: "gpu".into(),
            name: "RTX 2080 SUPER".into(),
            vendor_id: 0x10de,
            device_id: 0x1e81,
            subsystem_vendor_id: 0x1462,
            subsystem_device_id: 0x3755,
            bus: 1,
            device: 0,
            function: 0,
            bridge: crate::devices::PciBridge {
                vendor_id: 0x8086,
                device_id: 0x460d,
                bus: 0,
                device: 1,
                function: 0,
            },
            bar0_base: 0x8000_0000,
            bar0_top: 0x80ff_ffff,
            current_bar_size: 8 * 1024 * 1024 * 1024,
            dedicated_video_memory: 8 * 1024 * 1024 * 1024,
            is_turing: true,
            recommended_bar_size_selector: Some(7),
            effective_bar_size_selector: Some(7),
        };
        let tool = FirmwareFingerprint {
            file_name: "nvidia-smi.exe".into(),
            byte_length: 1,
            sha256: Sha256Digest::from_bytes(b"tool"),
        };
        let evidence = build_evidence(
            "nvstraps-0123456789abcdef01234567".into(),
            PathBuf::from(r"C:\Windows\System32\nvidia-smi.exe"),
            tool,
            XML.as_bytes(),
            &[device],
        )
        .unwrap();
        assert_eq!(evidence.driver_version, "596.36");
        assert!(evidence.all_profile_gpus_observed);
        assert!(evidence.warnings.is_empty());
        assert_eq!(
            evidence.gpus[0].bar1_total_bytes.as_deref(),
            Some("8589934592")
        );
        assert_eq!(evidence.gpus[0].matches_windows_bar_size, Some(true));
    }

    #[test]
    fn parser_handles_unavailable_memory_and_rejects_invalid_pci_locations() {
        assert_eq!(parse_memory_bytes("N/A").unwrap(), None);
        assert_eq!(parse_memory_bytes("2 GiB").unwrap(), Some(2_147_483_648));
        assert!(parse_memory_bytes("2 GB").is_err());
        assert_eq!(parse_pci_bus_id("00000000:01:00.0").unwrap(), (1, 0, 0));
        assert!(parse_pci_bus_id("00000000:01:20.0").is_err());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "read-only hardware smoke test for a machine with an NVIDIA driver"]
    fn installed_nvidia_smi_xml_matches_the_guarded_contract() {
        let executable = nvidia_smi_path().unwrap();
        let xml = run_nvidia_smi(&executable).unwrap();
        let text = std::str::from_utf8(&xml).unwrap();
        let parsed: NvidiaSmiLog = quick_xml::de::from_str(text).unwrap();
        assert!(!parsed.driver_version.is_empty());
        assert!(!parsed.gpu.is_empty());
        for gpu in parsed.gpu {
            parse_pci_bus_id(&gpu.pci.pci_bus_id).unwrap();
            assert!(
                parse_memory_bytes(&gpu.bar1_memory_usage.total)
                    .unwrap()
                    .is_some()
            );
        }
    }
}
