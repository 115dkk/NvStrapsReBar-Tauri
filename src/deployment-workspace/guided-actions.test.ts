import { describe, expect, it, vi } from "vitest";
import type { SystemSnapshot } from "../types";
import type { DeploymentAdapter } from "./adapter";
import type { DeploymentPlan, MachineProfile, NvidiaSmiEvidence, StepId } from "./contract";
import { createDeploymentWorkspaceSession } from "./session";

/** Session protocols added for the guided screens. */

const snapshot = {
        schemaVersion: 1,
        platform: { operatingSystem: "windows", architecture: "x86_64", supported: true, uefi: true, elevated: true, bootedAtUnixMs: null },
        firmware: { accessible: true, privilegeEnabled: true, configVariablePresent: true, accessError: null },
        driverStatus: null,
        barSettings: {
                currentBootDxeState: "observedThisBoot",
                currentBootDxeReasonCode: "currentBootStatusObserved",
                controlEvidence: "currentBootDxe",
                settingsAvailable: true,
                savedConfigurationState: "disabled",
                topologyToken: "topology",
                configToken: "configuration",
        },
        config: null,
        devices: [],
        machineIdentity: null,
        hardwareSupport: {
                motherboardNativeResizableBar: { state: "unknown", reasonCode: "machineIdentityUnavailable", catalogId: null },
                targetGpuFamily: { state: "unknown", reasonCode: "noGpusDetected" },
                overallState: "unknown",
        },
        notices: [],
} as SystemSnapshot;

const owner: MachineProfile = {
        schemaVersion: 4,
        profileId: "nvstraps-guided",
        displayName: "guided",
        boardPath: "nativeResizableBar",
        legacyPatches: null,
        identity: { boardManufacturer: "M", boardProduct: "P", boardVersion: "V", biosVendor: "B", biosVersion: "1", biosReleaseDate: "D", gpus: [] },
        originalFirmware: { fileName: "firmware.bin", byteLength: 1, sha256: "a".repeat(64) },
        recovery: { method: "usbFlashback", testedOrDocumented: true, note: "test" },
        firmwareTargetPolicy: "requireUnique",
        firmwareInstall: null,
};

const order: StepId[] = [
        "verifyProfile",
        "flashWithVendorRoute",
        "configureFirmwareSetup",
        "rebootAfterFirmware",
        "verifyDriverLoaded",
        "writeNvstrapsConfiguration",
        "rebootAfterConfiguration",
        "verifyResizableBar",
        "configureNvidiaApplications",
];

const planAt = (active: StepId): DeploymentPlan => {
        const activeIndex = order.indexOf(active);
        return {
                schemaVersion: 1,
                profileId: owner.profileId,
                originalFirmwareSha256: owner.originalFirmware.sha256,
                recoveryMethod: owner.recovery.method,
                revision: activeIndex + 1,
                steps: order.map((id, index) => ({
                        id,
                        kind: "automated",
                        title: id,
                        state: index < activeIndex ? "completed" : index === activeIndex ? "ready" : "pending",
                        evidence: index < activeIndex ? { kind: id, value: "1000" } : null,
                })),
        };
};

const adapter = (overrides: Partial<DeploymentAdapter>): DeploymentAdapter =>
        new Proxy(overrides as DeploymentAdapter, {
                get(target, property) {
                        if (property in target) return target[property as keyof DeploymentAdapter];
                        return vi.fn(async () => null);
                },
        });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const start = async (active: StepId, overrides: Partial<DeploymentAdapter>) => {
        const session = createDeploymentWorkspaceSession(
                snapshot,
                adapter({
                        listMachineProfiles: async () => [owner],
                        getNvidiaProfileInspectorInstallation: async () => null,
                        getDeploymentPlan: async () => planAt(active),
                        ...overrides,
                }),
        );
        await tick();
        return session;
};

const manualAdapter = () => {
        let current = planAt("flashWithVendorRoute");
        const previews: string[] = [];
        const confirmations: string[] = [];
        return {
                previews,
                confirmations,
                overrides: {
                        getDeploymentPlan: async () => current,
                        previewManualDeploymentStep: async () => {
                                const active = current.steps.find((step) => step.state === "ready")!;
                                const token = `token-${active.id}-${current.revision}`;
                                previews.push(token);
                                return { profileId: owner.profileId, planRevision: current.revision, stepId: active.id, title: active.id, confirmationToken: token, warnings: [] };
                        },
                        confirmManualDeploymentStep: async (preview) => {
                                confirmations.push(preview.confirmationToken);
                                current = planAt(order[order.indexOf(preview.stepId) + 1]!);
                                return { plan: current, stepId: preview.stepId, recordedAtUnixMs: "1" };
                        },
                } satisfies Partial<DeploymentAdapter>,
        };
};

