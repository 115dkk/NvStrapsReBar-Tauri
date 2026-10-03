import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { previewMode } from "../bridge";
import type { StaticMessageId } from "../i18n-catalog";
import type { GameSettingsBridge, GameSettingsCatalog } from "./contract";
import { gameSettingsErrorId, keepChanged } from "./model";
import { nativeGameSettingsBridge } from "./native-bridge";
import { previewGameSettingsBridge } from "./preview-bridge";

export const gameSettingsBridge: GameSettingsBridge = previewMode ? previewGameSettingsBridge : nativeGameSettingsBridge;

export type GamesLoad =
        | { status: "loading" }
        | { status: "ready"; catalog: GameSettingsCatalog }
        | { status: "failed"; message: StaticMessageId };

/** What the last finished change did, for the status line. */
export type GamesOutcome = { kind: "game"; name: string; on: boolean } | { kind: "allGames"; on: boolean } | { kind: "restored" } | null;

export type GamesDialog = "allGames" | "restore" | null;

/**
 * Driver settings for the games page. Each game switch runs on its own; the all-games switch
 * and the restore wait for every game switch and reload the list afterwards.
 */
export const useGameSettings = (bridge: GameSettingsBridge = gameSettingsBridge) => {
        const [load, setLoad] = useState<GamesLoad>({ status: "loading" });
        // Requested on/off per game name while its change runs.
        const [pendingGames, setPendingGames] = useState<Record<string, boolean>>({});
        const [bulk, setBulk] = useState<"allGames" | "restore" | "reload" | null>(null);
        const [error, setError] = useState<StaticMessageId | null>(null);
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
                        if (current === generation.current) setLoad({ status: "failed", message: gameSettingsErrorId(cause) });
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
                                                                  games: previous.catalog.games.map((game) => (game.name === name ? { ...game, state: receipt.state } : game)),
                                                          },
                                                  }
                                                : previous,
                                );
                                setKept((current) => (current.includes(name) ? current : [...current, name]));
                                setOutcome({ kind: "game", name, on: receipt.state.on });
                        } catch (cause) {
                                if (current === generation.current) setError(gameSettingsErrorId(cause));
                        } finally {
                                running.current.delete(name);
                                setPendingGames(({ [name]: _, ...rest }) => rest);
                        }
                },
                [bridge, bulk],
        );

        const runBulk = useCallback(
                async (kind: "allGames" | "restore", work: () => Promise<GameSettingsCatalog | null>, done: GamesOutcome) => {
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
                                setError(gameSettingsErrorId(cause));
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

        const confirmRestore = useCallback(() => {
                const sha = load.status === "ready" ? load.catalog.backup?.sha256 : undefined;
                if (!sha) return;
                void runBulk("restore", () => bridge.restore(sha), { kind: "restored" });
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
                        confirmRestore,
                }),
                [load, pendingGames, bulk, gameBusy, error, outcome, kept, dialog, reload, setGame, setAllGames, confirmAllGames, confirmRestore],
        );
};

export type GameSettingsController = ReturnType<typeof useGameSettings>;
