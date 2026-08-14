use nvstraps_core::registry::{
    BAR_SIZE_EXCLUDED, MAX_BAR_SIZE_SELECTOR, automatic_bar_size, bar_size_bytes, is_turing,
    registry_bar_size,
};
use nvstraps_deploy::Sha256Digest;

use super::{
    NvidiaBar1Observation, NvidiaSmiEvidence, PatchConfigurationAssessment,
    PatchConfigurationReasonCode, PatchConfigurationState, ResizableBarApertureState,
    ResizableBarGpuInspection, ResizableBarInspection,
    nvidia_smi::{NvidiaSmiCapture, decode_xml, parse_memory_bytes, parse_pci_bus_id},
};
use crate::{
    config::validate_dxe_bar0,
    devices::GpuDevice,
    error::{BackendError, BackendResult},
};

#[derive(Clone, Copy)]
enum EvidencePurpose {
    CurrentInventory,
    ExactProfile,
}

pub(super) fn build_current_inventory_evidence(
    capture: NvidiaSmiCapture,
    devices: &[GpuDevice],
) -> BackendResult<NvidiaSmiEvidence> {
    build_evidence(
        String::new(),
        capture,
        devices,
        EvidencePurpose::CurrentInventory,
    )
}

pub(super) fn build_exact_profile_evidence(
    profile_id: String,
    capture: NvidiaSmiCapture,
    devices: &[GpuDevice],
) -> BackendResult<NvidiaSmiEvidence> {
    build_evidence(profile_id, capture, devices, EvidencePurpose::ExactProfile)
}

fn build_evidence(
    profile_id: String,
    capture: NvidiaSmiCapture,
    devices: &[GpuDevice],
    purpose: EvidencePurpose,
) -> BackendResult<NvidiaSmiEvidence> {
    let parsed = decode_xml(&capture.xml)?;
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
    if observations.windows(2).any(|pair| {
        (pair[0].bus, pair[0].device, pair[0].function)
            == (pair[1].bus, pair[1].device, pair[1].function)
    }) {
        return Err(BackendError::Deployment(
            "nvidia-smi returned duplicate observations for one PCI location".into(),
        ));
    }
    let all_profile_gpus_observed = devices.iter().all(|device| {
        observations.iter().any(|observation| {
            observation.bus == device.bus
                && observation.device == device.device
                && observation.function == device.function
        })
    });
    if !all_profile_gpus_observed {
        warnings.push(match purpose {
            EvidencePurpose::CurrentInventory => {
                "nvidia-smi did not report every current NVIDIA GPU in the Windows PCI inventory"
                    .into()
            }
            EvidencePurpose::ExactProfile => {
                "nvidia-smi did not report every GPU pinned by the machine profile".into()
            }
        });
    }

    Ok(NvidiaSmiEvidence {
        profile_id,
        tool_path: capture.executable.to_string_lossy().into_owned(),
        tool: capture.tool,
        raw_xml_sha256: Sha256Digest::from_bytes(&capture.xml),
        driver_version: parsed.driver_version,
        captured_at: parsed.timestamp,
        gpus: observations,
        all_profile_gpus_observed,
        warnings,
    })
}

pub(super) fn require_resizable_bar_proof(
    evidence: &NvidiaSmiEvidence,
    devices: &[GpuDevice],
) -> BackendResult<()> {
    if !evidence.all_profile_gpus_observed {
        return Err(BackendError::Deployment(
            "nvidia-smi did not observe every GPU pinned by the exact machine profile".into(),
        ));
    }
    for device in devices {
        let observation = evidence.gpus.iter().find(|observation| {
            observation.bus == device.bus
                && observation.device == device.device
                && observation.function == device.function
        });
        let inspection = classify_aperture(device, observation);
        if inspection.state != ResizableBarApertureState::Expanded {
            return Err(BackendError::Deployment(format!(
                "{}: {}",
                inspection.pci_bus_id, inspection.reason
            )));
        }
    }
    Ok(())
}

