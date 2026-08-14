import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemSnapshot } from "../types";
import type { DeploymentAdapter } from "./adapter";
import type { DeploymentPlan, MachineProfile, StepId } from "./contract";
import { createDeploymentWorkspaceSession } from "./session";

const snapshot: SystemSnapshot = {
        schemaVersion: 1,
        platform: {
                operatingSystem: "windows",
                architecture: "x86_64",
                supported: true,
                uefi: true,
                elevated: true,
        },
        firmware: {
                accessible: true,
                privilegeEnabled: true,
                configVariablePresent: true,
                accessError: null,
        },
        driverStatus: {
                raw: "0x14",
                code: 20,
                kind: "configured",
                label: "Configured",
                severity: "success",
                pciLocation: null,
        },
        config: null,
        devices: [],
        machineIdentity: null,
        hardwareSupport: {
                motherboardNativeResizableBar: {
                        state: "unknown",
                        reasonCode: "machineIdentityUnavailable",
                        catalogId: null,
                },
                targetGpuFamily: {
                        state: "unknown",
                        reasonCode: "noGpusDetected",
                },
                overallState: "unknown",
        },
        notices: [],
};
const profile = (id: string): MachineProfile => ({
        schemaVersion: 3,
        profileId: id,
        displayName: id,
        boardPath: "nativeResizableBar",
        legacyPatches: null,
        identity: {
                boardManufacturer: "M",
                boardProduct: "P",
                boardVersion: "V",
                biosVendor: "B",
                biosVersion: "1",
                biosReleaseDate: "D",
                gpus: [],
        },
        originalFirmware: {
                fileName: "firmware.bin",
                byteLength: 1,
                sha256: `${id}0`.repeat(32).slice(0, 64),
        },
        recovery: {
                method: "usbFlashback",
                testedOrDocumented: true,
                note: "test",
        },
        firmwareInstall: null,
});
const order: StepId[] = [
        "verifyProfile",
        "writeNvstrapsConfiguration",
        "rebootAfterConfiguration",
        "configureNvidiaApplications",
];
const plan = (
        owner: MachineProfile,
        activeIndex: number,
        revision = activeIndex + 1,
): DeploymentPlan => ({
        schemaVersion: 1,
        profileId: owner.profileId,
        originalFirmwareSha256: owner.originalFirmware.sha256,
        recoveryMethod: owner.recovery.method,
        revision,
        steps: order.map((id, index) => ({
                id,
                kind:
                        id === "configureNvidiaApplications"
                                ? "externalTool"
                                : id === "rebootAfterConfiguration"
                                  ? "reboot"
                                  : "automated",
                title: id,
                state:
                        index < activeIndex
                                ? "completed"
                                : index === activeIndex
                                  ? "ready"
                                  : "pending",
                evidence:
                        index < activeIndex
                                ? { kind: id, value: "evidence" }
                                : null,
        })),
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = <T>() => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((done) => {
                resolve = done;
        });
        return { promise, resolve };
};
const adapter = (overrides: Partial<DeploymentAdapter>): DeploymentAdapter =>
        new Proxy(overrides as DeploymentAdapter, {
                get(target, property) {
                        if (property in target)
                                return target[
                                        property as keyof DeploymentAdapter
                                ];
                        return vi.fn(async () => null);
                },
        });

describe("DeploymentWorkspaceSession", () => {
        beforeEach(() => vi.restoreAllMocks());

        it("uses the Rust catalog ID for MSI route defaults", () => {
                const catalogSnapshot = structuredClone(snapshot);
                catalogSnapshot.hardwareSupport.motherboardNativeResizableBar = {
                        state: "supported",
                        reasonCode: "exactMotherboardCatalogMatch",
                        catalogId: "msi-pro-z690-a-ddr4-ms-7d25",
                };
                const session = createDeploymentWorkspaceSession(
                        catalogSnapshot,
                        adapter({
                                listMachineProfiles: async () => [],
                                getNvidiaProfileInspectorInstallation:
                                        async () => null,
                        }),
                );

                expect(session.view()).toMatchObject({
                        displayName: "PRO Z690-A DDR4 · RTX 2080 SUPER",
                        recoveryMethod: "usbFlashback",
                        instructionsUrl: expect.stringContaining(
                                "PROZ690-AWIFIDDR4",
                        ),
                        installNote:
                                "Use M-FLASH to select the exported vendor-format image.",
                });
        });

        it("projects the literal step immediately after the active plan step", async () => {
                const owner = profile("p1");
                const session = createDeploymentWorkspaceSession(
                        snapshot,
                        adapter({
                                listMachineProfiles: async () => [owner],
                                getNvidiaProfileInspectorInstallation:
                                        async () => null,
                                getDeploymentPlan: async () => plan(owner, 1),
                        }),
                );
                await tick();
                expect(session.view().activeStep?.id).toBe(
                        "writeNvstrapsConfiguration",
                );
                expect(session.view().nextStep?.id).toBe(
                        "rebootAfterConfiguration",
                );
        });

        it("has no next step when the active step is last", async () => {
                const owner = profile("p1");
                const session = createDeploymentWorkspaceSession(
                        snapshot,
                        adapter({
                                listMachineProfiles: async () => [owner],
                                getNvidiaProfileInspectorInstallation:
                                        async () => null,
                                getDeploymentPlan: async () => plan(owner, 3),
                        }),
                );
                await tick();
                expect(session.view().activeStep?.id).toBe(
                        "configureNvidiaApplications",
                );
                expect(session.view().nextStep).toBeNull();
        });

        it("has no next step without a plan or after plan completion", async () => {
                const empty = createDeploymentWorkspaceSession(
                        snapshot,
                        adapter({
                                listMachineProfiles: async () => [],
                                getNvidiaProfileInspectorInstallation:
                                        async () => null,
                        }),
                );
                await tick();
                expect(empty.view().plan).toBeNull();
                expect(empty.view().nextStep).toBeNull();

                const owner = profile("p1");
                const complete = createDeploymentWorkspaceSession(
                        snapshot,
                        adapter({
                                listMachineProfiles: async () => [owner],
                                getNvidiaProfileInspectorInstallation:
                                        async () => null,
                                getDeploymentPlan: async () =>
                                        plan(owner, order.length),
                        }),
                );
                await tick();
                expect(complete.view().activeStep).toBeNull();
                expect(complete.view().nextStep).toBeNull();
        });

        it("rejects a stale profile plan response after profile selection changes", async () => {
                const first = profile("p1"),
                        second = profile("p2");
                const p1 = deferred<DeploymentPlan>(),
                        p2 = deferred<DeploymentPlan>();
                const session = createDeploymentWorkspaceSession(
                        snapshot,
                        adapter({
                                listMachineProfiles: async () => [
                                        first,
                                        second,
                                ],
                                getNvidiaProfileInspectorInstallation:
                                        async () => null,
                                getDeploymentPlan: (id) =>
                                        id === first.profileId
                                                ? p1.promise
                                                : p2.promise,
                        }),
                );
                await tick();
                const selecting = session.dispatch({
                        type: "setSelectedProfile",
                        value: second.profileId,
                });
                p2.resolve(plan(second, 1));
                await selecting;
                expect(session.view().nextStep?.id).toBe(
                        "rebootAfterConfiguration",
                );
                p1.resolve(plan(first, 2));
                await tick();
                expect(session.view().selectedProfileId).toBe(second.profileId);
                expect(session.view().plan?.profileId).toBe(second.profileId);
                expect(session.view().nextStep?.id).toBe(
                        "rebootAfterConfiguration",
                );
        });

        it("does not leak a deferred workflow response after profile selection changes", async () => {
                const first = profile("p1"),
                        second = profile("p2");
                const workflowPlan = (
                        owner: MachineProfile,
                        state: "before" | "after",
                ): DeploymentPlan => ({
                        schemaVersion: 1,
                        profileId: owner.profileId,
                        originalFirmwareSha256: owner.originalFirmware.sha256,
                        recoveryMethod: owner.recovery.method,
                        revision: state === "before" ? 1 : 3,
                        steps: [
                                {
                                        id: "verifyProfile",
                                        kind: "automated",
                                        title: "verify",
                                        state: "completed",
                                        evidence: {
                                                kind: "verifyProfile",
                                                value: "evidence",
                                        },
                                },
                                {
                                        id: "prepareRustDriver",
                                        kind: "automated",
                                        title: "prepare",
                                        state:
                                                state === "before"
                                                        ? "ready"
                                                        : "completed",
                                        evidence:
                                                state === "after"
                                                        ? {
                                                                  kind: "prepareRustDriver",
                                                                  value: "driver",
                                                          }
                                                        : null,
                                },
                                {
                                        id: "verifyPatchedArtifact",
                                        kind: "automated",
                                        title: "verify artifact",
                                        state:
                                                state === "before"
                                                        ? "pending"
                                                        : "completed",
                                        evidence:
                                                state === "after"
                                                        ? {
                                                                  kind: "verifyPatchedArtifact",
                                                                  value: "artifact",
                                                          }
                                                        : null,
                                },
                                {
                                        id: "configureNvidiaApplications",
                                        kind: "externalTool",
                                        title: "policy",
                                        state:
                                                state === "before"
                                                        ? "pending"
                                                        : "ready",
                                        evidence: null,
                                },
                        ],
                });
                const pending =
                        deferred<
                                Awaited<
                                        ReturnType<
                                                DeploymentAdapter["prepareFirmwareArtifact"]
                                        >
                                >
                        >();
                const session = createDeploymentWorkspaceSession(
                        snapshot,
                        adapter({
                                listMachineProfiles: async () => [
                                        first,
                                        second,
                                ],
                                getNvidiaProfileInspectorInstallation:
                                        async () => null,
                                getDeploymentPlan: async (id) =>
                                        workflowPlan(
                                                id === first.profileId
                                                        ? first
                                                        : second,
                                                "before",
                                        ),
                                prepareFirmwareArtifact: () => pending.promise,
                        }),
                );
                await tick();
                const preparing = session.dispatch({ type: "prepare" });
                await session.dispatch({
                        type: "setSelectedProfile",
                        value: second.profileId,
                });
                pending.resolve({
                        plan: workflowPlan(first, "after"),
                        driver: {
                                kind: "driver",
                                path: "old-driver",
                                byteLength: 1,
                                sha256: "a".repeat(64),
                        },
                        legacyPatchedFirmware: null,
                        legacyPatchReceipt: null,
                        legacyPatch: null,
                        patchedFirmware: {
                                kind: "artifact",
                                path: "old-artifact",
                                byteLength: 1,
                                sha256: "b".repeat(64),
                        },
                        injection: null,
                });
                await preparing;
                expect(session.view().selectedProfileId).toBe(second.profileId);
                expect(session.view().plan?.profileId).toBe(second.profileId);
                expect(session.view().preparation).toBeNull();
                expect(session.view().activity).toBeNull();
        });

        it("suppresses duplicate configuration submits while one is in flight", async () => {
                const owner = profile("p1");
                const pending =
                        deferred<
                                Awaited<
                                        ReturnType<
                                                DeploymentAdapter["saveDeploymentConfig"]
                                        >
                                >
                        >();
                const saveDeploymentConfig = vi.fn(() => pending.promise);
                const session = createDeploymentWorkspaceSession(
                        snapshot,
                        adapter({
                                listMachineProfiles: async () => [owner],
                                getNvidiaProfileInspectorInstallation:
                                        async () => null,
                                getDeploymentPlan: async () =>
                                        plan(owner, 1, 2),
                                getRecommendedDeploymentConfig: async () => ({
                                        draft: {
                                                globalMode: 1,
                                                targetPciBarSize: 0,
                                                skipS3Resume: false,
                                                overrideBarSizeMask: false,
                                                guardSetupChanges: true,
                                                rules: [],
                                        },
                                        turingGpuCount: 1,
                                        registryManagedGpuCount: 1,
                                        exactFallbackRuleCount: 0,
                                }),
                                saveDeploymentConfig,
                        }),
                );
                await tick();
                await tick();
                await session.dispatch({
                        type: "setGuardedConfigConfirmed",
                        value: true,
                });
                const first = session.dispatch({ type: "saveGuardedConfig" });
                const second = session.dispatch({ type: "saveGuardedConfig" });
                expect(saveDeploymentConfig).toHaveBeenCalledTimes(1);
                const next = plan(owner, 2, 3);
                pending.resolve({
                        plan: next,
                        save: {
                                savedAtUnixMs: "1",
                                bytesWritten: 45,
                                variablePresent: true,
                                rebootRequired: true,
                                draft: {
                                        globalMode: 1,
                                        targetPciBarSize: 0,
                                        skipS3Resume: false,
                                        overrideBarSizeMask: false,
                                        guardSetupChanges: true,
                                        rules: [],
                                },
                        },
                });
                await Promise.all([first, second]);
                expect(session.view().plan?.revision).toBe(3);
        });

        it.each([
                [
                        "profile",
                        (value: DeploymentPlan) => ({
                                ...value,
                                profileId: "wrong",
                        }),
                        "different profile contract",
                ],
                [
                        "revision",
                        (value: DeploymentPlan) => ({
                                ...value,
                                revision: value.revision + 1,
                        }),
                        "unexpected deployment plan revision",
                ],
                [
                        "step",
                        (value: DeploymentPlan) => ({
                                ...value,
                                steps: value.steps.map((step, index) =>
                                        index === 1
                                                ? {
                                                          ...step,
                                                          state: "ready" as const,
                                                          evidence: null,
                                                  }
                                                : index === 2
                                                  ? {
                                                            ...step,
                                                            state: "completed" as const,
                                                            evidence: {
                                                                    kind: step.id,
                                                                    value: "bad",
                                                            },
                                                    }
                                                  : step,
                                ),
                        }),
                        "advanced unexpected deployment steps",
                ],
        ])(
                "rejects a wrong %s receipt without applying it",
                async (_kind, corrupt, message) => {
                        const owner = profile("p1"),
                                before = plan(owner, 1, 2);
                        const valid = plan(owner, 2, 3);
                        const session = createDeploymentWorkspaceSession(
                                snapshot,
                                adapter({
                                        listMachineProfiles: async () => [
                                                owner,
                                        ],
                                        getNvidiaProfileInspectorInstallation:
                                                async () => null,
                                        getDeploymentPlan: async () => before,
                                        getRecommendedDeploymentConfig:
                                                async () => ({
                                                        draft: {
                                                                globalMode: 1,
                                                                targetPciBarSize: 0,
                                                                skipS3Resume: false,
                                                                overrideBarSizeMask: false,
                                                                guardSetupChanges: true,
                                                                rules: [],
                                                        },
                                                        turingGpuCount: 1,
                                                        registryManagedGpuCount: 1,
                                                        exactFallbackRuleCount: 0,
                                                }),
                                        saveDeploymentConfig: async (
                                                _id,
                                                draft,
                                        ) => ({
                                                plan: corrupt(valid),
                                                save: {
                                                        savedAtUnixMs: "1",
                                                        bytesWritten: 45,
                                                        variablePresent: true,
                                                        rebootRequired: true,
                                                        draft,
                                                },
                                        }),
                                }),
                        );
                        await tick();
                        await tick();
                        await session.dispatch({
                                type: "setGuardedConfigConfirmed",
                                value: true,
                        });
                        await session.dispatch({ type: "saveGuardedConfig" });
                        expect(session.view().plan?.revision).toBe(
                                before.revision,
                        );
                        expect(session.view().activity?.message).toMatchObject({
                                id: "ui.deploymentOperationFailed",
                                values: {
                                        detail: expect.stringContaining(message),
                                },
                        });
                },
        );

        it("does not advance the plan when a reboot request is accepted", async () => {
                const owner = profile("p1"),
                        before = plan(owner, 2, 3);
                const session = createDeploymentWorkspaceSession(
                        snapshot,
                        adapter({
                                listMachineProfiles: async () => [owner],
                                getNvidiaProfileInspectorInstallation:
                                        async () => null,
                                getDeploymentPlan: async () => before,
                                previewConfigurationReboot: async () => ({
                                        profileId: owner.profileId,
                                        planRevision: 3,
                                        confirmationToken: "token",
                                        command: "shutdown",
                                        arguments: ["/r"],
                                        immediate: true,
                                        forceCloseApplications: false,
                                        warnings: [],
                                }),
                                rebootAfterConfiguration: async () => ({
                                        profileId: owner.profileId,
                                        accepted: true,
                                        planAdvanced: false,
                                }),
                        }),
                );
                await tick();
                await session.dispatch({ type: "openConfigurationReboot" });
                await session.dispatch({ type: "setSavedWork", value: true });
                await session.dispatch({ type: "requestConfigurationReboot" });
                expect(session.view().plan?.revision).toBe(3);
                expect(session.view().workflowReceipt?.detail).toEqual({
                        id: "ui.returnAfterWindowsBootsThenCheckTheBootTime",
                });
        });

        it("binds a manual preview to the current profile, step and revision", async () => {
                const owner = profile("p1"),
                        before = plan(owner, 3, 4);
                const confirm = vi.fn();
                const session = createDeploymentWorkspaceSession(
                        snapshot,
                        adapter({
                                listMachineProfiles: async () => [owner],
                                getNvidiaProfileInspectorInstallation:
                                        async () => null,
                                getDeploymentPlan: async () => before,
                                previewManualDeploymentStep: async () => ({
                                        profileId: owner.profileId,
                                        planRevision: 3,
                                        stepId: "configureNvidiaApplications",
                                        title: "Configure NVIDIA application profiles",
                                        confirmationToken: "bound-token",
                                        warnings: [],
                                }),
                                confirmManualDeploymentStep: confirm,
                        }),
                );
                await tick();
                await session.dispatch({ type: "openManual" });
                expect(session.view().showManual).toBe(false);
                expect(session.view().activity?.message).toMatchObject({
                        id: "ui.deploymentOperationFailed",
                        values: {
                                detail: expect.stringContaining("plan changed"),
                        },
                });
                expect(confirm).not.toHaveBeenCalled();
        });

        it("launching Profile Inspector never completes the policy step", async () => {
                const owner = profile("p1"),
                        before = plan(owner, 3, 4);
                const backup = {
                        backupPath: "b",
                        manifestPath: "m",
                        manifest: {
                                profileId: owner.profileId,
                                toolVersion: "1",
                                nipSha256: "a".repeat(64),
                                nipByteLength: 1,
                                profileCount: 1,
                                executableCount: 1,
                                settingCount: 1,
                        },
                        manifestSha256: "b".repeat(64),
                };
                const session = createDeploymentWorkspaceSession(
                        snapshot,
                        adapter({
                                listMachineProfiles: async () => [owner],
                                getNvidiaProfileInspectorInstallation:
                                        async () => ({
                                                installPath: "i",
                                                executablePath: "e",
                                                manifest: {
                                                        version: "1",
                                                        sourceCommit: "c",
                                                        releaseUrl: "u",
                                                        assetSha256: "a",
                                                },
                                                manifestSha256: "m",
                                                installedNow: false,
                                        }),
                                getDeploymentPlan: async () => before,
                                launchNvidiaProfileInspector: async () => ({
                                        profileId: owner.profileId,
                                        processId: 1,
                                        executablePath: "e",
                                        executableSha256: "s",
                                        elevated: true,
                                        backup,
                                        warnings: [],
                                }),
                        }),
                );
                await tick();
                await session.dispatch({ type: "launchInspector" });
                expect(session.view().plan).toEqual(before);
                expect(session.view().activeStep?.id).toBe(
                        "configureNvidiaApplications",
                );
        });
});
