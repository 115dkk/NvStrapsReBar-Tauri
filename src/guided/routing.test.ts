import { describe, expect, it } from "vitest";
import type { DeploymentPlan, StepId } from "../deployment-workspace/contract";
import type { DeploymentWorkspaceView } from "../deployment-workspace/session-contract";
import type { SystemSnapshot } from "../types";
import { homeState, installFinished, installInProgress, installScreen, stageFor, type InstallUiState } from "./routing";

const snapshot = (installed = false, dxe: SystemSnapshot["barSettings"]["currentBootDxeState"] = "notObservedThisBoot") => ({
        platform: { uefi: true, elevated: true },
        barSettings: { controlEvidence: installed ? "currentBootDxe" : "notObserved", currentBootDxeState: dxe },
        devices: [{ isTuring: true }],
}) as SystemSnapshot;

const order: StepId[] = [
        "verifyProfile", "confirmRecovery", "preserveOriginalFirmware", "prepareRustDriver", "verifyPatchedArtifact",
        "flashWithVendorRoute", "configureFirmwareSetup", "rebootAfterFirmware", "verifyDriverLoaded",
        "writeNvstrapsConfiguration", "rebootAfterConfiguration", "verifyResizableBar", "configureNvidiaApplications",
];

const viewAt = (active: StepId | null, extra: Partial<DeploymentWorkspaceView> = {}) => {
        const index = active ? order.indexOf(active) : order.length;
        const steps = order.map((id, position) => ({
                id,
                kind: "automated" as const,
                title: id,
                state: position < index ? ("completed" as const) : position === index ? ("ready" as const) : ("pending" as const),
                evidence: null,
        }));
        const plan = { profileId: "nvstraps-1", revision: index, steps } as unknown as DeploymentPlan;
        return {
                plan,
                activeStep: steps.find((step) => step.state === "ready") ?? null,
                firmware: { fileName: "E7D25IMS.1N0", byteLength: 1, sha256: "a" },
                boardPath: "nativeResizableBar",
                legacyReady: true,
                preflightExact: null,
                autoCheck: null,
                ...extra,
        } as DeploymentWorkspaceView;
};

const ui = (patch: Partial<InstallUiState> = {}): InstallUiState => ({
        startNew: false,
        catalogBoard: true,
        question: 1,
        claimedInstalled: false,
        savingAgain: false,
        showGuide: false,
        exported: true,
        restartedSinceSave: false,
        ...patch,
});

describe("home state", () => {
        it("resumes an unfinished installation before anything else", () => {
                expect(homeState(snapshot(true), "expanded", true)).toBe("continue");
        });

        it("separates installation from configuration and current activation", () => {
                expect(homeState(snapshot(), "legacy", false)).toBe("start");
                expect(homeState(snapshot(true), "legacy", false)).toBe("off");
                expect(homeState(snapshot(true), "mixed", false)).toBe("mixed");
                expect(homeState(snapshot(true), "expanded", false)).toBe("on");
        });

        it("asks to check again instead of calling an unknown state uninstalled", () => {
                expect(homeState(snapshot(), "unavailable", false)).toBe("unavailable");
                const unknownDriver = snapshot();
                unknownDriver.barSettings.controlEvidence = "indeterminate";
                expect(homeState(unknownDriver, "legacy", false)).toBe("unavailable");
                const noGpu = snapshot();
                noGpu.devices = [];
                expect(homeState(noGpu, "legacy", false)).toBe("noTargetGpu");
        });

        it("states access prerequisites and keeps loading passive", () => {
                const limited = snapshot();
                limited.platform.elevated = false;
                expect(homeState(limited, "legacy", false)).toBe("adminRequired");
                limited.platform.uefi = false;
                expect(homeState(limited, "legacy", false)).toBe("uefiRequired");
                expect(homeState(snapshot(), "loading", false)).toBe("checking");
        });
});

describe("install progress", () => {
        it("treats the NVIDIA per-game step as optional", () => {
                expect(installInProgress(viewAt("verifyResizableBar"))).toBe(true);
                expect(installInProgress(viewAt("configureNvidiaApplications"))).toBe(false);
                expect(installFinished(viewAt("configureNvidiaApplications"))).toBe(true);
                expect(installFinished(viewAt(null))).toBe(true);
                expect(installFinished({ plan: null, activeStep: null })).toBe(false);
        });
});

