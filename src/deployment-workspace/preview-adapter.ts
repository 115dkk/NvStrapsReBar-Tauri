import type { ConfigDraft, MachineIdentity } from "../types";
import type { DeploymentAdapter } from "./adapter";
import type {
        DeploymentPlan,
        FirmwareFingerprint,
        LegacyFirmwareAnalysis,
        MachineProfile,
        NvidiaProfileBackupReceipt,
        NvidiaSmiEvidence,
        ProfileInspectorInstallation,
        StepId,
} from "./contract";

const clone = <T>(value: T): T => structuredClone(value);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const profileKey = "nvstraps-preview-profiles";
const cursorKey = (profileId: string) =>
        `nvstraps-preview-fixture-cursor:${profileId}`;
const savedConfigKey = (profileId: string) =>
        `nvstraps-preview-config-time:${profileId}`;
const firmware: FirmwareFingerprint = {
        fileName: "E7D25IMS.1N0",
        byteLength: 33554432,
        sha256: "71".repeat(32),
};
const firmwareFor = (path: string): FirmwareFingerprint =>
        path.toLowerCase().includes("changed-fingerprint")
                ? {
                          fileName: "changed-fingerprint.bin",
                          byteLength: firmware.byteLength,
                          sha256: "93".repeat(32),
                  }
                : firmware;
const sameFirmware = (left: FirmwareFingerprint, right: FirmwareFingerprint) =>
        left.fileName === right.fileName &&
        left.byteLength === right.byteLength &&
        left.sha256 === right.sha256;
const identity: MachineIdentity = {
        boardManufacturer: "Micro-Star International Co., Ltd.",
        boardProduct: "PRO Z690-A DDR4(MS-7D25)",
        boardVersion: "1.0",
        biosVendor: "American Megatrends International, LLC.",
        biosVersion: "1.N0",
        biosReleaseDate: "2026-03-12",
        gpus: [
                {
                        vendorId: 0x10de,
                        deviceId: 0x1e81,
                        subsystemVendorId: 0x1462,
                        subsystemDeviceId: 0x3755,
                        location: { bus: 1, device: 0, function: 0 },
                        bridgeLocation: { bus: 0, device: 1, function: 0 },
                        bar0Base: 2147483648,
                        bar0Top: 2164260863,
                },
        ],
};

type StepFixture = readonly [
        StepId,
        DeploymentPlan["steps"][number]["kind"],
        string,
];
const baseSteps: readonly StepFixture[] = Object.freeze([
        [
                "verifyProfile",
                "automated",
                "Compare current hardware, BIOS, topology, and source image",
        ],
        [
                "confirmRecovery",
                "physicalConfirmation",
                "Record the firmware recovery route",
        ],
        [
                "preserveOriginalFirmware",
                "automated",
                "Preserve and hash the source firmware image",
        ],
        [
                "prepareRustDriver",
                "automated",
                "Build and inspect the Rust DXE driver",
        ],
        [
                "verifyPatchedArtifact",
                "automated",
                "Inject the driver and inspect the firmware artifact",
        ],
        [
                "flashWithVendorRoute",
                "firmwareManual",
                "Flash with the documented vendor route",
        ],
        [
                "configureFirmwareSetup",
                "firmwareManual",
                "Confirm firmware setup values",
        ],
        [
                "rebootAfterFirmware",
                "reboot",
                "Boot Windows after the firmware handoff",
        ],
        [
                "verifyDriverLoaded",
                "automated",
                "Read the firmware driver status",
        ],
        [
                "writeNvstrapsConfiguration",
                "automated",
                "Write and read back the NvStrapsReBar configuration",
        ],
        ["rebootAfterConfiguration", "reboot", "Restart after configuration"],
        [
                "verifyResizableBar",
                "automated",
                "Observe Resizable BAR through NVIDIA telemetry",
        ],
        [
                "configureNvidiaApplications",
                "externalTool",
                "Configure NVIDIA application profiles",
        ],
]);
const legacyStep: StepFixture = [
        "applyLegacyBoardPatches",
        "automated",
        "Apply the profile's legacy-board patch bundle",
];
const loadProfiles = (): MachineProfile[] =>
        JSON.parse(
                sessionStorage.getItem(profileKey) ?? "[]",
        ) as MachineProfile[];
const saveProfiles = (profiles: MachineProfile[]) =>
        sessionStorage.setItem(profileKey, JSON.stringify(profiles));
