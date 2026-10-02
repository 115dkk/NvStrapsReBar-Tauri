import { firmwareInstalled } from "../bar-settings-routing";
import type { DeploymentWorkspaceView } from "../deployment-workspace/session-contract";
import type { StepId } from "../deployment-workspace/contract";
import type { ResizableBarStatusPresentation } from "../resizable-bar-status";
import type { SystemSnapshot } from "../types";

/**
 * Screen selection for the guided interface. These functions only choose what
 * to show; every write and every plan transition stays with the session and
 * the Rust backend.
 */

export type GuidedPage = "home" | "install" | "bar" | "games" | "changes" | "record" | "profiles";

/** The NVIDIA per-application step is offered after the install, not required by it. */
export const OPTIONAL_FINAL_STEP: StepId = "configureNvidiaApplications";

type PlanView = Pick<DeploymentWorkspaceView, "plan" | "activeStep">;

export const installInProgress = (view: PlanView) =>
        Boolean(view.plan && view.activeStep && view.activeStep.id !== OPTIONAL_FINAL_STEP);

export const installFinished = (view: PlanView) =>
        Boolean(view.plan && (!view.activeStep || view.activeStep.id === OPTIONAL_FINAL_STEP));

export type HomeState =
        | "checking"
        | "continue"
        | "uefiRequired"
        | "adminRequired"
        | "unavailable"
        | "noTargetGpu"
        | "on"
        | "mixed"
        | "off"
        | "start";

export const homeState = (
        snapshot: SystemSnapshot,
        tone: ResizableBarStatusPresentation["tone"],
        continuing: boolean,
): HomeState => {
        if (continuing) return "continue";
        if (tone === "expanded") return "on";
        if (!snapshot.platform.uefi) return "uefiRequired";
        if (!snapshot.platform.elevated) return "adminRequired";
        if (tone === "loading") return "checking";
        if (tone === "unavailable" || snapshot.barSettings.controlEvidence === "indeterminate") return "unavailable";
        const installed = firmwareInstalled(snapshot);
        if (!installed && !snapshot.devices.some((gpu) => gpu.isTuring)) return "noTargetGpu";
        if (installed) return tone === "mixed" ? "mixed" : "off";
        return "start";
};

export type InstallScreen =
        | "pickFirmware"
        | "boardQuestion"
        | "legacyAnalysis"
        | "installQuestion"
        | "recoveryQuestion"
        | "routes"
        | "making"
        | "save"
        | "guide"
        | "returnRecord"
        | "missing"
        | "admin"
        | "checkFailed"
        | "checkingDriver"
        | "mismatch"
        | "turnOn"
        | "restart"
        | "checkingResult"
        | "done";

export type InstallUiState = {
        /** The user asked to prepare a new BIOS file while an older record exists. */
        startNew: boolean;
        /** Catalog-board answers come from the app; other boards answer three questions. */
        catalogBoard: boolean;
        question: 1 | 2 | 3;
        /** The user pressed "I finished in BIOS setup" on the guide screen. */
        claimedInstalled: boolean;
        /** The user asked to save the package to another place from the guide screen. */
        savingAgain: boolean;
        /** The user asked to see the BIOS steps again although the driver already runs. */
        showGuide: boolean;
        /** Whether a package for the selected profile was exported (this run or earlier). */
        exported: boolean;
        /**
         * Windows booted after the package was saved. A running NvStrapsReBar seen before that
         * comes from an earlier install, not from the file the user is about to flash.
         */
        restartedSinceSave: boolean;
};

type InstallView = Pick<
        DeploymentWorkspaceView,
        "plan" | "activeStep" | "firmware" | "boardPath" | "legacyReady" | "preflightExact" | "autoCheck"
>;

const PREPARE_STEPS: StepId[] = ["verifyProfile", "confirmRecovery", "preserveOriginalFirmware", "prepareRustDriver", "applyLegacyBoardPatches", "verifyPatchedArtifact"];

const sourceScreen = (view: InstallView, ui: InstallUiState): InstallScreen => {
        if (!view.firmware) return "pickFirmware";
        if (ui.catalogBoard) return view.boardPath === "legacyAbove4g" && !view.legacyReady ? "legacyAnalysis" : "routes";
        if (ui.question === 1) return "boardQuestion";
        if (view.boardPath === "legacyAbove4g" && !view.legacyReady) return "legacyAnalysis";
        return ui.question === 2 ? "installQuestion" : "recoveryQuestion";
};

export const installScreen = (
        view: InstallView,
        snapshot: SystemSnapshot,
        ui: InstallUiState,
): InstallScreen => {
        if (!view.plan || ui.startNew) return sourceScreen(view, ui);
        if (view.preflightExact === false) return "mismatch";
        const step = view.activeStep?.id;
        if (!step || step === OPTIONAL_FINAL_STEP) return "done";
        if (PREPARE_STEPS.includes(step)) return "making";
        if (step === "flashWithVendorRoute" || step === "configureFirmwareSetup") {
                const flash = step === "flashWithVendorRoute";
                if (flash && (!ui.exported || ui.savingAgain)) return "save";
                const observed = snapshot.barSettings.currentBootDxeState === "observedThisBoot";
                // Before the flash is recorded, a running driver counts only after a restart since
                // the save, or when the user says the BIOS work is done.
                const observedForThisFile = observed && (!flash || ui.restartedSinceSave || ui.claimedInstalled);
                if (observedForThisFile && !ui.showGuide) return "returnRecord";
                if (ui.claimedInstalled)
                        return snapshot.platform.elevated && snapshot.barSettings.currentBootDxeState === "notObservedThisBoot" ? "missing" : "admin";
                return "guide";
        }
        if (step === "rebootAfterFirmware" || step === "verifyDriverLoaded") {
                if (view.autoCheck?.stepId === step && view.autoCheck.status === "failed") {
                        const dxe = snapshot.barSettings.currentBootDxeState;
                        if (!snapshot.platform.elevated || dxe === "indeterminate") return "admin";
                        // NvStrapsReBar ran, so the failure is in recording it, not in the BIOS install.
                        return dxe === "observedThisBoot" ? "checkFailed" : "missing";
                }
                return "checkingDriver";
        }
        if (step === "writeNvstrapsConfiguration") return "turnOn";
        if (step === "rebootAfterConfiguration") return "restart";
        return "checkingResult";
};

/** Stage shown in the tracker for an install screen. */
export const stageFor = (screen: InstallScreen): 1 | 2 | 3 | 4 | 5 => {
        switch (screen) {
                case "pickFirmware":
                case "boardQuestion":
                case "legacyAnalysis":
                case "installQuestion":
                case "recoveryQuestion":
                case "routes":
                case "making":
                case "save":
                        return 1;
                case "guide":
                case "returnRecord":
                case "missing":
                case "admin":
                case "checkFailed":
                case "checkingDriver":
                case "mismatch":
                        return 2;
                case "turnOn":
                case "restart":
                        return 3;
                case "checkingResult":
                        return 4;
                case "done":
                        return 5;
        }
};
