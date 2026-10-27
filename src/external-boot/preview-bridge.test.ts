import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalBootBridge, ExternalMedium } from "./contract";
import { activeRoute, defaultSize, externalScreen, usableCandidates } from "./model";
import type { PreviewExternalState } from "./preview-bridge";

const usb: ExternalMedium = { kind: "usb", root: "E:\\" };
const esp: ExternalMedium = { kind: "esp" };
const GiB = 1024 ** 3;
const preview = async (scenario: PreviewExternalState = "ready") => {
        vi.resetModules();
        vi.stubGlobal("localStorage", { getItem: vi.fn((key: string) => key === "nvstraps-preview-external-state" ? scenario : null) });
        return (await import("./preview-bridge")).previewExternalBootBridge;
};
const diagnostic = async (bridge: ExternalBootBridge, medium: ExternalMedium) => {
        await bridge.prepareDiagnostic(medium);
        await bridge.restart(true);
        return bridge.readReport(medium);
};
const loader = async (bridge: ExternalBootBridge, medium: ExternalMedium) => {
        const report = await diagnostic(bridge, medium);
        const gpu = usableCandidates(report)[0];
        return bridge.writeLoader(medium, gpu.slot, defaultSize(gpu)!);
};

afterEach(() => vi.unstubAllGlobals());

