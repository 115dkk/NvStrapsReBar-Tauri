import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
        DEFAULT_DRAFT,
        type ConfigDraft,
        type CreateProfileRequest,
        type DeploymentBundle,
        type DeploymentPackageReceipt,
        type DeploymentPlan,
        type FirmwareFingerprint,
        type FirmwarePreparation,
        type FirmwareSetupRebootPreview,
        type LegacyFirmwareAnalysis,
        type LegacyPatchCatalogView,
        type MachineIdentity,
        type MachineProfile,
        type NvidiaProfileBackupReceipt,
        type NvidiaSmiEvidence,
        type ProfileComparison,
        type ProfileInspectorInstallation,
        type ProfileInspectorLaunch,
        type SaveReceipt,
        type SystemSnapshot,
        type ValidationReport,
} from "./types";

export interface Bridge {
        snapshot(): Promise<SystemSnapshot>;
        refresh(): Promise<SystemSnapshot>;
        validate(draft: ConfigDraft): Promise<ValidationReport>;
        save(draft: ConfigDraft): Promise<SaveReceipt>;
        elevate(): Promise<void>;
        selectFirmwareImage(): Promise<string | null>;
        selectDestinationDirectory(): Promise<string | null>;
        inspectFirmwareImage(path: string): Promise<FirmwareFingerprint>;
        analyzeLegacyFirmware(path: string): Promise<LegacyFirmwareAnalysis>;
        listLegacyPatchCatalogs(): Promise<LegacyPatchCatalogView[]>;
        createMachineProfile(
                request: CreateProfileRequest,
        ): Promise<DeploymentBundle>;
        listMachineProfiles(): Promise<MachineProfile[]>;
        getDeploymentPlan(profileId: string): Promise<DeploymentPlan>;
        compareMachineProfile(
                profileId: string,
                firmwarePath?: string,
        ): Promise<ProfileComparison>;
        prepareFirmwareArtifact(profileId: string): Promise<FirmwarePreparation>;
        exportDeploymentPackage(
                profileId: string,
                destinationRoot: string,
        ): Promise<DeploymentPackageReceipt>;
        previewFirmwareSetupReboot(
                profileId: string,
        ): Promise<FirmwareSetupRebootPreview>;
        rebootToFirmwareSetup(
                preview: FirmwareSetupRebootPreview,
                unsavedWorkConfirmed: boolean,
        ): Promise<{ profileId: string; accepted: boolean }>;
        collectNvidiaSmiEvidence(profileId: string): Promise<NvidiaSmiEvidence>;
        installNvidiaProfileInspector(): Promise<ProfileInspectorInstallation>;
        getNvidiaProfileInspectorInstallation(): Promise<ProfileInspectorInstallation | null>;
        backupNvidiaProfiles(profileId: string): Promise<NvidiaProfileBackupReceipt>;
        launchNvidiaProfileInspector(profileId: string): Promise<ProfileInspectorLaunch>;
}

