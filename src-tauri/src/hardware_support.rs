use nvstraps_core::registry::is_turing;
use nvstraps_deploy::MachineIdentity;
use serde::Serialize;

use crate::devices::GpuDevice;

#[derive(Clone, Copy)]
struct NativeResizableBarBoard {
    id: &'static str,
    manufacturer: &'static str,
    product: &'static str,
    version: &'static str,
}

const NATIVE_RESIZABLE_BAR_BOARDS: &[NativeResizableBarBoard] = &[NativeResizableBarBoard {
    id: "msi-pro-z690-a-ddr4-ms-7d25",
    manufacturer: "Micro-Star International Co., Ltd.",
    product: "PRO Z690-A DDR4(MS-7D25)",
    version: "1.0",
}];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HardwareSupportState {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HardwareSupportReasonCode {
    ExactMotherboardCatalogMatch,
    MotherboardNotInCatalog,
    MachineIdentityUnavailable,
    AllDetectedGpusTuring,
    DetectedGpuOutsideTuringFamily,
    MixedTuringAndNonTuringGpus,
    NoGpusDetected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareSupportFinding {
    pub state: HardwareSupportState,
    pub reason_code: HardwareSupportReasonCode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MotherboardSupportFinding {
    pub state: HardwareSupportState,
    pub reason_code: HardwareSupportReasonCode,
    pub catalog_id: Option<&'static str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareSupportAssessment {
    pub motherboard_native_resizable_bar: MotherboardSupportFinding,
    pub target_gpu_family: HardwareSupportFinding,
    pub overall_state: HardwareSupportState,
}

pub fn determine_hardware_support(
    identity: Option<&MachineIdentity>,
    devices: &[GpuDevice],
) -> HardwareSupportAssessment {
    let motherboard_native_resizable_bar = determine_motherboard_support(identity);
    let target_gpu_family = determine_target_gpu_support(devices);
    HardwareSupportAssessment {
        motherboard_native_resizable_bar,
        target_gpu_family,
        overall_state: combine_support(
            motherboard_native_resizable_bar.state,
            target_gpu_family.state,
        ),
    }
}

fn determine_motherboard_support(identity: Option<&MachineIdentity>) -> MotherboardSupportFinding {
    let Some(identity) = identity else {
        return MotherboardSupportFinding {
            state: HardwareSupportState::Unknown,
            reason_code: HardwareSupportReasonCode::MachineIdentityUnavailable,
            catalog_id: None,
        };
    };
    let catalog_match = NATIVE_RESIZABLE_BAR_BOARDS.iter().find(|board| {
        identity.board_manufacturer == board.manufacturer
            && identity.board_product == board.product
            && identity.board_version == board.version
    });
    if let Some(board) = catalog_match {
        MotherboardSupportFinding {
            state: HardwareSupportState::Supported,
            reason_code: HardwareSupportReasonCode::ExactMotherboardCatalogMatch,
            catalog_id: Some(board.id),
        }
    } else {
        MotherboardSupportFinding {
            state: HardwareSupportState::Unknown,
            reason_code: HardwareSupportReasonCode::MotherboardNotInCatalog,
            catalog_id: None,
        }
    }
}

fn determine_target_gpu_support(devices: &[GpuDevice]) -> HardwareSupportFinding {
    let turing_count = devices
        .iter()
        .filter(|device| is_turing(device.device_id))
        .count();
    match (turing_count, devices.len()) {
        (_, 0) => HardwareSupportFinding {
            state: HardwareSupportState::Unknown,
            reason_code: HardwareSupportReasonCode::NoGpusDetected,
        },
        (supported, total) if supported == total => HardwareSupportFinding {
            state: HardwareSupportState::Supported,
            reason_code: HardwareSupportReasonCode::AllDetectedGpusTuring,
        },
        (0, _) => HardwareSupportFinding {
            state: HardwareSupportState::Unsupported,
            reason_code: HardwareSupportReasonCode::DetectedGpuOutsideTuringFamily,
        },
        _ => HardwareSupportFinding {
            state: HardwareSupportState::Unsupported,
            reason_code: HardwareSupportReasonCode::MixedTuringAndNonTuringGpus,
        },
    }
}

const fn combine_support(
    motherboard: HardwareSupportState,
    gpu: HardwareSupportState,
) -> HardwareSupportState {
    match (motherboard, gpu) {
        (HardwareSupportState::Unsupported, _) | (_, HardwareSupportState::Unsupported) => {
            HardwareSupportState::Unsupported
        }
        (HardwareSupportState::Supported, HardwareSupportState::Supported) => {
            HardwareSupportState::Supported
        }
        _ => HardwareSupportState::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use nvstraps_deploy::PciLocation;

    use super::*;
    use crate::devices::PciBridge;

    fn identity(version: &str) -> MachineIdentity {
        MachineIdentity {
            board_manufacturer: "Micro-Star International Co., Ltd.".into(),
            board_product: "PRO Z690-A DDR4(MS-7D25)".into(),
            board_version: version.into(),
            bios_vendor: "American Megatrends International, LLC.".into(),
            bios_version: "1.N0".into(),
            bios_release_date: "2026-03-12".into(),
            gpus: vec![nvstraps_deploy::GpuFingerprint {
                vendor_id: 0x10de,
                device_id: 0x1e81,
                subsystem_vendor_id: 0x1462,
                subsystem_device_id: 0x3755,
                location: PciLocation {
                    bus: 1,
                    device: 0,
                    function: 0,
                },
                bridge_location: PciLocation {
                    bus: 0,
                    device: 1,
                    function: 0,
                },
                bar0_base: 0x8000_0000,
                bar0_top: 0x80ff_ffff,
            }],
        }
    }

    fn gpu(device_id: u16) -> GpuDevice {
        GpuDevice {
            id: format!("gpu-{device_id:04x}"),
            name: "NVIDIA GPU".into(),
            vendor_id: 0x10de,
            device_id,
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
            current_bar_size: 256 * 1024 * 1024,
            dedicated_video_memory: 8 * 1024 * 1024 * 1024,
            is_turing: false,
            recommended_bar_size_selector: None,
            effective_bar_size_selector: None,
        }
    }

    #[test]
    fn exact_current_msi_board_is_in_the_native_rebar_catalog() {
        let result = determine_motherboard_support(Some(&identity("1.0")));
        assert_eq!(result.state, HardwareSupportState::Supported);
        assert_eq!(
            result.reason_code,
            HardwareSupportReasonCode::ExactMotherboardCatalogMatch
        );
        assert_eq!(result.catalog_id, Some("msi-pro-z690-a-ddr4-ms-7d25"));
    }

    #[test]
    fn board_version_near_miss_is_unknown_instead_of_unsupported() {
        let result = determine_motherboard_support(Some(&identity("1.1")));
        assert_eq!(result.state, HardwareSupportState::Unknown);
        assert_eq!(
            result.reason_code,
            HardwareSupportReasonCode::MotherboardNotInCatalog
        );
        assert_eq!(result.catalog_id, None);

        let mut near_product = identity("1.0");
        near_product.board_product = "PRO Z690-A DDR4(MS-7D25)-near-miss".into();
        assert_eq!(
            determine_motherboard_support(Some(&near_product)).state,
            HardwareSupportState::Unknown
        );
        assert_eq!(
            determine_motherboard_support(Some(&near_product)).catalog_id,
            None
        );
    }

    #[test]
    fn canonical_turing_registry_determines_target_family_support() {
        let turing = determine_target_gpu_support(&[gpu(0x1e81)]);
        assert_eq!(turing.state, HardwareSupportState::Supported);
        let non_turing = determine_target_gpu_support(&[gpu(0x2684)]);
        assert_eq!(non_turing.state, HardwareSupportState::Unsupported);
    }

    #[test]
    fn mixed_and_empty_gpu_inventory_aggregate_without_false_support() {
        let board = identity("1.0");
        let mixed = determine_hardware_support(Some(&board), &[gpu(0x1e81), gpu(0x2684)]);
        assert_eq!(
            mixed.target_gpu_family.state,
            HardwareSupportState::Unsupported
        );
        assert_eq!(
            mixed.target_gpu_family.reason_code,
            HardwareSupportReasonCode::MixedTuringAndNonTuringGpus
        );
        assert_eq!(mixed.overall_state, HardwareSupportState::Unsupported);

        let empty = determine_hardware_support(Some(&board), &[]);
        assert_eq!(empty.target_gpu_family.state, HardwareSupportState::Unknown);
        assert_eq!(
            empty.target_gpu_family.reason_code,
            HardwareSupportReasonCode::NoGpusDetected
        );
        assert_eq!(empty.overall_state, HardwareSupportState::Unknown);
    }

    #[test]
    fn assessment_serializes_as_a_stable_camel_case_contract() {
        let assessment = determine_hardware_support(Some(&identity("1.0")), &[gpu(0x1e81)]);
        let value = serde_json::to_value(assessment).unwrap();
        assert_eq!(value["overallState"], "supported");
        assert_eq!(
            value["motherboardNativeResizableBar"]["reasonCode"],
            "exactMotherboardCatalogMatch"
        );
        assert_eq!(
            value["motherboardNativeResizableBar"]["catalogId"],
            "msi-pro-z690-a-ddr4-ms-7d25"
        );
        assert_eq!(
            value["targetGpuFamily"]["reasonCode"],
            "allDetectedGpusTuring"
        );

        let unknown = determine_hardware_support(Some(&identity("1.1")), &[gpu(0x1e81)]);
        let unknown_value = serde_json::to_value(unknown).unwrap();
        assert!(unknown_value["motherboardNativeResizableBar"]["catalogId"].is_null());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "read-only hardware support assessment of the current Windows machine"]
    fn current_machine_hardware_support_assessment_reports_observed_identity() {
        let devices = crate::devices::enumerate_gpus()
            .expect("read-only NVIDIA GPU inventory should be available");
        let identity = crate::machine::collect_machine_identity(&devices)
            .expect("read-only machine identity should be available");
        let assessment = determine_hardware_support(Some(&identity), &devices);
        eprintln!(
            "board manufacturer={:?} product={:?} version={:?}; motherboard={:?}/{:?} catalog_id={:?}; target_gpu_family={:?}/{:?}; overall={:?}",
            identity.board_manufacturer,
            identity.board_product,
            identity.board_version,
            assessment.motherboard_native_resizable_bar.state,
            assessment.motherboard_native_resizable_bar.reason_code,
            assessment.motherboard_native_resizable_bar.catalog_id,
            assessment.target_gpu_family.state,
            assessment.target_gpu_family.reason_code,
            assessment.overall_state,
        );
    }
}
