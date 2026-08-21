import { describe, expect, it } from "vitest";
import {
        driverAdviceNotice,
        presentSystemNotices,
} from "./system-messages";
import type { SystemSnapshot } from "./types";

const driverStatus = (
        kind: string,
): NonNullable<SystemSnapshot["driverStatus"]> => ({
        raw: "0x0000000000000000",
        code: 0,
        kind,
        label: kind,
        severity: "neutral",
        pciLocation: null,
});

const snapshot = (kind: string | null): SystemSnapshot =>
        ({
                platform: {
                        operatingSystem: "windows",
                        architecture: "x86_64",
                        supported: true,
                        uefi: true,
                        elevated: true,
                },
                driverStatus: kind === null ? null : driverStatus(kind),
                devices: [{}],
                machineIdentity: {},
        }) as unknown as SystemSnapshot;

describe("driver advice", () => {
        it("gives no advice for healthy or expected driver states", () => {
                for (const kind of [
                        "configured",
                        "unconfigured",
                        "not_loaded",
                        "straps_configured",
                        "straps_confirmed",
                        "pci_rebar_configured",
                        "size_override",
                        "gpu_excluded",
                        "unknown",
                ])
                        expect(driverAdviceNotice(driverStatus(kind))).toBeNull();
                expect(driverAdviceNotice(null)).toBeNull();
        });

        it("explains the safety clear after a setup change or CMOS reset", () => {
                expect(driverAdviceNotice(driverStatus("cleared"))).toEqual({
                        tone: "warning",
                        id: "ui.driverAdviceCleared",
                });
        });

        it("shares one hardware-mismatch advice across stale-topology errors", () => {
                for (const kind of [
                        "missing_bridge",
                        "bad_bridge",
                        "bridge_order",
                        "missing_gpu",
                        "bad_gpu",
                ])
                        expect(driverAdviceNotice(driverStatus(kind))).toEqual({
                                tone: "warning",
                                id: "ui.driverAdviceHardwareMismatch",
                        });
        });

        it("maps setup-variable failures to the guard toggle advice", () => {
                for (const kind of [
                        "bad_setup_attributes",
                        "ambiguous_setup",
                        "missing_setup",
                ])
                        expect(driverAdviceNotice(driverStatus(kind))?.id).toBe(
                                "ui.driverAdviceSetupVariable",
                        );
        });

        it("marks EFI and parse failures as errors", () => {
                for (const kind of [
                        "allocation_error",
                        "efi_error",
                        "nvar_api_error",
                ])
                        expect(driverAdviceNotice(driverStatus(kind))).toEqual({
                                tone: "error",
                                id: "ui.driverAdviceEfiError",
                        });
                expect(driverAdviceNotice(driverStatus("parse_error"))).toEqual({
                        tone: "error",
                        id: "ui.driverAdviceParseError",
                });
        });

        it("appends the advice to the system notices", () => {
                expect(presentSystemNotices(snapshot("cleared"))).toEqual([
                        { tone: "warning", id: "ui.driverAdviceCleared" },
                ]);
                expect(presentSystemNotices(snapshot("configured"))).toEqual(
                        [],
                );
        });
});
