import { invoke } from "@tauri-apps/api/core";
import {
        DEFAULT_DRAFT,
        type ConfigDraft,
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
}
const gpu = {
        id: "pci-01-00-0",
        name: "NVIDIA GeForce RTX 2080",
        vendorId: 0x10de,
        deviceId: 0x1e87,
        subsystemVendorId: 0x1043,
        subsystemDeviceId: 0x8673,
        bus: 1,
        device: 0,
        function: 0,
        bar0Base: "0x00000000C0000000",
        bar0Top: "0x00000000C0FFFFFF",
        currentBarSize: "268435456",
        dedicatedVideoMemory: "8589934592",
        isTuring: true,
        recommendedBarSizeSelector: 7,
        effectiveBarSizeSelector: 7,
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
        notices: [],
};
const isTauri = () => "__TAURI_INTERNALS__" in window;
const preview: Bridge = {
        snapshot: async () => structuredClone(previewSnapshot),
        refresh: async () => structuredClone(previewSnapshot),
        validate: async (d) => {
                const selected = Boolean(
                        d.globalMode ||
                                d.rules.some(
                                        (r) =>
                                                r.barSizeSelector !== null &&
                                                r.barSizeSelector !== 254,
                                ),
                );
                const encodedSize =
                        !d.globalMode && !d.rules.length
                                ? 0
                                : 14 +
                                  d.rules.length * 10 +
                                  (selected ? 31 : 0);
                return {
                        valid: d.rules.length <= 8,
                        errors:
                                d.rules.length > 8
                                        ? [
                                                  "A maximum of eight GPU rules is supported.",
                                          ]
                                        : [],
                        warnings: d.skipS3Resume
                                ? [
                                          "S3 resume reconfiguration is disabled; resume behavior must be verified on this machine.",
                                  ]
                                : [],
                        changed:
                                JSON.stringify(d) !==
                                JSON.stringify(previewSnapshot.config?.draft),
                        variableWillExist: encodedSize > 0,
                        encodedSize,
                        affectedGpuIds: selected ? [gpu.id] : [],
                        rebootRequired: true,
                };
        },
        save: async (d) => {
                const selected = Boolean(
                        d.globalMode ||
                                d.rules.some(
                                        (r) =>
                                                r.barSizeSelector !== null &&
                                                r.barSizeSelector !== 254,
                                ),
                );
                const bytesWritten =
                        !d.globalMode && !d.rules.length
                                ? 0
                                : 14 +
                                  d.rules.length * 10 +
                                  (selected ? 31 : 0);
                previewSnapshot = {
                        ...previewSnapshot,
                        config: {
                                draft: structuredClone(d),
                                rawSize: bytesWritten,
                                setupFingerprintPresent: d.guardSetupChanges,
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
                        draft: structuredClone(d),
                };
        },
        elevate: async () => {},
};
export const bridge: Bridge = isTauri()
        ? {
                  snapshot: () => invoke("get_system_snapshot"),
                  refresh: () => invoke("refresh_system"),
                  validate: (d) => invoke("validate_config", { draft: d }),
                  save: (d) => invoke("save_config", { draft: d }),
                  elevate: () => invoke("request_elevation"),
          }
        : preview;
export const previewMode = !isTauri();
