import type {
        DriverSettingsBackup,
        GameProfile,
        GameRebarReceipt,
        GameSettingsBridge,
        GameSettingsCatalog,
        RebarState,
} from "./contract";

/** Browser preview: a fixed driver database that resolves values like the driver does. */
export const PREVIEW_GAMES_STATE_KEY = "nvstraps-preview-games-state";
export type PreviewGamesState = "ready" | "unavailable" | "write-fails" | "readback-fails";

type Fixture = { name: string; apps: string[]; nvidia?: true };

// Profiles NVIDIA turns on carry `nvidia`.
const fixtures: Fixture[] = [
        { name: "Apex Legends", apps: ["r5apex.exe"] },
        { name: "Assassin's Creed Valhalla", apps: ["ACValhalla.exe"], nvidia: true },
        { name: "Baldur's Gate 3", apps: ["bg3.exe", "bg3_dx11.exe"] },
        { name: "Battlefield 2042", apps: ["BF2042.exe"], nvidia: true },
        { name: "Black Myth: Wukong", apps: ["b1-Win64-Shipping.exe"] },
        { name: "Call of Duty: Modern Warfare III", apps: ["cod.exe"] },
        { name: "Counter-Strike 2", apps: ["cs2.exe"] },
        { name: "Cyberpunk 2077", apps: ["Cyberpunk2077.exe"], nvidia: true },
        { name: "Dead Space", apps: ["Dead Space.exe"], nvidia: true },
        { name: "Death Stranding", apps: ["ds.exe"], nvidia: true },
        { name: "Diablo IV", apps: ["Diablo IV.exe"] },
        { name: "Elden Ring", apps: ["eldenring.exe", "start_protected_game.exe"] },
        { name: "Final Fantasy XIV Online", apps: ["ffxiv_dx11.exe"] },
        { name: "Forza Horizon 5", apps: ["ForzaHorizon5.exe"], nvidia: true },
        { name: "Fortnite", apps: ["FortniteClient-Win64-Shipping.exe"] },
        { name: "Grand Theft Auto V", apps: ["GTA5.exe"] },
        { name: "Hogwarts Legacy", apps: ["HogwartsLegacy.exe"], nvidia: true },
        { name: "Horizon Zero Dawn", apps: ["HorizonZeroDawn.exe"], nvidia: true },
        { name: "League of Legends", apps: ["League of Legends.exe"] },
        { name: "Lost Ark", apps: ["LOSTARK.exe"] },
        { name: "MapleStory", apps: ["MapleStory.exe"] },
        { name: "Metro Exodus", apps: ["MetroExodus.exe"], nvidia: true },
        { name: "Minecraft", apps: ["Minecraft.Windows.exe", "javaw.exe"] },
        { name: "Monster Hunter Wilds", apps: ["MonsterHunterWilds.exe"] },
        { name: "Overwatch 2", apps: ["Overwatch.exe"] },
        { name: "PUBG: BATTLEGROUNDS", apps: ["TslGame.exe"] },
        { name: "Red Dead Redemption 2", apps: ["RDR2.exe"], nvidia: true },
        { name: "Starfield", apps: ["Starfield.exe"] },
        { name: "The Witcher 3: Wild Hunt", apps: ["witcher3.exe"] },
        { name: "VALORANT", apps: ["VALORANT-Win64-Shipping.exe"] },
];

let allGamesOn: boolean | null = null;
let userValues = new Map<string, boolean>();
let backup: DriverSettingsBackup | null = null;
let backupValues: { allGamesOn: boolean | null; userValues: Map<string, boolean> } | null = null;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const previewState = (): PreviewGamesState => {
        try {
                const value = sessionStorage.getItem(PREVIEW_GAMES_STATE_KEY);
                if (value === "unavailable" || value === "write-fails" || value === "readback-fails") return value;
        } catch {
                // Storage can be unavailable; the fixture stays ready.
        }
        return "ready";
};