const fixturesFor = (profile: MachineProfile): readonly StepFixture[] =>
        profile.boardPath === "legacyAbove4g"
                ? [...baseSteps.slice(0, 4), legacyStep, ...baseSteps.slice(4)]
                : baseSteps;
type PlanCursor =
        | "created"
        | "prepared"
        | "flashed"
        | "setup"
        | "driver"
        | "configured"
        | "returned"
        | "bar"
        | "complete";
type State = DeploymentPlan["steps"][number]["state"];
type SnapshotFixture = Readonly<{ revision: number; states: readonly State[] }>;
const NATIVE_SNAPSHOTS: Readonly<Record<PlanCursor, SnapshotFixture>> =
        Object.freeze({
                created: {
                        revision: 4,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                        ],
                },
                prepared: {
                        revision: 6,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                        ],
                },
                flashed: {
                        revision: 7,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                        ],
                },
                setup: {
                        revision: 8,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                        ],
                },
                driver: {
                        revision: 10,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                                "pending",
                                "pending",
                                "pending",
                        ],
                },
                configured: {
                        revision: 11,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                                "pending",
                                "pending",
                        ],
                },
                returned: {
                        revision: 12,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                                "pending",
                        ],
                },
                bar: {
                        revision: 13,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                        ],
                },
                complete: {
                        revision: 14,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                        ],
                },
        });
const LEGACY_SNAPSHOTS: Readonly<Record<PlanCursor, SnapshotFixture>> =
        Object.freeze({
                created: {
                        revision: 4,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                        ],
                },
                prepared: {
                        revision: 7,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                        ],
                },
                flashed: {
                        revision: 8,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                        ],
                },
                setup: {
                        revision: 9,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                                "pending",
                        ],
                },
                driver: {
                        revision: 11,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                                "pending",
                                "pending",
                                "pending",
                        ],
                },
                configured: {
                        revision: 12,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                                "pending",
                                "pending",
                        ],
                },
                returned: {
                        revision: 13,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                                "pending",
                        ],
                },
                bar: {
                        revision: 14,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "ready",
                        ],
                },
                complete: {
                        revision: 15,
                        states: [
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                                "completed",
                        ],
                },
        });
const loadCursor = (profileId: string): PlanCursor =>
        (sessionStorage.getItem(cursorKey(profileId)) as PlanCursor | null) ??
        "created";
const saveCursor = (profileId: string, cursor: PlanCursor) =>
        sessionStorage.setItem(cursorKey(profileId), cursor);
