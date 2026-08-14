import { describe, expect, it, vi } from "vitest";
import { createTauriDeploymentAdapter } from "./tauri-adapter";

describe("Tauri deployment adapter", () => {
        it("maps native command names and camel-case request arguments exactly", async () => {
                const invoke = vi.fn(async () => ({}));
                const adapter = createTauriDeploymentAdapter(
                        invoke as never,
                        vi.fn(async () => null),
                );
                await adapter.inspectFirmwareImage("C:\\firmware.bin");
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
                        [
                                "inspect_firmware_image",
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

        it("keeps native dialog configuration inside the adapter", async () => {
                const open = vi
                        .fn()
                        .mockResolvedValueOnce("C:\\firmware.bin")
                        .mockResolvedValueOnce("C:\\export");
                const adapter = createTauriDeploymentAdapter(vi.fn(), open);
                await expect(adapter.selectFirmwareImage()).resolves.toBe(
                        "C:\\firmware.bin",
                );
                await expect(
                        adapter.selectDestinationDirectory(),
                ).resolves.toBe("C:\\export");
                expect(open.mock.calls[0]?.[0]).toMatchObject({
                        directory: false,
                        multiple: false,
                        title: "Select the vendor firmware image",
                });
                expect(open.mock.calls[1]?.[0]).toEqual({
                        directory: true,
                        multiple: false,
                        title: "Select an empty deployment package destination",
                });
        });
});
