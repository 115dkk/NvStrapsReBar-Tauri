import { describe, expect, it } from "vitest";
import type { GameProfile, RebarState } from "./contract";
import { gameSettingsError, indexGames, keepChanged, searchGames, sourceMessageId } from "./model";

const off: RebarState = { on: false, source: "driver", changed: false };
const game = (name: string, apps: string[], state: RebarState = off): GameProfile => ({ name, apps, state });

const games = [
        game("Counter-Strike 2", ["cs2.exe"]),
        game("Cyberpunk 2077", ["Cyberpunk2077.exe"], { on: true, source: "nvidia", changed: false }),
        game("Red Dead Redemption 2", ["RDR2.exe"]),
        game("Dead Space", ["Dead Space.exe"]),
        game("Pokémon Legends", ["legends.exe"]),
];
const names = (query: string, limit?: number) => searchGames(indexGames(games), query, limit).shown.map((entry) => entry.name);

describe("game search", () => {
        it("ignores case, punctuation, and spacing", () => {
                expect(names("counter strike")).toEqual(["Counter-Strike 2"]);
                expect(names("COUNTERSTRIKE")).toEqual(["Counter-Strike 2"]);
                expect(names("pokemon")).toEqual(["Pokémon Legends"]);
        });

        it("ranks a name prefix before a word prefix before a part of a name", () => {
                expect(names("dead")).toEqual(["Dead Space", "Red Dead Redemption 2"]);
                expect(names("ead")).toEqual(["Dead Space", "Red Dead Redemption 2"]);
        });

        it("finds a game by its program", () => {
                expect(names("rdr2")).toEqual(["Red Dead Redemption 2"]);
                expect(names("cs2.exe")).toEqual(["Counter-Strike 2"]);
        });

        it("shows nothing for an empty query and counts what the limit hides", () => {
                expect(searchGames(indexGames(games), "  ")).toEqual({ shown: [], total: 0 });
                const limited = searchGames(indexGames(games), "e", 2);
                expect(limited.shown).toHaveLength(2);
                expect(limited.total).toBe(5);
        });
});

describe("game rows", () => {
        it("keeps games changed on this PC listed in the order they appeared", () => {
                const changed = { on: true, source: "thisPc", changed: true } as const;
                const kept = keepChanged([], [game("B", ["b.exe"], changed), game("A", ["a.exe"])]);
                expect(kept).toEqual(["B"]);
                // A game turned back to the driver default stays listed for the visit.
                expect(keepChanged(kept, [game("B", ["b.exe"]), game("C", ["c.exe"], changed)])).toEqual(["B", "C"]);
        });

        it("names the source except for the driver default", () => {
                expect(sourceMessageId({ on: true, source: "nvidia", changed: false })).toBe("ui.gameSourceNvidia");
                expect(sourceMessageId({ on: true, source: "allGames", changed: false })).toBe("ui.gameSourceAllGames");
                expect(sourceMessageId({ on: false, source: "thisPc", changed: true })).toBe("ui.gameSourceThisPc");
                expect(sourceMessageId(off)).toBeNull();
        });

        it("maps backend error codes to next actions and keeps the backend message", () => {
                expect(gameSettingsError({ code: "administrator_required" }).id).toBe("ui.gamesErrorAdministrator");
                expect(gameSettingsError({ code: "nvidia_driver_unavailable" }).id).toBe("ui.gamesErrorDriverUnavailable");
                expect(gameSettingsError({ code: "nvidia_driver_readback_mismatch" }).id).toBe("ui.gamesErrorReadback");
                const failed = gameSettingsError({ code: "nvidia_driver_settings_failed", message: "NvAPI_DRS_SetSetting returned NvAPI status -1 (log: C:\\logs\\driver-settings.log)" });
                expect(failed).toEqual({ id: "ui.gamesErrorFailed", detail: "NvAPI_DRS_SetSetting returned NvAPI status -1 (log: C:\\logs\\driver-settings.log)" });
                expect(gameSettingsError(new Error("worker stopped"))).toEqual({ id: "ui.gamesErrorFailed", detail: "worker stopped" });
                expect(gameSettingsError("plain text")).toEqual({ id: "ui.gamesErrorFailed", detail: "plain text" });
                expect(gameSettingsError(undefined)).toEqual({ id: "ui.gamesErrorFailed", detail: null });
        });
});
