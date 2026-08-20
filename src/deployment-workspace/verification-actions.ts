import { message } from "../i18n-catalog";
import type { DeploymentSessionRuntime } from "./session-action-runtime";
import {
        collectResizableBarEvidence,
        confirmManualStep,
        loadConfigurationRebootPreview,
        loadManualStepPreview,
        requestConfigurationReboot,
        saveRecommendedConfig,
        verifyConfigurationBoot,
        verifyDeploymentDriver,
} from "./workflow-operations";

/** Manual gates and post-boot configuration/evidence protocols. */
export class VerificationActions {
        constructor(private runtime: DeploymentSessionRuntime) {}

        openManual() {
                const before = this.runtime.state().plan!;
                return this.runtime.run("manual-preview", async (tx) => {
                        const preview = await loadManualStepPreview(
                                this.runtime.adapter,
                                before,
                        );
                        tx.patch({
                                manualPreview: preview,
                                showManual: true,
                        });
                        tx.success(
                                message("ui.currentManualStepLoadedForReview"),
                        );
                });
        }

        confirmManual() {
                const state = this.runtime.state();
                const before = state.plan!;
                const preview = state.manualPreview!;
                this.runtime.patch({ showManual: false });
                return this.runtime.run("manual-confirm", async (tx) => {
                        const receipt = await confirmManualStep(
                                this.runtime.adapter,
                                before,
                                preview,
                        );
                        tx.patch({
                                plan: receipt.plan,
                                workflowReceipt: {
                                        title: message(
                                                "ui.manualStepRecordedInTheDeploymentPlan",
                                        ),
                                        detail: message(
                                                "ui.completionRecordedAt",
                                                {
                                                        time: receipt.recordedAtUnixMs,
                                                },
                                        ),
                                },
                        });
                        tx.success(
                                message(
                                        "ui.manualStepRecordedInTheDeploymentPlan",
                                ),
                        );
                });
        }

        verifyDriver() {
                const before = this.runtime.state().plan!;
                return this.runtime.run("driver-verify", async (tx) => {
                        const receipt = await verifyDeploymentDriver(
                                this.runtime.adapter,
                                before,
                        );
                        tx.patch({
                                plan: receipt.plan,
                                workflowReceipt: {
                                        title: message(
                                                "ui.currentBootAndRustDxeStatusRecorded",
                                        ),
                                        detail: message(
                                                "ui.driverRawAndBootStepsRecorded",
                                                { raw: receipt.status.raw },
                                        ),
                                },
                        });
                        tx.success(
                                message(
                                        "ui.currentWindowsBootAndRustDxeStatusRecorded",
                                ),
                        );
                        if (tx.current())
                                await this.runtime.loadRecommendation();
                });
        }

        saveGuardedConfig() {
                const state = this.runtime.state();
                const before = state.plan!;
                const recommendation = state.configRecommendation!;
                if (
                        !state.guardedConfigConfirmed ||
                        recommendation.profileId !== before.profileId ||
                        recommendation.planRevision !== before.revision
                )
                        return Promise.resolve();
                return this.runtime.run("deployment-config", async (tx) => {
                        const receipt = await saveRecommendedConfig(
                                this.runtime.adapter,
                                before,
                                recommendation.value,
                        );
                        tx.patch({
                                plan: receipt.plan,
                                workflowReceipt: {
                                        title: message(
                                                "ui.configurationWrittenAndReadBack",
                                        ),
                                        detail: message(
                                                "ui.configurationSaved",
                                                {
                                                        bytes: receipt.save
                                                                .bytesWritten,
                                                        time: receipt.save
                                                                .savedAtUnixMs,
                                                },
                                        ),
                                },
                                guardedConfigConfirmed: false,
                        });
                        tx.success(
                                message(
                                        "ui.deploymentConfigurationWrittenAndReadBack",
                                ),
                        );
                });
        }

        openConfigurationReboot() {
                const before = this.runtime.state().plan!;
                return this.runtime.run(
                        "configuration-reboot-preview",
                        async (tx) => {
                                const preview =
                                        await loadConfigurationRebootPreview(
                                                this.runtime.adapter,
                                                before,
                                        );
                                tx.patch({
                                        configurationRebootPreview: preview,
                                        showConfigurationReboot: true,
                                });
                                tx.success(
                                        message(
                                                "ui.configurationRestartDetailsLoadedForReview",
                                        ),
                                );
                        },
                );
        }

        requestConfigurationReboot() {
                const state = this.runtime.state();
                const before = state.plan!;
                const preview = state.configurationRebootPreview!;
                const selectedProfileId = state.selectedProfileId;
                this.runtime.patch({ showConfigurationReboot: false });
                return this.runtime.run("configuration-reboot", async (tx) => {
                        await requestConfigurationReboot(
                                this.runtime.adapter,
                                before,
                                preview,
                                selectedProfileId,
                                // Confirming the restart dialog is the
                                // explicit unsaved-work acknowledgement.
                                true,
                        );
                        tx.patch({
                                workflowReceipt: {
                                        title: message(
                                                "ui.configurationRestartRequestAccepted",
                                        ),
                                        detail: message(
                                                "ui.returnAfterWindowsBootsThenCheckTheBootTime",
                                        ),
                                },
                        });
                        tx.success(
                                message(
                                        "ui.windowsAcceptedTheRestartRequestReturnAfterTheNextBoot",
                                ),
                        );
                });
        }

        verifyConfigurationBoot() {
                const before = this.runtime.state().plan!;
                return this.runtime.run(
                        "configuration-boot-verify",
                        async (tx) => {
                                const receipt = await verifyConfigurationBoot(
                                        this.runtime.adapter,
                                        before,
                                );
                                tx.patch({
                                        plan: receipt.plan,
                                        workflowReceipt: {
                                                title: message(
                                                        "ui.windowsBootTimeRecorded",
                                                ),
                                                detail: message(
                                                        "ui.bootRecordedAfterConfiguration",
                                                        {
                                                                bootTime: receipt.bootedAtUnixMs,
                                                                savedTime: receipt.configurationSavedAtUnixMs,
                                                        },
                                                ),
                                        },
                                });
                                tx.success(
                                        message(
                                                "ui.windowsBootAfterTheConfigurationReadBackRecorded",
                                        ),
                                );
                        },
                );
        }

        collectBar() {
                const before = this.runtime.state().plan!;
                return this.runtime.run("bar1", async (tx) => {
                        const receipt = await collectResizableBarEvidence(
                                this.runtime.adapter,
                                before,
                        );
                        tx.patch({
                                plan: receipt.plan,
                                barEvidence: receipt.evidence,
                                workflowReceipt: {
                                        title: message(
                                                "ui.resizableBarObserved",
                                        ),
                                        detail: message(
                                                "ui.profileGpusObserved",
                                                {
                                                        hash: `${receipt.evidence.rawXmlSha256.slice(0, 10)}…${receipt.evidence.rawXmlSha256.slice(-8)}`,
                                                },
                                        ),
                                },
                        });
                        tx.success(
                                message(
                                        "ui.nvidiaBar1DataRecordedForThisProfile",
                                ),
                        );
                });
        }
}
