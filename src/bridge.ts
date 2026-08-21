import { invoke } from "@tauri-apps/api/core";
import {
        DEFAULT_DRAFT,
        type ConfigDraft,
        type MachineIdentity,
        type ResizableBarInspection,
        type SaveBarSettingsReceipt,
        type SaveBarSettingsRequest,
        type SaveReceipt,
        type SystemSnapshot,
        type ValidationReport,
} from "./types";
import { hasOperationalConfiguration } from "./configuration-workspace/model";

export interface ConfigureBridge {
        snapshot(): Promise<SystemSnapshot>;
        refresh(): Promise<SystemSnapshot>;
        inspectResizableBarStatus(): Promise<ResizableBarInspection>;
        validate(draft: ConfigDraft): Promise<ValidationReport>;
        save(draft: ConfigDraft): Promise<SaveReceipt>;
        saveBarSettings(
                request: SaveBarSettingsRequest,
        ): Promise<SaveBarSettingsReceipt>;
        elevate(): Promise<void>;
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
        bar0Top: "10737418239",
        currentBarSize: "8589934592",
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
                        bar0Top: 10737418239,
                },
        ],
};
const previewTopologyToken = "a1".repeat(32);
const mixedPreviewTopologyToken = "b2".repeat(32);
let previewConfigToken = "c3".repeat(32);
let previewSnapshot: SystemSnapshot = {
        schemaVersion: 2,
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
        barSettings: {
                currentBootDxeState: "observedThisBoot",
                currentBootDxeReasonCode: "currentBootStatusObserved",
                controlEvidence: "currentBootDxe",
                settingsAvailable: true,
                savedConfigurationState: "enabled",
                topologyToken: previewTopologyToken,
                configToken: previewConfigToken,
        },
        config: {
                draft: { ...DEFAULT_DRAFT, globalMode: 1 },
                rawSize: 45,
                setupFingerprintPresent: true,
                setupCrc: "A4D12B87E10C8302",
        },
        devices: [gpu],
        machineIdentity: identity,
        hardwareSupport: {
                motherboardNativeResizableBar: {
                        state: "supported",
                        reasonCode: "exactMotherboardCatalogMatch",
                        catalogId: "msi-pro-z690-a-ddr4-ms-7d25",
                },
                targetGpuFamily: {
                        state: "supported",
                        reasonCode: "allDetectedGpusTuring",
                },
                overallState: "supported",
        },
        notices: [],
};
const bytesFor = (draft: ConfigDraft) => {
        return hasOperationalConfiguration(draft)
                ? 45 + draft.rules.length * 10
                : 0;
};
const previewResizableBarInspection: ResizableBarInspection = {
        driverVersion: "596.36",
        capturedAt: "2026-08-14T10:50:58Z",
        state: "expanded",
        gpus: [
                {
                        pciBusId: "00000000:01:00.0",
                        productName: "NVIDIA GeForce RTX 2080 SUPER",
                        bar1TotalBytes: "8589934592",
                        windowsBarSizeBytes: "8589934592",
                        state: "expanded",
                        reason: "BAR1 is larger than the legacy 256 MiB window and matches Windows",
                        patchConfiguration: {
                                state: "notNeeded",
                                reasonCode: "alreadyExpanded",
                                targetSelector: null,
                                targetSizeBytes: null,
                        },
                },
        ],
        warnings: [],
};
export const PREVIEW_REBAR_STATE_KEY = "nvstraps-preview-rebar-state";
export const PREVIEW_BAR_SETTINGS_ERROR_KEY =
        "nvstraps-preview-bar-settings-error";