pub(super) fn build_inspection(
    evidence: &NvidiaSmiEvidence,
    devices: &[GpuDevice],
) -> ResizableBarInspection {
    let mut gpus: Vec<_> = devices
        .iter()
        .filter(|device| is_turing(device.device_id))
        .map(|device| {
            let observation = evidence.gpus.iter().find(|observation| {
                observation.bus == device.bus
                    && observation.device == device.device
                    && observation.function == device.function
            });
            classify_aperture(device, observation)
        })
        .collect();
    gpus.sort_by_key(|gpu| gpu.pci_bus_id.clone());

    let state = aggregate_aperture_state(gpus.iter().map(|gpu| gpu.state));

    let mut warnings = evidence.warnings.clone();
    if gpus.is_empty() {
        warnings.push("No current NVIDIA Turing GPU was found in the Windows PCI inventory".into());
    }
    ResizableBarInspection {
        driver_version: evidence.driver_version.clone(),
        captured_at: evidence.captured_at.clone(),
        state,
        gpus,
        warnings,
    }
}

fn aggregate_aperture_state(
    states: impl IntoIterator<Item = ResizableBarApertureState>,
) -> ResizableBarApertureState {
    let mut saw_any = false;
    let mut saw_expanded = false;
    let mut saw_legacy = false;
    for state in states {
        saw_any = true;
        match state {
            ResizableBarApertureState::Expanded => saw_expanded = true,
            ResizableBarApertureState::Legacy256MiB => saw_legacy = true,
            ResizableBarApertureState::Mixed | ResizableBarApertureState::Indeterminate => {
                return ResizableBarApertureState::Indeterminate;
            }
        }
    }
    match (saw_any, saw_expanded, saw_legacy) {
        (true, true, false) => ResizableBarApertureState::Expanded,
        (true, false, true) => ResizableBarApertureState::Legacy256MiB,
        (true, true, true) => ResizableBarApertureState::Mixed,
        _ => ResizableBarApertureState::Indeterminate,
    }
}

fn classify_aperture(
    device: &GpuDevice,
    observation: Option<&NvidiaBar1Observation>,
) -> ResizableBarGpuInspection {
    const LEGACY_BAR1_BYTES: u64 = 256 * 1024 * 1024;
    let location = format!(
        "00000000:{:02X}:{:02X}.{}",
        device.bus, device.device, device.function
    );
    let windows_bar_size_bytes = device.current_bar_size.to_string();
    let Some(observation) = observation else {
        return gpu_inspection(
            device,
            location,
            device.name.clone(),
            None,
            windows_bar_size_bytes,
            ResizableBarApertureState::Indeterminate,
            "nvidia-smi did not report this Windows Turing GPU".into(),
        );
    };
    let indeterminate = |reason: String| {
        gpu_inspection(
            device,
            observation.pci_bus_id.clone(),
            observation.product_name.clone(),
            observation.bar1_total_bytes.clone(),
            windows_bar_size_bytes.clone(),
            ResizableBarApertureState::Indeterminate,
            reason,
        )
    };
    let parse = |value: Option<&str>, field: &str| {
        value
            .ok_or_else(|| format!("BAR1 {field} is unavailable"))?
            .parse::<u64>()
            .map_err(|_| format!("BAR1 {field} is not a canonical byte count"))
    };
    let total = match parse(observation.bar1_total_bytes.as_deref(), "total") {
        Ok(value) => value,
        Err(reason) => return indeterminate(reason),
    };
    let used = match parse(observation.bar1_used_bytes.as_deref(), "used") {
        Ok(value) => value,
        Err(reason) => return indeterminate(reason),
    };
    let free = match parse(observation.bar1_free_bytes.as_deref(), "free") {
        Ok(value) => value,
        Err(reason) => return indeterminate(reason),
    };
    if used.checked_add(free) != Some(total) {
        return indeterminate("BAR1 total does not equal used plus free".into());
    }
    if observation.matches_windows_bar_size != Some(true) || total != device.current_bar_size {
        return indeterminate(
            "BAR1 does not match the independent Windows PCI resource observation".into(),
        );
    }
    let (state, reason) = if total > LEGACY_BAR1_BYTES {
        (
            ResizableBarApertureState::Expanded,
            "BAR1 is larger than the legacy 256 MiB window and matches Windows".into(),
        )
    } else if total == LEGACY_BAR1_BYTES {
        (
            ResizableBarApertureState::Legacy256MiB,
            "BAR1 is the legacy 256 MiB window".into(),
        )
    } else {
        return indeterminate("BAR1 is smaller than the legacy 256 MiB window".into());
    };
    gpu_inspection(
        device,
        observation.pci_bus_id.clone(),
        observation.product_name.clone(),
        observation.bar1_total_bytes.clone(),
        windows_bar_size_bytes,
        state,
        reason,
    )
}

