import {
        message,
        type MessageDescriptor,
        type StaticMessageId,
} from "../i18n-catalog";
import type { FirmwareFingerprint, LegacyPatchRisk, StepId } from "./contract";
import { stepTitleIds } from "./messages";
import type {
        DeploymentNextAction,
        DeploymentWorkspaceState,
        DeploymentWorkspaceView,
} from "./session-contract";

const sameFirmware = (
        left: FirmwareFingerprint | null,
        right: FirmwareFingerprint | null,
) =>
        Boolean(
                left &&
                        right &&
                        left.fileName === right.fileName &&
                        left.byteLength === right.byteLength &&
                        left.sha256 === right.sha256,
        );

export const legacyRuleKey = (catalog: string, ruleId: string) =>
        `${catalog}:${ruleId}`;

const riskAcknowledgementMessageIds = {
        dsdtModification: "ui.addDsdtRiskAcknowledgement",
        nvramWhitelist: "ui.addNvramRiskAcknowledgement",
        usbControllerBlacklist: "ui.addUsbRiskAcknowledgement",
        experimentalX79: "ui.addX79RiskAcknowledgement",
} as const satisfies Record<LegacyPatchRisk, StaticMessageId>;

const nextActionFor = (stepId?: StepId): DeploymentNextAction => {
        switch (stepId) {
                case "prepareRustDriver":
                case "applyLegacyBoardPatches":
                case "verifyPatchedArtifact":
                        return "prepare";
                case "flashWithVendorRoute":
                case "configureFirmwareSetup":
                        return "manual";
                case "rebootAfterFirmware":
                case "verifyDriverLoaded":
                        return "verifyDriver";
                case "writeNvstrapsConfiguration":
                        return "writeConfig";
                case "rebootAfterConfiguration":
                        return "configurationReboot";
                case "verifyResizableBar":
                        return "collectBar";
                case "configureNvidiaApplications":
                        return "nvidiaPolicy";
                case undefined:
                        return "complete";
                default:
                        return "none";
        }
};

export const projectDeploymentWorkspace = (
        state: DeploymentWorkspaceState,
): DeploymentWorkspaceView => {
        const selectedProfile =
                state.profiles.find(
                        (profile) =>
                                profile.profileId === state.selectedProfileId,
                ) ?? null;
        const planSteps = state.plan?.steps ?? [];
        const activeStepIndex = planSteps.findIndex(
                (step) => step.state === "ready",
        );
        const activeStep =
                activeStepIndex >= 0
                        ? (planSteps[activeStepIndex] ?? null)
                        : null;
        const nextStep =
                activeStepIndex >= 0
                        ? (planSteps[activeStepIndex + 1] ?? null)
                        : null;
        const legacyAnalysisValid = Boolean(
                state.legacyAnalysis &&
                        state.legacyAnalysis.path === state.firmwarePath &&
                        sameFirmware(
                                state.legacyAnalysis.value.firmware,
                                state.firmware,
                        ),
        );
        const selectedLegacyEntries =
                !state.legacyAnalysis || !legacyAnalysisValid
                        ? []
                        : state.legacyAnalysis.value.catalogs.flatMap(
                                  (catalog) =>
                                          catalog.rules
                                                  .filter(
                                                          (rule) =>
                                                                  rule.status ===
                                                                          "applicable" &&
                                                                  state.selectedLegacyRules.includes(
                                                                          legacyRuleKey(
                                                                                  catalog.catalog,
                                                                                  rule.ruleId,
                                                                          ),
                                                                  ),
                                                  )
                                                  .map((rule) => ({
                                                          catalog,
                                                          rule,
                                                  })),
                          );
        const selectedLegacyRisks = [
                ...new Set(
                        selectedLegacyEntries.flatMap(
                                ({ rule }) => rule.requiredRisks,
                        ),
                ),
        ];
        const missingLegacyRisk = selectedLegacyRisks.find(
                (risk) => !state.legacyAcknowledgements[risk]?.confirmed,
        );
        const legacyReady =
                state.boardPath !== "legacyAbove4g" ||
                (state.legacyAnalysisStatus === "ready" &&
                        legacyAnalysisValid &&
                        selectedLegacyEntries.length > 0 &&
                        !missingLegacyRisk);
        let legacyNextAction: MessageDescriptor | null = null;
        if (state.boardPath === "legacyAbove4g") {
                if (!state.firmware)
                        legacyNextAction = message(
                                "ui.chooseAndInspectTheFirmwareImageFirst",
                        );
                else if (state.legacyAnalysisStatus === "pending")
                        legacyNextAction = message(
                                "ui.waitForTheImageAnalysisToFinish",
                        );
                else if (state.legacyAnalysisStatus === "error")
                        legacyNextAction = message(
                                "ui.analysisFailedRetryImage",
                                {
                                        detail: state.legacyAnalysisError,
                                },
                        );
                else if (!state.legacyAnalysis || !legacyAnalysisValid)
                        legacyNextAction = message(
                                "ui.analyzeThisFirmwareImageBeforeSelectingLegacyRules",
                        );
                else if (!selectedLegacyEntries.length)
                        legacyNextAction = message(
                                "ui.selectAtLeastOneRuleReportedAsApplicableByTheAnalyzer",
                        );
                else if (missingLegacyRisk)
                        legacyNextAction = message(
                                riskAcknowledgementMessageIds[
                                        missingLegacyRisk
                                ],
                        );
                else
                        legacyNextAction = message(
                                "ui.selectedLegacyRulesAreLinkedToThisFirmwareFingerprintTheProfileIsReadyToCreate",
                        );
        }

        return {
                ...state,
                selectedProfile,
                activeStep,
                nextStep,
                activeStepTitleId: activeStep
                        ? stepTitleIds[activeStep.id]
                        : null,
                nextStepTitleId: nextStep ? stepTitleIds[nextStep.id] : null,
                nextAction: nextActionFor(activeStep?.id),
                legacyAnalysisValid,
                selectedLegacyEntries,
                selectedLegacyRisks,
                missingLegacyRisk,
                legacyReady,
                legacyNextAction,
        };
};

export const firmwareFingerprintsMatch = sameFirmware;
