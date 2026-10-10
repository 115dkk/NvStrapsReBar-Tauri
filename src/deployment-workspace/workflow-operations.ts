import type { DeploymentAdapter } from "./adapter";
import type {
        ConfigurationRebootPreview,
        DeploymentConfigRecommendation,
        DeploymentPlan,
        ManualDeploymentStepPreview,
} from "./contract";

const activeStep = (plan: DeploymentPlan) =>
        plan.steps.find((step) => step.state === "ready");

export const prepareFirmwareArtifact = (
        adapter: DeploymentAdapter,
        before: DeploymentPlan,
) => adapter.prepareFirmwareArtifact(before.profileId);

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
                preview.stepId !== active.id
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
        return adapter.confirmManualDeploymentStep(preview);
};

export const verifyDeploymentDriver = (
        adapter: DeploymentAdapter,
        before: DeploymentPlan,
) => adapter.verifyDeploymentDriver(before.profileId);

export const saveRecommendedConfig = (
        adapter: DeploymentAdapter,
        before: DeploymentPlan,
        recommendation: DeploymentConfigRecommendation,
) =>
        adapter.saveDeploymentConfig(
                before.profileId,
                structuredClone(recommendation.draft),
        );

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
        savedWork: boolean,
) => {
        if (
                preview.profileId !== before.profileId ||
                preview.planRevision !== before.revision
        )
                throw new Error("The configuration reboot preview is stale.");
        return adapter.rebootAfterConfiguration(preview, savedWork);
};

export const verifyConfigurationBoot = (
        adapter: DeploymentAdapter,
        before: DeploymentPlan,
) => adapter.verifyConfigurationReboot(before.profileId);

export const collectResizableBarEvidence = (
        adapter: DeploymentAdapter,
        before: DeploymentPlan,
) => adapter.collectNvidiaSmiEvidence(before.profileId);