fn gpu_inspection(
    device: &GpuDevice,
    pci_bus_id: String,
    product_name: String,
    bar1_total_bytes: Option<String>,
    windows_bar_size_bytes: String,
    state: ResizableBarApertureState,
    reason: String,
) -> ResizableBarGpuInspection {
    ResizableBarGpuInspection {
        pci_bus_id,
        product_name,
        bar1_total_bytes,
        windows_bar_size_bytes,
        state,
        reason,
        patch_configuration: assess_patch_configuration(device, state),
    }
}

fn assess_patch_configuration(
    device: &GpuDevice,
    aperture_state: ResizableBarApertureState,
) -> PatchConfigurationAssessment {
    let empty = |state, reason_code| PatchConfigurationAssessment {
        state,
        reason_code,
        target_selector: None,
        target_size_bytes: None,
    };
    match aperture_state {
        ResizableBarApertureState::Expanded => empty(
            PatchConfigurationState::NotNeeded,
            PatchConfigurationReasonCode::AlreadyExpanded,
        ),
        ResizableBarApertureState::Indeterminate | ResizableBarApertureState::Mixed => empty(
            PatchConfigurationState::Indeterminate,
            PatchConfigurationReasonCode::ApertureIndeterminate,
        ),
        ResizableBarApertureState::Legacy256MiB => {
            if registry_bar_size(device.device_id) == Some(BAR_SIZE_EXCLUDED) {
                return empty(
                    PatchConfigurationState::Unavailable,
                    PatchConfigurationReasonCode::RegistryExcluded,
                );
            }
            let Some(selector) = automatic_bar_size(device.device_id) else {
                return empty(
                    PatchConfigurationState::Indeterminate,
                    PatchConfigurationReasonCode::ApertureIndeterminate,
                );
            };
            if selector > MAX_BAR_SIZE_SELECTOR {
                return empty(
                    PatchConfigurationState::Indeterminate,
                    PatchConfigurationReasonCode::ApertureIndeterminate,
                );
            }
            if validate_dxe_bar0(device).is_err() {
                return empty(
                    PatchConfigurationState::Unavailable,
                    PatchConfigurationReasonCode::UnusableBar0,
                );
            }
            let Some(target_size_bytes) = bar_size_bytes(selector) else {
                return empty(
                    PatchConfigurationState::Indeterminate,
                    PatchConfigurationReasonCode::ApertureIndeterminate,
                );
            };
            PatchConfigurationAssessment {
                state: PatchConfigurationState::Available,
                reason_code: PatchConfigurationReasonCode::AutomaticTargetAvailable,
                target_selector: Some(selector),
                target_size_bytes: Some(target_size_bytes.to_string()),
            }
        }
    }
}

