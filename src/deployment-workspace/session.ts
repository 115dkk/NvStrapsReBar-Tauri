import type { ConfigDraft, SystemSnapshot } from "../types";
import type { DeploymentAdapter } from "./adapter";
import { previewDeploymentAdapter } from "./preview-adapter";
import { tauriDeploymentAdapter } from "./tauri-adapter";
import type {
        BoardPath,
        ConfigurationRebootPreview,
        DeploymentConfigRecommendation,
        DeploymentPackageReceipt,
        DeploymentPlan,
        FirmwareFingerprint,
        FirmwareInstallMethod,
        FirmwarePreparation,
        FirmwareSetupRebootPreview,
        LegacyFirmwareAnalysis,
        LegacyPatchRisk,
        MachineProfile,
        ManualDeploymentStepPreview,
        NvidiaProfileBackupReceipt,
        NvidiaSmiEvidence,
        ProfileInspectorInstallation,
        ProfileInspectorLaunch,
        RecoveryMethod,
        StepId,
} from "./contract";

const MSI_MANUAL =
        "https://download.msi.com/archive/mnu_exe/mb/PROZ690-AWIFIDDR4_PROZ690-ADDR4100x150.pdf";
const isTauri = () =>
        typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const clone = <T>(value: T): T => structuredClone(value);
const errorText = (error: unknown) =>
        (error as { message?: string }).message || String(error);
const fileName = (path: string) => path.split(/[\\/]/).at(-1) || "firmware.bin";
const sameFirmware = (
        left: FirmwareFingerprint | null,
        right: FirmwareFingerprint | null,
) =>
        Boolean(
                left &&
                        right &&
                        left.fileName === right.fileName &&
                        left.byteLength === right.byteLength &&
                        left.sha256 === right.sha256,
        );
const legacyRuleKey = (catalog: string, ruleId: string) =>
        `${catalog}:${ruleId}`;
const validAcknowledgementNote = (note: string, fingerprintPrefix: string) => {
        const normalized = note.trim();
        return (
                normalized.length >= 40 &&
                normalized.split(/\s+/).length >= 8 &&
                normalized
                        .toLowerCase()
                        .includes(fingerprintPrefix.toLowerCase())
        );
};
const riskLabels: Record<LegacyPatchRisk, string> = {
        dsdtModification: "DSDT modification",
        nvramWhitelist: "NVRAM whitelist change",
        usbControllerBlacklist: "USB controller blacklist",
        experimentalX79: "Experimental X79 patch",
};

export type DeploymentWorkspaceActivity = {
        tone: "success" | "warning" | "error";
        text: string;
} | null;
export type DeploymentNextAction =
        | "prepare"
        | "manual"
        | "verifyDriver"
        | "writeConfig"
        | "configurationReboot"
        | "verifyConfigurationBoot"
        | "collectBar"
        | "nvidiaPolicy"
        | "complete"
        | "none";

export interface DeploymentWorkspaceView {
        snapshot: SystemSnapshot;
        displayName: string;
        boardPath: BoardPath;
        firmwarePath: string;
        firmware: FirmwareFingerprint | null;
        recoveryMethod: RecoveryMethod;
        installMethod: FirmwareInstallMethod;
        instructionsUrl: string;
        recoveryNote: string;
        installNote: string;
        routeConfirmed: boolean;
        legacyAnalysis: { path: string; value: LegacyFirmwareAnalysis } | null;
        legacyAnalysisStatus: "idle" | "pending" | "ready" | "error";
        legacyAnalysisError: string;
        selectedLegacyRules: string[];
        legacyAcknowledgements: Partial<
                Record<LegacyPatchRisk, { note: string; confirmed: boolean }>
        >;
        profiles: MachineProfile[];
        selectedProfileId: string;
        selectedProfile: MachineProfile | null;
        plan: DeploymentPlan | null;
        activeStep: DeploymentPlan["steps"][number] | null;
        nextAction: DeploymentNextAction;
        preflightExact: boolean | null;
        preparation: FirmwarePreparation | null;
        destination: string;
        packageReceipt: DeploymentPackageReceipt | null;
        rebootPreview: FirmwareSetupRebootPreview | null;
        showReboot: boolean;
        savedWork: boolean;
        manualPreview: ManualDeploymentStepPreview | null;
        showManual: boolean;
        manualConfirmed: boolean;
        configurationRebootPreview: ConfigurationRebootPreview | null;
        showConfigurationReboot: boolean;
        guardedConfigConfirmed: boolean;
        configRecommendation: {
                profileId: string;
                planRevision: number;
                value: DeploymentConfigRecommendation;
        } | null;
        recommendationStatus: "idle" | "pending" | "ready" | "error";
        recommendationError: string;
        workflowReceipt: { title: string; detail: string } | null;
        barEvidence: NvidiaSmiEvidence | null;
        installation: ProfileInspectorInstallation | null;
        backup: NvidiaProfileBackupReceipt | null;
        launch: ProfileInspectorLaunch | null;
        busyAction: string;
        activity: DeploymentWorkspaceActivity;
        legacyAnalysisValid: boolean;
        selectedLegacyEntries: {
                catalog: LegacyFirmwareAnalysis["catalogs"][number];
                rule: LegacyFirmwareAnalysis["catalogs"][number]["rules"][number];
        }[];
        selectedLegacyRisks: LegacyPatchRisk[];
        acknowledgementHash: string;
        missingLegacyRisk: LegacyPatchRisk | undefined;
        legacyReady: boolean;
        legacyNextAction: string;
}

type FieldIntent =
        | { type: "setDisplayName"; value: string }
        | { type: "setBoardPath"; value: BoardPath }
        | { type: "setFirmwarePath"; value: string }
        | { type: "setRecoveryMethod"; value: RecoveryMethod }
        | { type: "setInstallMethod"; value: FirmwareInstallMethod }
        | { type: "setInstructionsUrl"; value: string }
        | { type: "setRecoveryNote"; value: string }
        | { type: "setInstallNote"; value: string }
        | { type: "setRouteConfirmed"; value: boolean }
        | { type: "setDestination"; value: string }
        | { type: "setSelectedProfile"; value: string }
        | { type: "setSavedWork"; value: boolean }
        | { type: "setManualConfirmed"; value: boolean }
        | { type: "setGuardedConfigConfirmed"; value: boolean }
        | { type: "toggleLegacyRule"; key: string; checked: boolean }
        | { type: "setLegacyRiskNote"; risk: LegacyPatchRisk; note: string }
        | {
                  type: "setLegacyRiskConfirmed";
                  risk: LegacyPatchRisk;
                  confirmed: boolean;
          };