const planSnapshot = (
        profile: MachineProfile,
        cursor = loadCursor(profile.profileId),
): DeploymentPlan => {
        const snapshot = (
                profile.boardPath === "legacyAbove4g"
                        ? LEGACY_SNAPSHOTS
                        : NATIVE_SNAPSHOTS
        )[cursor];
        return {
                schemaVersion: 1,
                profileId: profile.profileId,
                originalFirmwareSha256: profile.originalFirmware.sha256,
                recoveryMethod: profile.recovery.method,
                revision: snapshot.revision,
                steps: fixturesFor(profile).map(([id, kind, title], index) => ({
                        id,
                        kind,
                        title,
                        state: snapshot.states[index]!,
                        evidence:
                                snapshot.states[index] === "completed"
                                        ? {
                                                  kind: id,
                                                  value:
                                                          id ===
                                                          "writeNvstrapsConfiguration"
                                                                  ? (sessionStorage.getItem(
                                                                            savedConfigKey(
                                                                                    profile.profileId,
                                                                            ),
                                                                    ) ??
                                                                    "preview-evidence")
                                                                  : "preview-evidence",
                                          }
                                        : null,
                })),
        };
};
const profileFor = (profileId: string) => {
        const profile = loadProfiles().find(
                (candidate) => candidate.profileId === profileId,
        );
        if (!profile)
                throw new Error(
                        "The selected deployment profile is unavailable.",
                );
        return profile;
};
const MANUAL_PREVIEW_FIXTURES = Object.freeze({
        flashed: {
                stepId: "flashWithVendorRoute" as const,
                title: "Flash with the documented vendor route",
                warnings: [
                        "Select the exported artifact in the documented vendor tool.",
                        "Record completion after the vendor tool reports success.",
                        "Keep power connected during flashing and keep the recovery files nearby.",
                ],
        },
        setupNative: {
                stepId: "configureFirmwareSetup" as const,
                title: "Confirm firmware setup values",
                warnings: [
                        "Enable native ReBAR and Above 4G decoding, and disable CSM.",
                        "Save these firmware setup values, then return to record the step.",
                ],
        },
        setupLegacy: {
                stepId: "configureFirmwareSetup" as const,
                title: "Confirm firmware setup values",
                warnings: [
                        "Enable Above 4G decoding and disable CSM. This legacy route uses NvStrapsReBar instead of native motherboard ReBAR.",
                        "Save these firmware setup values, then return to record the step.",
                ],
        },
        complete: {
                stepId: "configureNvidiaApplications" as const,
                title: "Configure NVIDIA application profiles",
                warnings: [
                        "Apply and review the intended per-application ReBAR policy.",
                        "Return after editing the policy and record the result.",
                ],
        },
});
const legacyAnalysis: LegacyFirmwareAnalysis = {
        firmware: clone(firmware),
        upstreamCommit: "9c80fdb2cd3db94bdd19c58bd00d5ecf822f6430",
        catalogs: [
                {
                        catalog: "general",
                        sourceSha256: "8a".repeat(32),
                        rules: [
                                {
                                        ruleId: "4b".repeat(32),
                                        description:
                                                "Above 4G decoding compatibility rule",
                                        sectionType: 16,
                                        requiredRisks: [],
                                        status: "applicable",
                                        expectedMatches: 1,
                                        blockedReason: null,
                                        recommended: true,
                                },
                                {
                                        ruleId: "5c".repeat(32),
                                        description:
                                                "DSDT resource-window compatibility patch",
                                        sectionType: 16,
                                        requiredRisks: ["dsdtModification"],
                                        status: "applicable",
                                        expectedMatches: 1,
                                        blockedReason: null,
                                        recommended: false,
                                },
                                {
                                        ruleId: "6d".repeat(32),
                                        description:
                                                "Already absent compatibility pattern",
                                        sectionType: 16,
                                        requiredRisks: [],
                                        status: "absent",
                                        expectedMatches: null,
                                        blockedReason: null,
                                        recommended: false,
                                },
                                {
                                        ruleId: "7e".repeat(32),
                                        description:
                                                "Compressed vendor-specific compatibility patch",
                                        sectionType: 16,
                                        requiredRisks: [],
                                        status: "blocked",
                                        expectedMatches: null,
                                        blockedReason:
                                                "This build does not support the compressed section.",
                                        recommended: false,
                                },
                        ],
                },
        ],
};
const backupReceipt = (profileId: string): NvidiaProfileBackupReceipt => ({
        backupPath: `C:\\ProgramData\\NvStrapsReBar\\backups\\${profileId}.nip`,
        manifestPath: `C:\\ProgramData\\NvStrapsReBar\\backups\\${profileId}.json`,
        manifest: {
                profileId,
                toolVersion: "v3.0.2.1",
                nipSha256: "94".repeat(32),
                nipByteLength: 18432,
                profileCount: 12,
                executableCount: 8,
                settingCount: 37,
        },
        manifestSha256: "a5".repeat(32),
});
let installation: ProfileInspectorInstallation | null = null;

