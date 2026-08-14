import type { StaticMessageId } from "./i18n-catalog";
import type { SystemSnapshot } from "./types";

const driverStatusIds: Record<string, StaticMessageId> = {
        not_loaded: "ui.driverNotLoaded",
        configured: "ui.configured",
        gpu_unconfigured: "ui.driverGpuUnconfigured",
        unconfigured: "ui.driverUnconfigured",
        cleared: "ui.driverCleared",
        bridge_found: "ui.driverBridgeFound",
        gpu_found: "ui.driverGpuFound",
        straps_configured: "ui.driverStrapsConfigured",
        straps_preconfigured: "ui.driverStrapsPreconfigured",
        straps_confirmed: "ui.driverStrapsConfirmed",
        delay_elapsed: "ui.driverDelayElapsed",
        pci_rebar_configured: "ui.driverPciRebarConfigured",
        straps_unconfirmed: "ui.driverStrapsUnconfirmed",
        size_override: "ui.driverSizeOverride",
        capability_missing: "ui.driverCapabilityMissing",
        gpu_excluded: "ui.driverGpuExcluded",
        missing_bridge: "ui.driverMissingBridge",
        bad_bridge: "ui.driverBadBridge",
        bridge_order: "ui.driverBridgeOrder",
        missing_gpu: "ui.driverMissingGpu",
        bad_gpu: "ui.driverBadGpu",
        bad_setup_attributes: "ui.driverBadSetupAttributes",
        ambiguous_setup: "ui.driverAmbiguousSetup",
        missing_setup: "ui.driverMissingSetup",
        allocation_error: "ui.driverAllocationError",
        efi_error: "ui.driverEfiError",
        nvar_api_error: "ui.driverNvarApiError",
        parse_error: "ui.driverParseError",
        unknown: "ui.driverUnknown",
};

export const driverStatusMessageId = (
        status: NonNullable<SystemSnapshot["driverStatus"]>,
): StaticMessageId => driverStatusIds[status.kind] ?? "ui.driverUnknown";

export type SystemNoticePresentation = {
        tone: "error" | "warning";
        id: StaticMessageId;
};

export function presentSystemNotices(
        snapshot: SystemSnapshot,
): SystemNoticePresentation[] {
        const notices: SystemNoticePresentation[] = [];
        if (!snapshot.platform.uefi)
                notices.push({
                        tone: "error",
                        id: "ui.windowsIsNotRunningInUefiModeFirmwareVariablesAreUnavailable",
                });
        else if (!snapshot.platform.elevated)
                notices.push({
                        tone: "warning",
                        id: "ui.administratorAccessIsRequiredToReadOrSaveUefiSettings",
                });
        else if (!snapshot.driverStatus)
                notices.push({ tone: "warning", id: "ui.driverStatusUnavailable" });
        if (snapshot.devices.length === 0)
                notices.push({
                        tone: "warning",
                        id: "ui.noNvidiaDisplayAdaptersWereDetected",
                });
        if (!snapshot.machineIdentity)
                notices.push({
                        tone: "warning",
                        id: "ui.machineIdentityUnavailable",
                });
        return notices;
}
