import { describe, expect, it } from "vitest";
import {
        createResizableBarInspectionCoordinator,
        createRequestGenerationGuard,
        presentResizableBarStatus,
        type ResizableBarInspectionLoadState,
} from "./resizable-bar-status";
import type {
        ResizableBarApertureState,
        ResizableBarInspection,
} from "./types";

const inspection = (
        state: ResizableBarApertureState,
): ResizableBarInspection => ({
        driverVersion: "596.36",
        capturedAt: "2026-08-14T10:50:58Z",
        state,
        gpus: [
                {
                        pciBusId: "00000000:01:00.0",
                        productName: "NVIDIA GeForce RTX 2080 SUPER",
                        bar1TotalBytes:
                                state === "indeterminate"
                                        ? null
                                        : state === "expanded"
                                          ? "8589934592"
                                          : "268435456",
                        windowsBarSizeBytes:
                                state === "expanded"
                                        ? "8589934592"
                                        : "268435456",
                        state,
                        reason: "fixture",
                        patchConfiguration:
                                state === "expanded"
                                        ? {
                                                  state: "notNeeded",
                                                  reasonCode: "alreadyExpanded",
                                                  targetSelector: null,
                                                  targetSizeBytes: null,
                                          }
                                        : state === "legacy256MiB"
                                          ? {
                                                    state: "available",
                                                    reasonCode:
                                                            "automaticTargetAvailable",
					targetSelector: 7,
                                                    targetSizeBytes: "8589934592",
                                            }
                                          : {
                                                    state: "indeterminate",
                                                    reasonCode:
                                                            "apertureIndeterminate",
                                                    targetSelector: null,
                                                    targetSizeBytes: null,
                                            },
                },
        ],
        warnings: [],
});

const deferred = <T>() => {
        let resolve!: (value: T) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<T>((yes, no) => {
                resolve = yes;
                reject = no;
        });
        return { promise, resolve, reject };
};

describe("Resizable BAR status presenter", () => {
        it("rejects an older snapshot generation after refresh begins", () => {
                const guard = createRequestGenerationGuard();
                const initialLoad = guard.begin();
                const refresh = guard.begin();

                expect(guard.isCurrent(initialLoad)).toBe(false);
                expect(guard.isCurrent(refresh)).toBe(true);
        });

        it("distinguishes expanded, legacy aperture, and unavailable states", () => {
                expect(
                        presentResizableBarStatus({
                                status: "ready",
                                inspection: inspection("expanded"),
                        }),
                ).toMatchObject({
                        tone: "expanded",
                        headingId: "ui.resizableBarActive",
                        aggregateSymbol: null,
                        gpus: [
                                {
                                        apertureId: "ui.apertureExpanded",
                                        patchStateId: "ui.configurationNotNeeded",
                                        patchSymbol: "—",
                                        gpu: { bar1TotalBytes: "8589934592" },
                                },
                        ],
                });
                expect(
                        presentResizableBarStatus({
                                status: "ready",
                                inspection: inspection("legacy256MiB"),
                        }),
                ).toMatchObject({
                        tone: "legacy",
                        headingId: "ui.bar1IsUsingThe256MibAperture",
                        aggregateSymbol: null,
                        gpus: [
                                {
                                        apertureId: "ui.apertureLegacy256Mib",
                                        patchStateId: "ui.patchConfigurationAvailable",
                                        patchSymbol: "O",
                                        gpu: { state: "legacy256MiB" },
                                },
                        ],
                });
                expect(
                        presentResizableBarStatus({
                                status: "ready",
                                inspection: inspection("indeterminate"),
                        }),
                ).toEqual({
                        tone: "unavailable",
                        headingId: "ui.resizableBarStatusUnavailable",
                        aggregateSymbol: null,
                        driverVersion: null,
                        gpus: [
                                expect.objectContaining({
                                        apertureId: "ui.apertureIndeterminate",
                                        patchStateId:
                                                "ui.patchConfigurationIndeterminate",
                                        patchSymbol: "?",
                                }),
                        ],
                });
                expect(
                        presentResizableBarStatus({ status: "error" }),
                ).toEqual({
                        tone: "unavailable",
                        headingId: "ui.resizableBarStatusUnavailable",
                        aggregateSymbol: null,
                        driverVersion: null,
                        gpus: [],
                });
        });

        it("keeps every GPU in a mixed inspection with app configuration facts", () => {
                const expanded = inspection("expanded").gpus[0]!;
                const legacy = inspection("legacy256MiB").gpus[0]!;
                const result = presentResizableBarStatus({
                        status: "ready",
                        inspection: {
                                ...inspection("expanded"),
                                state: "mixed",
                                gpus: [expanded, legacy],
                        },
                });

                expect(result).toMatchObject({
                        tone: "mixed",
                        headingId: "ui.mixedResizableBarApertures",
                        aggregateSymbol: "MIX",
                });
                expect(result.gpus).toHaveLength(2);
                expect(result.gpus.map((gpu) => gpu.patchSymbol)).toEqual([
                        "—",
                        "O",
                ]);
                expect(result.gpus[1]?.gpu.patchConfiguration).toMatchObject({
                        state: "available",
			targetSelector: 7,
                        targetSizeBytes: "8589934592",
                });
        });

        it("distinguishes a registry-excluded configuration from an available target", () => {
                const legacy = inspection("legacy256MiB").gpus[0]!;
                const result = presentResizableBarStatus({
                        status: "ready",
                        inspection: {
                                ...inspection("legacy256MiB"),
                                gpus: [
                                        {
                                                ...legacy,
                                                patchConfiguration: {
                                                        state: "unavailable",
                                                        reasonCode:
                                                                "registryExcluded",
                                                        targetSelector: null,
                                                        targetSizeBytes: null,
                                                },
                                        },
                                ],
                        },
                });

                expect(result.gpus[0]).toMatchObject({
                        patchStateId: "ui.patchConfigurationUnavailable",
                        patchSymbol: "X",
                        patchTone: "unavailable",
                });
        });

        it("keeps a newer refresh result when an older inspection fails later", async () => {
                const first = deferred<ResizableBarInspection>();
                const second = deferred<ResizableBarInspection>();
                const states: ResizableBarInspectionLoadState[] = [];
                const coordinator = createResizableBarInspectionCoordinator(
                        (state) => states.push(state),
                );

                const oldRequest = coordinator.run(() => first.promise);
                const newRequest = coordinator.run(() => second.promise);
                second.resolve(inspection("expanded"));
                await newRequest;
                first.reject(new Error("stale nvidia-smi failure"));
                await oldRequest;

                expect(states.at(-1)).toEqual({
                        status: "ready",
                        inspection: inspection("expanded"),
                });
                expect(states).not.toContainEqual({ status: "error" });
        });
});
