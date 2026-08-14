mod assessment;
mod nvidia_smi;

use nvstraps_deploy::{FirmwareFingerprint, Sha256Digest};
use serde::Serialize;

use crate::{devices::GpuDevice, error::BackendResult};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ResizableBarApertureState {
    Expanded,
    Legacy256MiB,
    Indeterminate,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizableBarGpuInspection {
    pub pci_bus_id: String,
    pub product_name: String,
    pub bar1_total_bytes: Option<String>,
    pub windows_bar_size_bytes: String,
    pub state: ResizableBarApertureState,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizableBarInspection {
    pub driver_version: String,
    pub captured_at: String,
    pub state: ResizableBarApertureState,
    pub gpus: Vec<ResizableBarGpuInspection>,
    pub warnings: Vec<String>,
}

pub fn observe_current_apertures(devices: &[GpuDevice]) -> BackendResult<ResizableBarInspection> {
    let capture = nvidia_smi::capture()?;
    let evidence = assessment::build_evidence(String::new(), capture, devices)?;
    Ok(assessment::build_inspection(&evidence, devices))
}

pub fn collect_exact_profile_evidence(
    profile_id: String,
    devices: &[GpuDevice],
) -> BackendResult<NvidiaSmiEvidence> {
    let capture = nvidia_smi::capture()?;
    let evidence = assessment::build_evidence(profile_id, capture, devices)?;
    assessment::require_resizable_bar_proof(&evidence, devices)?;
    Ok(evidence)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    #[ignore = "read-only hardware inspection of the current Windows NVIDIA GPU"]
    fn current_machine_resizable_bar_inspection_reports_observed_state() {
        let devices = crate::devices::enumerate_gpus().expect("enumerate current NVIDIA GPUs");
        let inspection =
            observe_current_apertures(&devices).expect("inspect the current Windows NVIDIA GPU");
        println!(
            "{}",
            serde_json::to_string_pretty(&inspection).expect("serialize inspection")
        );
    }
}
