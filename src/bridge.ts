import { invoke } from "@tauri-apps/api/core";
import {
        DEFAULT_DRAFT,
        type ConfigDraft,
        type MachineIdentity,
        type ResizableBarInspection,
        type SaveReceipt,
        type SystemSnapshot,
        type ValidationReport,
} from "./types";

export interface ConfigureBridge {
        snapshot(): Promise<SystemSnapshot>;
        refresh(): Promise<SystemSnapshot>;
        inspectResizableBarStatus(): Promise<ResizableBarInspection>;
        validate(draft: ConfigDraft): Promise<ValidationReport>;
        save(draft: ConfigDraft): Promise<SaveReceipt>;
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
        const selected = Boolean(
                draft.globalMode ||
                        draft.rules.some(
                                (rule) =>
                                        rule.barSizeSelector !== null &&
                                        rule.barSizeSelector !== 254,
                        ),
        );
        return !draft.globalMode && !draft.rules.length
                ? 0
                : 14 + draft.rules.length * 10 + (selected ? 31 : 0);
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
const useMixedPreview = () =>
        typeof sessionStorage !== "undefined" &&
        sessionStorage.getItem(PREVIEW_REBAR_STATE_KEY) === "mixed";
const currentPreviewSnapshot = (): SystemSnapshot => {
        const value = structuredClone(previewSnapshot);
        if (!useMixedPreview()) return value;
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
        return value;
};
export const previewConfigureBridge: ConfigureBridge = {
        snapshot: async () => currentPreviewSnapshot(),
        refresh: async () => currentPreviewSnapshot(),
        inspectResizableBarStatus: async () =>
                structuredClone(
                        useMixedPreview()
                                ? mixedPreviewInspection
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
                const bytesWritten = bytesFor(draft);
                previewSnapshot = {
                        ...previewSnapshot,
                        config: {
                                draft: structuredClone(draft),
                                rawSize: bytesWritten,
                                setupFingerprintPresent:
                                        draft.guardSetupChanges,
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
};
const nativeBridge: ConfigureBridge = {
        snapshot: () => invoke("get_system_snapshot"),
        refresh: () => invoke("refresh_system"),
        inspectResizableBarStatus: () =>
                invoke("inspect_resizable_bar_status"),
        validate: (draft) => invoke("validate_config", { draft }),
        save: (draft) => invoke("save_config", { draft }),
        elevate: () => invoke("request_elevation"),
};
const isTauri = () =>
        typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const bridge: ConfigureBridge = isTauri()
        ? nativeBridge
        : previewConfigureBridge;
export const previewMode = !isTauri();
