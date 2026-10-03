/** Wire types of the NVIDIA driver settings commands (src-tauri/src/nvidia_profiles). */

/** Where the value that decides a profile's state lives. */
export type RebarSource = "thisPc" | "nvidia" | "allGames" | "driver";

export type RebarState = {
        on: boolean;
        source: RebarSource;
        /** The profile holds Resizable BAR values written on this PC. */
        changed: boolean;
};

export type GameProfile = {
        name: string;
        apps: string[];
        state: RebarState;
};

export type DriverSettingsBackup = {
        path: string;
        sha256: string;
        byteLength: number;
        driverVersion: string;
        createdAtUnixMs: string;
};

export type GameSettingsCatalog = {
        driver: { version: string; appSetting: boolean };
        allGames: RebarState;
        games: GameProfile[];
        backup: DriverSettingsBackup | null;
        /** Profiles the driver refused to read; each one has a line in the log. */
        skippedProfiles: number;
        /** The diagnostic log of the driver settings commands. */
        logPath: string | null;
        /** The profiles the app changed; the undo returns them to their earlier values. */
        undo: UndoSummary | null;
};

export type UndoSummary = {
        profiles: number;
        /** The record revision an undo request names, so it never undoes a list the screen did not show. */
        revision: string;
};

export type GameRebarReceipt = {
        /** The game profile, or null for all games. */
        profileName: string | null;
        /** The state a new driver session read back after the save. */
        state: RebarState;
        backup: DriverSettingsBackup;
        /** The undo record after this change. */
        undo: UndoSummary | null;
};

export interface GameSettingsBridge {
        load(): Promise<GameSettingsCatalog>;
        setGame(profileName: string, on: boolean): Promise<GameRebarReceipt>;
        setAllGames(on: boolean, consented: boolean): Promise<GameRebarReceipt>;
        undo(revision: string): Promise<GameSettingsCatalog>;
}
