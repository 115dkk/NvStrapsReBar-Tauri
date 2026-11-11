import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, open, save } = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open, save }));

import { choosePath } from "./native-dialogs";

const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const filters = [{ name: "NvStrapsReBar settings", extensions: ["json"] }];

describe("choosePath", () => {
        beforeEach(() => {
                invoke.mockReset();
                open.mockReset();
                save.mockReset();
        });
        afterEach(() => vi.unstubAllGlobals());

        it("opens the dialog plugin's dialogs on Windows", async () => {
                vi.stubGlobal("navigator", { userAgent: WINDOWS });
                open.mockResolvedValueOnce("C:\\bios\\E7D25IMS.1N0").mockResolvedValueOnce("E:\\").mockResolvedValueOnce(null);
                save.mockResolvedValueOnce("C:\\settings.json");

                await expect(choosePath({ kind: "file", title: "Choose the BIOS file" })).resolves.toBe("C:\\bios\\E7D25IMS.1N0");
                await expect(choosePath({ kind: "folder", title: "Choose the USB drive" })).resolves.toBe("E:\\");
                await expect(choosePath({ kind: "file", filters })).resolves.toBeNull();
                await expect(choosePath({ kind: "newFile", suggestedName: "NvStrapsReBar-settings.json", filters })).resolves.toBe("C:\\settings.json");

                expect(open.mock.calls.map(([options]) => options)).toEqual([
                        { multiple: false, directory: false, title: "Choose the BIOS file", filters: undefined },
                        { multiple: false, directory: true, title: "Choose the USB drive" },
                        { multiple: false, directory: false, title: undefined, filters },
                ]);
                expect(save).toHaveBeenCalledWith({ title: undefined, defaultPath: "NvStrapsReBar-settings.json", filters });
                expect(invoke).not.toHaveBeenCalled();
        });

        it("asks the app's own chooser on Linux, without file type filters", async () => {
                vi.stubGlobal("navigator", { userAgent: LINUX });
                invoke.mockResolvedValueOnce("/home/user/E7B98IMS.1F0").mockResolvedValueOnce(null).mockResolvedValueOnce("/home/user/settings.json");

                await expect(choosePath({ kind: "file", title: "Choose the BIOS file" })).resolves.toBe("/home/user/E7B98IMS.1F0");
                await expect(choosePath({ kind: "folder", title: "Choose the USB drive" })).resolves.toBeNull();
                await expect(choosePath({ kind: "newFile", suggestedName: "NvStrapsReBar-settings.json", filters })).resolves.toBe("/home/user/settings.json");

                expect(invoke.mock.calls).toEqual([
                        ["choose_path", { chooser: { kind: "file", title: "Choose the BIOS file", suggestedName: null } }],
                        ["choose_path", { chooser: { kind: "folder", title: "Choose the USB drive", suggestedName: null } }],
                        ["choose_path", { chooser: { kind: "newFile", title: "", suggestedName: "NvStrapsReBar-settings.json" } }],
                ]);
                expect(open).not.toHaveBeenCalled();
                expect(save).not.toHaveBeenCalled();
        });
});
