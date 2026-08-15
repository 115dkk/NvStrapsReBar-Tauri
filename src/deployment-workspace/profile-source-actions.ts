import { message } from "../i18n-catalog";
import { assertPlanProjection } from "./deployment-receipts";
import {
        analyzeLegacyFirmware,
        inspectFirmware,
        selectAndInspectFirmware,
} from "./firmware-source";
import { buildMachineProfileRequest } from "./machine-profile-draft";
import type { DeploymentSessionRuntime } from "./session-action-runtime";

/** Source-image inspection, legacy rule selection, and profile pinning. */
export class ProfileSourceActions {
        constructor(private runtime: DeploymentSessionRuntime) {}

        chooseFirmware() {
                return this.runtime.run("firmware", async (tx) => {
                        const inspected = await selectAndInspectFirmware(
                                this.runtime.adapter,
                        );
                        tx.patch({
                                firmwarePath: inspected.path,
                                firmware: inspected.firmware,
                                legacyAnalysis: null,
                                legacyAnalysisStatus: "idle",
                                legacyAnalysisError: "",
                                selectedLegacyRules: [],
                                legacyAcknowledgements: {},
                        });
                        tx.success(
                                message(
                                        "ui.sourceFirmwareInspectedSizeAndSha256Recorded",
                                ),
                        );
                });
        }

        inspectFirmware() {
                return this.runtime.run("firmware", async (tx) => {
                        const inspected = await inspectFirmware(
                                this.runtime.adapter,
                                this.runtime.state().firmwarePath,
                        );
                        tx.patch({
                                firmware: inspected.firmware,
                                legacyAnalysis: null,
                                legacyAnalysisStatus: "idle",
                                legacyAnalysisError: "",
                                selectedLegacyRules: [],
                                legacyAcknowledgements: {},
                        });
                        tx.success(
                                message(
                                        "ui.sourceFirmwareInspectedSizeAndSha256Recorded",
                                ),
                        );
                });
        }

        analyzeLegacy() {
                return this.runtime.run("legacy-analysis", async (tx) => {
                        const requestedPath =
                                this.runtime.state().firmwarePath;
                        const requestedFirmware = structuredClone(
                                this.runtime.state().firmware!,
                        );
                        tx.patch({
                                legacyAnalysisStatus: "pending",
                                legacyAnalysisError: "",
                                legacyAnalysis: null,
                                selectedLegacyRules: [],
                                legacyAcknowledgements: {},
                        });
                        const result = await analyzeLegacyFirmware(
                                this.runtime.adapter,
                                requestedPath,
                                requestedFirmware,
                        );
                        if (
                                requestedPath !==
                                this.runtime.state().firmwarePath
                        )
                                return;
                        tx.patch({
                                legacyAnalysis: {
                                        path: requestedPath,
                                        value: result.value,
                                },
                                selectedLegacyRules:
                                        result.selectedLegacyRules,
                                legacyAnalysisStatus: "ready",
                        });
                        tx.success(
                                message(
                                        "ui.legacyAnalysisCompleteSourceFingerprintAndRuleResultsRecorded",
                                ),
                        );
                });
        }

        createProfile() {
                const view = this.runtime.view();
                if (!view.firmware) return Promise.resolve();
                return this.runtime.run("profile", async (tx) => {
                        const bundle =
                                await this.runtime.adapter.createMachineProfile(
                                        buildMachineProfileRequest(view),
                                );
                        assertPlanProjection(bundle.profile, bundle.plan);
                        tx.patch({
                                profiles: [
                                        bundle.profile,
                                        ...this.runtime
                                                .state()
                                                .profiles.filter(
                                                        (profile) =>
                                                                profile.profileId !==
                                                                bundle.profile
                                                                        .profileId,
                                                ),
                                ],
                                selectedProfileId: bundle.profile.profileId,
                                plan: bundle.plan,
                                preflightExact: true,
                        });
                        const selectionCount = view.selectedLegacyEntries.length;
                        const successMessage =
                                view.boardPath === "legacyAbove4g"
                                        ? selectionCount === 1
                                                ? message(
                                                          "ui.legacyProfileCreatedWithOneRule",
                                                  )
                                                : message(
                                                          "ui.legacyProfileCreated",
                                                          {
                                                                  ruleCount: selectionCount,
                                                          },
                                                  )
                                        : message(
                                                  "ui.machineProfileCreatedSourceImageFingerprintRecorded",
                                          );
                        tx.success(successMessage);
                });
        }

        compareMachine() {
                return this.runtime.run("preflight", async (tx) => {
                        const comparison =
                                await this.runtime.adapter.compareMachineProfile(
                                        this.runtime.state().selectedProfileId,
                                );
                        const exact =
                                comparison.result.differences.length === 0;
                        tx.patch({ preflightExact: exact });
                        if (!exact) {
                                const count =
                                        comparison.result.differences.length;
                                throw new Error(
                                        `Hardware check found ${count} difference${count === 1 ? "" : "s"}; deployment remains blocked until the selected profile matches.`,
                                );
                        }
                        tx.success(
                                message("ui.currentProfileMatchesHardware"),
                        );
                });
        }
}
