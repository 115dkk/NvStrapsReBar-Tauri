import { describe, expect, it } from "vitest";
import { barSettingsErrorMessageId } from "./bar-settings-errors";

describe("BAR Settings error presentation", () => {
        it.each([
                ["stale_topology", "ui.barSettingsErrorStaleTopology"],
                [
                        "stale_configuration",
                        "ui.barSettingsErrorStaleConfiguration",
                ],
                [
                        "bar_settings_control_not_observed",
                        "ui.barSettingsErrorControlNotObserved",
                ],
                ["readback_mismatch", "ui.barSettingsErrorReadbackMismatch"],
        ])("maps %s without inspecting the English message", (code, id) => {
                expect(
                        barSettingsErrorMessageId({
                                code,
                                message: "arbitrary localized backend detail",
                        }),
                ).toBe(id);
        });

        it("leaves unrelated errors to the generic error path", () => {
                expect(
                        barSettingsErrorMessageId({ code: "windows_api_error" }),
                ).toBeNull();
                expect(barSettingsErrorMessageId(new Error("stale_topology"))).toBeNull();
        });
});
