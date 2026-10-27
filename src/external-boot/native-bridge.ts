import { invoke } from "@tauri-apps/api/core";
import type { ExternalBootBridge } from "./contract";

export const nativeExternalBootBridge: ExternalBootBridge = {
        inspect: () => invoke("inspect_external_boot"),
        prepareDiagnostic: (medium) => invoke("prepare_external_diagnostic", { request: { medium } }),
        readReport: (medium) => invoke("read_external_report", { request: { medium } }),
        writeLoader: (medium, target, sizeBytes) => invoke("write_external_loader", { request: { medium, target, sizeBytes } }),
        makePermanent: () => invoke("make_external_boot_permanent"),
        remove: (medium) => invoke("remove_external_boot", { request: { medium } }),
        restart: (suspendBitLocker) => invoke("restart_for_external_boot", { request: { suspendBitLocker } }),
};