const gpu = {
        id: "pci-01-00-0",
        name: "NVIDIA GeForce RTX 2080 SUPER",
        vendorId: 0x10de,
        deviceId: 0x1e81,
        subsystemVendorId: 0x1462,
        subsystemDeviceId: 0x3755,
        bus: 1,
        device: 0,
        function: 0,
        bar0Base: "2147483648",
        bar0Top: "2164260863",
        currentBarSize: "268435456",
        dedicatedVideoMemory: "8589934592",
        isTuring: true,
        recommendedBarSizeSelector: 13,
        effectiveBarSizeSelector: 13,
};
const identity: MachineIdentity = {
        boardManufacturer: "Micro-Star International Co., Ltd.",
        boardProduct: "PRO Z690-A DDR4(MS-7D25)",
        boardVersion: "1.0",
        biosVendor: "American Megatrends International, LLC.",
        biosVersion: "1.N0",
        biosReleaseDate: "2026-03-12",
        gpus: [
                {
                        vendorId: gpu.vendorId,
                        deviceId: gpu.deviceId,
                        subsystemVendorId: gpu.subsystemVendorId,
                        subsystemDeviceId: gpu.subsystemDeviceId,
                        location: { bus: 1, device: 0, function: 0 },
                        bridgeLocation: { bus: 0, device: 1, function: 0 },
                        bar0Base: 2147483648,
                        bar0Top: 2164260863,
                },
        ],
};
const previewDraft: ConfigDraft = { ...DEFAULT_DRAFT, globalMode: 1 };
let previewSnapshot: SystemSnapshot = {
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
                raw: "0x0000000000000014",
                code: 20,
                kind: "configured",
                label: "Configured",
                severity: "success",
                pciLocation: null,
        },
        config: {
                draft: previewDraft,
                rawSize: 45,
                setupFingerprintPresent: true,
                setupCrc: "A4D12B87E10C8302",
        },
        devices: [gpu],
        machineIdentity: identity,
        notices: [],
};
const previewFirmware: FirmwareFingerprint = {
        fileName: "E7D25IMS.1N0",
        byteLength: 33554432,
        sha256: "71".repeat(32),
};
const previewFirmwareForPath = (path: string): FirmwareFingerprint =>
        path.toLowerCase().includes("changed-fingerprint")
                ? {
                          fileName: "changed-fingerprint.bin",
                          byteLength: previewFirmware.byteLength,
                          sha256: "93".repeat(32),
                  }
                : previewFirmware;
const sameFirmware = (
        left: FirmwareFingerprint,
        right: FirmwareFingerprint,
) =>
        left.fileName === right.fileName &&
        left.byteLength === right.byteLength &&
        left.sha256 === right.sha256;
const previewCatalogs: LegacyPatchCatalogView[] = [
        {
                catalog: "general",
                upstreamCommit: "9c80fdb2cd3db94bdd19c58bd00d5ecf822f6430",
                sourceSha256: "8a".repeat(32),
                rules: [
                        {
                                ruleId: "4b".repeat(32),
                                description: "Pinned Above 4G decoding compatibility rule",
                                sectionType: 16,
                                requiredRisks: ["dsdtModification"],
                        },
                ],
        },
];
const previewLegacyAnalysis: LegacyFirmwareAnalysis = {
        firmware: structuredClone(previewFirmware),
        upstreamCommit: "9c80fdb2cd3db94bdd19c58bd00d5ecf822f6430",
        catalogs: [
                {
                        catalog: "general",
                        sourceSha256: "8a".repeat(32),
                        rules: [
                                {
                                        ruleId: "4b".repeat(32),
                                        description: "Pinned Above 4G decoding compatibility rule",
                                        sectionType: 16,
                                        requiredRisks: [],
                                        status: "applicable",
                                        expectedMatches: 1,
                                        blockedReason: null,
                                        recommended: true,
                                },
                                {
                                        ruleId: "5c".repeat(32),
                                        description: "DSDT resource-window compatibility patch",
                                        sectionType: 16,
                                        requiredRisks: ["dsdtModification"],
                                        status: "applicable",
                                        expectedMatches: 1,
                                        blockedReason: null,
                                        recommended: false,
                                },
                                {
                                        ruleId: "6d".repeat(32),
                                        description: "Already absent compatibility pattern",
                                        sectionType: 16,
                                        requiredRisks: [],
                                        status: "absent",
                                        expectedMatches: null,
                                        blockedReason: null,
                                        recommended: false,
                                },
                                {
                                        ruleId: "7e".repeat(32),
                                        description: "Compressed vendor-specific compatibility patch",
                                        sectionType: 16,
                                        requiredRisks: [],
                                        status: "blocked",
                                        expectedMatches: null,
                                        blockedReason: "The compressed section cannot be proven safe by this build.",
                                        recommended: false,
                                },
                        ],
                },
        ],
};
let previewProfiles: MachineProfile[] = [];
let previewPlans = new Map<string, DeploymentPlan>();
let inspectorInstallation: ProfileInspectorInstallation | null = null;

