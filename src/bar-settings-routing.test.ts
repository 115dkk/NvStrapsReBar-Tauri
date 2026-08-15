import { describe, expect, it } from "vitest";
import {
        initialApplicationSurface,
        settingsLockMessageId,
} from "./bar-settings-routing";
import type { ResizableBarInspectionLoadState } from "./resizable-bar-status";
import type { SystemSnapshot } from "./types";

const snapshot = (
        currentBootDxeState: SystemSnapshot["barSettings"]["currentBootDxeState"],
        settingsAvailable: boolean,
): SystemSnapshot =>
        ({
                barSettings: {
                        currentBootDxeState,
                        currentBootDxeReasonCode:
                                currentBootDxeState === "observedThisBoot"
                                        ? "currentBootStatusObserved"
                                        : currentBootDxeState ===
                                            "notObservedThisBoot"
                                          ? "statusVariableMissing"
                                          : "statusVariableUnavailable",
                        controlEvidence: settingsAvailable
                                ? currentBootDxeState === "observedThisBoot"
                                        ? "currentBootDxe"
                                        : "expandedTuringAperture"
                                : currentBootDxeState ===
                                    "notObservedThisBoot"
                                  ? "notObserved"
                                  : "indeterminate",
                        settingsAvailable,
                        savedConfigurationState: "enabled",
                        topologyToken: "topology",
                        configToken: "configuration",
                },
        }) as SystemSnapshot;

const inspection = (
        state: "expanded" | "mixed" | "legacy256MiB" | "indeterminate",
): ResizableBarInspectionLoadState => ({
        status: "ready",
        inspection: { state } as never,
});

describe("BAR Settings routing", () => {
        it("opens Settings only for expanded aperture with settings available", () => {
                expect(
                        initialApplicationSurface(
                                snapshot("observedThisBoot", true),
                                inspection("expanded"),
                        ),
                ).toBe("settings");
                for (const state of [
                        "mixed",
                        "legacy256MiB",
                        "indeterminate",
                ] as const)
                        expect(
                                initialApplicationSurface(
                                        snapshot("observedThisBoot", true),
                                        inspection(state),
                                ),
                        ).toBe("configure");
        });

        it("never unlocks from aperture or saved configuration alone", () => {
                for (const currentBootDxeState of [
                        "notObservedThisBoot",
                        "indeterminate",
                ] as const)
                        expect(
                                initialApplicationSurface(
                                        snapshot(currentBootDxeState, false),
                                        inspection("expanded"),
                                ),
                        ).toBe("configure");
        });

        it("keeps loading and inspection failures on Configure", () => {
                const available = snapshot("observedThisBoot", true);
                expect(
                        initialApplicationSurface(available, {
                                status: "loading",
                        }),
                ).toBe("configure");
                expect(
                        initialApplicationSurface(available, {
                                status: "error",
                        }),
                ).toBe("configure");
        });

        it("selects a typed lock explanation without display-string logic", () => {
                expect(
                        settingsLockMessageId(
                                snapshot("notObservedThisBoot", false),
                        ),
                ).toBe("ui.settingsLockedControlNotObserved");
                expect(
                        settingsLockMessageId(snapshot("indeterminate", false)),
                ).toBe("ui.settingsLockedDriverStateIndeterminate");
        });
});
