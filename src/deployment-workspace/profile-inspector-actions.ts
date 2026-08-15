import { message } from "../i18n-catalog";
import type { DeploymentSessionRuntime } from "./session-action-runtime";

/** NVIDIA Profile Inspector installation and policy handoff receipts. */
export class ProfileInspectorActions {
        constructor(private runtime: DeploymentSessionRuntime) {}

        install() {
                return this.runtime.run("install-inspector", async (tx) => {
                        const installation =
                                await this.runtime.adapter.installNvidiaProfileInspector();
                        tx.patch({ installation });
                        tx.success(
                                message(
                                        "ui.nvidiaProfileInspectorInstalled",
                                ),
                        );
                });
        }

        backup() {
                return this.runtime.run("backup-profiles", async (tx) => {
                        const profileId =
                                this.runtime.state().selectedProfileId;
                        const backup =
                                await this.runtime.adapter.backupNvidiaProfiles(
                                        profileId,
                                );
                        if (
                                backup.manifest.profileId !== profileId ||
                                !backup.manifestSha256.trim()
                        )
                                throw new Error(
                                        "The NVIDIA profile backup receipt does not match the selected profile.",
                                );
                        tx.patch({ backup });
                        tx.success(
                                message("ui.nvidiaProfilesBackupExported"),
                        );
                });
        }

        launch() {
                return this.runtime.run("launch-inspector", async (tx) => {
                        const profileId =
                                this.runtime.state().selectedProfileId;
                        const launch =
                                await this.runtime.adapter.launchNvidiaProfileInspector(
                                        profileId,
                                );
                        if (
                                launch.profileId !== profileId ||
                                launch.backup.manifest.profileId !== profileId ||
                                !launch.executableSha256.trim()
                        )
                                throw new Error(
                                        "The Profile Inspector launch receipt does not match the selected profile.",
                                );
                        tx.patch({ launch, backup: launch.backup });
                        tx.success(message("ui.profileInspectorLaunched"));
                });
        }
}
