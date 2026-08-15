import type { StaticMessageId } from "./i18n-catalog";

const messageByCode: Record<string, StaticMessageId> = {
        stale_topology: "ui.barSettingsErrorStaleTopology",
        stale_configuration: "ui.barSettingsErrorStaleConfiguration",
        bar_settings_control_not_observed:
                "ui.barSettingsErrorControlNotObserved",
        readback_mismatch: "ui.barSettingsErrorReadbackMismatch",
};

export const barSettingsErrorMessageId = (
        cause: unknown,
): StaticMessageId | null => {
        if (!cause || typeof cause !== "object" || !("code" in cause))
                return null;
        const code = (cause as { code?: unknown }).code;
        return typeof code === "string" ? (messageByCode[code] ?? null) : null;
};