export type DeploymentWorkspaceIntent =
        | FieldIntent
        | {
                  type:
                          | "chooseFirmware"
                          | "inspectFirmware"
                          | "analyzeLegacy"
                          | "createProfile"
                          | "compare"
                          | "prepare"
                          | "chooseDestination"
                          | "exportPackage"
                          | "previewFirmwareReboot"
                          | "requestFirmwareReboot"
                          | "openManual"
                          | "confirmManual"
                          | "verifyDriver"
                          | "saveGuardedConfig"
                          | "openConfigurationReboot"
                          | "requestConfigurationReboot"
                          | "verifyConfigurationBoot"
                          | "collectBar"
                          | "installInspector"
                          | "backupProfiles"
                          | "launchInspector"
                          | "closeModals"
                          | "dismissActivity";
          };

export interface DeploymentWorkspaceSession {
        view(): DeploymentWorkspaceView;
        dispatch(intent: DeploymentWorkspaceIntent): Promise<void>;
        subscribe(listener: () => void): () => void;
        dispose(): void;
}

type DeploymentWorkspaceState = Omit<
        DeploymentWorkspaceView,
        | "selectedProfile"
        | "activeStep"
        | "nextAction"
        | "legacyAnalysisValid"
        | "selectedLegacyEntries"
        | "selectedLegacyRisks"
        | "acknowledgementHash"
        | "missingLegacyRisk"
        | "legacyReady"
        | "legacyNextAction"
>;

const assertPlanAdvance = (
        before: DeploymentPlan,
        after: DeploymentPlan,
        completedStepIds: StepId[],
) => {
        if (
                after.profileId !== before.profileId ||
                after.schemaVersion !== before.schemaVersion ||
                after.originalFirmwareSha256 !==
                        before.originalFirmwareSha256 ||
                after.recoveryMethod !== before.recoveryMethod
        )
                throw new Error(
                        "The backend returned a deployment receipt for a different profile contract.",
                );
        if (after.revision !== before.revision + completedStepIds.length)
                throw new Error(
                        "The backend returned an unexpected deployment plan revision.",
                );
        if (
                after.steps.length !== before.steps.length ||
                after.steps.some(
                        (step, index) => step.id !== before.steps[index]?.id,
                )
        )
                throw new Error(
                        "The backend returned a malformed deployment step sequence.",
                );
        const readyBefore = before.steps
                .map((step, index) => ({ step, index }))
                .filter(({ step }) => step.state === "ready");
        if (readyBefore.length !== 1)
                throw new Error(
                        "The current deployment plan does not have exactly one active step.",
                );
        const activeIndex = readyBefore[0]!.index;
        const expectedCompleted = before.steps.slice(
                activeIndex,
                activeIndex + completedStepIds.length,
        );
        if (
                expectedCompleted.length !== completedStepIds.length ||
                expectedCompleted.some(
                        (step, index) =>
                                step.id !== completedStepIds[index] ||
                                (index === 0
                                        ? step.state !== "ready"
                                        : step.state !== "pending"),
                ) ||
                completedStepIds.some((_, index) => {
                        const step = after.steps[activeIndex + index];
                        return (
                                step?.state !== "completed" ||
                                !step.evidence?.kind.trim() ||
                                !step.evidence.value.trim()
                        );
                }) ||
                after.steps.some(
                        (step, index) =>
                                (index < activeIndex ||
                                        index >
                                                activeIndex +
                                                        completedStepIds.length) &&
                                (step.state !== before.steps[index]?.state ||
                                        JSON.stringify(step.evidence) !==
                                                JSON.stringify(
                                                        before.steps[index]
                                                                ?.evidence,
                                                )),
                )
        )
                throw new Error(
                        "The backend receipt advanced unexpected deployment steps.",
                );
        const nextIndex = activeIndex + completedStepIds.length;
        const next = after.steps[nextIndex];
        if (
                (next &&
                        (next.state !== "ready" ||
                                before.steps[nextIndex]?.state !== "pending" ||
                                JSON.stringify(next.evidence) !==
                                        JSON.stringify(
                                                before.steps[nextIndex]
                                                        ?.evidence,
                                        ))) ||
                (!next && after.steps.some((step) => step.state === "ready"))
        )
                throw new Error(
                        "The backend receipt did not activate exactly the next deployment step.",
                );
        if (
                after.steps.filter((step) => step.state === "ready").length !==
                (next ? 1 : 0)
        )
                throw new Error(
                        "The backend returned an invalid active deployment step count.",
                );
};
const assertPlanProjection = (
        profile: MachineProfile,
        plan: DeploymentPlan,
) => {
        const ready = plan.steps.filter((step) => step.state === "ready");
        const firstOpen = plan.steps.findIndex(
                (step) => step.state !== "completed",
        );
        const invalidEvidence = plan.steps.some((step) =>
                step.state === "completed"
                        ? !step.evidence?.kind.trim() ||
                          !step.evidence.value.trim()
                        : step.evidence !== null,
        );
        const invalidOrder = plan.steps.some((step, index) =>
                firstOpen < 0
                        ? step.state !== "completed"
                        : index < firstOpen
                          ? step.state !== "completed"
                          : index === firstOpen
                            ? step.state !== "ready"
                            : step.state !== "pending",
        );
        if (
                plan.profileId !== profile.profileId ||
                plan.originalFirmwareSha256 !==
                        profile.originalFirmware.sha256 ||
                plan.recoveryMethod !== profile.recovery.method ||
                plan.revision < 0 ||
                ready.length !== (firstOpen < 0 ? 0 : 1) ||
                invalidEvidence ||
                invalidOrder
        ) {
                throw new Error(
                        "The backend returned a malformed deployment plan for the selected profile.",
                );
        }
        return plan;
};
const assertRecommendation = (value: DeploymentConfigRecommendation) => {
        const ids = value.draft.rules.map((rule) =>
                [
                        rule.deviceId,
                        rule.subsystemVendorId,
                        rule.subsystemDeviceId,
                        rule.bus,
                        rule.device,
                        rule.function,
                ].join(":"),
        );
        if (
                value.draft.globalMode !== 1 ||
                value.draft.targetPciBarSize !== 0 ||
                value.draft.skipS3Resume ||
                value.draft.overrideBarSizeMask ||
                !value.draft.guardSetupChanges ||
                value.turingGpuCount <= 0 ||
                value.registryManagedGpuCount < 0 ||
                value.exactFallbackRuleCount < 0 ||
                value.registryManagedGpuCount + value.exactFallbackRuleCount !==
                        value.turingGpuCount ||
                value.exactFallbackRuleCount !== value.draft.rules.length ||
                new Set(ids).size !== ids.length ||
                value.draft.rules.some(
                        (rule) =>
                                rule.matchScope !== "location" ||
                                rule.barSizeSelector !== 5 ||
                                rule.overrideBarSizeMask !== null,
                )
        )
                throw new Error(
                        "The backend returned an inconsistent deployment configuration recommendation.",
                );
        return value;
};
const nextActionFor = (stepId?: StepId): DeploymentNextAction => {
        switch (stepId) {
                case "prepareRustDriver":
                case "applyLegacyBoardPatches":
                case "verifyPatchedArtifact":
                        return "prepare";
                case "flashWithVendorRoute":
                case "configureFirmwareSetup":
                        return "manual";
                case "rebootAfterFirmware":
                case "verifyDriverLoaded":
                        return "verifyDriver";
                case "writeNvstrapsConfiguration":
                        return "writeConfig";
                case "rebootAfterConfiguration":
                        return "configurationReboot";
                case "verifyResizableBar":
                        return "collectBar";
                case "configureNvidiaApplications":
                        return "nvidiaPolicy";
                case undefined:
                        return "complete";
                default:
                        return "none";
        }
};

