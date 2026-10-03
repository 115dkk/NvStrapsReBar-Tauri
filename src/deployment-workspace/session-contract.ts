import type { SystemSnapshot } from "../types";
import type { MessageDescriptor, StaticMessageId } from "../i18n-catalog";
import type {
        BoardPath,
        ConfigurationRebootPreview,
        DeploymentConfigRecommendation,
        DeploymentPackageReceipt,
        DeploymentPlan,
        FirmwareFingerprint,
        FirmwareInstallMethod,
        FirmwarePreparation,
        FirmwareTargetPolicy,
        FirmwareSetupRebootPreview,
        LegacyFirmwareAnalysis,
        LegacyPatchRisk,
        MachineProfile,
        ManualDeploymentStepPreview,
        NvidiaSmiEvidence,
        RecoveryMethod,
        StepId,
} from "./contract";

export type DeploymentWorkspaceActivity = {
        tone: "success" | "warning" | "error";
        message: MessageDescriptor;
} | null;

export type DeploymentNextAction =
        | "prepare"
        | "manual"
        | "verifyDriver"
        | "writeConfig"
        | "configurationReboot"
        | "verifyConfigurationBoot"
        | "collectBar"
        | "nvidiaPolicy"
        | "complete"
        | "none";

export interface DeploymentWorkspaceView {
        snapshot: SystemSnapshot;
        displayName: string;
        boardPath: BoardPath;
        firmwarePath: string;
        firmware: FirmwareFingerprint | null;
        recoveryMethod: RecoveryMethod;
        firmwareTargetPolicy: FirmwareTargetPolicy;
        installMethod: FirmwareInstallMethod;
        instructionsUrl: string;
        recoveryNote: string;
        installNote: string;
        recoveryNotePresetId: StaticMessageId | null;
        installNotePresetId: StaticMessageId | null;
        routeConfirmed: boolean;
        legacyAnalysis: { path: string; value: LegacyFirmwareAnalysis } | null;
        legacyAnalysisStatus: "idle" | "pending" | "ready" | "error";
        legacyAnalysisError: string;
        selectedLegacyRules: string[];
        legacyAcknowledgements: Partial<
                Record<LegacyPatchRisk, { confirmed: boolean }>
        >;
        profiles: MachineProfile[];
        /** Stored records and the selected plan have been read; false while a record loads. */
        profilesLoaded: boolean;
        /** Counts successful profile creations, so a screen can tell a new record was made. */
        profileCreations: number;
        selectedProfileId: string;
        selectedProfile: MachineProfile | null;
        plan: DeploymentPlan | null;
        activeStep: DeploymentPlan["steps"][number] | null;
        nextStep: DeploymentPlan["steps"][number] | null;
        activeStepTitleId: StaticMessageId | null;
        nextStepTitleId: StaticMessageId | null;
        nextAction: DeploymentNextAction;
        preflightExact: boolean | null;
        preparation: FirmwarePreparation | null;
        destination: string;
        packageReceipt: DeploymentPackageReceipt | null;
        rebootPreview: FirmwareSetupRebootPreview | null;
        showReboot: boolean;
        manualPreview: ManualDeploymentStepPreview | null;
        showManual: boolean;
        configurationRebootPreview: ConfigurationRebootPreview | null;
        showConfigurationReboot: boolean;
        guardedConfigConfirmed: boolean;
        configRecommendation: {
                profileId: string;
                planRevision: number;
                value: DeploymentConfigRecommendation;
        } | null;
        recommendationStatus: "idle" | "pending" | "ready" | "error";
        recommendationError: MessageDescriptor | null;
        workflowReceipt: {
                title: MessageDescriptor;
                detail: MessageDescriptor;
        } | null;
        barEvidence: NvidiaSmiEvidence | null;
        busyAction: string;
        activity: DeploymentWorkspaceActivity;
        /** A read-only check the guided screens run on their own after a restart. */
        autoCheck: {
                stepId: StepId;
                status: "running" | "failed";
                message: MessageDescriptor | null;
        } | null;
        legacyAnalysisValid: boolean;
        selectedLegacyEntries: {
                catalog: LegacyFirmwareAnalysis["catalogs"][number];
                rule: LegacyFirmwareAnalysis["catalogs"][number]["rules"][number];
        }[];
        selectedLegacyRisks: LegacyPatchRisk[];
        missingLegacyRisk: LegacyPatchRisk | undefined;
        legacyReady: boolean;
        legacyNextAction: MessageDescriptor | null;
}

type FieldIntent =
        | { type: "setDisplayName"; value: string }
        | { type: "setBoardPath"; value: BoardPath }
        | { type: "setFirmwarePath"; value: string }
        | { type: "setRecoveryMethod"; value: RecoveryMethod }
        | { type: "setFirmwareTargetPolicy"; value: FirmwareTargetPolicy }
        | { type: "setInstallMethod"; value: FirmwareInstallMethod }
        | { type: "setInstructionsUrl"; value: string }
        | { type: "setRecoveryNote"; value: string }
        | { type: "setInstallNote"; value: string }
        | { type: "setRouteConfirmed"; value: boolean }
        | { type: "setDestination"; value: string }
        | { type: "setSelectedProfile"; value: string }
        | { type: "setGuardedConfigConfirmed"; value: boolean }
        | { type: "toggleLegacyRule"; key: string; checked: boolean }
        | {
                  type: "setLegacyRiskConfirmed";
                  risk: LegacyPatchRisk;
                  confirmed: boolean;
          }
        | { type: "retryRecommendation" }
        | {
                  type: "recordFirmwareHandoff";
                  includeSetup: boolean;
                  /** Plan revision the user reviewed; a moved plan is refused. */
                  planRevision: number;
          };

export type DeploymentWorkspaceIntent =
        | FieldIntent
        | {
                  type:
                          | "chooseFirmware"
                          | "inspectFirmware"
                          | "analyzeLegacy"
                          | "createProfile"
                          | "compare"
                          | "prepare"
                          | "chooseDestination"
                          | "exportPackage"
                          | "previewFirmwareReboot"
                          | "requestFirmwareReboot"
                          | "openManual"
                          | "confirmManual"
                          | "verifyDriver"
                          | "saveGuardedConfig"
                          | "openConfigurationReboot"
                          | "requestConfigurationReboot"
                          | "verifyConfigurationBoot"
                          | "collectBar"
                          | "autoCheck"
                          | "saveToUsb"
                          | "saveRecommendedConfig"
                          | "closeModals";
          };

export interface DeploymentWorkspaceSession {
        view(): DeploymentWorkspaceView;
        dispatch(intent: DeploymentWorkspaceIntent): Promise<void>;
        subscribe(listener: () => void): () => void;
        dispose(): void;
}

export type DeploymentWorkspaceState = Omit<
        DeploymentWorkspaceView,
        | "selectedProfile"
        | "activeStep"
        | "nextStep"
        | "activeStepTitleId"
        | "nextStepTitleId"
        | "nextAction"
        | "legacyAnalysisValid"
        | "selectedLegacyEntries"
        | "selectedLegacyRisks"
        | "missingLegacyRisk"
        | "legacyReady"
        | "legacyNextAction"
>;