const failure = (code: string, message: string) => Object.assign(new Error(message), { code, recoverable: true });

const allGamesState = (): RebarState =>
        allGamesOn === null
                ? { on: false, source: "driver", changed: false }
                : { on: allGamesOn, source: "thisPc", changed: true };

const gameState = (fixture: Fixture): RebarState => {
        const own = userValues.get(fixture.name);
        if (own !== undefined) return { on: own, source: "thisPc", changed: true };
        if (fixture.nvidia) return { on: true, source: "nvidia", changed: false };
        if (allGamesOn !== null) return { on: allGamesOn, source: "allGames", changed: false };
        return { on: false, source: "driver", changed: false };
};

const catalog = (): GameSettingsCatalog => ({
        driver: { version: "616.64", appSetting: true },
        allGames: allGamesState(),
        games: fixtures.map((fixture): GameProfile => ({ name: fixture.name, apps: [...fixture.apps], state: gameState(fixture) })),
        backup: backup && { ...backup },
});

/** The first change saves the database it is about to change. */
const ensureBackup = (): DriverSettingsBackup => {
        if (!backup) {
                backupValues = { allGamesOn, userValues: new Map(userValues) };
                backup = {
                        path: "C:\\Users\\Preview\\AppData\\Local\\com.nvstraps.rebar\\nvidia-driver-settings\\backups\\5d".concat("41".repeat(31), ".nvdrs"),
                        sha256: "5d".concat("41".repeat(31)),
                        byteLength: 3_482_112,
                        driverVersion: "616.64",
                        createdAtUnixMs: String(Date.UTC(2026, 9, 3, 1, 20)),
                };
        }
        return { ...backup };
};

const write = async (): Promise<DriverSettingsBackup> => {
        await delay(260);
        const state = previewState();
        if (state === "unavailable") throw failure("nvidia_driver_unavailable", "NVIDIA driver settings are unavailable");
        if (state === "write-fails") throw failure("nvidia_driver_settings_failed", "NvAPI_DRS_SaveSettings returned NvAPI status -1");
        return ensureBackup();
};

export const resetPreviewGameSettings = () => {
        allGamesOn = null;
        userValues = new Map();
        backup = null;
        backupValues = null;
};

export const previewGameSettingsBridge: GameSettingsBridge = {
        load: async () => {
                await delay(320);
                if (previewState() === "unavailable") throw failure("nvidia_driver_unavailable", "nvapi64.dll returned NvAPI status -2");
                return catalog();
        },
        setGame: async (profileName, on): Promise<GameRebarReceipt> => {
                const fixture = fixtures.find((game) => game.name === profileName);
                if (!fixture) throw failure("nvidia_driver_settings_failed", `the driver has no profile named "${profileName}"`);
                const saved = await write();
                const before = new Map(userValues);
                userValues.delete(profileName);
                if (on || gameState(fixture).on) userValues.set(profileName, on);
                if (previewState() === "readback-fails") {
                        userValues = before;
                        throw failure("nvidia_driver_readback_mismatch", "the NVIDIA driver did not keep the requested Resizable BAR value");
                }
                return { profileName, state: gameState(fixture), backup: saved };
        },
        setAllGames: async (on, consented): Promise<GameRebarReceipt> => {
                if (on && !consented) throw failure("nvidia_driver_settings_failed", "turning Resizable BAR on for all programs needs the user's consent");
                const saved = await write();
                allGamesOn = on ? true : null;
                return { profileName: null, state: allGamesState(), backup: saved };
        },
        restore: async (backupSha256) => {
                await delay(260);
                if (!backup || !backupValues || backup.sha256 !== backupSha256) throw failure("nvidia_driver_settings_failed", "the NVIDIA settings backup changed after it was shown");
                allGamesOn = backupValues.allGamesOn;
                userValues = new Map(backupValues.userValues);
                return catalog();
        },
};
