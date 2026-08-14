use std::{
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use nvstraps_deploy::FirmwareFingerprint;
use serde::Deserialize;

use crate::error::{BackendError, BackendResult};

const NVIDIA_SMI_ARGUMENTS: [&str; 2] = ["-q", "-x"];
const NVIDIA_SMI_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CAPTURE_BYTES: u64 = 8 * 1024 * 1024;

pub(super) struct NvidiaSmiCapture {
    pub(super) executable: PathBuf,
    pub(super) tool: FirmwareFingerprint,
    pub(super) xml: Vec<u8>,
}

#[derive(Debug, Deserialize)]
pub(super) struct NvidiaSmiLog {
    pub(super) driver_version: String,
    pub(super) timestamp: String,
    #[serde(default)]
    pub(super) gpu: Vec<NvidiaSmiGpu>,
}

#[derive(Debug, Deserialize)]
pub(super) struct NvidiaSmiGpu {
    pub(super) product_name: String,
    pub(super) pci: NvidiaSmiPci,
    pub(super) fb_memory_usage: NvidiaSmiMemory,
    pub(super) bar1_memory_usage: NvidiaSmiMemory,
}

#[derive(Debug, Deserialize)]
pub(super) struct NvidiaSmiPci {
    pub(super) pci_bus_id: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct NvidiaSmiMemory {
    pub(super) total: String,
    pub(super) used: String,
    pub(super) free: String,
}

pub(super) fn capture() -> BackendResult<NvidiaSmiCapture> {
    let executable = nvidia_smi_path()?;
    let tool = FirmwareFingerprint::inspect(&executable)?;
    let xml = run_nvidia_smi(&executable)?;
    Ok(NvidiaSmiCapture {
        executable,
        tool,
        xml,
    })
}

pub(super) fn decode_xml(xml: &[u8]) -> BackendResult<NvidiaSmiLog> {
    let text = std::str::from_utf8(xml).map_err(|error| {
        BackendError::Deployment(format!("nvidia-smi XML is not valid UTF-8: {error}"))
    })?;
    quick_xml::de::from_str(text).map_err(|error| {
        BackendError::Deployment(format!("nvidia-smi XML could not be decoded: {error}"))
    })
}

pub(super) fn parse_memory_bytes(value: &str) -> BackendResult<Option<u64>> {
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

pub(super) fn parse_pci_bus_id(value: &str) -> BackendResult<(u8, u8, u8)> {
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
        let parsed = decode_xml(&xml).unwrap();
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
