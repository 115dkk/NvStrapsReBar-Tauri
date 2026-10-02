import { describe, expect, it } from "vitest";
import { DEFAULT_DRAFT, type ConfigDraft, type GpuDevice, type GpuRule } from "../types";
import {
        EXCLUDED_SELECTOR,
        applyGpuChoice,
        automaticSelector,
        changeItems,
        expansionOn,
        gpuChoice,
        otherRules,
        pciLocation,
        withExpansion,
} from "./bar-settings-model";

const gpu: GpuDevice = {
        id: "pci-01-00-0",
        name: "NVIDIA GeForce RTX 2080 SUPER",
        vendorId: 0x10de,
        deviceId: 0x1e81,
        subsystemVendorId: 0x1462,
        subsystemDeviceId: 0x3755,
        bus: 1,
        device: 0,
        function: 0,
        bar0Base: "0",
        bar0Top: "0",
        currentBarSize: "268435456",
        dedicatedVideoMemory: "8589934592",
        isTuring: true,
        recommendedBarSizeSelector: 7,
        registryBarSizeSelector: 7,
        effectiveBarSizeSelector: null,
};
const twin: GpuDevice = { ...gpu, id: "pci-02-00-0", bus: 2 };
const unlisted: GpuDevice = { ...gpu, id: "pci-03-00-0", deviceId: 0x1f00, bus: 3, recommendedBarSizeSelector: 5, registryBarSizeSelector: null };

const rule = (scope: GpuRule["matchScope"], selector: number | null, at: GpuDevice = gpu): GpuRule => ({
        matchScope: scope,
        deviceId: at.deviceId,
        subsystemVendorId: at.subsystemVendorId,
        subsystemDeviceId: at.subsystemDeviceId,
        bus: at.bus,
        device: at.device,
        function: at.function,
        barSizeSelector: selector,
        overrideBarSizeMask: null,
});
const draft = (patch: Partial<ConfigDraft> = {}): ConfigDraft => ({ ...DEFAULT_DRAFT, globalMode: 2, ...patch });

describe("the size a GPU gets follows nvstraps-core precedence", () => {
        it("prefers a sized location rule, then the last subsystem rule, then the last device rule", () => {
                expect(gpuChoice(draft({ rules: [rule("device", 3), rule("subsystem", 4), rule("location", 6)] }), gpu)).toBe(6);
                expect(gpuChoice(draft({ rules: [rule("subsystem", 4), rule("device", 3), rule("subsystem", 5)] }), gpu)).toBe(5);
                expect(gpuChoice(draft({ rules: [rule("device", 3), rule("device", 2)] }), gpu)).toBe(2);
        });

        it("ignores rules without a size and reads 254 as excluded", () => {
                expect(gpuChoice(draft({ rules: [rule("location", null)] }), gpu)).toBe("auto");
                expect(gpuChoice(draft({ rules: [rule("location", EXCLUDED_SELECTOR)] }), gpu)).toBe("exclude");
        });

        it("gives listed models their listed size and others 2 GiB only in the fallback mode", () => {
                expect(automaticSelector(draft({ globalMode: 2 }), gpu)).toBe(7);
                expect(automaticSelector(draft({ globalMode: 1 }), gpu)).toBe(7);
                expect(automaticSelector(draft({ globalMode: 2 }), unlisted)).toBe(5);
                expect(automaticSelector(draft({ globalMode: 1 }), unlisted)).toBeNull();
                expect(automaticSelector(draft({ globalMode: 0 }), gpu)).toBeNull();
        });
});

describe("choosing a size", () => {
        it("writes a location rule for that slot and updates it on the next choice", () => {
                const once = applyGpuChoice(draft(), gpu, 6);
                expect(once.rules).toEqual([{ ...rule("location", 6) }]);
                const twice = applyGpuChoice(once, gpu, "exclude");
                expect(twice.rules).toEqual([{ ...rule("location", EXCLUDED_SELECTOR) }]);
                // The other card of the same model keeps the automatic size.
                expect(gpuChoice(twice, twin)).toBe("auto");
        });

        it("returns to automatic by clearing every sized rule that matches, keeping mask overrides", () => {
                const masked = { ...rule("location", 4), overrideBarSizeMask: true };
                const next = applyGpuChoice(draft({ rules: [rule("device", 3), masked, rule("location", 2, unlisted)] }), gpu, "auto");
                expect(next.rules).toEqual([{ ...masked, barSizeSelector: null }, rule("location", 2, unlisted)]);
                expect(gpuChoice(next, gpu)).toBe("auto");
        });
});

describe("the expansion switch", () => {
        it("is on for an expanding mode or a sized rule", () => {
                expect(expansionOn(draft({ globalMode: 0 }))).toBe(false);
                expect(expansionOn(draft({ globalMode: 0, rules: [rule("location", EXCLUDED_SELECTOR)] }))).toBe(false);
                expect(expansionOn(draft({ globalMode: 0, rules: [rule("location", 4)] }))).toBe(true);
                expect(expansionOn(draft({ globalMode: 1 }))).toBe(true);
        });

        it("turns off by clearing the rules and turns on with what was there, or the recommended mode", () => {
                const before = draft({ globalMode: 1, rules: [rule("location", 6)] });
                const off = withExpansion(before, false, null);
                expect(off).toMatchObject({ globalMode: 0, rules: [] });
                expect(withExpansion(off, true, { globalMode: before.globalMode, rules: before.rules })).toEqual(before);
                expect(withExpansion(off, true, null)).toMatchObject({ globalMode: 2, rules: [] });
        });
});

describe("the change summary", () => {
        it("lists nothing for identical settings and one GPU line for one size change", () => {
                const saved = draft({ globalMode: 1 });
                expect(changeItems(saved, structuredClone(saved), [gpu])).toEqual([]);
                const items = changeItems(saved, applyGpuChoice(saved, gpu, 6), [gpu]);
                expect(items).toHaveLength(1);
                expect(items[0]).toMatchObject({ kind: "gpu", from: "auto", to: 6 });
        });

        it("reports switching expansion off without listing every GPU", () => {
                const saved = draft({ globalMode: 2 });
                expect(changeItems(saved, withExpansion(saved, false, null), [gpu, twin])).toEqual([{ kind: "expansion", on: false }]);
        });

        it("groups firmware options as advanced and keeps rules for other GPUs separate", () => {
                const saved = draft({ globalMode: 2, rules: [rule("location", 4, unlisted)] });
                expect(changeItems(saved, { ...saved, skipS3Resume: true }, [gpu])).toEqual([{ kind: "advanced" }]);
                expect(changeItems(saved, { ...saved, globalMode: 1 }, [gpu])).toEqual([{ kind: "advanced" }]);
                expect(otherRules(saved, [gpu])).toEqual([{ rule: rule("location", 4, unlisted), index: 0 }]);
                expect(changeItems(saved, { ...saved, rules: [] }, [gpu])).toEqual([{ kind: "otherRules" }]);
        });

        it("formats PCI locations as bus:device.function", () => {
                expect(pciLocation({ bus: 0x1a, device: 0, function: 1 })).toBe("1A:00.1");
        });
});
