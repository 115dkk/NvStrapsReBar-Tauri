import { beforeEach, describe, expect, it } from "vitest";
import { previewGameSettingsBridge as bridge, resetPreviewGameSettings } from "./preview-bridge";

const state = async (name: string) => (await bridge.load()).games.find((game) => game.name === name)!.state;

describe("preview driver settings", () => {
        beforeEach(() => resetPreviewGameSettings());

        it("turns a game on and back to the driver default", async () => {
                expect(await state("Elden Ring")).toEqual({ on: false, source: "driver", changed: false });
                const on = await bridge.setGame("Elden Ring", true);
                expect(on.state).toEqual({ on: true, source: "thisPc", changed: true });
                const off = await bridge.setGame("Elden Ring", false);
                expect(off.state).toEqual({ on: false, source: "driver", changed: false });
                expect(off.backup).toEqual(on.backup);
        });

        it("writes an explicit off for a game NVIDIA or All games turns on", async () => {
                expect((await bridge.setGame("Cyberpunk 2077", false)).state).toEqual({ on: false, source: "thisPc", changed: true });
                await expect(bridge.setAllGames(true, false)).rejects.toMatchObject({ code: "nvidia_driver_settings_failed" });
                await bridge.setAllGames(true, true);
                expect(await state("Counter-Strike 2")).toEqual({ on: true, source: "allGames", changed: false });
                expect((await bridge.setGame("Counter-Strike 2", false)).state.on).toBe(false);
        });

        it("restores the database saved before the first change", async () => {
                expect((await bridge.load()).backup).toBeNull();
                const first = await bridge.setGame("Elden Ring", true);
                await bridge.setAllGames(true, true);
                const restored = await bridge.restore(first.backup.sha256);
                expect(restored.allGames.on).toBe(false);
                expect(restored.games.every((game) => !game.state.changed)).toBe(true);
                await expect(bridge.restore("0".repeat(64))).rejects.toMatchObject({ code: "nvidia_driver_settings_failed" });
        });
});
