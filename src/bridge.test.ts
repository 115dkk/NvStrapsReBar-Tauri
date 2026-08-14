import { describe, expect, it } from "vitest";
import { previewConfigureBridge } from "./bridge";

describe("ConfigureBridge Resizable BAR inspection", () => {
        it("exposes coherent expanded preview data without a deployment plan", async () => {
                const [snapshot, inspection] = await Promise.all([
                        previewConfigureBridge.snapshot(),
                        previewConfigureBridge.inspectResizableBarStatus(),
                ]);

                expect(snapshot.devices).toHaveLength(1);
                expect(snapshot.devices[0]).toMatchObject({
                        name: "NVIDIA GeForce RTX 2080 SUPER",
                        currentBarSize: "8589934592",
                });
                expect(snapshot.hardwareSupport).toEqual({
                        motherboardNativeResizableBar: {
                                state: "supported",
                                reasonCode: "exactMotherboardCatalogMatch",
                                catalogId: "msi-pro-z690-a-ddr4-ms-7d25",
                        },
                        targetGpuFamily: {
                                state: "supported",
                                reasonCode: "allDetectedGpusTuring",
                        },
                        overallState: "supported",
                });
                expect(inspection).toEqual({
                        driverVersion: "596.36",
                        capturedAt: "2026-08-14T10:50:58Z",
                        state: "expanded",
                        gpus: [
                                {
                                        pciBusId: "00000000:01:00.0",
                                        productName:
                                                "NVIDIA GeForce RTX 2080 SUPER",
                                        bar1TotalBytes: "8589934592",
                                        windowsBarSizeBytes: "8589934592",
                                        state: "expanded",
                                        reason: "BAR1 is larger than the legacy 256 MiB window and matches Windows",
                                        patchConfiguration: {
                                                state: "notNeeded",
                                                reasonCode: "alreadyExpanded",
                                                targetSelector: null,
                                                targetSizeBytes: null,
                                        },
                                },
                        ],
                        warnings: [],
                });
                expect(inspection).not.toHaveProperty("plan");
                expect(inspection).not.toHaveProperty("profileId");
        });
});
