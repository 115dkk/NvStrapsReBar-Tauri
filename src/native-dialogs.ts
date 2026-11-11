import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { runsOnLinux } from "./platform";

export type FileTypeFilter = { name: string; extensions: string[] };

/** What the user is asked to choose: an existing file, a folder, or where to save a new file. */
export type PathRequest =
        | { kind: "file"; title?: string; filters?: FileTypeFilter[] }
        | { kind: "folder"; title?: string }
        | { kind: "newFile"; title?: string; suggestedName: string; filters?: FileTypeFilter[] };

/**
 * Asks for a path with the system's dialog; `null` when the user cancels.
 *
 * On Linux the app's own `choose_path` command opens the dialog, because the dialog plugin gives
 * it no parent window there: the chooser then is a separate window that can be minimized behind
 * the app. `choose_path` makes it a modal child of the app window. It takes no file type filters:
 * the GNOME chooser has listed no file at all under a pattern filter, "*.*" included (issue #63).
 */
export async function choosePath(request: PathRequest): Promise<string | null> {
        if (runsOnLinux()) {
                return invoke<string | null>("choose_path", {
                        chooser: {
                                kind: request.kind,
                                title: request.title ?? "",
                                suggestedName: request.kind === "newFile" ? request.suggestedName : null,
                        },
                });
        }
        switch (request.kind) {
                case "file": {
                        const chosen = await open({ multiple: false, directory: false, title: request.title, filters: request.filters });
                        return typeof chosen === "string" ? chosen : null;
                }
                case "folder": {
                        const chosen = await open({ multiple: false, directory: true, title: request.title });
                        return typeof chosen === "string" ? chosen : null;
                }
                case "newFile":
                        return save({ title: request.title, defaultPath: request.suggestedName, filters: request.filters });
        }
}
