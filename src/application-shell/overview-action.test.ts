import { describe, expect, it } from "vitest";
import { overviewAction } from "./overview-action";
import type { SystemSnapshot } from "../types";

const snapshot = (installed = false) => ({
        platform: { uefi: true, elevated: true },
        barSettings: { controlEvidence: installed ? "currentBootDxe" : "notObserved" },
        devices: [{ isTuring: true }],
}) as SystemSnapshot;

describe("overview next action", () => {
        it("resumes an unfinished plan without inventing its completion", () => {
                expect(overviewAction(snapshot(true), "expanded", true).action).toBe("deploy");
        });
        it("separates installation from configuration and current activation", () => {
                expect(overviewAction(snapshot(), "legacy", false).action).toBe("deploy");
                expect(overviewAction(snapshot(true), "legacy", false).action).toBe("bar");
                expect(overviewAction(snapshot(true), "expanded", false).title).toBe("ui.expansionAlreadyActive");
        });
        it("does not call unknown state uninstalled or promise an unsupported GPU upgrade", () => {
                expect(overviewAction(snapshot(), "unavailable", false).action).toBe("refresh");
                const noGpu = snapshot(); noGpu.devices = [];
                expect(overviewAction(noGpu, "legacy", false).title).toBe("ui.overviewNoTargetGpu");
                expect(overviewAction(noGpu, "expanded", false).action).toBe(null);
        });
        it("explains access prerequisites and keeps loading passive", () => {
                const limited = snapshot(); limited.platform.elevated = false;
                expect(overviewAction(limited, "legacy", false).action).toBe("elevate");
                limited.platform.uefi = false;
                expect(overviewAction(limited, "legacy", false).action).toBe(null);
                expect(overviewAction(snapshot(), "loading", false).action).toBe(null);
        });
});