const mixedPreviewGpu = {
        ...gpu,
        id: "pci-02-00-0",
        name: "NVIDIA Quadro RTX 4000",
        deviceId: 0x1eb1,
        subsystemDeviceId: 0x12a0,
        bus: 2,
        bar0Base: "10737418240",
        bar0Top: "11005853695",
        currentBarSize: "268435456",
        dedicatedVideoMemory: "8589934592",
        recommendedBarSizeSelector: 7,
        effectiveBarSizeSelector: null,
};
const mixedPreviewInspection: ResizableBarInspection = {
        ...previewResizableBarInspection,
        state: "mixed",
        gpus: [
                ...previewResizableBarInspection.gpus,
                {
                        pciBusId: "00000000:02:00.0",
                        productName: mixedPreviewGpu.name,
                        bar1TotalBytes: "268435456",
                        windowsBarSizeBytes: "268435456",
                        state: "legacy256MiB",
                        reason: "BAR1 is using the legacy 256 MiB aperture",
                        patchConfiguration: {
                                state: "available",
                                reasonCode: "automaticTargetAvailable",
                                targetSelector: 7,
                                targetSizeBytes: "8589934592",
                        },
                },
        ],
};
type PreviewState =
        | "expanded"
        | "expanded-no-access"
        | "mixed"
        | "not-observed"
        | "driver-cleared";
const previewState = (): PreviewState => {
        if (typeof sessionStorage === "undefined") return "expanded";
        const value = sessionStorage.getItem(PREVIEW_REBAR_STATE_KEY);
        return value === "mixed" ||
                value === "not-observed" ||
                value === "expanded-no-access" ||
                value === "driver-cleared"
                ? value
                : "expanded";
};
const notObservedPreviewInspection: ResizableBarInspection = {
        ...previewResizableBarInspection,
        state: "legacy256MiB",
        gpus: [
                {
                        ...previewResizableBarInspection.gpus[0],
                        bar1TotalBytes: "268435456",
                        windowsBarSizeBytes: "268435456",
                        state: "legacy256MiB",
                        reason: "BAR1 is using the legacy 256 MiB aperture",
                        patchConfiguration: {
                                state: "available",
                                reasonCode: "automaticTargetAvailable",
                                targetSelector: 13,
                                targetSizeBytes: "8589934592",
                        },
                },
        ],
};
const currentPreviewSnapshot = (): SystemSnapshot => {
        const value = structuredClone(previewSnapshot);
        if (previewState() === "mixed") {
                value.devices.push(structuredClone(mixedPreviewGpu));
                value.machineIdentity?.gpus.push({
                        vendorId: mixedPreviewGpu.vendorId,
                        deviceId: mixedPreviewGpu.deviceId,
                        subsystemVendorId: mixedPreviewGpu.subsystemVendorId,
                        subsystemDeviceId: mixedPreviewGpu.subsystemDeviceId,
                        location: { bus: 2, device: 0, function: 0 },
                        bridgeLocation: { bus: 0, device: 2, function: 0 },
                        bar0Base: 10737418240,
                        bar0Top: 11005853695,
                });
                value.barSettings.topologyToken = mixedPreviewTopologyToken;
        }
        if (previewState() === "not-observed") {
                value.driverStatus = {
                        raw: "0x000000000000000a",
                        code: 10,
                        kind: "notFound",
                        label: "Not found",
                        severity: "warning",
                        pciLocation: null,
                };
                value.barSettings = {
                        ...value.barSettings,
                        currentBootDxeState: "notObservedThisBoot",
                        currentBootDxeReasonCode: "statusVariableMissing",
                        controlEvidence: "notObserved",
                        settingsAvailable: false,
                };
                value.devices[0].currentBarSize = "268435456";
        }
        if (previewState() === "driver-cleared") {
                value.driverStatus = {
                        raw: "0x0000000000000032",
                        code: 50,
                        kind: "cleared",
                        label: "Cleared",
                        severity: "neutral",
                        pciLocation: null,
                };
                value.devices[0].currentBarSize = "268435456";
        }
        if (previewState() === "expanded-no-access") {
                value.platform.elevated = false;
                value.firmware = {
                        ...value.firmware,
                        accessible: false,
                        privilegeEnabled: false,
                        configVariablePresent: null,
                };
                value.config = null;
                value.barSettings = {
                        ...value.barSettings,
                        currentBootDxeState: "indeterminate",
                        currentBootDxeReasonCode: "statusVariableUnavailable",
                        controlEvidence: "expandedTuringAperture",
                        settingsAvailable: true,
                        savedConfigurationState: "unreadable",
                        configToken: null,
                };
                value.driverStatus = null;
        }
        return value;
};

