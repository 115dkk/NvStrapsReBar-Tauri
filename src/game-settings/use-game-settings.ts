import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { previewMode } from "../bridge";
import type { GameSettingsBridge, GameSettingsCatalog } from "./contract";
import { gameSettingsError, keepChanged, type GameSettingsError } from "./model";
import { nativeGameSettingsBridge } from "./native-bridge";
import { previewGameSettingsBridge } from "./preview-bridge";

export const gameSettingsBridge: GameSettingsBridge = previewMode ? previewGameSettingsBridge : nativeGameSettingsBridge;

export type GamesLoad =
        | { status: "loading" }
        | { status: "ready"; catalog: GameSettingsCatalog }
        | { status: "failed"; error: GameSettingsError };

/** What the last finished change did, for the status line. */
export type GamesOutcome = { kind: "game"; name: string; on: boolean } | { kind: "allGames"; on: boolean } | { kind: "undone" } | null;

export type GamesDialog = "allGames" | "undo" | null;

/**
 * Driver settings for the games page. Each game switch runs on its own; the all-games switch
 * and the undo wait for every game switch and reload the list afterwards.
 */
export const useGameSettings = (bridge: GameSettingsBridge = gameSettingsBridge) => {
        const [load, setLoad] = useState<GamesLoad>({ status: "loading" });
        // Requested on/off per game name while its change runs.
        const [pendingGames, setPendingGames] = useState<Record<string, boolean>>({});
        const [bulk, setBulk] = useState<"allGames" | "undo" | "reload" | null>(null);
        const [error, setError] = useState<GameSettingsError | null>(null);
        const [outcome, setOutcome] = useState<GamesOutcome>(null);
        const [kept, setKept] = useState<string[]>([]);
        const [dialog, setDialog] = useState<GamesDialog>(null);
        const generation = useRef(0);
        const running = useRef(new Set<string>());

        const apply = useCallback((catalog: GameSettingsCatalog) => {
                setLoad({ status: "ready", catalog });
                setKept((current) => keepChanged(current, catalog.games));
        }, []);

        const reload = useCallback(async () => {
                const current = ++generation.current;
                setLoad((previous) => (previous.status === "ready" ? previous : { status: "loading" }));
                try {
                        const catalog = await bridge.load();
                        if (current === generation.current) apply(catalog);
                } catch (cause) {
                        console.error("[games] reading the NVIDIA driver settings failed", cause);
                        if (current === generation.current) setLoad({ status: "failed", error: gameSettingsError(cause) });
                }
        }, [apply, bridge]);

        useEffect(() => {
                void reload();
                return () => {
                        generation.current++;
                };
        }, [reload]);

        const gameBusy = Object.keys(pendingGames).length > 0;

        const setGame = useCallback(
                async (name: string, on: boolean) => {
                        if (running.current.has(name) || bulk) return;
                        running.current.add(name);
                        const current = generation.current;
                        setPendingGames((pending) => ({ ...pending, [name]: on }));
                        setError(null);
                        try {
                                const receipt = await bridge.setGame(name, on);
                                if (current !== generation.current) return;
                                setLoad((previous) =>
                                        previous.status === "ready"
                                                ? {
                                                          status: "ready",
                                                          catalog: {
                                                                  ...previous.catalog,
                                                                  backup: receipt.backup,
                                                                  undo: receipt.undo,
                                                                  games: previous.catalog.games.map((game) => (game.name === name ? { ...game, state: receipt.state } : game)),
                                                          },
                                                  }
                                                : previous,
                                );
                                setKept((current) => (current.includes(name) ? current : [...current, name]));
                                setOutcome({ kind: "game", name, on: receipt.state.on });
                        } catch (cause) {
                                console.error(`[games] turning ${on ? "on" : "off"} ${name} failed`, cause);
                                if (current === generation.current) setError(gameSettingsError(cause));
                        } finally {
                                running.current.delete(name);
                                setPendingGames(({ [name]: _, ...rest }) => rest);
                        }
                },
                [bridge, bulk],
        );

        const runBulk = useCallback(
                async (kind: "allGames" | "undo", work: () => Promise<GameSettingsCatalog | null>, done: GamesOutcome) => {
                        if (bulk || running.current.size) return;
                        setDialog(null);
                        setBulk(kind);
                        setError(null);
                        try {
                                const catalog = await work();
                                if (catalog) apply(catalog);
                                else {
                                        setBulk("reload");
                                        const current = ++generation.current;
                                        const fresh = await bridge.load();
                                        if (current === generation.current) apply(fresh);
                                }
                                setOutcome(done);
                        } catch (cause) {
                                console.error(`[games] ${kind} failed`, cause);
                                setError(gameSettingsError(cause));
                        } finally {
                                setBulk(null);
                        }
                },
                [apply, bridge, bulk],
        );

        /** Turning on for all games waits for consent in a dialog; turning off runs at once. */
        const setAllGames = useCallback(
                (on: boolean) => {
                        if (on) {
                                setDialog("allGames");
                                return;
                        }
                        void runBulk("allGames", async () => (await bridge.setAllGames(false, false), null), { kind: "allGames", on: false });
                },
                [bridge, runBulk],
        );

        const confirmAllGames = useCallback(
                () => runBulk("allGames", async () => (await bridge.setAllGames(true, true), null), { kind: "allGames", on: true }),
                [bridge, runBulk],
        );

        const confirmUndo = useCallback(() => {
                const revision = load.status === "ready" ? load.catalog.undo?.revision : undefined;
                if (!revision) return;
                void runBulk("undo", () => bridge.undo(revision), { kind: "undone" });
        }, [bridge, load, runBulk]);

        return useMemo(
                () => ({
                        load,
                        pendingGames,
                        bulk,
                        gameBusy,
                        error,
                        outcome,
                        kept,
                        dialog,
                        setDialog,
                        reload,
                        setGame,
                        setAllGames,
                        confirmAllGames,
                        confirmUndo,
                }),
                [load, pendingGames, bulk, gameBusy, error, outcome, kept, dialog, reload, setGame, setAllGames, confirmAllGames, confirmUndo],
        );
};

export type GameSettingsController = ReturnType<typeof useGameSettings>;
