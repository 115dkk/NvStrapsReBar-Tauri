import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { nativeConfigureBridge } from "./bridge";
import { DEFAULT_DRAFT } from "./types";

describe("native ConfigureBridge BAR Settings contract", () => {
        beforeEach(() => invoke.mockReset());

        it("maps settings snapshot commands onto the chosen file path", async () => {
                invoke.mockResolvedValue({});
                await nativeConfigureBridge.exportSettingsSnapshot(
                        "C:/snap.json",
                );
                expect(invoke).toHaveBeenCalledWith(
                        "export_bar_settings_snapshot",
                        { path: "C:/snap.json" },
                );
                await nativeConfigureBridge.inspectSettingsSnapshot(
                        "C:/snap.json",
                );
                expect(invoke).toHaveBeenCalledWith(
                        "inspect_bar_settings_snapshot",
                        { path: "C:/snap.json" },
                );
        });

        it("invokes save_bar_settings with the nested token-bound request", async () => {
                invoke.mockResolvedValue({
                        save: {},
                        topologyToken: "next-topology",
                        configToken: "next-config",
                });
                const request = {
                        draft: DEFAULT_DRAFT,
                        expectedTopologyToken: "topology",
                        expectedConfigToken: "configuration",
                };

                await nativeConfigureBridge.saveBarSettings(request);

                expect(invoke).toHaveBeenCalledWith("save_bar_settings", {
                        request,
                });
        });
});