describe("install screen", () => {
        it("asks for the BIOS file, then the routes, before any record exists", () => {
                const fresh = { ...viewAt(null), plan: null, activeStep: null };
                expect(installScreen({ ...fresh, firmware: null }, snapshot(), ui())).toBe("pickFirmware");
                expect(installScreen(fresh, snapshot(), ui())).toBe("routes");
        });

        it("asks unknown boards three questions with the legacy analysis after the first", () => {
                const fresh = { ...viewAt(null), plan: null, activeStep: null };
                expect(installScreen(fresh, snapshot(), ui({ catalogBoard: false }))).toBe("boardQuestion");
                expect(installScreen({ ...fresh, boardPath: "legacyAbove4g", legacyReady: false }, snapshot(), ui({ catalogBoard: false, question: 2 }))).toBe("legacyAnalysis");
                expect(installScreen(fresh, snapshot(), ui({ catalogBoard: false, question: 2 }))).toBe("installQuestion");
                expect(installScreen(fresh, snapshot(), ui({ catalogBoard: false, question: 3 }))).toBe("recoveryQuestion");
        });

        it("shows stage 1 again while a new preparation replaces an older record", () => {
                expect(installScreen({ ...viewAt("flashWithVendorRoute"), firmware: null }, snapshot(), ui({ startNew: true }))).toBe("pickFirmware");
        });

        it("saves to USB before the BIOS guide, and the guide waits for the driver", () => {
                expect(installScreen(viewAt("prepareRustDriver"), snapshot(), ui())).toBe("making");
                expect(installScreen(viewAt("flashWithVendorRoute"), snapshot(), ui({ exported: false }))).toBe("save");
                expect(installScreen(viewAt("flashWithVendorRoute"), snapshot(), ui({ savingAgain: true }))).toBe("save");
                expect(installScreen(viewAt("flashWithVendorRoute"), snapshot(), ui())).toBe("guide");
                expect(installScreen(viewAt("flashWithVendorRoute"), snapshot(true, "observedThisBoot"), ui({ restartedSinceSave: true }))).toBe("returnRecord");
                expect(installScreen(viewAt("configureFirmwareSetup"), snapshot(true, "observedThisBoot"), ui())).toBe("returnRecord");
                // The steps stay one press away.
                expect(installScreen(viewAt("flashWithVendorRoute"), snapshot(true, "observedThisBoot"), ui({ restartedSinceSave: true, showGuide: true }))).toBe("guide");
        });

        it("shows the guide while only an earlier NvStrapsReBar runs", () => {
                // Running before any restart since the save: it is the old install, not this file.
                expect(installScreen(viewAt("flashWithVendorRoute"), snapshot(true, "observedThisBoot"), ui())).toBe("guide");
                // The user says the BIOS work is done: they record it themselves.
                expect(installScreen(viewAt("flashWithVendorRoute"), snapshot(true, "observedThisBoot"), ui({ claimedInstalled: true }))).toBe("returnRecord");
        });

        it("keeps the BIOS settings step reachable without a remembered save", () => {
                expect(installScreen(viewAt("configureFirmwareSetup"), snapshot(), ui({ exported: false }))).toBe("guide");
                expect(installScreen(viewAt("configureFirmwareSetup"), snapshot(), ui({ exported: false, claimedInstalled: true }))).toBe("missing");
                expect(installScreen(viewAt("configureFirmwareSetup"), snapshot(true, "observedThisBoot"), ui({ exported: false }))).toBe("returnRecord");
        });

        it("separates a missing driver from a status that needs administrator rights", () => {
                expect(installScreen(viewAt("flashWithVendorRoute"), snapshot(), ui({ claimedInstalled: true }))).toBe("missing");
                const limited = snapshot(false, "indeterminate");
                limited.platform.elevated = false;
                expect(installScreen(viewAt("flashWithVendorRoute"), limited, ui({ claimedInstalled: true }))).toBe("admin");
                const failed = viewAt("rebootAfterFirmware", { autoCheck: { stepId: "rebootAfterFirmware", status: "failed", message: null } });
                expect(installScreen(failed, snapshot(), ui())).toBe("missing");
                expect(installScreen(failed, limited, ui())).toBe("admin");
                // NvStrapsReBar ran; only recording the check failed.
                expect(installScreen(failed, snapshot(true, "observedThisBoot"), ui())).toBe("checkFailed");
                expect(installScreen(viewAt("rebootAfterFirmware"), snapshot(), ui())).toBe("checkingDriver");
        });

        it("stops on a hardware mismatch and finishes at the observed BAR size", () => {
                expect(installScreen(viewAt("flashWithVendorRoute", { preflightExact: false }), snapshot(), ui())).toBe("mismatch");
                expect(installScreen(viewAt("writeNvstrapsConfiguration"), snapshot(), ui())).toBe("turnOn");
                expect(installScreen(viewAt("rebootAfterConfiguration"), snapshot(), ui())).toBe("restart");
                expect(installScreen(viewAt("verifyResizableBar"), snapshot(), ui())).toBe("checkingResult");
                expect(installScreen(viewAt("configureNvidiaApplications"), snapshot(), ui())).toBe("done");
                expect(installScreen(viewAt(null), snapshot(), ui())).toBe("done");
        });

        it("maps every screen to one of four stages plus the finished state", () => {
                expect(stageFor("routes")).toBe(1);
                expect(stageFor("save")).toBe(1);
                expect(stageFor("guide")).toBe(2);
                expect(stageFor("turnOn")).toBe(3);
                expect(stageFor("checkingResult")).toBe(4);
                expect(stageFor("done")).toBe(5);
        });
});
