use nvstraps_deploy::{DeploymentPlan, DeploymentWorkflow, StepId};
use serde::Serialize;
use tauri::AppHandle;

use crate::{
    deployment::load_exact_deployment,
    devices::enumerate_gpus,
    error::{ApiError, BackendError, BackendResult, CommandResult},
    resizable_bar::{
        NvidiaSmiEvidence, ResizableBarInspection, collect_exact_profile_evidence,
        observe_current_apertures,
    },
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NvidiaSmiEvidenceReceipt {
    pub plan: DeploymentPlan,
    pub evidence: NvidiaSmiEvidence,
}

#[tauri::command]
pub async fn collect_nvidia_smi_evidence(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<NvidiaSmiEvidenceReceipt> {
    tauri::async_runtime::spawn_blocking(move || collect_command(&app, &profile_id))
        .await
        .map_err(|error| {
            ApiError::from(BackendError::Deployment(format!(
                "nvidia-smi evidence worker failed: {error}"
            )))
        })?
        .map_err(ApiError::from)
}

#[tauri::command]
pub async fn inspect_resizable_bar_status() -> CommandResult<ResizableBarInspection> {
    tauri::async_runtime::spawn_blocking(inspect_command)
        .await
        .map_err(|error| {
            ApiError::from(BackendError::Deployment(format!(
                "Resizable BAR inspection worker failed: {error}"
            )))
        })?
        .map_err(ApiError::from)
}

fn inspect_command() -> BackendResult<ResizableBarInspection> {
    let devices = enumerate_gpus()?;
    observe_current_apertures(&devices)
}

fn collect_command(app: &AppHandle, profile_id: &str) -> BackendResult<NvidiaSmiEvidenceReceipt> {
    let exact = load_exact_deployment(app, profile_id, "nvidia-smi evidence collection")?;
    exact
        .plan
        .require_active(StepId::VerifyResizableBar)
        .map_err(BackendError::from)?;
    let evidence =
        collect_exact_profile_evidence(exact.profile.profile_id.clone(), &exact.devices)?;

    let mut workflow = DeploymentWorkflow::from_plan(&exact.store, &exact.profile, exact.plan)
        .map_err(BackendError::from)?;
    workflow
        .record_step(
            StepId::VerifyResizableBar,
            evidence.raw_xml_sha256.to_string(),
        )
        .map_err(BackendError::from)?;
    Ok(NvidiaSmiEvidenceReceipt {
        plan: workflow.into_plan(),
        evidence,
    })
}
