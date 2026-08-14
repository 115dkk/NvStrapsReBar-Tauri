import { describe, expect, it } from "vitest";
import {
        createResizableBarInspectionCoordinator,
        createRequestGenerationGuard,
        presentResizableBarStatus,
        type ResizableBarInspectionLoadState,
} from "./resizable-bar-status";
import type { ResizableBarInspection } from "./types";

const inspection = (
        state: ResizableBarInspection["state"],
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
                        heading: "Resizable BAR active",
                        gpus: [{ bar1TotalBytes: "8589934592" }],
                });
                expect(
                        presentResizableBarStatus({
                                status: "ready",
                                inspection: inspection("legacy256MiB"),
                        }),
                ).toMatchObject({
                        tone: "legacy",
                        heading: "BAR1 is using the 256 MiB aperture",
                        gpus: [{ state: "legacy256MiB" }],
                });
                expect(
                        presentResizableBarStatus({
                                status: "ready",
                                inspection: inspection("indeterminate"),
                        }),
                ).toEqual({
                        tone: "unavailable",
                        heading: "Resizable BAR status unavailable",
                        driverVersion: null,
                        gpus: [],
                });
                expect(
                        presentResizableBarStatus({ status: "error" }),
                ).toEqual({
                        tone: "unavailable",
                        heading: "Resizable BAR status unavailable",
                        driverVersion: null,
                        gpus: [],
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
