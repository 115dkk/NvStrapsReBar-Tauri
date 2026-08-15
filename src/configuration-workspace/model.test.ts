import { describe, expect, it } from "vitest";
import { DEFAULT_DRAFT } from "../types";
import { hasOperationalConfiguration } from "./model";

describe("configuration workspace model", () => {
        it("distinguishes an empty operational draft from every actual target", () => {
                expect(hasOperationalConfiguration(DEFAULT_DRAFT)).toBe(false);
                expect(
                        hasOperationalConfiguration({
                                ...DEFAULT_DRAFT,
                                targetPciBarSize: 10,
                        }),
                ).toBe(true);
                expect(
                        hasOperationalConfiguration({
                                ...DEFAULT_DRAFT,
                                globalMode: 1,
                        }),
                ).toBe(true);
                expect(
                        hasOperationalConfiguration({
                                ...DEFAULT_DRAFT,
                                rules: [
                                        {
                                                matchScope: "device",
                                                deviceId: 0x1e81,
                                                subsystemVendorId: 0,
                                                subsystemDeviceId: 0,
                                                bus: 0,
                                                device: 0,
                                                function: 0,
                                                barSizeSelector: null,
                                                overrideBarSizeMask: null,
                                        },
                                ],
                        }),
                ).toBe(true);
        });
});