describe("preview external boot", () => {
        it("experiments on E: from choose through a diagnostic and loader to result", async () => {
                const bridge = await preview();
                const initial = await bridge.inspect();
                expect(externalScreen(initial, false)).toBe("choose");
                expect(initial.usbDrives).toMatchObject([
                        { root: "E:\\", label: "NVSTRAPS", fileSystem: "FAT32", usable: true, state: null },
                        { root: "F:\\", fileSystem: "NTFS", usable: false, problem: "notFat", state: null },
                ]);
                const prepared = await bridge.prepareDiagnostic(usb);
                expect(externalScreen(prepared, false)).toBe("diagnosticReady");
                expect(prepared.install).toBeNull();
                expect(activeRoute(prepared)?.state.stageWrittenUnixMs).toBeGreaterThan(initial.bootTimeUnixMs);
                expect(await bridge.inspect()).toEqual(prepared);
                await expect(bridge.readReport(usb)).rejects.toMatchObject({ code: "externalNoReport" });

                await bridge.restart(false);
                const diagnosed = await bridge.inspect();
                expect(externalScreen(diagnosed, false)).toBe("pickGpu");
                expect(diagnosed.bootTimeUnixMs).toBeGreaterThan(activeRoute(prepared)!.state.stageWrittenUnixMs!);
                expect(activeRoute(diagnosed)?.state.restartedSinceStage).toBe(true);
                const report = await bridge.readReport(usb);
                expect(report).toMatchObject({ environment: "physical", complete: true, errors: [], secureBoot: false });
                const gpu = report.candidates[0];
                expect(gpu).toMatchObject({
                        slot: { segment: 0, bus: 1, device: 0, function: 0 }, name: "NVIDIA GeForce RTX 2080 SUPER",
                        product: 0x1e81, currentBar1Bytes: 256 * 1024 ** 2, recommendedBytes: 8 * GiB, refusal: null,
                });
                expect(gpu.sizes.map((size) => size.bytes)).toEqual([0.5, 1, 2, 4, 8, 16, 32].map((size) => size * GiB));
                expect(gpu.sizes.filter((size) => size.error)).toEqual([
                        { bytes: 16 * GiB, error: "noAddressSpace" }, { bytes: 32 * GiB, error: "noAddressSpace" },
                ]);
                const written = await bridge.writeLoader(usb, gpu.slot, 4 * GiB);
                expect(externalScreen(written, false)).toBe("loaderReady");
                expect(activeRoute(written)?.state).toMatchObject({ restartedSinceStage: false, receipt: null, plan: { sizeBytes: 4 * GiB } });
                expect(await bridge.inspect()).toEqual(written);
                await bridge.restart(false);
                const result = await bridge.inspect();
                expect(externalScreen(result, false)).toBe("result");
                expect(activeRoute(result)?.state.receipt).toMatchObject({ target: "0000:01:00.0", sizeBytes: 4 * GiB, measuredBytes: 4 * GiB });
                await expect(bridge.makePermanent()).rejects.toMatchObject({ code: "externalNoReceipt" });
                expect(externalScreen(await bridge.remove(usb), false)).toBe("choose");
                await expect(bridge.readReport(usb)).rejects.toMatchObject({ code: "externalNoReport" });
        });

        it("installs from choose through a successful trial to installed, then removes the route", async () => {
                const bridge = await preview();
                expect(externalScreen(await bridge.inspect(), false)).toBe("choose");
                await expect(bridge.makePermanent()).rejects.toMatchObject({ code: "externalNoReceipt" });
                const prepared = await bridge.prepareDiagnostic(esp);
                expect(prepared.install).toMatchObject({ diagnosticEntry: true, loaderEntry: false, nextScheduled: "diagnostic" });
                expect(externalScreen(prepared, false)).toBe("diagnosticReady");
                await bridge.restart(false);
                const diagnosed = await bridge.inspect();
                expect(diagnosed.install?.nextScheduled).toBeNull();
                expect(externalScreen(diagnosed, false)).toBe("pickGpu");
                const gpu = (await bridge.readReport(esp)).candidates[0];
                const written = await bridge.writeLoader(esp, gpu.slot, defaultSize(gpu)!);
                expect(externalScreen(written, false)).toBe("loaderReady");
                expect(written.install).toMatchObject({ diagnosticEntry: true, loaderEntry: true, loaderFirst: false, nextScheduled: "loader" });
                await expect(bridge.makePermanent()).rejects.toMatchObject({ code: "externalNoReceipt" });
                await bridge.restart(false);
                const trial = await bridge.inspect();
                expect(externalScreen(trial, false)).toBe("result");
                expect(trial.install?.receipt?.measuredBytes).toBe(8 * GiB);
                const permanent = await bridge.makePermanent();
                expect(externalScreen(permanent, false)).toBe("installed");
                expect(permanent.install).toMatchObject({ diagnosticEntry: false, loaderEntry: true, loaderFirst: true, nextScheduled: null });
                expect(await bridge.inspect()).toEqual(permanent);
                await bridge.restart(false);
                expect(externalScreen(await bridge.inspect(), false)).toBe("installed");
                const removed = await bridge.remove(esp);
                expect(removed.install).toBeNull();
                expect(externalScreen(removed, false)).toBe("choose");
        });

        it("requires BitLocker consent on each restart and does not boot when refused", async () => {
                const bridge = await preview("bitLocker");
                const prepared = await bridge.prepareDiagnostic(esp);
                await expect(bridge.restart(false)).rejects.toMatchObject({ code: "externalBitLockerSuspensionRequired" });
                expect(await bridge.inspect()).toEqual(prepared);
                await bridge.restart(true);
                const booted = await bridge.inspect();
                expect(externalScreen(booted, false)).toBe("pickGpu");
                expect(booted.bitLocker).toBe("on");
                await expect(bridge.restart(false)).rejects.toMatchObject({ code: "externalBitLockerSuspensionRequired" });
        });

        it.each([usb, esp])("reports a failed loader on %j without manufacturing a receipt", async (medium) => {
                const bridge = await preview("loaderFails");
                await loader(bridge, medium);
                await bridge.restart(false);
                const failed = await bridge.inspect();
                expect(externalScreen(failed, false)).toBe("loaderMissing");
                expect(activeRoute(failed)?.state).toMatchObject({ receipt: null, lastError: "pinned successor missing or changed" });
                await expect(bridge.makePermanent()).rejects.toMatchObject({ code: "externalNoReceipt" });
                const gpu = (await bridge.readReport(medium)).candidates[0];
                const retried = await bridge.writeLoader(medium, gpu.slot, 8 * GiB);
                expect(activeRoute(retried)?.state).toMatchObject({ receipt: null, lastError: null, restartedSinceStage: false });
                expect(externalScreen(await bridge.remove(medium), false)).toBe("choose");
        });

        it("refuses both stage writes while Secure Boot is on", async () => {
                const bridge = await preview("secureBoot");
                const initial = await bridge.inspect();
                expect(externalScreen(initial, false)).toBe("blocked");
                for (const medium of [usb, esp]) {
                        await expect(bridge.prepareDiagnostic(medium)).rejects.toMatchObject({ code: "externalSecureBootOn" });
                        await expect(bridge.writeLoader(medium, { segment: 0, bus: 1, device: 0, function: 0 }, 8 * GiB)).rejects.toMatchObject({ code: "externalSecureBootOn" });
                }
                expect(await bridge.inspect()).toEqual(initial);
        });

        it("refuses the console GPU at every size", async () => {
                const bridge = await preview("consoleGpu");
                const report = await diagnostic(bridge, usb);
                const gpu = report.candidates[0];
                expect(gpu.refusal).toBe("consoleInUse");
                expect(gpu.sizes.every((size) => size.error === "consoleInUse")).toBe(true);
                expect(usableCandidates(report)).toEqual([]);
                expect(defaultSize(gpu)).toBeNull();
                await expect(bridge.writeLoader(usb, gpu.slot, 8 * GiB)).rejects.toMatchObject({ code: "externalPlan", message: "consoleInUse" });
        });

        it("allows install without USB and refuses missing or non-FAT USB drives", async () => {
                const noUsb = await preview("noUsb");
                expect((await noUsb.inspect()).usbDrives).toEqual([]);
                await expect(noUsb.prepareDiagnostic(usb)).rejects.toMatchObject({ code: "externalMediumUnavailable" });
                expect(externalScreen(await noUsb.prepareDiagnostic(esp), false)).toBe("diagnosticReady");
                const ready = await preview();
                await expect(ready.prepareDiagnostic({ kind: "usb", root: "F:\\" })).rejects.toMatchObject({ code: "externalNotFat" });
        });

        it("validates the target and size against the saved diagnostic without changing the stage on failure", async () => {
                const bridge = await preview();
                const gpu = (await diagnostic(bridge, usb)).candidates[0];
                const before = await bridge.inspect();
                await expect(bridge.writeLoader(usb, { ...gpu.slot, bus: 2 }, 8 * GiB)).rejects.toMatchObject({ code: "externalPlan", message: "noTarget" });
                await expect(bridge.writeLoader(usb, gpu.slot, 16 * GiB)).rejects.toMatchObject({ code: "externalPlan", message: "noAddressSpace" });
                await expect(bridge.writeLoader(usb, gpu.slot, 123)).rejects.toMatchObject({ code: "externalPlan", message: "invalidSize" });
                expect(await bridge.inspect()).toEqual(before);
        });

        it("clears old evidence on stage writes and isolates returned objects from the machine", async () => {
                const bridge = await preview();
                await loader(bridge, usb);
                await bridge.restart(false);
                const snapshot = await bridge.inspect();
                const gpu = (await bridge.readReport(usb)).candidates[0];
                const rewritten = await bridge.writeLoader(usb, gpu.slot, 2 * GiB);
                expect(activeRoute(rewritten)?.state).toMatchObject({ receipt: null, lastError: null, restartedSinceStage: false });
                expect(activeRoute(snapshot)?.state.receipt?.measuredBytes).toBe(8 * GiB);
                snapshot.usbDrives.length = 0;
                gpu.sizes.length = 0;
                expect((await bridge.inspect()).usbDrives).toHaveLength(2);
                expect((await bridge.readReport(usb)).candidates[0].sizes).toHaveLength(7);
                const prepared = await bridge.prepareDiagnostic(usb);
                expect(activeRoute(prepared)?.state).toMatchObject({ stage: "diagnostic", report: false, plan: null, receipt: null, lastError: null });
                await expect(bridge.readReport(usb)).rejects.toMatchObject({ code: "externalNoReport" });
        });

        it("removes only the requested medium", async () => {
                const bridge = await preview();
                await bridge.prepareDiagnostic(usb);
                await bridge.prepareDiagnostic(esp);
                expect(activeRoute(await bridge.inspect())?.mode).toBe("install");
                const removed = await bridge.remove(esp);
                expect(activeRoute(removed)?.medium).toEqual(usb);
                expect(externalScreen(await bridge.remove(usb), false)).toBe("choose");
        });

        it("reads the scenario once at module load and falls back when storage is unavailable", async () => {
                const bridge = await preview("ready");
                const getItem = vi.mocked(localStorage.getItem);
                getItem.mockReturnValue("secureBoot");
                expect((await bridge.inspect()).secureBoot).toBe(false);
                expect(getItem).toHaveBeenCalledTimes(1);
                vi.resetModules();
                vi.stubGlobal("localStorage", { getItem: () => { throw new Error("storage denied"); } });
                const fallback = await import("./preview-bridge");
                expect(fallback.PREVIEW_EXTERNAL_STATE_KEY).toBe("nvstraps-preview-external-state");
                expect(externalScreen(await fallback.previewExternalBootBridge.inspect(), false)).toBe("choose");
        });
});
