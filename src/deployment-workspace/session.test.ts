import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageDescriptor } from "../i18n-catalog";
import type {
        ApiError,
        FirmwareInjectionDiagnostic,
        SystemSnapshot,
} from "../types";
import type { DeploymentAdapter } from "./adapter";
import type { DeploymentPlan, MachineProfile, StepId } from "./contract";
import {
        createDeploymentWorkspaceSession,
        formatDeploymentError,
} from "./session";

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
        barSettings: {
                currentBootDxeState: "notObservedThisBoot",
                currentBootDxeReasonCode: "statusVariableMissing",
                controlEvidence: "notObserved",
                settingsAvailable: false,
                savedConfigurationState: "disabled",
                topologyToken: "topology",
                configToken: "configuration",
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
        schemaVersion: 4,
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
        firmwareTargetPolicy: "requireUnique",
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
        let reject!: (reason: unknown) => void;
        const promise = new Promise<T>((done, fail) => {
                resolve = done;
                reject = fail;
        });
        return { promise, resolve, reject };
};
const firmwareInjectionError = (
        diagnostic: FirmwareInjectionDiagnostic,
): ApiError => ({
        code: "firmware_injection_failed",
        message: `firmware injection failed: ${diagnostic.kind}`,
        recoverable: true,
        firmwareInjection: diagnostic,
});
const preparationPlan = (owner: MachineProfile): DeploymentPlan => ({
        schemaVersion: 1,
        profileId: owner.profileId,
        originalFirmwareSha256: owner.originalFirmware.sha256,
        recoveryMethod: owner.recovery.method,
        revision: 2,
        steps: [
                {
                        id: "verifyProfile",
                        kind: "automated",
                        title: "verify",
                        state: "completed",
                        evidence: { kind: "verifyProfile", value: "evidence" },
                },
                {
                        id: "prepareRustDriver",
                        kind: "automated",
                        title: "prepare",
                        state: "ready",
                        evidence: null,
                },
                {
                        id: "verifyPatchedArtifact",
                        kind: "automated",
                        title: "verify artifact",
                        state: "pending",
                        evidence: null,
                },
        ],
});
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

        it("defaults to a unique DXE target and preserves an explicit all-domain policy intent", async () => {
                const session = createDeploymentWorkspaceSession(
                        snapshot,
                        adapter({
                                listMachineProfiles: async () => [],
                                getNvidiaProfileInspectorInstallation:
                                        async () => null,
                        }),
                );
                await tick();

                expect(session.view().firmwareTargetPolicy).toBe(
                        "requireUnique",
                );
                await session.dispatch({
                        type: "setFirmwareTargetPolicy",
                        value: "patchEveryDxeDomain",
                });
                expect(session.view().firmwareTargetPolicy).toBe(
                        "patchEveryDxeDomain",
                );
        });

        it("submits the all-domain policy only with a confirmed boot-independent recovery route", async () => {
                const createMachineProfile = vi.fn(
                        async (
                                _request: Parameters<
                                        DeploymentAdapter["createMachineProfile"]
                                >[0],
                        ) => {
                                throw new Error("fixture stop");
                        },
                );
                const session = createDeploymentWorkspaceSession(
                        snapshot,
                        adapter({
                                listMachineProfiles: async () => [],
                                getNvidiaProfileInspectorInstallation:
                                        async () => null,
                                selectFirmwareImage: async () =>
                                        "C:\\firmware\\vendor.bin",
                                inspectFirmwareImage: async () => ({
                                        fileName: "vendor.bin",
                                        byteLength: 1_048_576,
                                        sha256: "a".repeat(64),
                                }),
                                createMachineProfile,
                        }),
                );
                await tick();
                await session.dispatch({ type: "chooseFirmware" });
                for (const intent of [
                        { type: "setDisplayName", value: "test profile" },
                        {
                                type: "setInstructionsUrl",
                                value: "https://example.test/manual",
                        },
                        { type: "setInstallNote", value: "install note" },
                        { type: "setRecoveryNote", value: "recovery note" },
                        { type: "setRouteConfirmed", value: true },
                        {
                                type: "setFirmwareTargetPolicy",
                                value: "patchEveryDxeDomain",
                        },
                ] as const)
                        await session.dispatch(intent);

                await session.dispatch({ type: "createProfile" });
                expect(createMachineProfile).not.toHaveBeenCalled();

                await session.dispatch({
                        type: "setRecoveryMethod",
                        value: "usbFlashback",
                });
                await session.dispatch({ type: "createProfile" });
                expect(createMachineProfile).toHaveBeenCalledOnce();
                expect(createMachineProfile.mock.calls[0]?.[0]).toMatchObject({
                        firmwareTargetPolicy: "patchEveryDxeDomain",
                        recovery: {
                                method: "usbFlashback",
                                testedOrDocumented: true,
                        },
                });
        });

        it("maps every firmware injection diagnostic to localized copy", () => {
                const cases: readonly [
                        FirmwareInjectionDiagnostic,
                        MessageDescriptor["id"],
                ][] = [
                        [
                                { kind: "invalidDriverFfs", detail: "bad FFS" },
                                "ui.firmwareInjectionInvalidDriverFfs",
                        ],
                        [
                                {
                                        kind: "invalidFirmware",
                                        detail: "bad image",
                                },
                                "ui.firmwareInjectionInvalidFirmware",
                        ],
                        [
                                { kind: "driverAlreadyPresent" },
                                "ui.firmwareInjectionDriverAlreadyPresent",
                        ],
                        [
                                {
                                        kind: "compressionFailure",
                                        detail: "rebuild failed",
                                },
                                "ui.firmwareInjectionCompressionFailure",
                        ],
                        [
                                {
                                        kind: "unsupportedCapsule",
                                        capsuleKind: "aptioSigned",
                                        headerSize: 32,
                                        bodyOffset: 64,
                                        flags: 0,
                                },
                                "ui.firmwareInjectionUnsupportedCapsule",
                        ],
                        [
                                {
                                        kind: "malformedCapsule",
                                        capsuleKind: "standard",
                                        detail: "body offset",
                                },
                                "ui.firmwareInjectionMalformedCapsule",
                        ],
                        [
                                {
                                        kind: "ambiguousDxeTargets",
                                        targets: [
                                                {
                                                        containerFileOffsets: [],
                                                        firmwareVolumeOffset: 64,
                                                },
                                                {
                                                        containerFileOffsets: [
                                                                288,
                                                        ],
                                                        firmwareVolumeOffset: 96,
                                                },
                                        ],
                                },
                                "ui.firmwareInjectionAmbiguousDxeTargets",
                        ],
                        [
                                {
                                        kind: "incompleteDxeTargetCensus",
                                        uninspectedContainers: [
                                                {
                                                        containerFileOffsets: [
                                                                288,
                                                        ],
                                                        firmwareVolumeOffset: 64,
                                                        fileOffset: 512,
                                                },
                                        ],
                                },
                                "ui.firmwareInjectionIncompleteDxeTargetCensus",
                        ],
                        [
                                {
                                        kind: "unsupportedDxeTarget",
                                        target: {
                                                containerFileOffsets: [288],
                                                firmwareVolumeOffset: 64,
                                        },
                                },
                                "ui.firmwareInjectionUnsupportedDxeTarget",
                        ],
                        [
                                { kind: "noDxeVolume" },
                                "ui.firmwareInjectionNoDxeVolume",
                        ],
                        [
                                {
                                        kind: "insufficientDxeSpace",
                                        target: {
                                                containerFileOffsets: [288],
                                                firmwareVolumeOffset: 64,
                                        },
                                        availableBytes: 3_016,
                                        requiredBytes: 34_904,
                                },
                                "ui.firmwareInjectionInsufficientDxeSpace",
                        ],
                        [
                                {
                                        kind: "recompressedContainerTooLarge",
                                        containerFileOffsets: [288],
                                        firmwareVolumeOffset: 64,
                                        fileOffset: 512,
                                        availableBytes: 90_112,
                                        requiredBytes: 91_744,
                                },
                                "ui.firmwareInjectionRecompressedContainerTooLarge",
                        ],
                ];

                for (const [diagnostic, expectedId] of cases)
                        expect(
                                formatDeploymentError(
                                        firmwareInjectionError(diagnostic),
                                ).id,
                        ).toBe(expectedId);
        });

        it("preserves exact capacity values and keeps a generic fallback", () => {
                expect(
                        formatDeploymentError(
                                firmwareInjectionError({
                                        kind: "insufficientDxeSpace",
                                        target: {
                                                containerFileOffsets: [288],
                                                firmwareVolumeOffset: 64,
                                        },
                                        availableBytes: 3_016,
                                        requiredBytes: 34_904,
                                }),
                        ),
                ).toEqual({
                        id: "ui.firmwareInjectionInsufficientDxeSpace",
                        values: {
                                availableBytes: 3_016,
                                requiredBytes: 34_904,
                        },
                });
                expect(
                        formatDeploymentError({
                                code: "firmware_injection_failed",
                                message: "future diagnostic detail",
                                recoverable: true,
                                firmwareInjection: { kind: "futureKind" },
                        }),
                ).toEqual({
                        id: "ui.deploymentOperationFailed",
                        values: { detail: "future diagnostic detail" },
                });
                expect(
                        formatDeploymentError({
                                code: "firmware_injection_failed",
                                message: "malformed capacity detail",
                                recoverable: true,
                                firmwareInjection: {
                                        kind: "insufficientDxeSpace",
                                        availableBytes: "3016",
                                        requiredBytes: 34_904,
                                },
                        }),
                ).toEqual({
                        id: "ui.deploymentOperationFailed",
                        values: { detail: "malformed capacity detail" },
                });
        });

        it("keeps the inspected source when profile feasibility fails", async () => {
                const failure = firmwareInjectionError({
                        kind: "noDxeVolume",
                });
                const session = createDeploymentWorkspaceSession(
                        snapshot,
                        adapter({
                                listMachineProfiles: async () => [],
                                getNvidiaProfileInspectorInstallation:
                                        async () => null,
                                selectFirmwareImage: async () =>
                                        "C:\\firmware\\vendor.bin",
                                inspectFirmwareImage: async () => ({
                                        fileName: "vendor.bin",
                                        byteLength: 1_048_576,
                                        sha256: "a".repeat(64),
                                }),
                                createMachineProfile: async () => {
                                        throw failure;
                                },
                        }),
                );
                await tick();
                await session.dispatch({ type: "chooseFirmware" });
                await session.dispatch({ type: "createProfile" });

                expect(session.view()).toMatchObject({
                        firmwarePath: "C:\\firmware\\vendor.bin",
                        firmware: { sha256: "a".repeat(64) },
                        profiles: [],
                        selectedProfileId: "",
                        plan: null,
                        preparation: null,
                        busyAction: "",
                        activity: {
                                tone: "error",
                                message: {
                                        id: "ui.firmwareInjectionNoDxeVolume",
                                },
                        },
                });
        });

        it("keeps the plan and suppresses duplicate preparation after a feasibility error", async () => {
                const owner = profile("p1");
                const before = preparationPlan(owner);
                const pending =
                        deferred<
                                Awaited<
                                        ReturnType<
                                                DeploymentAdapter["prepareFirmwareArtifact"]
                                        >
                                >
                        >();
                const prepareFirmwareArtifact = vi.fn(() => pending.promise);
                const session = createDeploymentWorkspaceSession(
                        snapshot,
                        adapter({
                                listMachineProfiles: async () => [owner],
                                getNvidiaProfileInspectorInstallation:
                                        async () => null,
                                getDeploymentPlan: async () => before,
                                prepareFirmwareArtifact,
                        }),
                );
                await tick();
                const first = session.dispatch({ type: "prepare" });
                const duplicate = session.dispatch({ type: "prepare" });
                expect(prepareFirmwareArtifact).toHaveBeenCalledTimes(1);
                pending.reject(
                        firmwareInjectionError({
                                kind: "recompressedContainerTooLarge",
                                containerFileOffsets: [288],
                                firmwareVolumeOffset: 64,
                                fileOffset: 512,
                                availableBytes: 90_112,
                                requiredBytes: 91_744,
                        }),
                );
                await Promise.all([first, duplicate]);

                expect(session.view()).toMatchObject({
                        plan: before,
                        preparation: null,
                        busyAction: "",
                        activity: {
                                tone: "error",
                                message: {
                                        id: "ui.firmwareInjectionRecompressedContainerTooLarge",
                                        values: {
                                                availableBytes: 90_112,
                                                requiredBytes: 91_744,
                                        },
                                },
                        },
                });
        });

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
                        firmwareInjectionReceipt: null,
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
