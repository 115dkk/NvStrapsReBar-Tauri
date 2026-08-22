import { messages } from "../i18n-catalog";
import { usesMsiProZ690Route } from "../hardware-support";
import type { SystemSnapshot } from "../types";
import type {
        DeploymentWorkspaceIntent,
        DeploymentWorkspaceState,
} from "./session-contract";

const MSI_MANUAL =
        "https://download.msi.com/archive/mnu_exe/mb/PROZ690-AWIFIDDR4_PROZ690-ADDR4100x150.pdf";

const legacyReset = {
        legacyAnalysis: null,
        legacyAnalysisStatus: "idle",
        legacyAnalysisError: "",
        selectedLegacyRules: [],
        legacyAcknowledgements: {},
} as const satisfies Partial<DeploymentWorkspaceState>;

export const createInitialDeploymentState = (
        snapshot: SystemSnapshot,
): DeploymentWorkspaceState => {
        const msi = usesMsiProZ690Route(snapshot);
        return {
                snapshot,
                displayName: msi ? "PRO Z690-A DDR4 · RTX 2080 SUPER" : "",
                boardPath: "nativeResizableBar",
                firmwarePath: "",
                firmware: null,
                recoveryMethod: msi ? "usbFlashback" : "vendorRecovery",
                firmwareTargetPolicy: "requireUnique",
                installMethod: "firmwareSetupUtility",
                instructionsUrl: msi ? MSI_MANUAL : "",
                recoveryNote: msi
                        ? messages[
                                  "ui.msiFlashBiosButtonRecoveryMsiRomAtUsbRootRearFlashBiosPortPhysicalButton"
                          ].en
                        : "",
                installNote: msi
                        ? messages[
                                  "ui.useMFlashToSelectTheExportedVendorFormatImage"
                          ].en
                        : "",
                recoveryNotePresetId: msi
                        ? "ui.msiFlashBiosButtonRecoveryMsiRomAtUsbRootRearFlashBiosPortPhysicalButton"
                        : null,
                installNotePresetId: msi
                        ? "ui.useMFlashToSelectTheExportedVendorFormatImage"
                        : null,
                routeConfirmed: false,
                ...legacyReset,
                profiles: [],
                selectedProfileId: "",
                plan: null,
                preflightExact: null,
                preparation: null,
                destination: "",
                packageReceipt: null,
                rebootPreview: null,
                showReboot: false,
                manualPreview: null,
                showManual: false,
                configurationRebootPreview: null,
                showConfigurationReboot: false,
                guardedConfigConfirmed: false,
                configRecommendation: null,
                recommendationStatus: "idle",
                recommendationError: null,
                workflowReceipt: null,
                barEvidence: null,
                installation: null,
                backup: null,
                launch: null,
                busyAction: "",
                activity: null,
        };
};

export const resetProfileProjection = (
        selectedProfileId: string,
): Partial<DeploymentWorkspaceState> => ({
        selectedProfileId,
        plan: null,
        preflightExact: null,
        preparation: null,
        packageReceipt: null,
        rebootPreview: null,
        showReboot: false,
        manualPreview: null,
        showManual: false,
        configurationRebootPreview: null,
        showConfigurationReboot: false,
        guardedConfigConfirmed: false,
        configRecommendation: null,
        recommendationStatus: "idle",
        recommendationError: null,
        workflowReceipt: null,
        barEvidence: null,
        backup: null,
        launch: null,
        activity: null,
        busyAction: "",
});

export const reduceLocalDeploymentIntent = (
        state: DeploymentWorkspaceState,
        intent: DeploymentWorkspaceIntent,
): Partial<DeploymentWorkspaceState> | undefined => {
        switch (intent.type) {
                case "setDisplayName":
                        return { displayName: intent.value };
                case "setBoardPath":
                        return { ...legacyReset, boardPath: intent.value };
                case "setFirmwarePath":
                        return {
                                ...legacyReset,
                                firmwarePath: intent.value,
                                firmware: null,
                        };
                case "setRecoveryMethod":
                        return { recoveryMethod: intent.value };
                case "setFirmwareTargetPolicy":
                        return { firmwareTargetPolicy: intent.value };
                case "setInstallMethod":
                        return { installMethod: intent.value };
                case "setInstructionsUrl":
                        return { instructionsUrl: intent.value };
                case "setRecoveryNote":
                        return {
                                recoveryNote: intent.value,
                                recoveryNotePresetId: null,
                        };
                case "setInstallNote":
                        return {
                                installNote: intent.value,
                                installNotePresetId: null,
                        };
                case "setRouteConfirmed":
                        return { routeConfirmed: intent.value };
                case "setDestination":
                        return { destination: intent.value };
                case "setGuardedConfigConfirmed":
                        return { guardedConfigConfirmed: intent.value };
                case "toggleLegacyRule":
                        return {
                                selectedLegacyRules: intent.checked
                                        ? [
                                                  ...new Set([
                                                          ...state.selectedLegacyRules,
                                                          intent.key,
                                                  ]),
                                          ]
                                        : state.selectedLegacyRules.filter(
                                                  (key) => key !== intent.key,
                                          ),
                        };
                case "setLegacyRiskConfirmed":
                        return {
                                legacyAcknowledgements: {
                                        ...state.legacyAcknowledgements,
                                        [intent.risk]: {
                                                confirmed: intent.confirmed,
                                        },
                                },
                        };
                case "closeModals":
                        return {
                                showReboot: false,
                                showManual: false,
                                showConfigurationReboot: false,
                        };
                default:
                        return undefined;
        }
};
