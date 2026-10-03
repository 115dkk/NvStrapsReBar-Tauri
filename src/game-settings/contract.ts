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
};

export type GameRebarReceipt = {
        /** The game profile, or null for all games. */
        profileName: string | null;
        /** The state a new driver session read back after the save. */
        state: RebarState;
        backup: DriverSettingsBackup;
};

export interface GameSettingsBridge {
        load(): Promise<GameSettingsCatalog>;
        setGame(profileName: string, on: boolean): Promise<GameRebarReceipt>;
        setAllGames(on: boolean, consented: boolean): Promise<GameRebarReceipt>;
        restore(backupSha256: string): Promise<GameSettingsCatalog>;
}
