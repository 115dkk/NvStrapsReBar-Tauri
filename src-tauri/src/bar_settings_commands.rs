use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    app::{AppState, SaveReceipt, save_config_for_devices_inner},
    bar_settings::{
        StatusVariableObservation, configuration_token, current_boot_driver_is_observed,
        topology_token,
    },
    config::ConfigDraft,
    devices::{GpuDevice, enumerate_gpus},
    error::{ApiError, BackendError, BackendResult, CommandResult},
    firmware::{CONFIG_VARIABLE_NAME, STATUS_VARIABLE_NAME, read_variable},
    resizable_bar::windows_reports_expanded_turing_aperture,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBarSettingsRequest {
    pub draft: ConfigDraft,
    pub expected_topology_token: String,
    pub expected_config_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBarSettingsReceipt {
    pub save: SaveReceipt,
    pub topology_token: String,
    pub config_token: String,
}

#[tauri::command]
pub fn save_bar_settings(
    request: SaveBarSettingsRequest,
    state: State<'_, AppState>,
) -> CommandResult<SaveBarSettingsReceipt> {
    save_bar_settings_inner(request, &state).map_err(ApiError::from)
}

fn save_bar_settings_inner(
    request: SaveBarSettingsRequest,
    state: &AppState,
) -> BackendResult<SaveBarSettingsReceipt> {
    let status = match read_variable(STATUS_VARIABLE_NAME)? {
        Some(bytes) => StatusVariableObservation::Present(bytes),
        None => StatusVariableObservation::Missing,
    };
    let devices = enumerate_gpus()?;
    let current_config = read_variable(CONFIG_VARIABLE_NAME)?.unwrap_or_default();
    require_write_preconditions(&request, &status, &devices, &current_config)?;

    let topology_token = topology_token(&devices);
    let save = save_config_for_devices_inner(request.draft, state, devices)?;
    let saved = read_variable(CONFIG_VARIABLE_NAME)?.unwrap_or_default();
    Ok(SaveBarSettingsReceipt {
        save,
        topology_token,
        config_token: configuration_token(&saved),
    })
}

fn require_control_evidence(
    status: &StatusVariableObservation,
    devices: &[GpuDevice],
) -> BackendResult<()> {
    if current_boot_driver_is_observed(status) || windows_reports_expanded_turing_aperture(devices)
    {
        Ok(())
    } else {
        Err(BackendError::BarSettingsControlNotObserved)
    }
}

fn require_write_preconditions(
    request: &SaveBarSettingsRequest,
    status: &StatusVariableObservation,
    devices: &[GpuDevice],
    current_config: &[u8],
) -> BackendResult<()> {
    require_control_evidence(status, devices)?;
    if request.expected_topology_token != topology_token(devices) {
        return Err(BackendError::StaleTopology);
    }
    if request.expected_config_token != configuration_token(current_config) {
        return Err(BackendError::StaleConfiguration);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::PciBridge;

    fn device() -> GpuDevice {
        GpuDevice {
            id: "pci-01-00-0".into(),
            name: "GPU".into(),
            vendor_id: 0x10de,
            device_id: 0x1e81,
            subsystem_vendor_id: 0x1462,
            subsystem_device_id: 0x3755,
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
            bar0_base: 0xf000_0000,
            bar0_top: 0xf0ff_ffff,
            current_bar_size: 8 << 30,
            dedicated_video_memory: 8 << 30,
            is_turing: true,
            recommended_bar_size_selector: Some(7),
            effective_bar_size_selector: Some(7),
        }
    }

    fn request(devices: &[GpuDevice], config: &[u8]) -> SaveBarSettingsRequest {
        SaveBarSettingsRequest {
            draft: ConfigDraft::default(),
            expected_topology_token: topology_token(devices),
            expected_config_token: configuration_token(config),
        }
    }

    #[test]
    fn settings_write_gate_accepts_current_boot_status_or_expanded_turing_aperture() {
        assert!(
            require_control_evidence(
                &StatusVariableObservation::Present(40_u64.to_le_bytes().to_vec()),
                &[]
            )
            .is_ok()
        );
        assert!(
            require_control_evidence(
                &StatusVariableObservation::Present(200_u64.to_le_bytes().to_vec()),
                &[]
            )
            .is_ok()
        );
        let expanded = device();
        assert!(
            require_control_evidence(
                &StatusVariableObservation::Missing,
                std::slice::from_ref(&expanded)
            )
            .is_ok()
        );
        let mut legacy = expanded;
        legacy.current_bar_size = 256 * 1024 * 1024;
        assert!(require_control_evidence(&StatusVariableObservation::Missing, &[legacy]).is_err());
        assert!(
            require_control_evidence(&StatusVariableObservation::Present(vec![40]), &[]).is_err()
        );
    }

    #[test]
    fn write_preconditions_reject_stale_topology_and_configuration() {
        let status = StatusVariableObservation::Present(40_u64.to_le_bytes().to_vec());
        let devices = [device()];
        let current = b"current";
        assert!(
            require_write_preconditions(&request(&devices, current), &status, &devices, current)
                .is_ok()
        );

        let mut stale_topology = request(&devices, current);
        stale_topology.expected_topology_token = "00".repeat(32);
        assert!(matches!(
            require_write_preconditions(&stale_topology, &status, &devices, current),
            Err(BackendError::StaleTopology)
        ));

        let mut stale_config = request(&devices, current);
        stale_config.expected_config_token = "11".repeat(32);
        assert!(matches!(
            require_write_preconditions(&stale_config, &status, &devices, current),
            Err(BackendError::StaleConfiguration)
        ));
    }
}
