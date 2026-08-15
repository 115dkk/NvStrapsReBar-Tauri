import { afterEach, describe, expect, it, vi } from "vitest";
import {
        PREVIEW_REBAR_STATE_KEY,
        previewConfigureBridge,
} from "./bridge";

const previewStorage = (value: string | null) => ({
        getItem: (key: string) =>
                key === PREVIEW_REBAR_STATE_KEY ? value : null,
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: vi.fn(),
        length: value === null ? 0 : 1,
});

afterEach(() => vi.unstubAllGlobals());

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

describe("ConfigureBridge BAR Settings fixtures", () => {
        it.each([
                [
                        "expanded",
                        "expanded",
                        true,
                        "observedThisBoot",
                        "currentBootDxe",
                ],
                [
                        "expanded-no-access",
                        "expanded",
                        true,
                        "indeterminate",
                        "expandedTuringAperture",
                ],
                ["mixed", "mixed", true, "observedThisBoot", "currentBootDxe"],
                [
                        "not-observed",
                        "legacy256MiB",
                        false,
                        "notObservedThisBoot",
                        "notObserved",
                ],
        ] as const)(
                "exposes the %s route state without inventing durable proof",
                async (
                        mode,
                        aperture,
                        settingsAvailable,
                        dxeState,
                        controlEvidence,
                ) => {
                        vi.stubGlobal("sessionStorage", previewStorage(mode));
                        const [snapshot, inspection] = await Promise.all([
                                previewConfigureBridge.snapshot(),
                                previewConfigureBridge.inspectResizableBarStatus(),
                        ]);
                        expect(inspection.state).toBe(aperture);
                        expect(snapshot.barSettings).toMatchObject({
                                settingsAvailable,
                                currentBootDxeState: dxeState,
                                controlEvidence,
                        });
                        if (mode === "expanded-no-access") {
                                expect(snapshot.barSettings.configToken).toBeNull();
                                expect(snapshot.config).toBeNull();
                        }
                },
        );

        it("binds Settings saves to the current topology and configuration tokens", async () => {
                vi.stubGlobal("sessionStorage", previewStorage("expanded"));
                const before = await previewConfigureBridge.snapshot();
                const receipt = await previewConfigureBridge.saveBarSettings({
                        draft: {
                                ...before.config!.draft,
                                targetPciBarSize: 9,
                        },
                        expectedTopologyToken:
                                before.barSettings.topologyToken,
                        expectedConfigToken: before.barSettings.configToken!,
                });
                expect(receipt.save.draft.targetPciBarSize).toBe(9);
                expect(receipt.topologyToken).toBe(
                        before.barSettings.topologyToken,
                );
                expect(receipt.configToken).not.toBe(
                        before.barSettings.configToken,
                );
        });

        it("treats an empty operational draft as removal but keeps a PCI target as configuration", async () => {
                const empty = await previewConfigureBridge.validate({
                        globalMode: 0,
                        targetPciBarSize: 0,
                        skipS3Resume: false,
                        overrideBarSizeMask: false,
                        guardSetupChanges: true,
                        rules: [],
                });
                const pciTarget = await previewConfigureBridge.validate({
                        globalMode: 0,
                        targetPciBarSize: 10,
                        skipS3Resume: false,
                        overrideBarSizeMask: false,
                        guardSetupChanges: true,
                        rules: [],
                });
                expect(empty.variableWillExist).toBe(false);
                expect(pciTarget.variableWillExist).toBe(true);
        });
});
