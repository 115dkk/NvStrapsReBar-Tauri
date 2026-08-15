import { describe, expect, it, vi } from "vitest";
import { runSingleFlight } from "./use-configuration-workspace";

describe("configuration workspace elevation single flight", () => {
        it("issues one bridge elevation while two immediate UI requests share a pending flight", async () => {
                let finishElevation!: () => void;
                const pendingElevation = new Promise<void>((resolve) => {
                        finishElevation = resolve;
                });
                const bridge = {
                        elevate: vi.fn(() => pendingElevation),
                };
                const elevationInFlight = { current: false };
                const requestElevation = () =>
                        runSingleFlight(elevationInFlight, () =>
                                bridge.elevate(),
                        );

                const first = requestElevation();
                const second = requestElevation();

                expect(bridge.elevate).toHaveBeenCalledTimes(1);
                expect(elevationInFlight.current).toBe(true);
                await expect(second).resolves.toBeUndefined();

                finishElevation();
                await first;
                expect(elevationInFlight.current).toBe(false);
        });
});