const planFor = (profileId: string): DeploymentPlan => ({
        schemaVersion: 1,
        profileId,
        originalFirmwareSha256: previewFirmware.sha256,
        recoveryMethod: "usbFlashback",
        revision: 4,
        steps: [
                ["verifyProfile", "automated", "Verify the pinned machine, topology, BIOS, and source image", "completed"],
                ["confirmRecovery", "physicalConfirmation", "Confirm the pinned firmware recovery route", "completed"],
                ["preserveOriginalFirmware", "automated", "Preserve and hash the exact original firmware image", "completed"],
                ["prepareRustDriver", "automated", "Build and verify the Rust DXE driver", "ready"],
                ["verifyPatchedArtifact", "automated", "Inject and verify the patched firmware artifact", "pending"],
                ["flashWithVendorRoute", "firmwareManual", "Flash with the documented vendor route", "pending"],
                ["configureFirmwareSetup", "firmwareManual", "Confirm firmware setup values", "pending"],
                ["rebootAfterFirmware", "reboot", "Boot Windows after the firmware handoff", "pending"],
                ["verifyDriverLoaded", "automated", "Verify the firmware driver status", "pending"],
                ["writeNvstrapsConfiguration", "automated", "Write and read back the NvStrapsReBar configuration", "pending"],
                ["rebootAfterConfiguration", "reboot", "Restart after configuration", "pending"],
                ["verifyResizableBar", "automated", "Observe Resizable BAR through NVIDIA telemetry", "pending"],
                ["configureNvidiaApplications", "externalTool", "Configure NVIDIA application profiles", "pending"],
        ].map(([id, kind, title, state]) => ({
                id: id as DeploymentPlan["steps"][number]["id"],
                kind: kind as DeploymentPlan["steps"][number]["kind"],
                title,
                state: state as DeploymentPlan["steps"][number]["state"],
                evidence: state === "completed" ? { kind: id, value: "preview-evidence" } : null,
        })),
});

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