const savePreviewDraft = (draft: ConfigDraft): SaveReceipt => {
        const bytesWritten = bytesFor(draft);
        previewConfigToken = `${Date.now().toString(16)}`.padStart(64, "d").slice(-64);
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
                barSettings: {
                        ...previewSnapshot.barSettings,
                        savedConfigurationState: bytesWritten
                                ? "enabled"
                                : "disabled",
                        configToken: previewConfigToken,
                },
        };
        return {
                savedAtUnixMs: String(Date.now()),
                bytesWritten,
                variablePresent: bytesWritten > 0,
                rebootRequired: true,
                draft: structuredClone(draft),
        };
};
export const previewConfigureBridge: ConfigureBridge = {
        snapshot: async () => currentPreviewSnapshot(),
        refresh: async () => currentPreviewSnapshot(),
        inspectResizableBarStatus: async () =>
                structuredClone(
                        previewState() === "mixed"
                                ? mixedPreviewInspection
                                : previewState() === "not-observed" ||
                                    previewState() === "driver-cleared"
                                  ? notObservedPreviewInspection
                                : previewResizableBarInspection,
                ),
        validate: async (draft) => {
                const encodedSize = bytesFor(draft);
                return {
                        valid: draft.rules.length <= 8,
                        errors:
                                draft.rules.length > 8
                                        ? [
                                                  "A maximum of eight GPU rules is supported.",
                                          ]
                                        : [],
                        warnings: draft.skipS3Resume
                                ? [
                                          "S3 resume reconfiguration is disabled. Test S3 resume on this computer.",
                                  ]
                                : [],
                        changed:
                                JSON.stringify(draft) !==
                                JSON.stringify(previewSnapshot.config?.draft),
                        variableWillExist: encodedSize > 0,
                        encodedSize,
                        affectedGpuIds: encodedSize ? [gpu.id] : [],
                        rebootRequired: true,
                };
        },
        save: async (draft) => {
                return savePreviewDraft(draft);
        },
        saveBarSettings: async (request) => {
                const injectedCode =
                        typeof sessionStorage === "undefined"
                                ? null
                                : sessionStorage.getItem(
                                          PREVIEW_BAR_SETTINGS_ERROR_KEY,
                                  );
                if (injectedCode)
                        throw {
                                code: injectedCode,
                                message: "Injected BAR Settings preview failure",
                                recoverable: true,
                        };
                const snapshot = currentPreviewSnapshot();
                if (!snapshot.barSettings.settingsAvailable)
                        throw {
                                code: "bar_settings_control_not_observed",
                                message: "BAR Settings control evidence not observed",
                                recoverable: true,
                        };
                if (
                        request.expectedTopologyToken !==
                        snapshot.barSettings.topologyToken
                )
                        throw {
                                code: "stale_topology",
                                message: "Topology changed",
                                recoverable: true,
                        };
                if (
                        request.expectedConfigToken !==
                        snapshot.barSettings.configToken
                )
                        throw {
                                code: "stale_configuration",
                                message: "Configuration changed",
                                recoverable: true,
                        };
                const save = savePreviewDraft(request.draft);
                return {
                        save,
                        topologyToken: snapshot.barSettings.topologyToken,
                        configToken: previewConfigToken,
                };
        },
        elevate: async () => {},
};
export const nativeConfigureBridge: ConfigureBridge = {
        snapshot: () => invoke("get_system_snapshot"),
        refresh: () => invoke("refresh_system"),
        inspectResizableBarStatus: () =>
                invoke("inspect_resizable_bar_status"),
        validate: (draft) => invoke("validate_config", { draft }),
        save: (draft) => invoke("save_config", { draft }),
        saveBarSettings: (request) =>
                invoke("save_bar_settings", { request }),
        elevate: () => invoke("request_elevation"),
};
const isTauri = () =>
        typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const bridge: ConfigureBridge = isTauri()
        ? nativeConfigureBridge
        : previewConfigureBridge;
export const previewMode = !isTauri();
