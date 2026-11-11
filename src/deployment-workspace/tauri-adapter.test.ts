import { describe, expect, it, vi } from "vitest";
import type { Webview } from "@tauri-apps/api/webview";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { translate } from "../i18n";
import { createTauriDeploymentAdapter } from "./tauri-adapter";

describe("Tauri deployment adapter", () => {
        it("maps native command names and camel-case request arguments exactly", async () => {
                const invoke = vi.fn(async () => ({}));
                const adapter = createTauriDeploymentAdapter(
                        invoke as never,
                        vi.fn(async () => null),
                );
                await adapter.deleteMachineProfile("profile-1");
                await adapter.inspectFirmwareImage("C:\\firmware.bin");
                await adapter.inspectSignedFirmwareUpdate("C:\\firmware.bin");
                await adapter.compareMachineProfile("profile-1");
                await adapter.exportDeploymentPackage(
                        "profile-1",
                        "C:\\export",
                );
                await adapter.rebootAfterConfiguration(
                        {
                                profileId: "profile-1",
                                planRevision: 7,
                                confirmationToken: "token",
                                command: "shutdown",
                                arguments: ["/r"],
                                immediate: true,
                                forceCloseApplications: false,
                                warnings: [],
                        },
                        true,
                );
                expect(invoke.mock.calls).toEqual([
                        ["delete_machine_profile", { profileId: "profile-1" }],
                        [
                                "inspect_firmware_image",
                                { path: "C:\\firmware.bin" },
                        ],
                        [
                                "inspect_signed_firmware_update",
                                { path: "C:\\firmware.bin" },
                        ],
                        [
                                "compare_machine_profile",
                                {
                                        request: {
                                                profileId: "profile-1",
                                                firmwarePath: null,
                                        },
                                },
                        ],
                        [
                                "export_deployment_package",
                                {
                                        request: {
                                                profileId: "profile-1",
                                                destinationRoot: "C:\\export",
                                        },
                                },
                        ],
                        [
                                "reboot_after_configuration",
                                {
                                        request: {
                                                profileId: "profile-1",
                                                confirmationToken: "token",
                                                unsavedWorkConfirmed: true,
                                        },
                                },
                        ],
                ]);
        });

        it.each(["en", "ko"] as const)("asks for the BIOS file and the USB folder under the supplied %s titles, with no file type filter", async (locale) => {
                const choose = vi.fn()
                        .mockResolvedValueOnce("/home/user/E7B98IMS.1F0")
                        .mockResolvedValueOnce("/media/user/USB");
                const adapter = createTauriDeploymentAdapter(vi.fn(), choose);
                const biosTitle = translate(locale, "ui.dialogChooseBiosFile");
                const usbTitle = translate(locale, "ui.dialogChooseUsbFolder");
                await expect(adapter.selectFirmwareImage(biosTitle)).resolves.toBe("/home/user/E7B98IMS.1F0");
                await expect(adapter.selectDestinationDirectory(usbTitle)).resolves.toBe("/media/user/USB");
                expect(choose.mock.calls).toEqual([
                        [{ kind: "file", title: biosTitle }],
                        [{ kind: "folder", title: usbTitle }],
                ]);
        });

        it("propagates native deletion errors unchanged", async () => {
                const error = { code: "deployment_failed", message: "cannot delete", recoverable: true };
                const adapter = createTauriDeploymentAdapter(vi.fn().mockRejectedValue(error));
                await expect(adapter.deleteMachineProfile("profile-1")).rejects.toBe(error);
        });

        it.each([false, true])("unsubscribes even before registration resolves (%s)", async (early) => {
                let handler!: Parameters<Webview["onDragDropEvent"]>[0];
                let resolve!: (stop: () => void) => void;
                const stop = vi.fn();
                const watch: Webview["onDragDropEvent"] = (callback) => {
                        handler = callback;
                        return new Promise((done) => { resolve = done; });
                };
                const adapter = createTauriDeploymentAdapter(vi.fn(), vi.fn(), watch);
                const listener = vi.fn();
                const unsubscribe = adapter.watchFileDrops(listener);
                const position = new PhysicalPosition(10, 20);
                const emit = (payload: Parameters<typeof handler>[0]["payload"]) =>
                        handler({ event: "tauri://drag-drop", id: 1, payload });
                emit({ type: "enter", paths: ["/bios.bin"], position });
                emit({ type: "over", position });
                emit({ type: "leave" });
                emit({ type: "drop", paths: ["/bios.bin"], position });
                expect(listener.mock.calls).toEqual([
                        [{ kind: "over" }], [{ kind: "over" }], [{ kind: "leave" }],
                        [{ kind: "drop", paths: ["/bios.bin"] }],
                ]);
                if (early) unsubscribe();
                resolve(stop);
                await Promise.resolve();
                unsubscribe();
                unsubscribe();
                emit({ type: "drop", paths: ["/late.bin"], position });
                expect(listener).toHaveBeenCalledTimes(4);
                expect(stop).toHaveBeenCalledTimes(1);
        });

        it("handles an unavailable native drag listener without an unhandled rejection", async () => {
                const adapter = createTauriDeploymentAdapter(vi.fn(), vi.fn(), vi.fn().mockRejectedValue(new Error("unavailable")));
                const listener = vi.fn();
                const unsubscribe = adapter.watchFileDrops(listener);
                await Promise.resolve();
                await Promise.resolve();
                expect(listener).toHaveBeenCalledWith({ kind: "leave" });
                unsubscribe();
        });
});
