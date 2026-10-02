import { message } from "../i18n-catalog";
import type { StepId } from "./contract";
import { formatDeploymentError } from "./deployment-errors";
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

        /**
         * Records the vendor flash and, when asked, the firmware setup values
         * from one explicit confirmation. Each step still loads its own
         * preview and confirmation token before it is recorded. The
         * confirmation is bound to the plan revision the user reviewed.
         */
        recordFirmwareHandoff(includeSetup: boolean, planRevision: number) {
                const targets: StepId[] = includeSetup
                        ? ["flashWithVendorRoute", "configureFirmwareSetup"]
                        : ["flashWithVendorRoute"];
                return this.runtime.run("manual-confirm", async (tx) => {
                        if (this.runtime.state().plan?.revision !== planRevision)
                                throw new Error(
                                        "The installation record changed after it was shown. Review the screen again.",
                                );
                        let recorded = 0;
                        for (const stepId of targets) {
                                const before = this.runtime.state().plan!;
                                const active = before.steps.find(
                                        (step) => step.state === "ready",
                                );
                                if (active?.id !== stepId) continue;
                                const preview = await loadManualStepPreview(
                                        this.runtime.adapter,
                                        before,
                                );
                                if (!tx.current()) return;
                                const receipt = await confirmManualStep(
                                        this.runtime.adapter,
                                        before,
                                        preview,
                                );
                                if (!tx.current()) return;
                                tx.patch({ plan: receipt.plan });
                                recorded += 1;
                        }
                        if (!recorded)
                                throw new Error(
                                        "The BIOS installation step is no longer the active step.",
                                );
                        tx.success(
                                message(
                                        "ui.manualStepRecordedInTheDeploymentPlan",
                                ),
                        );
                });
        }

        /**
         * Runs the read-only check that belongs to the active restart or
         * observation step. A failure is kept on the step instead of becoming
         * an error notice, because the user may simply not have restarted yet.
         */
        autoCheck() {
                const before = this.runtime.state().plan;
                const active = before?.steps.find(
                        (step) => step.state === "ready",
                );
                if (!before || !active) return Promise.resolve();
                const stepId = active.id;
                if (
                        stepId !== "rebootAfterFirmware" &&
                        stepId !== "verifyDriverLoaded" &&
                        stepId !== "rebootAfterConfiguration" &&
                        stepId !== "verifyResizableBar"
                )
                        return Promise.resolve();
                return this.runtime.run("auto-check", async (tx) => {
                        tx.patch({
                                autoCheck: {
                                        stepId,
                                        status: "running",
                                        message: null,
                                },
                        });
                        try {
                                if (stepId === "rebootAfterConfiguration") {
                                        const receipt = await verifyConfigurationBoot(
                                                this.runtime.adapter,
                                                before,
                                        );
                                        tx.patch({ plan: receipt.plan, autoCheck: null });
                                } else if (stepId === "verifyResizableBar") {
                                        const receipt =
                                                await collectResizableBarEvidence(
                                                        this.runtime.adapter,
                                                        before,
                                                );
                                        tx.patch({
                                                plan: receipt.plan,
                                                barEvidence: receipt.evidence,
                                                autoCheck: null,
                                        });
                                } else {
                                        const receipt = await verifyDeploymentDriver(
                                                this.runtime.adapter,
                                                before,
                                        );
                                        tx.patch({ plan: receipt.plan, autoCheck: null });
                                }
                        } catch (error) {
                                tx.patch({
                                        autoCheck: {
                                                stepId,
                                                status: "failed",
                                                message: formatDeploymentError(error),
                                        },
                                });
                                return;
                        }
                        if (
                                tx.current() &&
                                (stepId === "rebootAfterFirmware" ||
                                        stepId === "verifyDriverLoaded")
                        )
                                await this.runtime.loadRecommendation();
                });
        }

        /** The guided screen's save button is the explicit review of the shown values. */
        saveRecommendedConfig() {
                this.runtime.patch({ guardedConfigConfirmed: true });
                return this.saveGuardedConfig();
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
