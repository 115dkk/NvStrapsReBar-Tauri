import type { DeploymentAdapter } from "./adapter";
import type {
        ConfigurationRebootPreview,
        DeploymentConfigRecommendation,
        DeploymentPlan,
        ManualDeploymentStepPreview,
        StepId,
} from "./contract";
import { assertPlanAdvance } from "./deployment-receipts";

const activeStep = (plan: DeploymentPlan) =>
        plan.steps.find((step) => step.state === "ready");

export const prepareFirmwareArtifact = async (
        adapter: DeploymentAdapter,
        before: DeploymentPlan,
) => {
        const active = activeStep(before)!;
        const start = before.steps.findIndex((step) => step.id === active.id);
        const end = before.steps.findIndex(
                (step) => step.id === "verifyPatchedArtifact",
        );
        const expected = before.steps
                .slice(start, end + 1)
                .map((step) => step.id);
        const preparation = await adapter.prepareFirmwareArtifact(
                before.profileId,
        );
        assertPlanAdvance(before, preparation.plan, expected);
        return preparation;
};

export const loadManualStepPreview = async (
        adapter: DeploymentAdapter,
        before: DeploymentPlan,
) => {
        const active = activeStep(before)!;
        const preview = await adapter.previewManualDeploymentStep(
                before.profileId,
        );
        if (
                preview.profileId !== before.profileId ||
                preview.planRevision !== before.revision ||
                preview.stepId !== active.id ||
                !preview.confirmationToken
        )
                throw new Error(
                        "The deployment plan changed while the consequence preview was loading. Review the current step again.",
                );
        return preview;
};

export const confirmManualStep = async (
        adapter: DeploymentAdapter,
        before: DeploymentPlan,
        preview: ManualDeploymentStepPreview,
) => {
        const active = activeStep(before);
        if (
                preview.profileId !== before.profileId ||
                preview.planRevision !== before.revision ||
                preview.stepId !== active?.id
        )
                throw new Error("The manual confirmation preview is stale.");
        const receipt = await adapter.confirmManualDeploymentStep(preview);
        if (
                receipt.plan.profileId !== before.profileId ||
                receipt.stepId !== preview.stepId
        )
                throw new Error(
                        "The backend returned a stale manual-step receipt.",
                );
        assertPlanAdvance(before, receipt.plan, [preview.stepId]);
        return receipt;
};

export const verifyDeploymentDriver = async (
        adapter: DeploymentAdapter,
        before: DeploymentPlan,
) => {
        const active = activeStep(before)!;
        const expected: StepId[] =
                active.id === "rebootAfterFirmware"
                        ? ["rebootAfterFirmware", "verifyDriverLoaded"]
                        : ["verifyDriverLoaded"];
        const receipt = await adapter.verifyDeploymentDriver(before.profileId);
        assertPlanAdvance(before, receipt.plan, expected);
        return receipt;
};

export const saveRecommendedConfig = async (
        adapter: DeploymentAdapter,
        before: DeploymentPlan,
        recommendation: DeploymentConfigRecommendation,
) => {
        const draft = structuredClone(recommendation.draft);
        const receipt = await adapter.saveDeploymentConfig(
                before.profileId,
                draft,
        );
        assertPlanAdvance(before, receipt.plan, ["writeNvstrapsConfiguration"]);
        if (JSON.stringify(receipt.save.draft) !== JSON.stringify(draft))
                throw new Error(
                        "The configuration read-back receipt does not match the recommended draft that was submitted.",
                );
        return receipt;
};

export const loadConfigurationRebootPreview = async (
        adapter: DeploymentAdapter,
        before: DeploymentPlan,
) => {
        const preview = await adapter.previewConfigurationReboot(
                before.profileId,
        );
        if (
                preview.profileId !== before.profileId ||
                preview.planRevision !== before.revision
        )
                throw new Error(
                        "The deployment plan changed while the restart preview was loading.",
                );
        return preview;
};

export const requestConfigurationReboot = async (
        adapter: DeploymentAdapter,
        before: DeploymentPlan,
        preview: ConfigurationRebootPreview,
        selectedProfileId: string,
        savedWork: boolean,
) => {
        if (
                preview.profileId !== before.profileId ||
                preview.planRevision !== before.revision ||
                !preview.confirmationToken
        )
                throw new Error("The configuration reboot preview is stale.");
        const receipt = await adapter.rebootAfterConfiguration(
                preview,
                savedWork,
        );
        if (
                receipt.profileId !== selectedProfileId ||
                receipt.accepted !== true ||
                receipt.planAdvanced !== false
        )
                throw new Error(
                        "The restart request returned an invalid plan-advancement receipt.",
                );
        return receipt;
};

export const verifyConfigurationBoot = async (
        adapter: DeploymentAdapter,
        before: DeploymentPlan,
) => {
        const receipt = await adapter.verifyConfigurationReboot(
                before.profileId,
        );
        assertPlanAdvance(before, receipt.plan, ["rebootAfterConfiguration"]);
        const savedEvidence = before.steps.find(
                (step) => step.id === "writeNvstrapsConfiguration",
        )?.evidence?.value;
        if (
                receipt.configurationSavedAtUnixMs !== savedEvidence ||
                Number(receipt.bootedAtUnixMs) <=
                        Number(receipt.configurationSavedAtUnixMs)
        )
                throw new Error(
                        "The returned boot receipt is not later than the configuration read-back.",
                );
        return receipt;
};

export const collectResizableBarEvidence = async (
        adapter: DeploymentAdapter,
        before: DeploymentPlan,
) => {
        const receipt = await adapter.collectNvidiaSmiEvidence(
                before.profileId,
        );
        if (
                receipt.evidence.profileId !== before.profileId ||
                !receipt.evidence.allProfileGpusObserved
        )
                throw new Error(
                        "NVIDIA telemetry is missing one or more GPUs from the selected profile.",
                );
        assertPlanAdvance(before, receipt.plan, ["verifyResizableBar"]);
        return receipt;
};
