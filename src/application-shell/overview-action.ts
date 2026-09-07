import { firmwareInstalled } from "../bar-settings-routing";
import type { StaticMessageId } from "../i18n-catalog";
import type { ResizableBarStatusPresentation } from "../resizable-bar-status";
import type { SystemSnapshot } from "../types";

export type OverviewAction = {
        title: StaticMessageId;
        detail: StaticMessageId;
        action: "deploy" | "bar" | "refresh" | "elevate" | null;
        label: StaticMessageId;
};

/** Navigation advice only: this never authorizes a write or advances a plan. */
export function overviewAction(snapshot: SystemSnapshot, tone: ResizableBarStatusPresentation["tone"], continuing: boolean): OverviewAction {
        if (continuing) return { title: "ui.continueInstallation", detail: "ui.continueInstallationDetail", action: "deploy", label: "ui.continueSetup" };
        if (tone === "expanded") return { title: "ui.expansionAlreadyActive", detail: "ui.expansionAlreadyActiveDetail", action: firmwareInstalled(snapshot) ? "bar" : null, label: "ui.openBarSettings" };
        if (!snapshot.platform.uefi) return { title: "ui.overviewUefiRequired", detail: "ui.windowsIsNotRunningInUefiModeFirmwareVariablesAreUnavailable", action: null, label: "ui.tryAgain" };
        if (!snapshot.platform.elevated) return { title: "ui.overviewAdminRequired", detail: "ui.administratorAccessIsRequiredToReadOrSaveUefiSettings", action: "elevate", label: "ui.restartAsAdministrator" };
        if (tone === "loading" || tone === "unavailable") return { title: "ui.overviewCheckState", detail: tone === "loading" ? "ui.rebarVerdictCheckingDetail" : "ui.rebarVerdictUnavailableDetail", action: tone === "loading" ? null : "refresh", label: "ui.retryStatusCheck" };
        if (!firmwareInstalled(snapshot) && !snapshot.devices.some((gpu) => gpu.isTuring)) return { title: "ui.overviewNoTargetGpu", detail: "ui.overviewNoTargetGpuDetail", action: "refresh", label: "ui.retryStatusCheck" };
        return firmwareInstalled(snapshot)
                ? { title: "ui.chooseExpansionSettings", detail: "ui.chooseExpansionSettingsDetail", action: "bar", label: "ui.openBarSettings" }
                : { title: "ui.installationNeeded", detail: "ui.installationNeededDetail", action: "deploy", label: "ui.startSetup" };
}
