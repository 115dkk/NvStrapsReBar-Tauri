use nvstraps_deploy::{DeploymentPlan, DeploymentWorkflow, StepId};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{
    app::{AppState, SaveReceipt, save_config_inner},
    config::ConfigDraft,
    deployment::load_exact_deployment,
    error::{ApiError, BackendError, BackendResult, CommandResult},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDeploymentConfigRequest {
    pub profile_id: String,
    pub draft: ConfigDraft,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDeploymentConfigReceipt {
    pub plan: DeploymentPlan,
    pub save: SaveReceipt,
}

#[tauri::command]
pub fn save_deployment_config(
    app: AppHandle,
    request: SaveDeploymentConfigRequest,
    state: State<'_, AppState>,
) -> CommandResult<SaveDeploymentConfigReceipt> {
    save_deployment_config_command(&app, request, &state).map_err(ApiError::from)
}

fn save_deployment_config_command(
    app: &AppHandle,
    request: SaveDeploymentConfigRequest,
    state: &AppState,
) -> BackendResult<SaveDeploymentConfigReceipt> {
    let exact = load_exact_deployment(app, &request.profile_id, "NvStraps configuration write")?;
    exact
        .plan
        .require_active(StepId::WriteNvstrapsConfiguration)
        .map_err(BackendError::from)?;

    // The existing writer re-enumerates topology, validates, writes the EFI variable, and performs
    // an exact byte-for-byte readback. Only that successful receipt may advance the durable plan.
    let save = save_config_inner(request.draft, state)?;
    let mut workflow = DeploymentWorkflow::from_plan(&exact.store, &exact.profile, exact.plan)
        .map_err(BackendError::from)?;
    workflow
        .record_step(
            StepId::WriteNvstrapsConfiguration,
            configuration_readback_evidence(&save),
        )
        .map_err(BackendError::from)?;

    Ok(SaveDeploymentConfigReceipt {
        plan: workflow.into_plan(),
        save,
    })
}

fn configuration_readback_evidence(save: &SaveReceipt) -> String {
    save.saved_at_unix_ms.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_evidence_is_the_exact_readback_timestamp() {
        let save = SaveReceipt {
            saved_at_unix_ms: "1786654321000".into(),
            bytes_written: 24,
            variable_present: true,
            reboot_required: true,
            draft: ConfigDraft::default(),
        };

        assert_eq!(configuration_readback_evidence(&save), "1786654321000");
    }
}
