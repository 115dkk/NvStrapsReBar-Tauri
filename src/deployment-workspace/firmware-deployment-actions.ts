import { message } from "../i18n-catalog";
import type { StepId } from "./contract";
import type { DeploymentSessionRuntime } from "./session-action-runtime";
import { prepareFirmwareArtifact } from "./workflow-operations";

type FirmwareRebootBinding = {
        profileId: string;
        planRevision: number;
        stepId: StepId;
        confirmationToken: string;
};

/** Artifact preparation, export, and the firmware-setup restart handoff. */
export class FirmwareDeploymentActions {
        private rebootBinding: FirmwareRebootBinding | null = null;

        constructor(private runtime: DeploymentSessionRuntime) {}

        resetProfileBinding() {
                this.rebootBinding = null;
        }

        prepare() {
                const before = this.runtime.state().plan!;
                return this.runtime.run("prepare", async (tx) => {
                        const preparation = await prepareFirmwareArtifact(
                                this.runtime.adapter,
                                before,
                        );
                        tx.patch({ preparation, plan: preparation.plan });
                        tx.success(
                                message(
                                        "ui.firmwareArtifactPreparedRustDriverInsertedAndSha256Recorded",
                                ),
                        );
                });
        }

        chooseDestination() {
                return this.runtime.run("destination", async (tx) => {
                        const value =
                                await this.runtime.adapter.selectDestinationDirectory();
                        if (!value)
                                throw new Error(
                                        "Destination selection was cancelled.",
                                );
                        tx.patch({ destination: value });
                        tx.success(
                                message("ui.packageDestinationSelected"),
                        );
                });
        }

        exportPackage() {
                return this.runtime.run("export", async (tx) => {
                        const state = this.runtime.state();
                        const packageReceipt =
                                await this.runtime.adapter.exportDeploymentPackage(
                                        state.selectedProfileId,
                                        state.destination,
                                );
                        tx.patch({ packageReceipt });
                        tx.success(
                                message(
                                        "ui.deploymentPackageExportedOpenItInTheVendorToolForFlashing",
                                ),
                        );
                });
        }

        previewFirmwareReboot() {
                return this.runtime.run("reboot-preview", async (tx) => {
                        const plan = this.runtime.state().plan!;
                        const active = plan.steps.find(
                                (step) => step.state === "ready",
                        )!;
                        const preview =
                                await this.runtime.adapter.previewFirmwareSetupReboot(
                                        this.runtime.state().selectedProfileId,
                                );
                        if (
                                preview.profileId !== plan.profileId ||
                                preview.activeStep !== active.id ||
                                !preview.confirmationToken
                        )
                                throw new Error(
                                        "The deployment plan changed while the restart preview was loading.",
                                );
                        if (!tx.current()) return;
                        this.rebootBinding = {
                                profileId: plan.profileId,
                                planRevision: plan.revision,
                                stepId: active.id,
                                confirmationToken: preview.confirmationToken,
                        };
                        tx.patch({
                                rebootPreview: preview,
                                savedWork: false,
                                showReboot: true,
                        });
                        tx.success(
                                message(
                                        "ui.firmwareSetupRestartDetailsLoadedForReview",
                                ),
                        );
                });
        }

        requestFirmwareReboot() {
                return this.runtime.run("reboot", async (tx) => {
                        const state = this.runtime.state();
                        const preview = state.rebootPreview!;
                        const active = state.plan?.steps.find(
                                (step) => step.state === "ready",
                        );
                        tx.patch({ showReboot: false });
                        if (
                                !this.rebootBinding ||
                                this.rebootBinding.profileId !==
                                        state.plan?.profileId ||
                                this.rebootBinding.planRevision !==
                                        state.plan?.revision ||
                                this.rebootBinding.stepId !== active?.id ||
                                this.rebootBinding.confirmationToken !==
                                        preview.confirmationToken
                        )
                                throw new Error(
                                        "The firmware restart preview is stale.",
                                );
                        const receipt =
                                await this.runtime.adapter.rebootToFirmwareSetup(
                                        preview,
                                        state.savedWork,
                                );
                        if (
                                receipt.profileId !== preview.profileId ||
                                receipt.accepted !== true
                        )
                                throw new Error(
                                        "The firmware restart request returned an invalid acceptance receipt.",
                                );
                        tx.success(
                                message("ui.restartingToFirmwareSetup"),
                        );
                });
        }
}