class Session implements DeploymentWorkspaceSession {
        private listeners = new Set<() => void>();
        private disposed = false;
        private generation = 0;
        private inflight: Promise<void> | null = null;
        private cachedView: DeploymentWorkspaceView | null = null;
        private firmwareRebootBinding: {
                profileId: string;
                planRevision: number;
                stepId: StepId;
                confirmationToken: string;
        } | null = null;
        private state: DeploymentWorkspaceState;
        constructor(
                snapshot: SystemSnapshot,
                private adapter: DeploymentAdapter,
        ) {
                const msi =
                        snapshot.machineIdentity?.boardManufacturer ===
                                "Micro-Star International Co., Ltd." &&
                        snapshot.machineIdentity.boardProduct ===
                                "PRO Z690-A DDR4(MS-7D25)" &&
                        snapshot.machineIdentity.boardVersion === "1.0";
                this.state = {
                        snapshot,
                        displayName: msi
                                ? "PRO Z690-A DDR4 · RTX 2080 SUPER"
                                : "",
                        boardPath: "nativeResizableBar",
                        firmwarePath: "",
                        firmware: null,
                        recoveryMethod: msi ? "usbFlashback" : "vendorRecovery",
                        installMethod: "firmwareSetupUtility",
                        instructionsUrl: msi ? MSI_MANUAL : "",
                        recoveryNote: msi
                                ? "MSI Flash BIOS Button recovery: MSI.ROM at USB root, rear Flash BIOS port, physical button."
                                : "",
                        installNote: msi
                                ? "Use M-FLASH to select the exported vendor-format image. The app does not perform the flash."
                                : "",
                        routeConfirmed: false,
                        legacyAnalysis: null,
                        legacyAnalysisStatus: "idle",
                        legacyAnalysisError: "",
                        selectedLegacyRules: [],
                        legacyAcknowledgements: {},
                        profiles: [],
                        selectedProfileId: "",
                        plan: null,
                        preflightExact: null,
                        preparation: null,
                        destination: "",
                        packageReceipt: null,
                        rebootPreview: null,
                        showReboot: false,
                        savedWork: false,
                        manualPreview: null,
                        showManual: false,
                        manualConfirmed: false,
                        configurationRebootPreview: null,
                        showConfigurationReboot: false,
                        guardedConfigConfirmed: false,
                        configRecommendation: null,
                        recommendationStatus: "idle",
                        recommendationError: "",
                        workflowReceipt: null,
                        barEvidence: null,
                        installation: null,
                        backup: null,
                        launch: null,
                        busyAction: "",
                        activity: null,
                };
                void this.initialize();
        }
        view = (): DeploymentWorkspaceView => {
                if (this.cachedView) return this.cachedView;
                const selectedProfile =
                        this.state.profiles.find(
                                (profile) =>
                                        profile.profileId ===
                                        this.state.selectedProfileId,
                        ) ?? null;
                const activeStep =
                        this.state.plan?.steps.find(
                                (step) => step.state === "ready",
                        ) ?? null;
                const legacyAnalysisValid = Boolean(
                        this.state.legacyAnalysis &&
                                this.state.legacyAnalysis.path ===
                                        this.state.firmwarePath &&
                                sameFirmware(
                                        this.state.legacyAnalysis.value
                                                .firmware,
                                        this.state.firmware,
                                ),
                );
                const selectedLegacyEntries =
                        !this.state.legacyAnalysis || !legacyAnalysisValid
                                ? []
                                : this.state.legacyAnalysis.value.catalogs.flatMap(
                                          (catalog) =>
                                                  catalog.rules
                                                          .filter(
                                                                  (rule) =>
                                                                          rule.status ===
                                                                                  "applicable" &&
                                                                          this.state.selectedLegacyRules.includes(
                                                                                  legacyRuleKey(
                                                                                          catalog.catalog,
                                                                                          rule.ruleId,
                                                                                  ),
                                                                          ),
                                                          )
                                                          .map((rule) => ({
                                                                  catalog,
                                                                  rule,
                                                          })),
                                  );
                const selectedLegacyRisks = [
                        ...new Set(
                                selectedLegacyEntries.flatMap(
                                        ({ rule }) => rule.requiredRisks,
                                ),
                        ),
                ];
                const acknowledgementHash =
                        this.state.firmware?.sha256.slice(0, 8) ?? "";
                const missingLegacyRisk = selectedLegacyRisks.find((risk) => {
                        const acknowledgement =
                                this.state.legacyAcknowledgements[risk];
                        return !(
                                acknowledgement?.confirmed &&
                                validAcknowledgementNote(
                                        acknowledgement.note,
                                        acknowledgementHash,
                                )
                        );
                });
                const legacyReady =
                        this.state.boardPath !== "legacyAbove4g" ||
                        (this.state.legacyAnalysisStatus === "ready" &&
                                legacyAnalysisValid &&
                                selectedLegacyEntries.length > 0 &&
                                !missingLegacyRisk);
                let legacyNextAction = "";
                if (this.state.boardPath === "legacyAbove4g") {
                        if (!this.state.firmware)
                                legacyNextAction =
                                        "Choose and inspect the exact firmware image first.";
                        else if (this.state.legacyAnalysisStatus === "pending")
                                legacyNextAction =
                                        "Wait for the exact-image analysis to finish.";
                        else if (this.state.legacyAnalysisStatus === "error")
                                legacyNextAction = `Analysis failed: ${this.state.legacyAnalysisError} Retry the exact image.`;
                        else if (
                                !this.state.legacyAnalysis ||
                                !legacyAnalysisValid
                        )
                                legacyNextAction =
                                        "Analyze this exact firmware image before selecting legacy rules.";
                        else if (!selectedLegacyEntries.length)
                                legacyNextAction =
                                        "Select at least one applicable rule. Only proven matches can be selected.";
                        else if (missingLegacyRisk)
                                legacyNextAction = `Add an image-specific note and confirmation for ${riskLabels[missingLegacyRisk]}.`;
                        else
                                legacyNextAction =
                                        "Legacy selections are pinned to this firmware fingerprint and ready for profile creation.";
                }
                this.cachedView = {
                        ...this.state,
                        selectedProfile,
                        activeStep,
                        nextAction: nextActionFor(activeStep?.id),
                        legacyAnalysisValid,
                        selectedLegacyEntries,
                        selectedLegacyRisks,
                        acknowledgementHash,
                        missingLegacyRisk,
                        legacyReady,
                        legacyNextAction,
                };
                return this.cachedView;
        };
        subscribe = (listener: () => void) => {
                this.listeners.add(listener);
                return () => this.listeners.delete(listener);
        };
        dispose = () => {
                this.disposed = true;
                this.generation += 1;
                this.listeners.clear();
        };
        private emit() {
                if (!this.disposed)
                        this.listeners.forEach((listener) => listener());
        }
        private patch(value: Partial<typeof this.state>) {
                Object.assign(this.state, value);
                this.cachedView = null;
                this.emit();
        }
        private async initialize() {
                const generation = ++this.generation;
                try {
                        const [profiles, installation] = await Promise.all([
                                this.adapter.listMachineProfiles(),
                                this.adapter.getNvidiaProfileInspectorInstallation(),
                        ]);
                        if (this.disposed || generation !== this.generation)
                                return;
                        this.patch({
                                profiles,
                                installation,
                                selectedProfileId: profiles[0]?.profileId ?? "",
                        });
                        if (profiles[0])
                                await this.loadPlan(
                                        profiles[0].profileId,
                                        generation,
                                );
                } catch (error) {
                        if (generation === this.generation)
                                this.patch({
                                        activity: {
                                                tone: "error",
                                                text: errorText(error),
                                        },
                                });
                }
        }
        private async loadPlan(
                profileId: string,
                generation = ++this.generation,
        ) {
                if (!profileId) {
                        this.patch({ plan: null });
                        return;
                }
                try {
                        const plan =
                                await this.adapter.getDeploymentPlan(profileId);
                        if (
                                this.disposed ||
                                generation !== this.generation ||
                                this.state.selectedProfileId !== profileId
                        )
                                return;
                        const profile = this.state.profiles.find(
                                (candidate) =>
                                        candidate.profileId === profileId,
                        );
                        if (!profile)
                                throw new Error(
                                        "The selected deployment profile is unavailable.",
                                );
                        assertPlanProjection(profile, plan);
                        this.patch({ plan });
                        void this.loadRecommendation();
                } catch (error) {
                        if (generation === this.generation)
                                this.patch({
                                        activity: {
                                                tone: "error",
                                                text: errorText(error),
                                        },
                                });
                }
        }
        private invalidateLegacy() {
                this.generation += 1;
                this.patch({
                        legacyAnalysis: null,
                        legacyAnalysisStatus: "idle",
                        legacyAnalysisError: "",
                        selectedLegacyRules: [],
                        legacyAcknowledgements: {},
                });
        }
        private run(
                action: string,
                work: (transaction: {
                        patch: (
                                value: Partial<DeploymentWorkspaceState>,
                        ) => void;
                        success: (text: string) => void;
                        current: () => boolean;
                }) => Promise<void>,
        ): Promise<void> {
                if (this.inflight) return this.inflight;
                const generation = this.generation;
                this.patch({ busyAction: action, activity: null });
                const current = () =>
                        !this.disposed && generation === this.generation;
                const transaction = {
                        patch: (value: Partial<DeploymentWorkspaceState>) => {
                                if (current()) this.patch(value);
                        },
                        success: (text: string) => {
                                if (current()) this.success(text);
                        },
                        current,
                };
                const promise = work(transaction)
                        .catch((error) => {
                                if (
                                        !this.disposed &&
                                        generation === this.generation
                                )
                                        this.patch({
                                                activity: {
                                                        tone: "error",
                                                        text: errorText(error),
                                                },
                                        });
                        })
                        .finally(() => {
                                if (this.inflight === promise) {
                                        this.inflight = null;
                                        this.patch({ busyAction: "" });
                                }
                        });
                this.inflight = promise;
                return promise;
        }
        private success(text: string) {
                this.patch({ activity: { tone: "success", text } });
        }
        private async loadRecommendation() {
                const plan = this.state.plan;
                if (
                        plan?.steps.find((step) => step.state === "ready")
                                ?.id !== "writeNvstrapsConfiguration"
                ) {
                        this.patch({
                                recommendationStatus: "idle",
                                configRecommendation: null,
                                recommendationError: "",
                                guardedConfigConfirmed: false,
                        });
                        return;
                }
                const generation = this.generation;
                this.patch({
                        recommendationStatus: "pending",
                        configRecommendation: null,
                        recommendationError: "",
                        guardedConfigConfirmed: false,
                });
                try {
                        const value = assertRecommendation(
                                await this.adapter.getRecommendedDeploymentConfig(
                                        plan.profileId,
                                ),
                        );
                        if (
                                generation !== this.generation ||
                                this.state.plan?.profileId !== plan.profileId ||
                                this.state.plan.revision !== plan.revision
                        )
                                return;
                        this.patch({
                                configRecommendation: {
                                        profileId: plan.profileId,
                                        planRevision: plan.revision,
                                        value,
                                },
                                recommendationStatus: "ready",
                        });
                } catch (error) {
                        if (generation === this.generation) {
                                const text = errorText(error);
                                this.patch({
                                        recommendationStatus: "error",
                                        recommendationError: text,
                                        activity: { tone: "error", text },
                                });
                        }
                }
        }
        dispatch = async (intent: DeploymentWorkspaceIntent): Promise<void> => {
                if (this.disposed) return;
                switch (intent.type) {
                        case "setDisplayName":
                                this.patch({ displayName: intent.value });
                                return;
                        case "setBoardPath":
                                this.invalidateLegacy();
                                this.patch({ boardPath: intent.value });
                                return;
                        case "setFirmwarePath":
                                this.invalidateLegacy();
                                this.patch({
                                        firmwarePath: intent.value,
                                        firmware: null,
                                });
                                return;
                        case "setRecoveryMethod":
                                this.patch({ recoveryMethod: intent.value });
                                return;
                        case "setInstallMethod":
                                this.patch({ installMethod: intent.value });
                                return;
                        case "setInstructionsUrl":
                                this.patch({ instructionsUrl: intent.value });
                                return;
                        case "setRecoveryNote":
                                this.patch({ recoveryNote: intent.value });
                                return;
                        case "setInstallNote":
                                this.patch({ installNote: intent.value });
                                return;
                        case "setRouteConfirmed":
                                this.patch({ routeConfirmed: intent.value });
                                return;
                        case "setDestination":
                                this.patch({ destination: intent.value });
                                return;
                        case "setSavedWork":
                                this.patch({ savedWork: intent.value });
                                return;
                        case "setManualConfirmed":
                                this.patch({ manualConfirmed: intent.value });
                                return;
                        case "setGuardedConfigConfirmed":
                                this.patch({
                                        guardedConfigConfirmed: intent.value,
                                });
                                return;
                        case "toggleLegacyRule":
                                this.patch({
                                        selectedLegacyRules: intent.checked
                                                ? [
                                                          ...new Set([
                                                                  ...this.state
                                                                          .selectedLegacyRules,
                                                                  intent.key,
                                                          ]),
                                                  ]
                                                : this.state.selectedLegacyRules.filter(
                                                          (key) =>
                                                                  key !==
                                                                  intent.key,
                                                  ),
                                });
                                return;
                        case "setLegacyRiskNote":
                                this.patch({
                                        legacyAcknowledgements: {
                                                ...this.state
                                                        .legacyAcknowledgements,
                                                [intent.risk]: {
                                                        note: intent.note,
                                                        confirmed:
                                                                this.state
                                                                        .legacyAcknowledgements[
                                                                        intent
                                                                                .risk
                                                                ]?.confirmed ??
                                                                false,
                                                },
                                        },
                                });
                                return;
                        case "setLegacyRiskConfirmed":
                                this.patch({
                                        legacyAcknowledgements: {
                                                ...this.state
                                                        .legacyAcknowledgements,
                                                [intent.risk]: {
                                                        note:
                                                                this.state
                                                                        .legacyAcknowledgements[
                                                                        intent
                                                                                .risk
                                                                ]?.note ?? "",
                                                        confirmed: intent.confirmed,
                                                },
                                        },
                                });
                                return;
                        case "setSelectedProfile": {
                                this.generation += 1;
                                this.inflight = null;
                                this.firmwareRebootBinding = null;
                                this.patch({
                                        selectedProfileId: intent.value,
                                        plan: null,
                                        preflightExact: null,
                                        preparation: null,
                                        packageReceipt: null,
                                        rebootPreview: null,
                                        showReboot: false,
                                        savedWork: false,
                                        manualPreview: null,
                                        showManual: false,
                                        configurationRebootPreview: null,
                                        showConfigurationReboot: false,
                                        guardedConfigConfirmed: false,
                                        configRecommendation: null,
                                        recommendationStatus: "idle",
                                        recommendationError: "",
                                        workflowReceipt: null,
                                        barEvidence: null,
                                        backup: null,
                                        launch: null,
                                        activity: null,
                                        busyAction: "",
                                });
                                await this.loadPlan(
                                        intent.value,
                                        this.generation,
                                );
                                return;
                        }
                        case "closeModals":
                                this.patch({
                                        showReboot: false,
                                        showManual: false,
                                        showConfigurationReboot: false,
                                });
                                return;
                        case "dismissActivity":
                                this.patch({ activity: null });
                                return;
                        case "chooseFirmware":
                                return this.run("firmware", async (tx) => {
                                        const path =
                                                await this.adapter.selectFirmwareImage();
                                        if (!path)
                                                throw new Error(
                                                        "Firmware selection was cancelled.",
                                                );
                                        const inspected =
                                                await this.adapter.inspectFirmwareImage(
                                                        path,
                                                );
                                        tx.patch({
                                                firmwarePath: path,
                                                firmware: inspected,
                                                legacyAnalysis: null,
                                                legacyAnalysisStatus: "idle",
                                                legacyAnalysisError: "",
                                                selectedLegacyRules: [],
                                                legacyAcknowledgements: {},
                                        });
                                        tx.success(
                                                "Source firmware read and hashed. No firmware was modified.",
                                        );
                                });
                        case "inspectFirmware":
                                return this.run("firmware", async (tx) => {
                                        const inspected =
                                                await this.adapter.inspectFirmwareImage(
                                                        this.state.firmwarePath,
                                                );
                                        tx.patch({
                                                firmware: inspected,
                                                legacyAnalysis: null,
                                                legacyAnalysisStatus: "idle",
                                                legacyAnalysisError: "",
                                                selectedLegacyRules: [],
                                                legacyAcknowledgements: {},
                                        });
                                        tx.success(
                                                "Source firmware read and hashed. No firmware was modified.",
                                        );
                                });
                        case "analyzeLegacy":
                                return this.run(
                                        "legacy-analysis",
                                        async (tx) => {
                                                const requestedPath =
                                                        this.state.firmwarePath;
                                                const requestedFirmware = clone(
                                                        this.state.firmware!,
                                                );
                                                tx.patch({
                                                        legacyAnalysisStatus:
                                                                "pending",
                                                        legacyAnalysisError: "",
                                                        legacyAnalysis: null,
                                                        selectedLegacyRules: [],
                                                        legacyAcknowledgements:
                                                                {},
                                                });
                                                const value =
                                                        await this.adapter.analyzeLegacyFirmware(
                                                                requestedPath,
                                                        );
                                                if (
                                                        requestedPath !==
                                                        this.state.firmwarePath
                                                )
                                                        return;
                                                if (
                                                        !sameFirmware(
                                                                value.firmware,
                                                                requestedFirmware,
                                                        )
                                                )
                                                        throw new Error(
                                                                "The firmware fingerprint changed between inspection and analysis.",
                                                        );
                                                tx.patch({
                                                        legacyAnalysis: {
                                                                path: requestedPath,
                                                                value,
                                                        },
                                                        selectedLegacyRules:
                                                                value.catalogs.flatMap(
                                                                        (
                                                                                catalog,
                                                                        ) =>
                                                                                catalog.rules
                                                                                        .filter(
                                                                                                (
                                                                                                        rule,
                                                                                                ) =>
                                                                                                        rule.status ===
                                                                                                                "applicable" &&
                                                                                                        rule.recommended,
                                                                                        )
                                                                                        .map(
                                                                                                (
                                                                                                        rule,
                                                                                                ) =>
                                                                                                        legacyRuleKey(
                                                                                                                catalog.catalog,
                                                                                                                rule.ruleId,
                                                                                                        ),
                                                                                        ),
                                                                ),
                                                        legacyAnalysisStatus:
                                                                "ready",
                                                });
                                                tx.success(
                                                        "Exact-image legacy analysis completed read-only. No firmware was modified.",
                                                );
                                        },
                                );
                        case "createProfile":
                                return this.createProfile();
                        case "compare":
                                return this.run("preflight", async (tx) => {
                                        const comparison =
                                                await this.adapter.compareMachineProfile(
                                                        this.state
                                                                .selectedProfileId,
                                                );
                                        const exact =
                                                comparison.result.differences
                                                        .length === 0;
                                        tx.patch({ preflightExact: exact });
                                        if (!exact) {
                                                const count =
                                                        comparison.result
                                                                .differences
                                                                .length;
                                                throw new Error(
                                                        `Pinned machine preflight found ${count} difference${count === 1 ? "" : "s"}; deployment remains blocked until the selected profile matches.`,
                                                );
                                        }
                                        tx.success(
                                                "Current machine, GPU topology, BIOS, and preserved source match the profile.",
                                        );
                                });
                        case "prepare":
                                return this.prepare();
                        case "chooseDestination":
                                return this.run("destination", async (tx) => {
                                        const value =
                                                await this.adapter.selectDestinationDirectory();
                                        if (!value)
                                                throw new Error(
                                                        "Destination selection was cancelled.",
                                                );
                                        tx.patch({ destination: value });
                                        tx.success(
                                                "Package destination selected.",
                                        );
                                });
                        case "exportPackage":
                                return this.run("export", async (tx) => {
                                        const packageReceipt =
                                                await this.adapter.exportDeploymentPackage(
                                                        this.state
                                                                .selectedProfileId,
                                                        this.state.destination,
                                                );
                                        tx.patch({ packageReceipt });
                                        tx.success(
                                                "Verified deployment package exported. Vendor flashing remains manual.",
                                        );
                                });
                        case "previewFirmwareReboot":
                                return this.run(
                                        "reboot-preview",
                                        async (tx) => {
                                                const plan = this.state.plan!;
                                                const active = plan.steps.find(
                                                        (step) =>
                                                                step.state ===
                                                                "ready",
                                                )!;
                                                const preview =
                                                        await this.adapter.previewFirmwareSetupReboot(
                                                                this.state
                                                                        .selectedProfileId,
                                                        );
                                                if (
                                                        preview.profileId !==
                                                                plan.profileId ||
                                                        preview.activeStep !==
                                                                active.id ||
                                                        !preview.confirmationToken
                                                )
                                                        throw new Error(
                                                                "The deployment plan changed while the restart preview was loading.",
                                                        );
                                                if (!tx.current()) return;
                                                this.firmwareRebootBinding = {
                                                        profileId: plan.profileId,
                                                        planRevision:
                                                                plan.revision,
                                                        stepId: active.id,
                                                        confirmationToken:
                                                                preview.confirmationToken,
                                                };
                                                tx.patch({
                                                        rebootPreview: preview,
                                                        savedWork: false,
                                                        showReboot: true,
                                                });
                                                tx.success(
                                                        "Restart scope previewed; no restart has occurred.",
                                                );
                                        },
                                );
                        case "requestFirmwareReboot":
                                return this.run("reboot", async (tx) => {
                                        const preview =
                                                this.state.rebootPreview!;
                                        const binding =
                                                this.firmwareRebootBinding;
                                        const active =
                                                this.state.plan?.steps.find(
                                                        (step) =>
                                                                step.state ===
                                                                "ready",
                                                );
                                        tx.patch({ showReboot: false });
                                        if (
                                                !binding ||
                                                binding.profileId !==
                                                        this.state.plan
                                                                ?.profileId ||
                                                binding.planRevision !==
                                                        this.state.plan
                                                                ?.revision ||
                                                binding.stepId !== active?.id ||
                                                binding.confirmationToken !==
                                                        preview.confirmationToken
                                        )
                                                throw new Error(
                                                        "The firmware restart preview is stale.",
                                                );
                                        const receipt =
                                                await this.adapter.rebootToFirmwareSetup(
                                                        preview,
                                                        this.state.savedWork,
                                                );
                                        if (
                                                receipt.profileId !==
                                                        preview.profileId ||
                                                receipt.accepted !== true
                                        )
                                                throw new Error(
                                                        "The firmware restart request returned an invalid acceptance receipt.",
                                                );
                                        tx.success(
                                                "Windows accepted the restart request. This only opens firmware setup.",
                                        );
                                });
                        case "openManual":
                                return this.openManual();
                        case "confirmManual":
                                return this.confirmManual();
                        case "verifyDriver":
                                return this.verifyDriver();
                        case "saveGuardedConfig":
                                return this.saveGuardedConfig();
                        case "openConfigurationReboot":
                                return this.openConfigurationReboot();
                        case "requestConfigurationReboot":
                                return this.requestConfigurationReboot();
                        case "verifyConfigurationBoot":
                                return this.verifyConfigurationBoot();
                        case "collectBar":
                                return this.collectBar();
                        case "installInspector":
                                return this.run(
                                        "install-inspector",
                                        async (tx) => {
                                                const installation =
                                                        await this.adapter.installNvidiaProfileInspector();
                                                tx.patch({ installation });
                                                tx.success(
                                                        "Pinned NVIDIA Profile Inspector verified and installed.",
                                                );
                                        },
                                );
                        case "backupProfiles":
                                return this.run(
                                        "backup-profiles",
                                        async (tx) => {
                                                const backup =
                                                        await this.adapter.backupNvidiaProfiles(
                                                                this.state
                                                                        .selectedProfileId,
                                                        );
                                                if (
                                                        backup.manifest
                                                                .profileId !==
                                                                this.state
                                                                        .selectedProfileId ||
                                                        !backup.manifestSha256.trim()
                                                )
                                                        throw new Error(
                                                                "The NVIDIA profile backup receipt does not match the selected profile.",
                                                        );
                                                tx.patch({ backup });
                                                tx.success(
                                                        "Customized NVIDIA profiles exported to an immutable backup.",
                                                );
                                        },
                                );
                        case "launchInspector":
                                return this.run(
                                        "launch-inspector",
                                        async (tx) => {
                                                const launch =
                                                        await this.adapter.launchNvidiaProfileInspector(
                                                                this.state
                                                                        .selectedProfileId,
                                                        );
                                                if (
                                                        launch.profileId !==
                                                                this.state
                                                                        .selectedProfileId ||
                                                        launch.backup.manifest
                                                                .profileId !==
                                                                this.state
                                                                        .selectedProfileId ||
                                                        !launch.executableSha256.trim()
                                                )
                                                        throw new Error(
                                                                "The Profile Inspector launch receipt does not match the selected profile.",
                                                        );
                                                tx.patch({
                                                        launch,
                                                        backup: launch.backup,
                                                });
                                                tx.success(
                                                        "Profile Inspector launched after an automatic profile backup. Policy changes remain manual.",
                                                );
                                        },
                                );
                }
        };
        private createProfile() {
                const view = this.view();
                if (!view.firmware) return Promise.resolve();
                return this.run("profile", async (tx) => {
                        const bundle = await this.adapter.createMachineProfile({
                                displayName: view.displayName,
                                boardPath: view.boardPath,
                                firmwarePath: view.firmwarePath,
                                expectedFirmware: clone(view.firmware!),
                                recovery: {
                                        method: view.recoveryMethod,
                                        testedOrDocumented: view.routeConfirmed,
                                        note: view.recoveryNote,
                                },
                                firmwareInstall: {
                                        method: view.installMethod,
                                        artifactFileName: fileName(
                                                view.firmwarePath,
                                        ),
                                        testedOrDocumented: view.routeConfirmed,
                                        officialInstructionsUrl:
                                                view.instructionsUrl,
                                        note: view.installNote,
                                },
                                legacyPatches:
                                        view.boardPath === "legacyAbove4g" &&
                                        view.legacyAnalysis &&
                                        view.legacyAnalysisValid
                                                ? {
                                                          upstreamCommit:
                                                                  view
                                                                          .legacyAnalysis
                                                                          .value
                                                                          .upstreamCommit,
                                                          catalogs: view.legacyAnalysis.value.catalogs
                                                                  .filter(
                                                                          (
                                                                                  catalog,
                                                                          ) =>
                                                                                  view.selectedLegacyEntries.some(
                                                                                          (
                                                                                                  entry,
                                                                                          ) =>
                                                                                                  entry
                                                                                                          .catalog
                                                                                                          .catalog ===
                                                                                                  catalog.catalog,
                                                                                  ),
                                                                  )
                                                                  .map(
                                                                          (
                                                                                  catalog,
                                                                          ) => ({
                                                                                  catalog: catalog.catalog,
                                                                                  sourceSha256:
                                                                                          catalog.sourceSha256,
                                                                          }),
                                                                  ),
                                                          selections: view.selectedLegacyEntries.map(
                                                                  ({
                                                                          catalog,
                                                                          rule,
                                                                  }) => ({
                                                                          catalog: catalog.catalog,
                                                                          ruleId: rule.ruleId,
                                                                          expectedMatches:
                                                                                  rule.expectedMatches!,
                                                                          requiredRisks:
                                                                                  rule.requiredRisks,
                                                                  }),
                                                          ),
                                                          acknowledgements:
                                                                  view.selectedLegacyRisks.map(
                                                                          (
                                                                                  risk,
                                                                          ) => ({
                                                                                  risk,
                                                                                  note: view.legacyAcknowledgements[
                                                                                          risk
                                                                                  ]!.note.trim(),
                                                                          }),
                                                                  ),
                                                  }
                                                : undefined,
                        });
                        assertPlanProjection(bundle.profile, bundle.plan);
                        tx.patch({
                                profiles: [
                                        bundle.profile,
                                        ...this.state.profiles.filter(
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
                        const selectionCount =
                                view.selectedLegacyEntries.length;
                        const success =
                                view.boardPath === "legacyAbove4g"
                                        ? [
                                                  "Machine-bound legacy profile created with",
                                                  selectionCount,
                                                  "authoritative rule",
                                                  selectionCount === 1
                                                          ? "selection;"
                                                          : "selections;",
                                                  "no firmware was modified or flashed.",
                                          ].join(" ")
                                        : "Machine-bound profile created; the exact source image was preserved.";
                        tx.success(success);
                });
        }
        private prepare() {
                const before = this.state.plan!;
                const active = before.steps.find(
                        (step) => step.state === "ready",
                )!;
                const start = before.steps.findIndex(
                        (step) => step.id === active.id,
                );
                const end = before.steps.findIndex(
                        (step) => step.id === "verifyPatchedArtifact",
                );
                const expected = before.steps
                        .slice(start, end + 1)
                        .map((step) => step.id);
                return this.run("prepare", async (tx) => {
                        const preparation =
                                await this.adapter.prepareFirmwareArtifact(
                                        before.profileId,
                                );
                        assertPlanAdvance(before, preparation.plan, expected);
                        tx.patch({ preparation, plan: preparation.plan });
                        tx.success(
                                "Rust driver injected and the patched artifact verified. Nothing was flashed.",
                        );
                });
        }
        private openManual() {
                const before = this.state.plan!;
                const active = before.steps.find(
                        (step) => step.state === "ready",
                )!;
                return this.run("manual-preview", async (tx) => {
                        const preview =
                                await this.adapter.previewManualDeploymentStep(
                                        before.profileId,
                                );
                        if (
                                preview.profileId !== before.profileId ||
                                preview.planRevision !== before.revision ||
                                preview.stepId !== active.id ||
                                !preview.confirmationToken
                        )
                                throw new Error(
                                        "The deployment plan changed while the consequence preview was loading. Review the current step again.",
                                );
                        tx.patch({
                                manualPreview: preview,
                                manualConfirmed: false,
                                showManual: true,
                        });
                        tx.success(
                                "Current manual consequence preview loaded; nothing was completed.",
                        );
                });
        }
        private confirmManual() {
                const before = this.state.plan!;
                const preview = this.state.manualPreview!;
                const active = before.steps.find(
                        (step) => step.state === "ready",
                );
                this.patch({ showManual: false });
                return this.run("manual-confirm", async (tx) => {
                        if (
                                preview.profileId !== before.profileId ||
                                preview.planRevision !== before.revision ||
                                preview.stepId !== active?.id
                        ) {
                                throw new Error(
                                        "The manual confirmation preview is stale.",
                                );
                        }
                        const receipt =
                                await this.adapter.confirmManualDeploymentStep(
                                        preview,
                                );
                        if (
                                receipt.plan.profileId !== before.profileId ||
                                receipt.stepId !== preview.stepId
                        ) {
                                throw new Error(
                                        "The backend returned a stale manual-step receipt.",
                                );
                        }
                        assertPlanAdvance(before, receipt.plan, [
                                preview.stepId,
                        ]);
                        tx.patch({
                                plan: receipt.plan,
                                workflowReceipt: {
                                        title: `${preview.title} recorded`,
                                        detail: `Operator attestation persisted at ${receipt.recordedAtUnixMs}.`,
                                },
                        });
                        tx.success(
                                "Manual gate recorded in the durable deployment plan.",
                        );
                });
        }
        private verifyDriver() {
                const before = this.state.plan!;
                const active = before.steps.find(
                        (step) => step.state === "ready",
                )!;
                const expected: StepId[] =
                        active.id === "rebootAfterFirmware"
                                ? ["rebootAfterFirmware", "verifyDriverLoaded"]
                                : ["verifyDriverLoaded"];
                return this.run("driver-verify", async (tx) => {
                        const receipt =
                                await this.adapter.verifyDeploymentDriver(
                                        before.profileId,
                                );
                        assertPlanAdvance(before, receipt.plan, expected);
                        tx.patch({
                                plan: receipt.plan,
                                workflowReceipt: {
                                        title: "Current boot and Rust DXE verified",
                                        detail: `${receipt.status.label} · ${receipt.status.raw}. The volatile status proved this boot and advanced both boot and driver gates.`,
                                },
                        });
                        tx.success(
                                "Current Windows boot and Rust DXE status were durably verified.",
                        );
                        if (tx.current()) await this.loadRecommendation();
                });
        }
        private saveGuardedConfig() {
                const before = this.state.plan!;
                const recommendation = this.state.configRecommendation!;
                if (
                        !this.state.guardedConfigConfirmed ||
                        recommendation.profileId !== before.profileId ||
                        recommendation.planRevision !== before.revision
                )
                        return Promise.resolve();
                const draft = clone(recommendation.value.draft);
                return this.run("deployment-config", async (tx) => {
                        const receipt = await this.adapter.saveDeploymentConfig(
                                before.profileId,
                                draft,
                        );
                        assertPlanAdvance(before, receipt.plan, [
                                "writeNvstrapsConfiguration",
                        ]);
                        if (
                                JSON.stringify(receipt.save.draft) !==
                                JSON.stringify(draft)
                        )
                                throw new Error(
                                        "The configuration read-back receipt does not match the recommended draft that was submitted.",
                                );
                        tx.patch({
                                plan: receipt.plan,
                                workflowReceipt: {
                                        title: "Configuration write verified by read-back",
                                        detail: `${receipt.save.bytesWritten} bytes · saved ${receipt.save.savedAtUnixMs}. A Windows restart is still required.`,
                                },
                                guardedConfigConfirmed: false,
                        });
                        tx.success(
                                "Guarded deployment configuration was written and verified by read-back.",
                        );
                });
        }
        private openConfigurationReboot() {
                const before = this.state.plan!;
                return this.run("configuration-reboot-preview", async (tx) => {
                        const preview =
                                await this.adapter.previewConfigurationReboot(
                                        before.profileId,
                                );
                        if (
                                preview.profileId !== before.profileId ||
                                preview.planRevision !== before.revision
                        )
                                throw new Error(
                                        "The deployment plan changed while the restart preview was loading.",
                                );
                        tx.patch({
                                configurationRebootPreview: preview,
                                savedWork: false,
                                showConfigurationReboot: true,
                        });
                        tx.success(
                                "Configuration restart previewed; the plan did not advance.",
                        );
                });
        }
        private requestConfigurationReboot() {
                const preview = this.state.configurationRebootPreview!;
                this.patch({ showConfigurationReboot: false });
                return this.run("configuration-reboot", async (tx) => {
                        if (
                                preview.profileId !==
                                        this.state.plan?.profileId ||
                                preview.planRevision !==
                                        this.state.plan?.revision ||
                                !preview.confirmationToken
                        )
                                throw new Error(
                                        "The configuration reboot preview is stale.",
                                );
                        const receipt =
                                await this.adapter.rebootAfterConfiguration(
                                        preview,
                                        this.state.savedWork,
                                );
                        if (
                                receipt.profileId !==
                                        this.state.selectedProfileId ||
                                receipt.accepted !== true ||
                                receipt.planAdvanced !== false
                        )
                                throw new Error(
                                        "The restart request returned an invalid plan-advancement receipt.",
                                );
                        tx.patch({
                                workflowReceipt: {
                                        title: "Configuration restart request accepted",
                                        detail: "Plan advanced: false. Return after Windows boots, then verify the later boot separately.",
                                },
                        });
                        tx.success(
                                "Windows accepted the restart request; this did not complete the reboot gate.",
                        );
                });
        }
        private verifyConfigurationBoot() {
                const before = this.state.plan!;
                return this.run("configuration-boot-verify", async (tx) => {
                        const receipt =
                                await this.adapter.verifyConfigurationReboot(
                                        before.profileId,
                                );
                        assertPlanAdvance(before, receipt.plan, [
                                "rebootAfterConfiguration",
                        ]);
                        const savedEvidence = before.steps.find(
                                (step) =>
                                        step.id ===
                                        "writeNvstrapsConfiguration",
                        )?.evidence?.value;
                        if (
                                receipt.configurationSavedAtUnixMs !==
                                        savedEvidence ||
                                Number(receipt.bootedAtUnixMs) <=
                                        Number(
                                                receipt.configurationSavedAtUnixMs,
                                        )
                        )
                                throw new Error(
                                        "The returned boot receipt is not later than the configuration read-back.",
                                );
                        tx.patch({
                                plan: receipt.plan,
                                workflowReceipt: {
                                        title: "Returned Windows boot verified",
                                        detail: `Boot ${receipt.bootedAtUnixMs} is later than configuration read-back ${receipt.configurationSavedAtUnixMs}.`,
                                },
                        });
                        tx.success(
                                "A Windows boot after the configuration read-back was durably verified.",
                        );
                });
        }
        private collectBar() {
                const before = this.state.plan!;
                return this.run("bar1", async (tx) => {
                        const receipt =
                                await this.adapter.collectNvidiaSmiEvidence(
                                        before.profileId,
                                );
                        if (
                                receipt.evidence.profileId !==
                                        before.profileId ||
                                !receipt.evidence.allProfileGpusObserved
                        )
                                throw new Error(
                                        "NVIDIA telemetry did not prove every GPU in the selected profile.",
                                );
                        assertPlanAdvance(before, receipt.plan, [
                                "verifyResizableBar",
                        ]);
                        tx.patch({
                                plan: receipt.plan,
                                barEvidence: receipt.evidence,
                                workflowReceipt: {
                                        title: "Resizable BAR independently verified",
                                        detail: `All profile GPUs observed · XML ${receipt.evidence.rawXmlSha256.slice(0, 10)}…${receipt.evidence.rawXmlSha256.slice(-8)}.`,
                                },
                        });
                        tx.success(
                                "NVIDIA BAR1 evidence captured and matched to this profile.",
                        );
                });
        }
}

export const createDeploymentWorkspaceSession = (
        snapshot: SystemSnapshot,
        adapter: DeploymentAdapter = isTauri()
                ? tauriDeploymentAdapter
                : previewDeploymentAdapter,
): DeploymentWorkspaceSession => new Session(snapshot, adapter);
