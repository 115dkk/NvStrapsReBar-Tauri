import { invoke } from "@tauri-apps/api/core";
import type { GameSettingsBridge } from "./contract";

export const nativeGameSettingsBridge: GameSettingsBridge = {
        load: () => invoke("load_nvidia_game_settings"),
        setGame: (profileName, on) =>
                invoke("set_nvidia_game_rebar", { request: { profileName, on } }),
        setAllGames: (on, consented) =>
                invoke("set_nvidia_all_games_rebar", { request: { on, consented } }),
        undo: (revision) => invoke("undo_nvidia_game_changes", { request: { revision } }),
};