export const previewDeploymentAdapter: DeploymentAdapter = {
        selectFirmwareImage: async () => "C:\\Firmware\\E7D25IMS.1N0",
        selectDestinationDirectory: async () => "C:\\NVSTRAPS-USB",
        inspectFirmwareImage: async (path) => clone(firmwareFor(path)),
        analyzeLegacyFirmware: async () => {
                await wait(100);
                return clone(legacyAnalysis);
        },
        createMachineProfile: async (request) => {
                const actual = firmwareFor(request.firmwarePath);
                if (!sameFirmware(request.expectedFirmware, actual))
                        throw new Error(
                                "The source firmware changed after inspection; inspect this image again.",
                        );
                const profileId = `nvstraps-${actual.sha256.slice(0, 16)}`;
                const profileIdentity = clone(identity);
                if (actual.fileName === "changed-fingerprint.bin")
                        profileIdentity.gpus[0]!.deviceId = 0x1f81;
                const profile: MachineProfile = {
                        schemaVersion: 3,
                        profileId,
                        displayName: request.displayName,
                        boardPath: request.boardPath,
                        legacyPatches: request.legacyPatches ?? null,
                        identity: profileIdentity,
                        originalFirmware: clone(actual),
                        recovery: clone(request.recovery),
                        firmwareInstall: clone(request.firmwareInstall),
                };
                const profiles = [
                        profile,
                        ...loadProfiles().filter(
                                (candidate) =>
                                        candidate.profileId !== profileId,
                        ),
                ];
                saveProfiles(profiles);
                saveCursor(profileId, "created");
                return {
                        profile: clone(profile),
                        plan: planSnapshot(profile),
                        originalFirmwarePath: `C:\\ProgramData\\NvStrapsReBar\\${profileId}\\original.bin`,
                };
        },
        listMachineProfiles: async () => clone(loadProfiles()),
        getDeploymentPlan: async (profileId) =>
                clone(planSnapshot(profileFor(profileId))),
        compareMachineProfile: async (profileId) => {
                const profile = profileFor(profileId);
                const mismatch =
                        sessionStorage.getItem(
                                "nvstraps-preview-profile-mismatch",
                        ) === "bios";
                return {
                        profile: clone(profile),
                        currentIdentity: clone(identity),
                        firmware: clone(firmware),
                        result: {
                                differences: mismatch
                                        ? [
                                                  {
                                                          kind: "biosVersion",
                                                          expected: profile
                                                                  .identity
                                                                  .biosVersion,
                                                          actual: "MISMATCH-PREVIEW",
                                                  },
                                          ]
                                        : [],
                        },
                };
        },
        prepareFirmwareArtifact: async (profileId) => {
                const profile = profileFor(profileId);
                saveCursor(profileId, "prepared");
                const plan = planSnapshot(profile);
                return {
                        plan,
                        driver: {
                                kind: "rustDriverFfs",
                                path: "C:\\ProgramData\\NvStrapsReBar\\artifacts\\rust-driver.ffs",
                                byteLength: 18432,
                                sha256: "72".repeat(32),
                        },
                        legacyPatchedFirmware: null,
                        legacyPatchReceipt: null,
                        legacyPatch: null,
                        patchedFirmware: {
                                kind: "patchedFirmware",
                                path: "C:\\ProgramData\\NvStrapsReBar\\artifacts\\patched-firmware.bin",
                                byteLength: firmware.byteLength,
                                sha256: "83".repeat(32),
                        },
                        injection: {
                                firmwareVolumeOffset: 16908288,
                                fileOffset: 17104896,
                                replacedPadFile: true,
                                erasePolarity: true,
                                encapsulatedVolumeImage: false,
                                recompressedGuidedSection: false,
                        },
                };
        },
        exportDeploymentPackage: async (profileId, destinationRoot) => ({
                packagePath: `${destinationRoot}\\nvstraps-${profileId.slice(-8)}`,
                manifest: {
                        profileId,
                        files: [
                                {
                                        relativePath: "E7D25IMS.1N0",
                                        purpose: "patchedFirmware",
                                        byteLength: firmware.byteLength,
                                        sha256: "83".repeat(32),
                                },
                                {
                                        relativePath:
                                                "recovery/original-firmware.bin",
                                        purpose: "originalRecoveryFirmware",
                                        byteLength: firmware.byteLength,
                                        sha256: firmware.sha256,
                                },
                        ],
                        manualGates: [
                                "Use MSI M-FLASH to select the exported artifact.",
                                "Keep power connected during vendor flashing.",
                        ],
                },
                manifestSha256: "b6".repeat(32),
                checksumsSha256: "c7".repeat(32),
        }),
        previewFirmwareSetupReboot: async (profileId) => ({
                profileId,
                activeStep: "flashWithVendorRoute",
                confirmationToken: `REBOOT-TO-FIRMWARE-${profileId.slice(-16).toUpperCase()}`,
                command: "Windows shutdown.exe",
                arguments: ["/r", "/fw", "/t", "0"],
                immediate: true,
                forceCloseApplications: false,
                warnings: [
                        "Save and close all work before confirming; Windows will restart immediately.",
                        "Windows opens the firmware setup screen. Continue there with the vendor instructions.",
                ],
        }),
        rebootToFirmwareSetup: async (preview, confirmed) => {
                if (!confirmed)
                        throw new Error("Saved-work confirmation is required.");
                return { profileId: preview.profileId, accepted: true };
        },
        previewManualDeploymentStep: async (profileId) => {
                await wait(100);
                const profile = profileFor(profileId);
                const cursor = loadCursor(profileId);
                const fixture =
                        cursor === "prepared"
                                ? MANUAL_PREVIEW_FIXTURES.flashed
                                : cursor === "flashed"
                                  ? profile.boardPath === "legacyAbove4g"
                                          ? MANUAL_PREVIEW_FIXTURES.setupLegacy
                                          : MANUAL_PREVIEW_FIXTURES.setupNative
                                  : MANUAL_PREVIEW_FIXTURES.complete;
                const plan = planSnapshot(profile, cursor);
                return {
                        profileId,
                        planRevision: plan.revision,
                        stepId: fixture.stepId,
                        title: fixture.title,
                        confirmationToken: `CONFIRM-${fixture.stepId.toUpperCase()}-${profileId.slice(-16).toUpperCase()}-R${plan.revision}`,
                        warnings: [...fixture.warnings],
                };
        },
        confirmManualDeploymentStep: async (preview) => {
                const profile = profileFor(preview.profileId);
                const plan = planSnapshot(profile);
                const token = `CONFIRM-${preview.stepId.toUpperCase()}-${preview.profileId.slice(-16).toUpperCase()}-R${plan.revision}`;
                if (preview.confirmationToken !== token)
                        throw new Error(
                                "The manual confirmation token does not match this profile, step, and plan revision.",
                        );
                const recordedAtUnixMs = String(Date.now());
                saveCursor(
                        preview.profileId,
                        preview.stepId === "flashWithVendorRoute"
                                ? "flashed"
                                : preview.stepId === "configureFirmwareSetup"
                                  ? "setup"
                                  : "complete",
                );
                return {
                        plan: planSnapshot(profile),
                        stepId: preview.stepId,
                        recordedAtUnixMs,
                };
        },
        verifyDeploymentDriver: async (profileId) => {
                const profile = profileFor(profileId);
                saveCursor(profileId, "driver");
                const plan = planSnapshot(profile);
                return {
                        plan,
                        status: {
                                raw: "0x0000000000000014",
                                code: 20,
                                kind: "configured",
                                label: "Configured",
                                severity: "success",
                                pciLocation: null,
                        },
                };
        },
        getRecommendedDeploymentConfig: async (profileId) => {
                const profile = profileFor(profileId);
                const unknown =
                        profile.originalFirmware.fileName ===
                        "changed-fingerprint.bin";
                const gpu = profile.identity.gpus[0]!;
                const rules: ConfigDraft["rules"] = unknown
                        ? [
                                  {
                                          matchScope: "location",
                                          deviceId: gpu.deviceId,
                                          subsystemVendorId:
                                                  gpu.subsystemVendorId,
                                          subsystemDeviceId:
                                                  gpu.subsystemDeviceId,
                                          bus: gpu.location.bus,
                                          device: gpu.location.device,
                                          function: gpu.location.function,
                                          barSizeSelector: 5,
                                          overrideBarSizeMask: null,
                                  },
                          ]
                        : [];
                return {
                        draft: {
                                globalMode: 1,
                                targetPciBarSize:
                                        sessionStorage.getItem(
                                                "nvstraps-preview-malformed-recommendation",
                                        ) === "guarded-fields"
                                                ? 1
                                                : 0,
                                skipS3Resume: false,
                                overrideBarSizeMask: false,
                                guardSetupChanges: true,
                                rules,
                        },
                        turingGpuCount: 1,
                        registryManagedGpuCount: unknown ? 0 : 1,
                        exactFallbackRuleCount: rules.length,
                };
        },
        saveDeploymentConfig: async (profileId, draft) => {
                const profile = profileFor(profileId);
                const savedAtUnixMs = String(Date.now());
                const save = {
                        savedAtUnixMs,
                        bytesWritten: 45 + draft.rules.length * 10,
                        variablePresent: true,
                        rebootRequired: true,
                        draft: clone(draft),
                };
                sessionStorage.setItem(
                        savedConfigKey(profileId),
                        savedAtUnixMs,
                );
                saveCursor(profileId, "configured");
                const next = planSnapshot(profile);
                const receiptPlan = clone(next);
                const fault = sessionStorage.getItem(
                        "nvstraps-preview-malformed-receipt",
                );
                if (fault === "profile")
                        receiptPlan.profileId = "nvstraps-malformed-receipt";
                else if (fault === "revision") receiptPlan.revision += 1;
                if (fault) saveCursor(profileId, "driver");
                return { plan: receiptPlan, save };
        },
        previewConfigurationReboot: async (profileId) => {
                const plan = planSnapshot(profileFor(profileId));
                return {
                        profileId,
                        planRevision: plan.revision,
                        confirmationToken: `REBOOT-AFTER-CONFIGURATION-${profileId.slice(-16).toUpperCase()}-R${plan.revision}`,
                        command: "Windows shutdown.exe",
                        arguments: ["/r", "/t", "0"],
                        immediate: true,
                        forceCloseApplications: false,
                        warnings: [
                                "Save and close all work before confirming; Windows will restart immediately.",
                                "Windows restarts immediately. Applications receive the standard shutdown request.",
                                "Return after Windows boots so the app can compare the new boot time.",
                        ],
                };
        },
        rebootAfterConfiguration: async (preview, confirmed) => {
                const plan = planSnapshot(profileFor(preview.profileId));
                if (!confirmed)
                        throw new Error("Saved-work confirmation is required.");
                if (plan.revision !== preview.planRevision)
                        throw new Error(
                                "The configuration reboot preview is stale.",
                        );
                return {
                        profileId: preview.profileId,
                        accepted: true,
                        planAdvanced: false,
                };
        },
        verifyConfigurationReboot: async (profileId) => {
                const profile = profileFor(profileId);
                const saved = sessionStorage.getItem(
                        savedConfigKey(profileId),
                )!;
                const bootedAtUnixMs = String(Number(saved) + 1000);
                saveCursor(profileId, "returned");
                return {
                        plan: planSnapshot(profile),
                        configurationSavedAtUnixMs: saved,
                        bootedAtUnixMs,
                };
        },
        collectNvidiaSmiEvidence: async (profileId) => {
                const profile = profileFor(profileId);
                const evidence: NvidiaSmiEvidence = {
                        profileId,
                        toolPath: "C:\\Windows\\System32\\nvidia-smi.exe",
                        tool: {
                                fileName: "nvidia-smi.exe",
                                byteLength: 812544,
                                sha256: "d8".repeat(32),
                        },
                        rawXmlSha256: "e9".repeat(32),
                        driverVersion: "596.36",
                        capturedAt: "2026-08-14T02:00:00+09:00",
                        gpus: [
                                {
                                        pciBusId: "00000000:01:00.0",
                                        productName:
                                                "NVIDIA GeForce RTX 2080 SUPER",
                                        bus: 1,
                                        device: 0,
                                        function: 0,
                                        framebufferTotalBytes: "8589934592",
                                        bar1TotalBytes: "8589934592",
                                        bar1UsedBytes: "4194304",
                                        bar1FreeBytes: "8585740288",
                                        matchedProfileGpu: true,
                                        matchesWindowsBarSize: true,
                                },
                        ],
                        allProfileGpusObserved: true,
                        warnings: [],
                };
                saveCursor(profileId, "bar");
                return { plan: planSnapshot(profile), evidence };
        },
        installNvidiaProfileInspector: async () => {
                installation = {
                        installPath:
                                "C:\\ProgramData\\NvStrapsReBar\\tools\\v3.0.2.1",
                        executablePath:
                                "C:\\ProgramData\\NvStrapsReBar\\tools\\v3.0.2.1\\nvidiaProfileInspector.exe",
                        manifest: {
                                version: "v3.0.2.1",
                                sourceCommit:
                                        "bedb800569384eda737cb7aa596fbd97b5d6863c",
                                releaseUrl: "https://github.com/Orbmu2k/nvidiaProfileInspector/releases/tag/v3.0.2.1",
                                assetSha256:
                                        "88dcf3514111e8de630688467c03c36d8c2a8ad9ebc8073f27c069f82b75bb40",
                        },
                        manifestSha256: "fa".repeat(32),
                        installedNow: true,
                };
                return clone(installation);
        },
        getNvidiaProfileInspectorInstallation: async () => clone(installation),
        backupNvidiaProfiles: async (profileId) => backupReceipt(profileId),
        launchNvidiaProfileInspector: async (profileId) => {
                if (!installation)
                        throw new Error(
                                "NVIDIA Profile Inspector is not installed.",
                        );
                return {
                        profileId,
                        processId: 3240,
                        executablePath: installation.executablePath,
                        executableSha256:
                                "1ebd8129b3c564bf226291fb3344819fd59668066f0c5e03334a69a04a62859e",
                        elevated: true,
                        backup: backupReceipt(profileId),
                        warnings: [
                                "Application profile changes remain manual in NVIDIA Profile Inspector.",
                        ],
                };
        },
};
