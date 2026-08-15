import type {
        DeploymentConfigRecommendation,
        DeploymentPlan,
        MachineProfile,
        StepId,
} from "./contract";

export const assertPlanAdvance = (
        before: DeploymentPlan,
        after: DeploymentPlan,
        completedStepIds: StepId[],
) => {
        if (
                after.profileId !== before.profileId ||
                after.schemaVersion !== before.schemaVersion ||
                after.originalFirmwareSha256 !==
                        before.originalFirmwareSha256 ||
                after.recoveryMethod !== before.recoveryMethod
        )
                throw new Error(
                        "The backend returned a deployment receipt for a different profile contract.",
                );
        if (after.revision !== before.revision + completedStepIds.length)
                throw new Error(
                        "The backend returned an unexpected deployment plan revision.",
                );
        if (
                after.steps.length !== before.steps.length ||
                after.steps.some(
                        (step, index) => step.id !== before.steps[index]?.id,
                )
        )
                throw new Error(
                        "The backend returned a malformed deployment step sequence.",
                );
        const readyBefore = before.steps
                .map((step, index) => ({ step, index }))
                .filter(({ step }) => step.state === "ready");
        if (readyBefore.length !== 1)
                throw new Error(
                        "The current deployment plan does not have exactly one active step.",
                );
        const activeIndex = readyBefore[0]!.index;
        const expectedCompleted = before.steps.slice(
                activeIndex,
                activeIndex + completedStepIds.length,
        );
        if (
                expectedCompleted.length !== completedStepIds.length ||
                expectedCompleted.some(
                        (step, index) =>
                                step.id !== completedStepIds[index] ||
                                (index === 0
                                        ? step.state !== "ready"
                                        : step.state !== "pending"),
                ) ||
                completedStepIds.some((_, index) => {
                        const step = after.steps[activeIndex + index];
                        return (
                                step?.state !== "completed" ||
                                !step.evidence?.kind.trim() ||
                                !step.evidence.value.trim()
                        );
                }) ||
                after.steps.some(
                        (step, index) =>
                                (index < activeIndex ||
                                        index >
                                                activeIndex +
                                                        completedStepIds.length) &&
                                (step.state !== before.steps[index]?.state ||
                                        JSON.stringify(step.evidence) !==
                                                JSON.stringify(
                                                        before.steps[index]
                                                                ?.evidence,
                                                )),
                )
        )
                throw new Error(
                        "The backend receipt advanced unexpected deployment steps.",
                );
        const nextIndex = activeIndex + completedStepIds.length;
        const next = after.steps[nextIndex];
        if (
                (next &&
                        (next.state !== "ready" ||
                                before.steps[nextIndex]?.state !== "pending" ||
                                JSON.stringify(next.evidence) !==
                                        JSON.stringify(
                                                before.steps[nextIndex]
                                                        ?.evidence,
                                        ))) ||
                (!next && after.steps.some((step) => step.state === "ready"))
        )
                throw new Error(
                        "The backend receipt did not activate exactly the next deployment step.",
                );
        if (
                after.steps.filter((step) => step.state === "ready").length !==
                (next ? 1 : 0)
        )
                throw new Error(
                        "The backend returned an invalid active deployment step count.",
                );
};

export const assertPlanProjection = (
        profile: MachineProfile,
        plan: DeploymentPlan,
) => {
        const ready = plan.steps.filter((step) => step.state === "ready");
        const firstOpen = plan.steps.findIndex(
                (step) => step.state !== "completed",
        );
        const invalidEvidence = plan.steps.some((step) =>
                step.state === "completed"
                        ? !step.evidence?.kind.trim() ||
                          !step.evidence.value.trim()
                        : step.evidence !== null,
        );
        const invalidOrder = plan.steps.some((step, index) =>
                firstOpen < 0
                        ? step.state !== "completed"
                        : index < firstOpen
                          ? step.state !== "completed"
                          : index === firstOpen
                            ? step.state !== "ready"
                            : step.state !== "pending",
        );
        if (
                plan.profileId !== profile.profileId ||
                plan.originalFirmwareSha256 !==
                        profile.originalFirmware.sha256 ||
                plan.recoveryMethod !== profile.recovery.method ||
                plan.revision < 0 ||
                ready.length !== (firstOpen < 0 ? 0 : 1) ||
                invalidEvidence ||
                invalidOrder
        ) {
                throw new Error(
                        "The backend returned a malformed deployment plan for the selected profile.",
                );
        }
        return plan;
};

export const assertRecommendation = (value: DeploymentConfigRecommendation) => {
        const ids = value.draft.rules.map((rule) =>
                [
                        rule.deviceId,
                        rule.subsystemVendorId,
                        rule.subsystemDeviceId,
                        rule.bus,
                        rule.device,
                        rule.function,
                ].join(":"),
        );
        if (
                value.draft.globalMode !== 1 ||
                value.draft.targetPciBarSize !== 0 ||
                value.draft.skipS3Resume ||
                value.draft.overrideBarSizeMask ||
                !value.draft.guardSetupChanges ||
                value.turingGpuCount <= 0 ||
                value.registryManagedGpuCount < 0 ||
                value.exactFallbackRuleCount < 0 ||
                value.registryManagedGpuCount + value.exactFallbackRuleCount !==
                        value.turingGpuCount ||
                value.exactFallbackRuleCount !== value.draft.rules.length ||
                new Set(ids).size !== ids.length ||
                value.draft.rules.some(
                        (rule) =>
                                rule.matchScope !== "location" ||
                                rule.barSizeSelector !== 5 ||
                                rule.overrideBarSizeMask !== null,
                )
        )
                throw new Error(
                        "The backend returned an inconsistent deployment configuration recommendation.",
                );
        return value;
};
