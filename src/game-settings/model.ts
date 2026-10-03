import type { StaticMessageId } from "../i18n-catalog";
import type { GameProfile, RebarState } from "./contract";

export const RESULT_LIMIT = 30;

/** Case, accents, and punctuation do not matter: "counter strike" finds "Counter-Strike 2". */
const fold = (text: string) =>
        text
                .normalize("NFKD")
                .replace(/\p{M}/gu, "")
                .toLowerCase()
                .replace(/[^\p{L}\p{N}]+/gu, " ")
                .trim();

const compact = (text: string) => text.replaceAll(" ", "");

export type GameIndexEntry = { game: GameProfile; name: string; nameCompact: string; apps: string[] };

export const indexGames = (games: GameProfile[]): GameIndexEntry[] =>
        games.map((game) => {
                const name = fold(game.name);
                return { game, name, nameCompact: compact(name), apps: game.apps.map((app) => compact(fold(app))) };
        });

const rank = (entry: GameIndexEntry, query: string, queryCompact: string) => {
        if (entry.name === query) return 0;
        if (entry.name.startsWith(query) || entry.nameCompact.startsWith(queryCompact)) return 1;
        if (entry.name.split(" ").some((word) => word.startsWith(query))) return 2;
        if (entry.nameCompact.includes(queryCompact)) return 3;
        if (entry.apps.some((app) => app.includes(queryCompact))) return 4;
        return null;
};

/** Games whose name or program matches, best first: exact, prefix, word prefix, part, program. */
export const searchGames = (index: GameIndexEntry[], text: string, limit = RESULT_LIMIT) => {
        const query = fold(text);
        if (!query) return { shown: [] as GameProfile[], total: 0 };
        const queryCompact = compact(query);
        const ranked = index
                .map((entry) => ({ entry, rank: rank(entry, query, queryCompact) }))
                .filter((item): item is { entry: GameIndexEntry; rank: number } => item.rank !== null)
                .sort((left, right) => left.rank - right.rank || left.entry.name.localeCompare(right.entry.name));
        return { shown: ranked.slice(0, limit).map((item) => item.entry.game), total: ranked.length };
};

/** Names of games changed on this PC, kept in the list for the rest of the visit. */
export const keepChanged = (kept: string[], games: GameProfile[]) => {
        const next = [...kept];
        for (const game of games) if (game.state.changed && !next.includes(game.name)) next.push(game.name);
        return next;
};

/** Says where the state comes from; the driver's own default needs no note. */
export const sourceMessageId = (state: RebarState): StaticMessageId | null => {
        switch (state.source) {
                case "thisPc":
                        return "ui.gameSourceThisPc";
                case "nvidia":
                        return "ui.gameSourceNvidia";
                case "allGames":
                        return "ui.gameSourceAllGames";
                case "driver":
                        return null;
        }
};

const errorIds: Record<string, StaticMessageId> = {
        administrator_required: "ui.gamesErrorAdministrator",
        nvidia_driver_unavailable: "ui.gamesErrorDriverUnavailable",
        nvidia_driver_readback_mismatch: "ui.gamesErrorReadback",
};

/** The next action for the user, and the backend's own message (with the log path) for the report. */
export type GameSettingsError = { id: StaticMessageId; detail: string | null };

export const gameSettingsError = (cause: unknown): GameSettingsError => {
        const record = cause && typeof cause === "object" ? (cause as { code?: unknown; message?: unknown }) : null;
        const code = record?.code;
        const message = typeof record?.message === "string" ? record.message : typeof cause === "string" ? cause : null;
        return {
                id: (typeof code === "string" && errorIds[code]) || "ui.gamesErrorFailed",
                detail: message?.trim() || null,
        };
};
