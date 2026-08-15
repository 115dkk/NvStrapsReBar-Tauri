import type { ResizableBarInspectionLoadState } from "./resizable-bar-status";
import type { StaticMessageId } from "./i18n-catalog";
import type { SystemSnapshot } from "./types";

export type ApplicationSurface = "configure" | "settings" | "deploy";

export const initialApplicationSurface = (
        snapshot: SystemSnapshot,
        inspection: ResizableBarInspectionLoadState,
): ApplicationSurface =>
        snapshot.barSettings.settingsAvailable &&
        inspection.status === "ready" &&
        inspection.inspection.state === "expanded"
                ? "settings"
                : "configure";

export const settingsLockMessageId = (
        snapshot: SystemSnapshot,
): StaticMessageId | null => {
        if (snapshot.barSettings.settingsAvailable) return null;
        if (snapshot.barSettings.controlEvidence === "notObserved")
                return "ui.settingsLockedControlNotObserved";
        if (snapshot.barSettings.controlEvidence === "indeterminate")
                return "ui.settingsLockedDriverStateIndeterminate";
        return "ui.settingsLockedCurrentConfigurationUnavailable";
};