const isTauri = () => "__TAURI_INTERNALS__" in window;
const preview: Bridge = {
        snapshot: async () => structuredClone(previewSnapshot),
        refresh: async () => structuredClone(previewSnapshot),
        validate: async (draft) => {
                const selected = Boolean(
                        draft.globalMode ||
                                draft.rules.some(
                                        (rule) =>
                                                rule.barSizeSelector !== null &&
                                                rule.barSizeSelector !== 254,
                                ),
                );
                const encodedSize =
                        !draft.globalMode && !draft.rules.length
                                ? 0
                                : 14 + draft.rules.length * 10 + (selected ? 31 : 0);
                return {
                        valid: draft.rules.length <= 8,
                        errors:
                                draft.rules.length > 8
                                        ? ["A maximum of eight GPU rules is supported."]
                                        : [],
                        warnings: draft.skipS3Resume
                                ? ["S3 resume reconfiguration is disabled; resume behavior must be verified on this machine."]
                                : [],
                        changed:
                                JSON.stringify(draft) !==
                                JSON.stringify(previewSnapshot.config?.draft),
                        variableWillExist: encodedSize > 0,
                        encodedSize,
                        affectedGpuIds: selected ? [gpu.id] : [],
                        rebootRequired: true,
                };
        },
        save: async (draft) => {
                const selected = Boolean(
                        draft.globalMode ||
                                draft.rules.some(
                                        (rule) =>
                                                rule.barSizeSelector !== null &&
                                                rule.barSizeSelector !== 254,
                                ),
                );
                const bytesWritten =
                        !draft.globalMode && !draft.rules.length
                                ? 0
                                : 14 + draft.rules.length * 10 + (selected ? 31 : 0);
                previewSnapshot = {
                        ...previewSnapshot,
                        config: {
                                draft: structuredClone(draft),
                                rawSize: bytesWritten,
                                setupFingerprintPresent: draft.guardSetupChanges,
                                setupCrc: "A4D12B87E10C8302",
                        },
                        firmware: {
                                ...previewSnapshot.firmware,
                                configVariablePresent: bytesWritten > 0,
                        },
                };
                return {
                        savedAtUnixMs: String(Date.now()),
                        bytesWritten,
                        variablePresent: bytesWritten > 0,
                        rebootRequired: true,
                        draft: structuredClone(draft),
                };
        },
        elevate: async () => {},
        selectFirmwareImage: async () => "C:\\Firmware\\E7D25IMS.1N0",
        selectDestinationDirectory: async () => "C:\\NVSTRAPS-USB",
        inspectFirmwareImage: async (path) =>
                structuredClone(previewFirmwareForPath(path)),
        analyzeLegacyFirmware: async () => {
                await new Promise((resolve) => setTimeout(resolve, 40));
                return structuredClone(previewLegacyAnalysis);
        },
        listLegacyPatchCatalogs: async () => structuredClone(previewCatalogs),
        createMachineProfile: async (request) => {
                const actualFirmware = previewFirmwareForPath(request.firmwarePath);
                if (!sameFirmware(request.expectedFirmware, actualFirmware)) {
                        throw new Error(
                                "The source firmware changed after inspection; inspect the exact image again.",
                        );
                }
                const profileId = `nvstraps-${actualFirmware.sha256.slice(0, 16)}`;
                const profile: MachineProfile = {
                        schemaVersion: 3,
                        profileId,
                        displayName: request.displayName,
                        boardPath: request.boardPath,
                        legacyPatches: request.legacyPatches ?? null,
                        identity: structuredClone(identity),
                        originalFirmware: structuredClone(actualFirmware),
                        recovery: structuredClone(request.recovery),
                        firmwareInstall: structuredClone(request.firmwareInstall),
                };
                const plan = planFor(profileId);
                previewProfiles = [profile];
                previewPlans.set(profileId, plan);
                return {
                        profile: structuredClone(profile),
                        plan: structuredClone(plan),
                        originalFirmwarePath: `C:\\ProgramData\\NvStrapsReBar\\${profileId}\\original.bin`,
                };
        },
        listMachineProfiles: async () => structuredClone(previewProfiles),
        getDeploymentPlan: async (profileId) =>
                structuredClone(previewPlans.get(profileId) ?? planFor(profileId)),
        compareMachineProfile: async (profileId) => ({
                profile: structuredClone(
                        previewProfiles.find((profile) => profile.profileId === profileId)!,
                ),
                currentIdentity: structuredClone(identity),
                firmware: structuredClone(previewFirmware),
                result: { differences: [] },
        }),
        prepareFirmwareArtifact: async (profileId) => {
                const plan = structuredClone(previewPlans.get(profileId) ?? planFor(profileId));
                for (const step of plan.steps) {
                        if (["prepareRustDriver", "verifyPatchedArtifact"].includes(step.id)) {
                                step.state = "completed";
                                step.evidence = { kind: step.id, value: "72".repeat(32) };
                        }
                }
                const flash = plan.steps.find((step) => step.id === "flashWithVendorRoute");
                if (flash) flash.state = "ready";
                plan.revision += 2;
                previewPlans.set(profileId, plan);
                return {
                        plan: structuredClone(plan),
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
                                byteLength: previewFirmware.byteLength,
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
                                        byteLength: previewFirmware.byteLength,
                                        sha256: "83".repeat(32),
                                },
                                {
                                        relativePath: "recovery/original-firmware.bin",
                                        purpose: "originalRecoveryFirmware",
                                        byteLength: previewFirmware.byteLength,
                                        sha256: previewFirmware.sha256,
                                },
                        ],
                        manualGates: [
                                "Use MSI M-FLASH to select the exported artifact.",
                                "Do not interrupt power during vendor flashing.",
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
                        "This only opens firmware setup. It does not flash firmware or change settings.",
                ],
        }),
        rebootToFirmwareSetup: async (previewValue, unsavedWorkConfirmed) => {
                if (!unsavedWorkConfirmed) throw new Error("Saved-work confirmation is required.");
                return { profileId: previewValue.profileId, accepted: true };
        },
        collectNvidiaSmiEvidence: async (profileId) => ({
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
                                productName: gpu.name,
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
        }),
        installNvidiaProfileInspector: async () => {
                inspectorInstallation = {
                        installPath: "C:\\ProgramData\\NvStrapsReBar\\tools\\v3.0.2.1",
                        executablePath: "C:\\ProgramData\\NvStrapsReBar\\tools\\v3.0.2.1\\nvidiaProfileInspector.exe",
                        manifest: {
                                version: "v3.0.2.1",
                                sourceCommit: "bedb800569384eda737cb7aa596fbd97b5d6863c",
                                releaseUrl: "https://github.com/Orbmu2k/nvidiaProfileInspector/releases/tag/v3.0.2.1",
                                assetSha256: "88dcf3514111e8de630688467c03c36d8c2a8ad9ebc8073f27c069f82b75bb40",
                        },
                        manifestSha256: "fa".repeat(32),
                        installedNow: true,
                };
                return structuredClone(inspectorInstallation);
        },
        getNvidiaProfileInspectorInstallation: async () =>
                structuredClone(inspectorInstallation),
        backupNvidiaProfiles: async (profileId) => backupReceipt(profileId),
        launchNvidiaProfileInspector: async (profileId) => ({
                profileId,
                processId: 3240,
                executablePath: inspectorInstallation!.executablePath,
                executableSha256: "1ebd8129b3c564bf226291fb3344819fd59668066f0c5e03334a69a04a62859e",
                elevated: true,
                backup: backupReceipt(profileId),
                warnings: ["Application profile changes remain manual in NVIDIA Profile Inspector."],
        }),
};

