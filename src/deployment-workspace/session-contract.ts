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
        FirmwareSetupRebootPreview,
        LegacyFirmwareAnalysis,
        LegacyPatchRisk,
        MachineProfile,
        ManualDeploymentStepPreview,
        NvidiaProfileBackupReceipt,
        NvidiaSmiEvidence,
        ProfileInspectorInstallation,
        ProfileInspectorLaunch,
        RecoveryMethod,
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
                Record<LegacyPatchRisk, { note: string; confirmed: boolean }>
        >;
        profiles: MachineProfile[];
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
        savedWork: boolean;
        manualPreview: ManualDeploymentStepPreview | null;
        showManual: boolean;
        manualConfirmed: boolean;
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
        installation: ProfileInspectorInstallation | null;
        backup: NvidiaProfileBackupReceipt | null;
        launch: ProfileInspectorLaunch | null;
        busyAction: string;
        activity: DeploymentWorkspaceActivity;
        legacyAnalysisValid: boolean;
        selectedLegacyEntries: {
                catalog: LegacyFirmwareAnalysis["catalogs"][number];
                rule: LegacyFirmwareAnalysis["catalogs"][number]["rules"][number];
        }[];
        selectedLegacyRisks: LegacyPatchRisk[];
        acknowledgementHash: string;
        missingLegacyRisk: LegacyPatchRisk | undefined;
        legacyReady: boolean;
        legacyNextAction: MessageDescriptor | null;
}

type FieldIntent =
        | { type: "setDisplayName"; value: string }
        | { type: "setBoardPath"; value: BoardPath }
        | { type: "setFirmwarePath"; value: string }
        | { type: "setRecoveryMethod"; value: RecoveryMethod }
        | { type: "setInstallMethod"; value: FirmwareInstallMethod }
        | { type: "setInstructionsUrl"; value: string }
        | { type: "setRecoveryNote"; value: string }
        | { type: "setInstallNote"; value: string }
        | { type: "setRouteConfirmed"; value: boolean }
        | { type: "setDestination"; value: string }
        | { type: "setSelectedProfile"; value: string }
        | { type: "setSavedWork"; value: boolean }
        | { type: "setManualConfirmed"; value: boolean }
        | { type: "setGuardedConfigConfirmed"; value: boolean }
        | { type: "toggleLegacyRule"; key: string; checked: boolean }
        | { type: "setLegacyRiskNote"; risk: LegacyPatchRisk; note: string }
        | {
                  type: "setLegacyRiskConfirmed";
                  risk: LegacyPatchRisk;
                  confirmed: boolean;
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
                          | "installInspector"
                          | "backupProfiles"
                          | "launchInspector"
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
        | "acknowledgementHash"
        | "missingLegacyRisk"
        | "legacyReady"
        | "legacyNextAction"
>;
