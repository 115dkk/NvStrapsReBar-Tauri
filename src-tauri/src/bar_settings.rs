use nvstraps_core::config::Config;
use nvstraps_deploy::Sha256Digest;
use serde::Serialize;

use crate::{
    devices::GpuDevice, resizable_bar::windows_reports_expanded_turing_aperture,
    status::DriverStatus,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CurrentBootDxeState {
    ObservedThisBoot,
    NotObservedThisBoot,
    Indeterminate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CurrentBootDxeReasonCode {
    CurrentBootStatusObserved,
    StatusVariableMissing,
    StatusVariableMalformed,
    StatusVariableUnavailable,
    StatusValueUnrecognized,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SavedBarConfigurationState {
    Enabled,
    Disabled,
    Invalid,
    Unreadable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BarSettingsControlEvidence {
    CurrentBootDxe,
    ExpandedTuringAperture,
    NotObserved,
    Indeterminate,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarSettingsStatus {
    pub current_boot_dxe_state: CurrentBootDxeState,
    pub current_boot_dxe_reason_code: CurrentBootDxeReasonCode,
    pub control_evidence: BarSettingsControlEvidence,
    pub settings_available: bool,
    pub saved_configuration_state: SavedBarConfigurationState,
    pub topology_token: String,
    pub config_token: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum StatusVariableObservation {
    Present(Vec<u8>),
    Missing,
    Unavailable,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum SavedConfigurationObservation<'a> {
    Valid { config: &'a Config, raw: &'a [u8] },
    Invalid { raw: &'a [u8] },
    Unreadable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DriverRuntimeAssessment {
    pub driver_status: Option<DriverStatus>,
    pub bar_settings: BarSettingsStatus,
}

pub(crate) fn assess_driver_runtime(
    status_variable: &StatusVariableObservation,
    saved_configuration: SavedConfigurationObservation<'_>,
    devices: &[GpuDevice],
) -> DriverRuntimeAssessment {
    let (driver_status, current_boot_dxe_state, current_boot_dxe_reason_code) =
        match status_variable {
            StatusVariableObservation::Present(bytes) if bytes.len() == size_of::<u64>() => {
                let raw = u64::from_le_bytes(bytes.as_slice().try_into().expect("length checked"));
                let status = DriverStatus::from_raw(raw);
                let (state, reason) = if status.proves_current_boot_execution() {
                    (
                        CurrentBootDxeState::ObservedThisBoot,
                        CurrentBootDxeReasonCode::CurrentBootStatusObserved,
                    )
                } else {
                    (
                        CurrentBootDxeState::Indeterminate,
                        CurrentBootDxeReasonCode::StatusValueUnrecognized,
                    )
                };
                (Some(status), state, reason)
            }
            StatusVariableObservation::Present(_) => (
                Some(DriverStatus::from_raw(200)),
                CurrentBootDxeState::Indeterminate,
                CurrentBootDxeReasonCode::StatusVariableMalformed,
            ),
            StatusVariableObservation::Missing => (
                Some(DriverStatus::from_raw(10)),
                CurrentBootDxeState::NotObservedThisBoot,
                CurrentBootDxeReasonCode::StatusVariableMissing,
            ),
            StatusVariableObservation::Unavailable => (
                None,
                CurrentBootDxeState::Indeterminate,
                CurrentBootDxeReasonCode::StatusVariableUnavailable,
            ),
        };
    let (saved_configuration_state, config_token) = match saved_configuration {
        SavedConfigurationObservation::Valid { config, raw } if config.is_driver_configured() => (
            SavedBarConfigurationState::Enabled,
            Some(configuration_token(raw)),
        ),
        SavedConfigurationObservation::Valid { raw, .. } => (
            SavedBarConfigurationState::Disabled,
            Some(configuration_token(raw)),
        ),
        SavedConfigurationObservation::Invalid { raw } => (
            SavedBarConfigurationState::Invalid,
            Some(configuration_token(raw)),
        ),
        SavedConfigurationObservation::Unreadable => (SavedBarConfigurationState::Unreadable, None),
    };
    let control_evidence = if current_boot_dxe_state == CurrentBootDxeState::ObservedThisBoot {
        BarSettingsControlEvidence::CurrentBootDxe
    } else if windows_reports_expanded_turing_aperture(devices) {
        BarSettingsControlEvidence::ExpandedTuringAperture
    } else if current_boot_dxe_state == CurrentBootDxeState::NotObservedThisBoot {
        BarSettingsControlEvidence::NotObserved
    } else {
        BarSettingsControlEvidence::Indeterminate
    };
    DriverRuntimeAssessment {
        driver_status,
        bar_settings: BarSettingsStatus {
            current_boot_dxe_state,
            current_boot_dxe_reason_code,
            control_evidence,
            settings_available: matches!(
                control_evidence,
                BarSettingsControlEvidence::CurrentBootDxe
                    | BarSettingsControlEvidence::ExpandedTuringAperture
            ),
            saved_configuration_state,
            topology_token: topology_token(devices),
            config_token,
        },
    }
}

pub(crate) fn current_boot_driver_is_observed(status_variable: &StatusVariableObservation) -> bool {
    let default = Config::default();
    assess_driver_runtime(
        status_variable,
        SavedConfigurationObservation::Valid {
            config: &default,
            raw: &[],
        },
        &[],
    )
    .bar_settings
    .current_boot_dxe_state
        == CurrentBootDxeState::ObservedThisBoot
}

pub(crate) fn topology_token(devices: &[GpuDevice]) -> String {
    let mut devices = devices.iter().collect::<Vec<_>>();
    devices.sort_by_key(|device| {
        (
            device.bus,
            device.device,
            device.function,
            device.vendor_id,
            device.device_id,
            device.subsystem_vendor_id,
            device.subsystem_device_id,
        )
    });
    let mut bytes = Vec::with_capacity(4 + devices.len() * 41);
    bytes.extend_from_slice(&(devices.len() as u32).to_le_bytes());
    for device in devices {
        bytes.extend_from_slice(&device.vendor_id.to_le_bytes());
        bytes.extend_from_slice(&device.device_id.to_le_bytes());
        bytes.extend_from_slice(&device.subsystem_vendor_id.to_le_bytes());
        bytes.extend_from_slice(&device.subsystem_device_id.to_le_bytes());
        bytes.extend_from_slice(&[device.bus, device.device, device.function]);
        bytes.extend_from_slice(&device.bridge.vendor_id.to_le_bytes());
        bytes.extend_from_slice(&device.bridge.device_id.to_le_bytes());
        bytes.extend_from_slice(&[
            device.bridge.bus,
            device.bridge.device,
            device.bridge.function,
        ]);
        bytes.extend_from_slice(&device.bar0_base.to_le_bytes());
        bytes.extend_from_slice(&device.bar0_top.to_le_bytes());
    }
    Sha256Digest::from_bytes(&bytes).to_string()
}

pub(crate) fn configuration_token(raw: &[u8]) -> String {
    Sha256Digest::from_bytes(raw).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::PciBridge;

    fn status(code: u64) -> StatusVariableObservation {
        StatusVariableObservation::Present(code.to_le_bytes().to_vec())
    }

    fn gpu(bus: u8) -> GpuDevice {
        GpuDevice {
            id: format!("pci-{bus:02x}-00-0"),
            name: format!("GPU {bus}"),
            vendor_id: 0x10de,
            device_id: 0x1e81,
            subsystem_vendor_id: 0x1462,
            subsystem_device_id: 0x3755,
            bus,
            device: 0,
            function: 0,
            bridge: PciBridge {
                vendor_id: 0x8086,
                device_id: 0x1901,
                bus: 0,
                device: bus,
                function: 0,
            },
            bar0_base: 0xf000_0000 - u64::from(bus) * 0x0100_0000,
            bar0_top: 0xf0ff_ffff - u64::from(bus) * 0x0100_0000,
            current_bar_size: 8 << 30,
            dedicated_video_memory: 8 << 30,
            is_turing: true,
            recommended_bar_size_selector: Some(7),
            effective_bar_size_selector: Some(7),
        }
    }

    fn valid<'a>(config: &'a Config, raw: &'a [u8]) -> SavedConfigurationObservation<'a> {
        SavedConfigurationObservation::Valid { config, raw }
    }

    #[test]
    fn current_boot_status_separates_observation_from_saved_configuration() {
        let disabled = Config::default();
        let assessment = assess_driver_runtime(&status(40), valid(&disabled, &[]), &[]);
        assert_eq!(
            assessment.bar_settings.current_boot_dxe_state,
            CurrentBootDxeState::ObservedThisBoot
        );
        assert_eq!(
            assessment.bar_settings.saved_configuration_state,
            SavedBarConfigurationState::Disabled
        );
        assert_eq!(
            assessment.bar_settings.control_evidence,
            BarSettingsControlEvidence::CurrentBootDxe
        );
        assert!(assessment.bar_settings.settings_available);
    }

    #[test]
    fn recognized_driver_errors_still_leave_settings_available_for_repair() {
        let default = Config::default();
        let assessment = assess_driver_runtime(&status(200), valid(&default, &[]), &[]);
        assert_eq!(
            assessment.bar_settings.current_boot_dxe_state,
            CurrentBootDxeState::ObservedThisBoot
        );
        assert!(assessment.bar_settings.settings_available);
    }

    #[test]
    fn missing_status_locks_settings_as_not_observed() {
        let default = Config::default();
        let assessment = assess_driver_runtime(
            &StatusVariableObservation::Missing,
            valid(&default, &[]),
            &[],
        );
        assert_eq!(
            assessment.bar_settings.current_boot_dxe_state,
            CurrentBootDxeState::NotObservedThisBoot
        );
        assert_eq!(
            assessment.bar_settings.current_boot_dxe_reason_code,
            CurrentBootDxeReasonCode::StatusVariableMissing
        );
        assert!(!assessment.bar_settings.settings_available);
        assert_eq!(
            assessment.bar_settings.control_evidence,
            BarSettingsControlEvidence::NotObserved
        );
    }

    #[test]
    fn expanded_turing_aperture_unlocks_settings_without_current_boot_status() {
        let assessment = assess_driver_runtime(
            &StatusVariableObservation::Missing,
            SavedConfigurationObservation::Unreadable,
            &[gpu(1)],
        );
        assert_eq!(
            assessment.bar_settings.control_evidence,
            BarSettingsControlEvidence::ExpandedTuringAperture
        );
        assert!(assessment.bar_settings.settings_available);
        assert_eq!(assessment.bar_settings.config_token, None);
    }

    #[test]
    fn expanded_non_turing_aperture_does_not_stand_in_for_nvstraps_control() {
        let mut non_turing = gpu(1);
        non_turing.device_id = 0x2204;
        non_turing.is_turing = true;
        let assessment = assess_driver_runtime(
            &StatusVariableObservation::Missing,
            SavedConfigurationObservation::Unreadable,
            &[non_turing],
        );
        assert_eq!(
            assessment.bar_settings.control_evidence,
            BarSettingsControlEvidence::NotObserved
        );
        assert!(!assessment.bar_settings.settings_available);
    }

    #[test]
    fn malformed_unknown_and_unavailable_status_never_claim_observation() {
        for observation in [
            StatusVariableObservation::Present(vec![1, 2, 3]),
            status(42),
            status(10),
            StatusVariableObservation::Unavailable,
        ] {
            let default = Config::default();
            let assessment = assess_driver_runtime(&observation, valid(&default, &[]), &[]);
            assert_eq!(
                assessment.bar_settings.current_boot_dxe_state,
                CurrentBootDxeState::Indeterminate
            );
            assert!(!assessment.bar_settings.settings_available);
        }
    }

    #[test]
    fn unreadable_configuration_does_not_hide_observed_control() {
        let assessment =
            assess_driver_runtime(&status(40), SavedConfigurationObservation::Unreadable, &[]);
        assert_eq!(
            assessment.bar_settings.current_boot_dxe_state,
            CurrentBootDxeState::ObservedThisBoot
        );
        assert!(assessment.bar_settings.settings_available);
        assert_eq!(assessment.bar_settings.config_token, None);
    }

    #[test]
    fn enabled_wire_state_tracks_any_persisted_driver_configuration() {
        let config = Config {
            option_flags: 1,
            ..Config::default()
        };
        let raw = config.encode().unwrap();
        let assessment = assess_driver_runtime(&status(20), valid(&config, &raw), &[]);
        assert_eq!(
            assessment.bar_settings.saved_configuration_state,
            SavedBarConfigurationState::Enabled
        );
        let value = serde_json::to_value(assessment.bar_settings).unwrap();
        assert_eq!(value["currentBootDxeState"], "observedThisBoot");
        assert_eq!(
            value["currentBootDxeReasonCode"],
            "currentBootStatusObserved"
        );
        assert_eq!(value["savedConfigurationState"], "enabled");
        assert_eq!(value["controlEvidence"], "currentBootDxe");
        assert_eq!(value["configToken"].as_str().unwrap().len(), 64);
        assert_eq!(value["topologyToken"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn invalid_and_unreadable_saved_configuration_are_distinct() {
        let invalid = assess_driver_runtime(
            &status(200),
            SavedConfigurationObservation::Invalid { raw: b"bad" },
            &[],
        );
        assert_eq!(
            invalid.bar_settings.saved_configuration_state,
            SavedBarConfigurationState::Invalid
        );
        assert!(invalid.bar_settings.settings_available);

        let unreadable =
            assess_driver_runtime(&status(20), SavedConfigurationObservation::Unreadable, &[]);
        assert_eq!(
            unreadable.bar_settings.saved_configuration_state,
            SavedBarConfigurationState::Unreadable
        );
        assert!(unreadable.bar_settings.settings_available);
    }

    #[test]
    fn topology_token_is_order_independent_and_load_bearing() {
        let first = gpu(1);
        let second = gpu(2);
        assert_eq!(
            topology_token(&[first.clone(), second.clone()]),
            topology_token(&[second.clone(), first.clone()])
        );
        let mut moved = second;
        moved.bar0_base += 0x10;
        assert_ne!(
            topology_token(&[first, moved]),
            topology_token(&[gpu(1), gpu(2)])
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "read-only current-machine DXE/config observation"]
    fn current_machine_bar_settings_control_reports_observed_state() {
        use crate::firmware::{CONFIG_VARIABLE_NAME, STATUS_VARIABLE_NAME, read_variable};

        let devices = crate::devices::enumerate_gpus().expect("read current NVIDIA inventory");
        let config_raw = read_variable(CONFIG_VARIABLE_NAME)
            .ok()
            .map(|value| value.unwrap_or_default());
        let decoded = config_raw.as_deref().map(Config::decode);
        let saved = match &decoded {
            Some(Ok(config)) => SavedConfigurationObservation::Valid {
                config,
                raw: config_raw
                    .as_deref()
                    .expect("decoded configuration has bytes"),
            },
            Some(Err(_)) => SavedConfigurationObservation::Invalid {
                raw: config_raw.as_deref().expect("failed decode has bytes"),
            },
            None => SavedConfigurationObservation::Unreadable,
        };
        let status = match read_variable(STATUS_VARIABLE_NAME) {
            Ok(Some(bytes)) => StatusVariableObservation::Present(bytes),
            Ok(None) => StatusVariableObservation::Missing,
            Err(_) => StatusVariableObservation::Unavailable,
        };
        let assessment = assess_driver_runtime(&status, saved, &devices);
        eprintln!(
            "{}",
            serde_json::to_string_pretty(&assessment).expect("serialize assessment")
        );
    }
}