describe("guided session actions", () => {
        it("records the vendor flash and BIOS settings with one token per step", async () => {
                const manual = manualAdapter();
                const session = await start("flashWithVendorRoute", manual.overrides);
                await session.dispatch({ type: "recordFirmwareHandoff", includeSetup: true, planRevision: 2 });
                expect(manual.previews).toEqual(["token-flashWithVendorRoute-2", "token-configureFirmwareSetup-3"]);
                expect(manual.confirmations).toEqual(manual.previews);
                expect(session.view().activeStep?.id).toBe("rebootAfterFirmware");
                expect(session.view().activity?.tone).toBe("success");
        });

        it("records only the flash when asked, leaving the settings step active", async () => {
                const manual = manualAdapter();
                const session = await start("flashWithVendorRoute", manual.overrides);
                await session.dispatch({ type: "recordFirmwareHandoff", includeSetup: false, planRevision: 2 });
                expect(manual.confirmations).toEqual(["token-flashWithVendorRoute-2"]);
                expect(session.view().activeStep?.id).toBe("configureFirmwareSetup");
        });

        it("refuses to record the handoff once another step is active", async () => {
                const confirm = vi.fn();
                const session = await start("writeNvstrapsConfiguration", { confirmManualDeploymentStep: confirm });
                await session.dispatch({ type: "recordFirmwareHandoff", includeSetup: true, planRevision: 6 });
                expect(confirm).not.toHaveBeenCalled();
                expect(session.view().activity?.tone).toBe("error");
        });

        it("refuses to record against a plan revision the screen did not show", async () => {
                const manual = manualAdapter();
                const session = await start("flashWithVendorRoute", manual.overrides);
                await session.dispatch({ type: "recordFirmwareHandoff", includeSetup: true, planRevision: 1 });
                expect(manual.previews).toEqual([]);
                expect(manual.confirmations).toEqual([]);
                expect(session.view().activity?.tone).toBe("error");
                expect(session.view().activeStep?.id).toBe("flashWithVendorRoute");
        });

        it("keeps a failed restart check on the step instead of raising an error notice", async () => {
                const session = await start("rebootAfterConfiguration", {
                        verifyConfigurationReboot: async () => {
                                throw new Error("Windows has not restarted since the configuration was saved.");
                        },
                });
                await session.dispatch({ type: "autoCheck" });
                const view = session.view();
                expect(view.activity).toBeNull();
                expect(view.autoCheck).toMatchObject({ stepId: "rebootAfterConfiguration", status: "failed" });
                expect(view.activeStep?.id).toBe("rebootAfterConfiguration");
        });

        it("advances only after the boot time is later than the saved configuration", async () => {
                const session = await start("rebootAfterConfiguration", {
                        verifyConfigurationReboot: async () => ({ plan: planAt("verifyResizableBar"), configurationSavedAtUnixMs: "1000", bootedAtUnixMs: "2000" }),
                });
                await session.dispatch({ type: "autoCheck" });
                expect(session.view().activeStep?.id).toBe("verifyResizableBar");
                expect(session.view().autoCheck).toBeNull();
        });

        it("records the observed BAR size automatically after the restart", async () => {
                const evidence = { profileId: owner.profileId, allProfileGpusObserved: true, gpus: [], driverVersion: "596.36" } as unknown as NvidiaSmiEvidence;
                const session = await start("verifyResizableBar", {
                        collectNvidiaSmiEvidence: async () => ({ plan: planAt("configureNvidiaApplications"), evidence }),
                });
                await session.dispatch({ type: "autoCheck" });
                expect(session.view().barEvidence).toBe(evidence);
                expect(session.view().activeStep?.id).toBe("configureNvidiaApplications");
        });

        it("runs no automatic check on steps that need a person", async () => {
                const confirm = vi.fn();
                const session = await start("flashWithVendorRoute", { confirmManualDeploymentStep: confirm, verifyDeploymentDriver: confirm });
                await session.dispatch({ type: "autoCheck" });
                expect(confirm).not.toHaveBeenCalled();
                expect(session.view().autoCheck).toBeNull();
        });

        it("saves to the chosen USB drive, and closing the picker changes nothing", async () => {
                const exportPackage = vi.fn(async (profileId: string, destination: string) => ({
                        packagePath: `${destination}\\NvStrapsReBar-x`,
                        manifest: { profileId, files: [], manualGates: [] },
                        manifestSha256: "m",
                        checksumsSha256: "c",
                        recoveryShortcut: null,
                }));
                let choice: string | null = null;
                const session = await start("flashWithVendorRoute", {
                        selectDestinationDirectory: async () => choice,
                        exportDeploymentPackage: exportPackage,
                });
                await session.dispatch({ type: "saveToUsb" });
                expect(exportPackage).not.toHaveBeenCalled();
                expect(session.view().activity).toBeNull();
                choice = "E:\\";
                await session.dispatch({ type: "saveToUsb" });
                expect(exportPackage).toHaveBeenCalledWith(owner.profileId, "E:\\");
                expect(session.view().packageReceipt?.packagePath).toBe("E:\\\\NvStrapsReBar-x");
        });

        it("resumes the record the user last worked on instead of the first stored one", async () => {
                const other: MachineProfile = { ...owner, profileId: "nvstraps-other", displayName: "other" };
                const loaded: string[] = [];
                const session = createDeploymentWorkspaceSession(
                        snapshot,
                        adapter({
                                listMachineProfiles: async () => [owner, other],
                                getNvidiaProfileInspectorInstallation: async () => null,
                                getDeploymentPlan: async (profileId) => {
                                        loaded.push(profileId);
                                        return { ...planAt("flashWithVendorRoute"), profileId };
                                },
                        }),
                        "nvstraps-other",
                );
                await tick();
                expect(session.view().selectedProfileId).toBe("nvstraps-other");
                expect(loaded).toEqual(["nvstraps-other"]);
                expect(session.view().profilesLoaded).toBe(true);
        });

        it("counts each created record, also when it matches an earlier one", async () => {
                const firmware = { fileName: "firmware.bin", byteLength: 1, sha256: "a".repeat(64) };
                const session = await start("verifyProfile", {
                        listMachineProfiles: async () => [],
                        selectFirmwareImage: async () => "C:\\Firmware\\firmware.bin",
                        inspectFirmwareImage: async () => firmware,
                        createMachineProfile: async () => ({ profile: owner, plan: planAt("verifyProfile"), originalFirmwarePath: "original.bin" }),
                });
                await session.dispatch({ type: "chooseFirmware" });
                await session.dispatch({ type: "createProfile" });
                await session.dispatch({ type: "createProfile" });
                expect(session.view().profileCreations).toBe(2);
                expect(session.view().selectedProfileId).toBe(owner.profileId);
        });

        it("marks a failed legacy analysis as an error so it can run again", async () => {
                const firmware = { fileName: "E7D25IMS.1N0", byteLength: 1, sha256: "b".repeat(64) };
                const session = await start("verifyProfile", {
                        listMachineProfiles: async () => [],
                        selectFirmwareImage: async () => "C:\\Firmware\\E7D25IMS.1N0",
                        inspectFirmwareImage: async () => firmware,
                        analyzeLegacyFirmware: async () => ({ firmware: { ...firmware, sha256: "c".repeat(64) }, upstreamCommit: "u", catalogs: [] }),
                });
                await session.dispatch({ type: "setBoardPath", value: "legacyAbove4g" });
                await session.dispatch({ type: "chooseFirmware" });
                await session.dispatch({ type: "analyzeLegacy" });
                expect(session.view().legacyAnalysisStatus).toBe("error");
                expect(session.view().legacyAnalysisError).toContain("fingerprint changed");
                expect(session.view().legacyReady).toBe(false);
                expect(session.view().legacyNextAction).toMatchObject({ id: "ui.analysisFailedRetryImage" });
        });

        it("installs Profile Inspector only when missing before launching it", async () => {
                const backup = { backupPath: "b", manifestPath: "m", manifest: { profileId: owner.profileId, toolVersion: "1", nipSha256: "a", nipByteLength: 1, profileCount: 1, executableCount: 1, settingCount: 1 }, manifestSha256: "b" };
                const install = vi.fn(async () => ({ installPath: "i", executablePath: "e", manifest: { version: "1", sourceCommit: "c", releaseUrl: "u", assetSha256: "a" }, manifestSha256: "m", installedNow: true }));
                const launch = vi.fn(async () => ({ profileId: owner.profileId, processId: 1, executablePath: "e", executableSha256: "s", elevated: true, backup, warnings: [] }));
                const session = await start("configureNvidiaApplications", { installNvidiaProfileInspector: install, launchNvidiaProfileInspector: launch });
                await session.dispatch({ type: "openInspector" });
                await session.dispatch({ type: "openInspector" });
                expect(install).toHaveBeenCalledTimes(1);
                expect(launch).toHaveBeenCalledTimes(2);
                expect(session.view().backup?.backupPath).toBe("b");
                expect(session.view().activeStep?.id).toBe("configureNvidiaApplications");
        });
});