const nativeBridge: Bridge = {
        snapshot: () => invoke("get_system_snapshot"),
        refresh: () => invoke("refresh_system"),
        validate: (draft) => invoke("validate_config", { draft }),
        save: (draft) => invoke("save_config", { draft }),
        elevate: () => invoke("request_elevation"),
        selectFirmwareImage: async () => {
                const selection = await open({
                        multiple: false,
                        directory: false,
                        title: "Select the exact vendor firmware image",
                        filters: [
                                {
                                        name: "Firmware images",
                                        extensions: ["bin", "rom", "cap", "fd", "bio", "1n0"],
                                },
                                { name: "All files", extensions: ["*"] },
                        ],
                });
                return typeof selection === "string" ? selection : null;
        },
        selectDestinationDirectory: async () => {
                const selection = await open({
                        multiple: false,
                        directory: true,
                        title: "Select an empty deployment package destination",
                });
                return typeof selection === "string" ? selection : null;
        },
        inspectFirmwareImage: (path) => invoke("inspect_firmware_image", { path }),
        analyzeLegacyFirmware: (path) =>
                invoke("analyze_legacy_firmware", { path }),
        listLegacyPatchCatalogs: () => invoke("list_legacy_patch_catalogs"),
        createMachineProfile: (request) => invoke("create_machine_profile", { request }),
        listMachineProfiles: () => invoke("list_machine_profiles"),
        getDeploymentPlan: (profileId) => invoke("get_deployment_plan", { profileId }),
        compareMachineProfile: (profileId, firmwarePath) =>
                invoke("compare_machine_profile", {
                        request: { profileId, firmwarePath: firmwarePath || null },
                }),
        prepareFirmwareArtifact: (profileId) =>
                invoke("prepare_firmware_artifact", { profileId }),
        exportDeploymentPackage: (profileId, destinationRoot) =>
                invoke("export_deployment_package", {
                        request: { profileId, destinationRoot },
                }),
        previewFirmwareSetupReboot: (profileId) =>
                invoke("preview_firmware_setup_reboot", { profileId }),
        rebootToFirmwareSetup: (previewValue, unsavedWorkConfirmed) =>
                invoke("reboot_to_firmware_setup", {
                        request: {
                                profileId: previewValue.profileId,
                                confirmationToken: previewValue.confirmationToken,
                                unsavedWorkConfirmed,
                        },
                }),
        collectNvidiaSmiEvidence: (profileId) =>
                invoke("collect_nvidia_smi_evidence", { profileId }),
        installNvidiaProfileInspector: () =>
                invoke("install_nvidia_profile_inspector"),
        getNvidiaProfileInspectorInstallation: () =>
                invoke("get_nvidia_profile_inspector_installation"),
        backupNvidiaProfiles: (profileId) =>
                invoke("backup_nvidia_profiles", { profileId }),
        launchNvidiaProfileInspector: (profileId) =>
                invoke("launch_nvidia_profile_inspector", {
                        request: { profileId },
                }),
};

export const bridge: Bridge = isTauri() ? nativeBridge : preview;
export const previewMode = !isTauri();