fn decimal(value: Option<u64>) -> Option<String> {
    value.map(|value| value.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use nvstraps_deploy::FirmwareFingerprint;

    use super::*;
    use crate::devices::PciBridge;

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

    fn test_gpu(bus: u8, current_bar_size: u64) -> GpuDevice {
        GpuDevice {
            id: format!("gpu-{bus}"),
            name: format!("RTX at bus {bus}"),
            vendor_id: 0x10de,
            device_id: 0x1e81,
            subsystem_vendor_id: 0x1462,
            subsystem_device_id: 0x3755,
            bus,
            device: 0,
            function: 0,
            bridge: PciBridge {
                vendor_id: 0x8086,
                device_id: 0x460d,
                bus: 0,
                device: bus,
                function: 0,
            },
            bar0_base: 0x8000_0000,
            bar0_top: 0x80ff_ffff,
            current_bar_size,
            dedicated_video_memory: 8 * 1024 * 1024 * 1024,
            is_turing: true,
            recommended_bar_size_selector: Some(7),
            effective_bar_size_selector: Some(7),
        }
    }

    fn observation(
        bus: u8,
        total: Option<u64>,
        used: Option<u64>,
        free: Option<u64>,
        matches_windows: Option<bool>,
    ) -> NvidiaBar1Observation {
        NvidiaBar1Observation {
            pci_bus_id: format!("00000000:{bus:02X}:00.0"),
            product_name: format!("RTX at bus {bus}"),
            bus,
            device: 0,
            function: 0,
            framebuffer_total_bytes: Some((8_u64 * 1024 * 1024 * 1024).to_string()),
            bar1_total_bytes: total.map(|value| value.to_string()),
            bar1_used_bytes: used.map(|value| value.to_string()),
            bar1_free_bytes: free.map(|value| value.to_string()),
            matched_profile_gpu: true,
            matches_windows_bar_size: matches_windows,
        }
    }

    fn evidence(gpus: Vec<NvidiaBar1Observation>) -> NvidiaSmiEvidence {
        NvidiaSmiEvidence {
            profile_id: String::new(),
            tool_path: "nvidia-smi.exe".into(),
            tool: tool(),
            raw_xml_sha256: Sha256Digest::from_bytes(b"xml"),
            driver_version: "596.36".into(),
            captured_at: "Fri Aug 14 02:00:00 2026".into(),
            gpus,
            all_profile_gpus_observed: true,
            warnings: Vec::new(),
        }
    }

    fn tool() -> FirmwareFingerprint {
        FirmwareFingerprint {
            file_name: "nvidia-smi.exe".into(),
            byte_length: 1,
            sha256: Sha256Digest::from_bytes(b"tool"),
        }
    }

    fn capture(xml: &str) -> NvidiaSmiCapture {
        NvidiaSmiCapture {
            executable: PathBuf::from(r"C:\Windows\System32\nvidia-smi.exe"),
            tool: tool(),
            xml: xml.as_bytes().to_vec(),
        }
    }

    #[test]
    fn inspection_classifies_expanded_and_exact_legacy_apertures() {
        const LEGACY: u64 = 256 * 1024 * 1024;
        const EXPANDED: u64 = 8 * 1024 * 1024 * 1024;
        let expanded = classify_aperture(
            &test_gpu(1, EXPANDED),
            Some(&observation(
                1,
                Some(EXPANDED),
                Some(1),
                Some(EXPANDED - 1),
                Some(true),
            )),
        );
        assert_eq!(expanded.state, ResizableBarApertureState::Expanded);
        assert_eq!(
            expanded.patch_configuration.state,
            PatchConfigurationState::NotNeeded
        );
        assert_eq!(
            expanded.patch_configuration.reason_code,
            PatchConfigurationReasonCode::AlreadyExpanded
        );
        let legacy = classify_aperture(
            &test_gpu(2, LEGACY),
            Some(&observation(
                2,
                Some(LEGACY),
                Some(0),
                Some(LEGACY),
                Some(true),
            )),
        );
        assert_eq!(legacy.state, ResizableBarApertureState::Legacy256MiB);
        assert_eq!(
            legacy.patch_configuration.state,
            PatchConfigurationState::Available
        );
        assert_eq!(
            legacy.patch_configuration.reason_code,
            PatchConfigurationReasonCode::AutomaticTargetAvailable
        );
        assert_eq!(legacy.patch_configuration.target_selector, Some(7));
        assert_eq!(
            legacy.patch_configuration.target_size_bytes.as_deref(),
            Some("8589934592")
        );
    }

    #[test]
    fn aggregate_state_is_complete_and_order_independent() {
        use ResizableBarApertureState::{Expanded, Indeterminate, Legacy256MiB, Mixed};

        assert_eq!(aggregate_aperture_state([]), Indeterminate);
        assert_eq!(aggregate_aperture_state([Expanded, Expanded]), Expanded);
        assert_eq!(
            aggregate_aperture_state([Legacy256MiB, Legacy256MiB]),
            Legacy256MiB
        );
        assert_eq!(aggregate_aperture_state([Expanded, Legacy256MiB]), Mixed);
        assert_eq!(aggregate_aperture_state([Legacy256MiB, Expanded]), Mixed);
        assert_eq!(
            aggregate_aperture_state([Legacy256MiB, Indeterminate]),
            Indeterminate
        );
        for states in [
            [Expanded, Legacy256MiB, Indeterminate],
            [Expanded, Indeterminate, Legacy256MiB],
            [Legacy256MiB, Expanded, Indeterminate],
            [Indeterminate, Expanded, Legacy256MiB],
            [Indeterminate, Legacy256MiB, Expanded],
            [Legacy256MiB, Indeterminate, Expanded],
        ] {
            assert_eq!(aggregate_aperture_state(states), Indeterminate);
        }
    }

    #[test]
    fn target_gpu_selection_uses_the_canonical_registry_identity() {
        const EXPANDED: u64 = 8 * 1024 * 1024 * 1024;
        let mut canonical_turing = test_gpu(1, EXPANDED);
        canonical_turing.is_turing = false;
        let mut non_turing = test_gpu(2, EXPANDED);
        non_turing.device_id = 0x2684;
        non_turing.is_turing = true;
        let mut registry_excluded = test_gpu(3, EXPANDED);
        registry_excluded.device_id = 0x1e30;
        let inspection = build_inspection(
            &evidence(vec![
                observation(1, Some(EXPANDED), Some(0), Some(EXPANDED), Some(true)),
                observation(2, Some(EXPANDED), Some(0), Some(EXPANDED), Some(true)),
                observation(3, Some(EXPANDED), Some(0), Some(EXPANDED), Some(true)),
            ]),
            &[canonical_turing, non_turing, registry_excluded],
        );
        assert_eq!(inspection.gpus.len(), 2);
        assert_eq!(inspection.gpus[0].pci_bus_id, "00000000:01:00.0");
        assert_eq!(inspection.gpus[1].pci_bus_id, "00000000:03:00.0");
    }

    #[test]
    fn legacy_patch_configuration_reports_exclusion_and_unusable_bar0() {
        const LEGACY: u64 = 256 * 1024 * 1024;
        let mut excluded = test_gpu(1, LEGACY);
        excluded.device_id = 0x1e30;
        let excluded = classify_aperture(
            &excluded,
            Some(&observation(
                1,
                Some(LEGACY),
                Some(0),
                Some(LEGACY),
                Some(true),
            )),
        );
        assert_eq!(
            excluded.patch_configuration.state,
            PatchConfigurationState::Unavailable
        );
        assert_eq!(
            excluded.patch_configuration.reason_code,
            PatchConfigurationReasonCode::RegistryExcluded
        );
        assert_eq!(excluded.patch_configuration.target_selector, None);

        let mut unusable = test_gpu(2, LEGACY);
        unusable.bar0_base = 0;
        let unusable = classify_aperture(
            &unusable,
            Some(&observation(
                2,
                Some(LEGACY),
                Some(0),
                Some(LEGACY),
                Some(true),
            )),
        );
        assert_eq!(
            unusable.patch_configuration.state,
            PatchConfigurationState::Unavailable
        );
        assert_eq!(
            unusable.patch_configuration.reason_code,
            PatchConfigurationReasonCode::UnusableBar0
        );
        assert_eq!(unusable.patch_configuration.target_size_bytes, None);

        let mut no_automatic_target = test_gpu(3, LEGACY);
        no_automatic_target.device_id = 0x2684;
        let assessment = assess_patch_configuration(
            &no_automatic_target,
            ResizableBarApertureState::Legacy256MiB,
        );
        assert_eq!(assessment.state, PatchConfigurationState::Indeterminate);
        assert_eq!(
            assessment.reason_code,
            PatchConfigurationReasonCode::ApertureIndeterminate
        );
    }

    #[test]
    fn inspection_is_indeterminate_for_unavailable_inconsistent_or_mismatched_data() {
        const EXPANDED: u64 = 8 * 1024 * 1024 * 1024;
        let gpu = test_gpu(1, EXPANDED);
        for observation in [
            observation(1, None, None, None, None),
            observation(1, Some(EXPANDED), Some(1), Some(1), Some(true)),
            observation(1, Some(EXPANDED), Some(0), Some(EXPANDED), Some(false)),
            observation(
                1,
                Some(128 * 1024 * 1024),
                Some(0),
                Some(128 * 1024 * 1024),
                Some(true),
            ),
        ] {
            assert_eq!(
                classify_aperture(&gpu, Some(&observation)).state,
                ResizableBarApertureState::Indeterminate
            );
        }
    }

    #[test]
    fn duplicate_nvidia_smi_bdf_is_a_structural_error() {
        let xml = r#"<nvidia_smi_log>
  <timestamp>now</timestamp><driver_version>test</driver_version>
  <gpu><product_name>RTX A</product_name><pci><pci_bus_id>00000000:01:00.0</pci_bus_id></pci><fb_memory_usage><total>8 GiB</total><used>0 B</used><free>8 GiB</free></fb_memory_usage><bar1_memory_usage><total>8 GiB</total><used>0 B</used><free>8 GiB</free></bar1_memory_usage></gpu>
  <gpu><product_name>RTX B</product_name><pci><pci_bus_id>00000000:01:00.0</pci_bus_id></pci><fb_memory_usage><total>8 GiB</total><used>0 B</used><free>8 GiB</free></fb_memory_usage><bar1_memory_usage><total>8 GiB</total><used>0 B</used><free>8 GiB</free></bar1_memory_usage></gpu>
</nvidia_smi_log>"#;
        let result = build_current_inventory_evidence(capture(xml), &[test_gpu(1, 8 << 30)]);
        assert!(
            matches!(result, Err(BackendError::Deployment(message)) if message.contains("duplicate observations"))
        );
    }

    #[test]
    fn inspection_marks_a_missing_gpu_and_mixed_multi_gpu_overall_truthfully() {
        const LEGACY: u64 = 256 * 1024 * 1024;
        const EXPANDED: u64 = 8 * 1024 * 1024 * 1024;
        let devices = vec![test_gpu(1, EXPANDED), test_gpu(2, LEGACY)];
        let missing = build_inspection(
            &evidence(vec![observation(
                1,
                Some(EXPANDED),
                Some(0),
                Some(EXPANDED),
                Some(true),
            )]),
            &devices,
        );
        assert_eq!(missing.state, ResizableBarApertureState::Indeterminate);
        assert_eq!(
            missing.gpus[1].state,
            ResizableBarApertureState::Indeterminate
        );
        let mixed = build_inspection(
            &evidence(vec![
                observation(1, Some(EXPANDED), Some(0), Some(EXPANDED), Some(true)),
                observation(2, Some(LEGACY), Some(0), Some(LEGACY), Some(true)),
            ]),
            &devices,
        );
        assert_eq!(mixed.state, ResizableBarApertureState::Mixed);
    }

    #[test]
    fn read_only_inspection_contract_is_plan_independent_and_camel_case() {
        const EXPANDED: u64 = 8 * 1024 * 1024 * 1024;
        const LEGACY: u64 = 256 * 1024 * 1024;
        let inspection = build_inspection(
            &evidence(vec![observation(
                1,
                Some(EXPANDED),
                Some(0),
                Some(EXPANDED),
                Some(true),
            )]),
            &[test_gpu(1, EXPANDED)],
        );
        let value = serde_json::to_value(inspection).unwrap();
        assert_eq!(value["state"], "expanded");
        assert_eq!(
            value["gpus"][0]["windowsBarSizeBytes"],
            EXPANDED.to_string()
        );
        assert!(value.get("plan").is_none());
        assert!(value.get("profileId").is_none());
        assert_eq!(value["gpus"][0]["patchConfiguration"]["state"], "notNeeded");
        assert_eq!(
            value["gpus"][0]["patchConfiguration"]["reasonCode"],
            "alreadyExpanded"
        );
        assert_eq!(
            serde_json::to_value(ResizableBarApertureState::Legacy256MiB).unwrap(),
            "legacy256MiB"
        );
        assert_eq!(
            serde_json::to_value(ResizableBarApertureState::Mixed).unwrap(),
            "mixed"
        );
        let legacy = classify_aperture(
            &test_gpu(2, LEGACY),
            Some(&observation(
                2,
                Some(LEGACY),
                Some(0),
                Some(LEGACY),
                Some(true),
            )),
        );
        let patch = serde_json::to_value(legacy.patch_configuration).unwrap();
        assert_eq!(patch["state"], "available");
        assert_eq!(patch["reasonCode"], "automaticTargetAvailable");
        assert_eq!(patch["targetSelector"], 7);
        assert_eq!(patch["targetSizeBytes"], "8589934592");
    }

    #[test]
    fn xml_parser_extracts_bar1_and_matches_the_windows_pci_inventory() {
        let device = test_gpu(1, 8 * 1024 * 1024 * 1024);
        let evidence = build_exact_profile_evidence(
            "nvstraps-0123456789abcdef01234567".into(),
            capture(XML),
            std::slice::from_ref(&device),
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
        require_resizable_bar_proof(&evidence, &[device]).unwrap();
    }

    #[test]
    fn current_inventory_warning_does_not_use_exact_profile_vocabulary() {
        let evidence = build_current_inventory_evidence(
            capture(XML),
            &[test_gpu(1, 8 << 30), test_gpu(2, 8 << 30)],
        )
        .unwrap();
        let warning = evidence.warnings.join(" ").to_ascii_lowercase();
        assert!(warning.contains("current nvidia gpu"));
        assert!(!warning.contains("profile"));
        assert!(!warning.contains("pinned"));
        assert!(!warning.contains("machine"));
    }

    #[test]
    fn proof_rejects_the_legacy_256_mib_aperture_and_unavailable_values() {
        const LEGACY: u64 = 256 * 1024 * 1024;
        let device = test_gpu(1, LEGACY);
        let mut evidence = evidence(vec![observation(
            1,
            Some(LEGACY),
            Some(0),
            Some(LEGACY),
            Some(true),
        )]);
        assert!(require_resizable_bar_proof(&evidence, std::slice::from_ref(&device)).is_err());
        evidence.gpus[0].bar1_total_bytes = None;
        evidence.gpus[0].bar1_free_bytes = None;
        assert!(require_resizable_bar_proof(&evidence, &[device]).is_err());
    }

    #[test]
    fn proof_rejects_mixed_multi_gpu_evidence() {
        const LEGACY: u64 = 256 * 1024 * 1024;
        const EXPANDED: u64 = 8 * 1024 * 1024 * 1024;
        let devices = [test_gpu(1, EXPANDED), test_gpu(2, LEGACY)];
        let evidence = evidence(vec![
            observation(1, Some(EXPANDED), Some(0), Some(EXPANDED), Some(true)),
            observation(2, Some(LEGACY), Some(0), Some(LEGACY), Some(true)),
        ]);
        assert_eq!(
            build_inspection(&evidence, &devices).state,
            ResizableBarApertureState::Mixed
        );
        assert!(require_resizable_bar_proof(&evidence, &devices).is_err());
    }
}
