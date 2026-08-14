import { invoke } from "@tauri-apps/api/core";
import {
        DEFAULT_DRAFT,
        type ConfigDraft,
        type MachineIdentity,
        type SaveReceipt,
        type SystemSnapshot,
        type ValidationReport,
} from "./types";

export interface ConfigureBridge {
        snapshot(): Promise<SystemSnapshot>;
        refresh(): Promise<SystemSnapshot>;
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
const preview: ConfigureBridge = {
        snapshot: async () => structuredClone(previewSnapshot),
        refresh: async () => structuredClone(previewSnapshot),
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
        validate: (draft) => invoke("validate_config", { draft }),
        save: (draft) => invoke("save_config", { draft }),
        elevate: () => invoke("request_elevation"),
};
const isTauri = () => "__TAURI_INTERNALS__" in window;
export const bridge: ConfigureBridge = isTauri() ? nativeBridge : preview;
export const previewMode = !isTauri();
