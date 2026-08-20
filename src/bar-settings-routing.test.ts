import { describe, expect, it } from "vitest";
import {
        firmwareInstalled,
        initialApplicationSurface,
} from "./bar-settings-routing";
import type { SystemSnapshot } from "./types";

const snapshot = (
        controlEvidence: SystemSnapshot["barSettings"]["controlEvidence"],
): SystemSnapshot =>
        ({
                barSettings: {
                        currentBootDxeState:
                                controlEvidence === "currentBootDxe"
                                        ? "observedThisBoot"
                                        : "notObservedThisBoot",
                        currentBootDxeReasonCode:
                                controlEvidence === "currentBootDxe"
                                        ? "currentBootStatusObserved"
                                        : "statusVariableMissing",
                        controlEvidence,
                        settingsAvailable:
                                controlEvidence === "currentBootDxe" ||
                                controlEvidence === "expandedTuringAperture",
                        savedConfigurationState: "enabled",
                        topologyToken: "topology",
                        configToken: "configuration",
                },
        }) as SystemSnapshot;

describe("application surface routing", () => {
        it("treats current-boot DXE or an expanded Turing aperture as an installed driver", () => {
                expect(firmwareInstalled(snapshot("currentBootDxe"))).toBe(
                        true,
                );
                expect(
                        firmwareInstalled(snapshot("expandedTuringAperture")),
                ).toBe(true);
                expect(firmwareInstalled(snapshot("notObserved"))).toBe(false);
                expect(firmwareInstalled(snapshot("indeterminate"))).toBe(
                        false,
                );
        });

        it("opens BAR settings once the driver left evidence in this boot", () => {
                expect(
                        initialApplicationSurface(snapshot("currentBootDxe")),
                ).toBe("bar");
                expect(
                        initialApplicationSurface(
                                snapshot("expandedTuringAperture"),
                        ),
                ).toBe("bar");
        });

        it("opens the firmware install journey before the driver is installed", () => {
                expect(
                        initialApplicationSurface(snapshot("notObserved")),
                ).toBe("deploy");
                expect(
                        initialApplicationSurface(snapshot("indeterminate")),
                ).toBe("deploy");
        });
});
