import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { SystemSnapshot } from "./types";
import { translateMessage, useI18n } from "./i18n";
import { usesMsiProZ690Route } from "./hardware-support";
import {
        createDeploymentWorkspaceSession,
        type DeploymentWorkspaceIntent,
} from "./deployment-workspace/session";
import type {
        BoardPath,
        FirmwareInstallMethod,
        LegacyPatchRisk,
        RecoveryMethod,
} from "./deployment-workspace/contract";
import {
        catalogLabelIds,
        configurationRebootWarningIds,
        firmwareRebootWarningIds,
        manualWarningIds,
        legacyRuleBlockedReasonId,
        legacyRuleDescriptionId,
        riskLabelIds,
        stepKindIds,
        stepStateIds,
        stepTitleIds,
} from "./deployment-workspace/messages";

const shortHash = (value?: string) =>
        value ? `${value.slice(0, 10)}…${value.slice(-8)}` : "—";
const legacyRuleKey = (catalog: string, ruleId: string) =>
        `${catalog}:${ruleId}`;
type Props = { snapshot: SystemSnapshot };

export function DeploymentWorkspace({ snapshot }: Props) {
        const { locale, t, n, exactMatches, absentRules } = useI18n();
        const session = useMemo(
                () => createDeploymentWorkspaceSession(snapshot),
                [snapshot],
        );
        useEffect(() => () => session.dispose(), [session]);
        const view = useSyncExternalStore(
                session.subscribe,
                session.view,
                session.view,
        );
        const {
                displayName, boardPath, firmwarePath, firmware, recoveryMethod,
                installMethod, instructionsUrl, recoveryNote, installNote,
                recoveryNotePresetId, installNotePresetId,
                routeConfirmed, legacyAnalysis, legacyAnalysisStatus,
                legacyAnalysisError, selectedLegacyRules, legacyAcknowledgements,
                profiles, selectedProfileId, selectedProfile, plan, activeStep,
                nextStep, activeStepTitleId, nextStepTitleId,
                nextAction, preflightExact, preparation, destination,
                packageReceipt, rebootPreview, showReboot, savedWork,
                manualPreview, showManual, manualConfirmed,
                configurationRebootPreview, showConfigurationReboot,
                guardedConfigConfirmed, configRecommendation,
                recommendationStatus, recommendationError, workflowReceipt,
                barEvidence, installation, backup, launch, busyAction, activity,
                legacyAnalysisValid, selectedLegacyEntries, selectedLegacyRisks,
                acknowledgementHash, missingLegacyRisk, legacyReady,
                legacyNextAction,
        } = view;
        const rebootDialog = useRef<HTMLDivElement>(null);
        const rebootButton = useRef<HTMLButtonElement>(null);
        useEffect(() => {
                if (!(showReboot || showManual || showConfigurationReboot)) return;
                const previous = document.activeElement as HTMLElement | null;
                const keydown = (event: KeyboardEvent) => {
                        if (event.key === "Escape") {
                                void session.dispatch({ type: "closeModals" });
                                return;
                        }
                        if (event.key !== "Tab" || !rebootDialog.current) return;
                        const focusable = [...rebootDialog.current.querySelectorAll<HTMLElement>(
                                "button:not([disabled]), input:not([disabled])",
                        )];
                        const first = focusable[0], last = focusable.at(-1);
                        if (event.shiftKey && document.activeElement === first && last) {
                                event.preventDefault(); last.focus();
                        } else if (!event.shiftKey && document.activeElement === last && first) {
                                event.preventDefault(); first.focus();
                        }
                };
                addEventListener("keydown", keydown);
                return () => {
                        removeEventListener("keydown", keydown);
                        (rebootButton.current ?? previous)?.focus();
                };
        }, [session, showReboot, showManual, showConfigurationReboot]);
        const send = (intent: DeploymentWorkspaceIntent) => void session.dispatch(intent);
        const setDisplayName = (value: string) => send({ type: "setDisplayName", value });
        const setBoardPath = (value: BoardPath) => send({ type: "setBoardPath", value });
        const setFirmwarePath = (value: string) => send({ type: "setFirmwarePath", value });
        const setRecoveryMethod = (value: RecoveryMethod) => send({ type: "setRecoveryMethod", value });
        const setInstallMethod = (value: FirmwareInstallMethod) => send({ type: "setInstallMethod", value });
        const setInstructionsUrl = (value: string) => send({ type: "setInstructionsUrl", value });
        const setRecoveryNote = (value: string) => send({ type: "setRecoveryNote", value });
        const setInstallNote = (value: string) => send({ type: "setInstallNote", value });
        const setRouteConfirmed = (value: boolean) => send({ type: "setRouteConfirmed", value });
        const setDestination = (value: string) => send({ type: "setDestination", value });
        const setSavedWork = (value: boolean) => send({ type: "setSavedWork", value });
        const setManualConfirmed = (value: boolean) => send({ type: "setManualConfirmed", value });
        const setGuardedConfigConfirmed = (value: boolean) => send({ type: "setGuardedConfigConfirmed", value });
        const setSelectedProfileId = (value: string) => send({ type: "setSelectedProfile", value });
        const toggleLegacyRule = (key: string, checked: boolean) => send({ type: "toggleLegacyRule", key, checked });
        const setLegacyRiskNote = (risk: LegacyPatchRisk, note: string) => send({ type: "setLegacyRiskNote", risk, note });
        const setLegacyRiskConfirmed = (risk: LegacyPatchRisk, confirmed: boolean) => send({ type: "setLegacyRiskConfirmed", risk, confirmed });
        const setShowReboot = (value: boolean) => { if (!value) send({ type: "closeModals" }); };
        const setShowManual = setShowReboot;
        const setShowConfigurationReboot = setShowReboot;
        const msi = usesMsiProZ690Route(snapshot);
        const stepCompleted = (stepId: string) =>
                plan?.steps.find((step) => step.id === stepId)?.state === "completed";
        const chooseFirmware = () => send({ type: "chooseFirmware" });
        const inspectManualPath = () => send({ type: "inspectFirmware" });
        const analyzeLegacy = () => send({ type: "analyzeLegacy" });
        const createProfile = () => send({ type: "createProfile" });
        const compare = () => send({ type: "compare" });
        const prepare = () => send({ type: "prepare" });
        const chooseDestination = () => send({ type: "chooseDestination" });
        const exportPackage = () => send({ type: "exportPackage" });
        const previewReboot = () => send({ type: "previewFirmwareReboot" });
        const reboot = () => send({ type: "requestFirmwareReboot" });
        const openManualConfirmation = () => send({ type: "openManual" });
        const confirmManual = () => send({ type: "confirmManual" });
        const verifyDriver = () => send({ type: "verifyDriver" });
        const saveGuardedConfig = () => send({ type: "saveGuardedConfig" });
        const openConfigurationReboot = () => send({ type: "openConfigurationReboot" });
        const requestConfigurationReboot = () => send({ type: "requestConfigurationReboot" });
        const verifyConfigurationBoot = () => send({ type: "verifyConfigurationBoot" });
        const collectBar = () => send({ type: "collectBar" });
        const installInspector = () => send({ type: "installInspector" });
        const backupProfiles = () => send({ type: "backupProfiles" });
        const launchInspector = () => send({ type: "launchInspector" });
        const activeAction = () => {
                if (nextAction === "complete")
                        return (
                                <div className="workflow-complete" role="status">
                                        <strong>{t("ui.deploymentPlanComplete")}</strong>
                                        <span>{t("ui.noRemainingSteps")}</span>
                                </div>
                        );
                switch (nextAction) {
                        case "prepare":
                                return (
                                        <button
                                                className="primary"
                                                onClick={prepare}
                                                disabled={Boolean(busyAction)}
                                        >{t("ui.prepareAndInspectFirmwareArtifact")}</button>
                                );
                        case "manual":
                                return (
                                        <div className="workflow-actions">
                                                <button
                                                        ref={rebootButton}
                                                        className="quiet"
                                                        onClick={previewReboot}
                                                        disabled={Boolean(busyAction)}
                                                >{t("ui.reviewRestartToFirmwareUi")}</button>
                                                <button
                                                        className="primary danger-button"
                                                        onClick={openManualConfirmation}
                                                        disabled={Boolean(busyAction)}
                                                >{t("ui.reviewConfirmCompletedStep")}</button>
                                        </div>
                                );
                        case "verifyDriver":
                                return (
                                        <button
                                                className="primary"
                                                onClick={verifyDriver}
                                                disabled={Boolean(busyAction)}
                                        >{t("ui.checkCurrentBootRustDxeStatus")}</button>
                                );
                        case "writeConfig":
                                return (
                                        <div className="guarded-config">
                                                {recommendationStatus === "pending" && (
                                                        <p role="status">{t("ui.loadingRecommendedConfiguration")}</p>
                                                )}
                                                {recommendationStatus === "error" && (
                                                        <p className="blocked-copy" role="alert">
                                                                {recommendationError &&
                                                                        translateMessage(locale, recommendationError)}{" "}
                                                                {t("ui.useConfigureOrReloadThisProfileAndTryAgain")}
                                                        </p>
                                                )}
                                                {configRecommendation && recommendationStatus === "ready" && (
                                                        <div className="recommended-config">
                                                                <strong>{t("ui.recommendedDeploymentConfiguration")}</strong>
                                                                <dl className="recommendation-facts">
                                                                        <div><dt>{t("ui.turingGpus")}</dt><dd>{configRecommendation.value.turingGpuCount}</dd></div>
                                                                        <div><dt>{t("ui.registryManaged")}</dt><dd>{configRecommendation.value.registryManagedGpuCount}</dd></div>
                                                                        <div><dt>{t("ui.locationSpecificFallbackRules")}</dt><dd>{configRecommendation.value.exactFallbackRuleCount}</dd></div>
                                                                </dl>
                                                                <code>
                                                                        {t("ui.globalMode")} {configRecommendation.value.draft.globalMode} · {t("ui.targetSelector")} {configRecommendation.value.draft.targetPciBarSize} · {t("ui.skipS3")} {String(configRecommendation.value.draft.skipS3Resume)} · {t("ui.maskOverride")} {String(configRecommendation.value.draft.overrideBarSizeMask)} · {t("ui.setupGuard")} {String(configRecommendation.value.draft.guardSetupChanges)}
                                                                </code>
                                                                {configRecommendation.value.draft.rules.length > 0 ? (
                                                                        <ul className="recommendation-rules" aria-label={t("ui.locationSpecificFallbackRules")}>
                                                                                {configRecommendation.value.draft.rules.map((rule) => (
                                                                                        <li key={`${rule.bus}-${rule.device}-${rule.function}`}>
                                                                                                <strong>{rule.bus.toString(16).padStart(2, "0")}:{rule.device.toString(16).padStart(2, "0")}.{rule.function}</strong>
                                                                                                <span>
                                                                                                        {t("ui.fallbackRuleFact", {
                                                                                                                deviceId: rule.deviceId.toString(16).padStart(4, "0"),
                                                                                                                selector: rule.barSizeSelector ?? "—",
                                                                                                        })}
                                                                                                </span>
                                                                                        </li>
                                                                                ))}
                                                                        </ul>
                                                                ) : (
                                                                        <p>{t("ui.everyDetectedTuringGpuIsCoveredByTheBuiltInRegistryNoFallbackRuleIsAdded")}</p>
                                                                )}
                                                                <p>{t("ui.thisDraftUsesTheCurrentGpuAndPciTopologySwitchToConfigureToChooseAnotherPolicyOrSize")}</p>
                                                        </div>
                                                )}
                                                <label className="consequence-check compact-check">
                                                        <input
                                                                type="checkbox"
                                                                checked={guardedConfigConfirmed}
                                                                disabled={recommendationStatus !== "ready"}
                                                                onChange={(event) =>
                                                                        setGuardedConfigConfirmed(
                                                                                event.target.checked,
                                                                        )
                                                                }
                                                        />
                                                        <span>
                                                                <strong>{t("ui.iReviewedThisConfigurationForTheSelectedProfile")}</strong>
                                                        </span>
                                                </label>
                                                <button
                                                        className="primary"
                                                        onClick={saveGuardedConfig}
                                                        disabled={
                                                                Boolean(busyAction) ||
                                                                !guardedConfigConfirmed ||
                                                                recommendationStatus !== "ready" ||
                                                                !configRecommendation
                                                        }
                                                >{t("ui.writeConfigurationAndReadItBack")}</button>
                                        </div>
                                );
                        case "configurationReboot":
                                return (
                                        <div className="workflow-actions">
                                                <button
                                                        className="quiet"
                                                        onClick={openConfigurationReboot}
                                                        disabled={Boolean(busyAction)}
                                                >{t("ui.reviewRestartAfterConfiguration")}</button>
                                                <button
                                                        className="primary"
                                                        onClick={verifyConfigurationBoot}
                                                        disabled={Boolean(busyAction)}
                                                >{t("ui.checkWindowsBootTime")}</button>
                                        </div>
                                );
                        case "collectBar":
                                return (
                                        <button
                                                className="primary"
                                                onClick={collectBar}
                                                disabled={Boolean(busyAction)}
                                        >{t("ui.collectBar1Data")}</button>
                                );
                        case "nvidiaPolicy":
                                return (
                                        <div className="policy-step">
                                                <div className="tool-actions">
                                                        {!installation ? (
                                                                <button
                                                                        className="quiet"
                                                                        onClick={installInspector}
                                                                        disabled={Boolean(busyAction)}
                                                                >{t("ui.installProfileInspector")}</button>
                                                        ) : (
                                                                <>
                                                                        <button
                                                                                className="quiet"
                                                                                onClick={backupProfiles}
                                                                                disabled={Boolean(busyAction)}
                                                                        >{t("ui.backUpProfiles")}</button>
                                                                        <button
                                                                                className="quiet"
                                                                                onClick={launchInspector}
                                                                                disabled={Boolean(busyAction)}
                                                                        >{t("ui.backUpLaunchEditor")}</button>
                                                                </>
                                                        )}
                                                </div>
                                                <p>{t("ui.afterEditingTheNvidiaPolicyReturnHereAndRecordTheResult")}</p>
                                                <button
                                                        className="primary danger-button"
                                                        onClick={openManualConfirmation}
                                                        disabled={Boolean(busyAction)}
                                                >{t("ui.reviewConfirmAppliedNvidiaPolicy")}</button>
                                        </div>
                                );
                        default:
                                return (
                                        <p className="blocked-copy" role="alert">{t("ui.completeThisStepInItsOwningToolThenReloadThePlanUseConfigureForConfigurationChanges")}</p>
                                );
                }
        };

        return (
                <div className="deployment-shell">
                        <aside className="deployment-rail" aria-label={t("ui.deploymentStatus")}>
                                <span className="kicker">{t("ui.deploymentProfile")}</span>
                                <h2>{selectedProfile?.displayName ?? t("ui.noProfileYet")}</h2>
                                {selectedProfile ? (
                                        <>
                                                <StatusLine
                                                        label={t("ui.hardwareCheck")}
                                                        state={
                                                                preflightExact === false
                                                                        ? "bad"
                                                                        : stepCompleted("verifyProfile") ||
                                                                            preflightExact === true
                                                                          ? "ok"
                                                                          : "idle"
                                                        }
                                                />
                                                <StatusLine
                                                        label={t("ui.artifactPrepared")}
                                                        state={
                                                                stepCompleted("verifyPatchedArtifact")
                                                                        ? "ok"
                                                                        : "idle"
                                                        }
                                                />
                                                <StatusLine
                                                        label={t("ui.packageExported")}
                                                        state={
                                                                packageReceipt
                                                                        ? "ok"
                                                                        : "idle"
                                                        }
                                                />
                                                <StatusLine
                                                        label={t("ui.bar1Observed")}
                                                        state={
                                                                stepCompleted("verifyResizableBar")
                                                                        ? "ok"
                                                                        : "idle"
                                                        }
                                                />
                                                <hr />
                                                <dl>
                                                        <dt>{t("ui.activeGate")}</dt>
                                                        <dd>
                                                                {activeStep
                                                                        ? t(activeStepTitleId!)
                                                                        : t("ui.noReadyStep")}
                                                        </dd>
                                                </dl>
                                        </>
                                ) : (
                                        <p className="muted-copy">{t("ui.selectASourceImageAndCreateAProfileForThisComputerFirst")}</p>
                                )}
                                {nextStep && (
                                        <div className="rail-note safety-note">
                                                <strong>{t("ui.nextStep")}</strong>
                                                <p>{t(nextStepTitleId!)}</p>
                                        </div>
                                )}
                        </aside>

                        <main className="deployment-content">
                                <section className="deployment-intro">
                                        <div>
                                                <span className="kicker">{t("ui.currentHardwarePreparedFiles")}</span>
                                                <h2>{t("ui.firmwarePreparationAndInstallation")}</h2>
                                                <p>{t("ui.prepareAndInspectFirmwareFilesHereFlashThePreparedImageWithTheVendorToolThenReturnToRecordTheResult")}</p>
                                        </div>
                                        <div className="truth-badge">
                                                <strong>{t("ui.flashWithVendorTool")}</strong>
                                                <span>{t("ui.useThePreparedImage")}</span>
                                        </div>
                                </section>

                                {activity && (
                                        <div
                                                className={`notice ${activity.tone}`}
                                                role={
                                                        activity.tone === "error"
                                                                ? "alert"
                                                                : "status"
                                                }
                                                >
                                                        <span>{translateMessage(locale, activity.message)}</span>
                                        </div>
                                )}

                                <section className="journey-panel" aria-labelledby="source-title">
                                        <JourneyHeading
                                                number="01"
                                                title={t("ui.sourceImageAndRecoveryFiles")}
                                                id="source-title"
                                                copy={t("ui.selectTheVendorImageInspectItsSizeAndSha256AndRecordTheInstallationAndRecoveryInstructions")}
                                        />
                                        {msi && (
                                                <div className="detected-route">
                                                        <strong>MSI {snapshot.machineIdentity?.boardProduct ?? t("ui.boardDetected")}</strong>
                                                        <span>{t("ui.nativeRebarMFlashAndFlashBiosButtonDefaultsArePrefilledFromTheOfficialManualConfirmThemBelow")}</span>
                                                </div>
                                        )}
                                        <div className="form-grid">
                                                <label className="field span-2">
                                                        <span>{t("ui.profileName")}</span>
                                                        <input
                                                                value={displayName}
                                                                onChange={(event) =>
                                                                        setDisplayName(
                                                                                event.target.value,
                                                                        )
                                                                }
                                                        />
                                                </label>
                                                <label className="field span-2">
                                                        <span>{t("ui.selectedFirmwareImage")}</span>
                                                        <div className="path-control">
                                                                <input
                                                                        value={firmwarePath}
                                                                        placeholder={t("ui.chooseAVendorBiosImageOrEnterAnAbsolutePath")}
                                                onChange={(event) => {
                                                                                setFirmwarePath(
                                                                                        event.target.value,
                                                                                );
                                                                        }}
                                                                />
                                                                <button
                                                                        onClick={chooseFirmware}
                                                                        disabled={Boolean(busyAction)}
                                                                >{t("ui.chooseFile")}</button>
                                                                <button
                                                                        className="quiet"
                                                                        onClick={inspectManualPath}
                                                                        disabled={
                                                                                Boolean(busyAction) ||
                                                                                !firmwarePath ||
                                                                                Boolean(firmware)
                                                                        }
                                                                >{t("ui.inspect")}</button>
                                                        </div>
                                                        {firmware && (
                                                                <small className="verified-line">
                                                                        {firmware.fileName} · {Math.round(
                                                                                firmware.byteLength /
                                                                                        1048576,
                                                                        )}{" "}
                                                                        MiB · SHA-256 {shortHash(
                                                                                firmware.sha256,
                                                                        )}
                                                                </small>
                                                        )}
                                                </label>
                                                <label className="field">
                                                        <span>{t("ui.boardPath")}</span>
                                                        <select
                                                                value={boardPath}
                                                                onChange={(event) => {
                                                                        setBoardPath(
                                                                                event.target.value as BoardPath,
                                                                        );
                                                                }}
                                                        >
                                                                <option value="nativeResizableBar">{t("ui.nativeResizableBar")}</option>
                                                                <option value="legacyAbove4g">{t("ui.legacyAbove4g")}</option>
                                                        </select>
                                                </label>
                                                <label className="field">
                                                        <span>{t("ui.vendorInstallRoute")}</span>
                                                        <select
                                                                value={installMethod}
                                                                onChange={(event) =>
                                                                        setInstallMethod(
                                                                                event.target.value as FirmwareInstallMethod,
                                                                        )
                                                                }
                                                        >
                                                                <option value="firmwareSetupUtility">{t("ui.firmwareSetupUtility")}</option>
                                                                <option value="usbFlashback">{t("ui.usbFlashback")}</option>
                                                                <option value="vendorWindowsUtility">{t("ui.vendorWindowsUtility")}</option>
                                                                <option value="externalSpiProgrammer">{t("ui.externalSpiProgrammer")}</option>
                                                        </select>
                                                </label>
                                                <label className="field">
                                                        <span>{t("ui.recoveryRoute")}</span>
                                                        <select
                                                                value={recoveryMethod}
                                                                onChange={(event) =>
                                                                        setRecoveryMethod(
                                                                                event.target.value as RecoveryMethod,
                                                                        )
                                                                }
                                                        >
                                                                <option value="usbFlashback">{t("ui.usbFlashback")}</option>
                                                                <option value="dualBios">{t("ui.dualBios")}</option>
                                                                <option value="vendorRecovery">{t("ui.vendorRecovery")}</option>
                                                                <option value="externalSpiProgrammer">{t("ui.externalSpiProgrammer")}</option>
                                                                <option value="none">{t("ui.noneProfileWillBeRefused")}</option>
                                                        </select>
                                                </label>
                                                <label className="field">
                                                        <span>{t("ui.officialInstructionsUrl")}</span>
                                                        <input
                                                                type="url"
                                                                value={instructionsUrl}
                                                                onChange={(event) =>
                                                                        setInstructionsUrl(
                                                                                event.target.value,
                                                                        )
                                                                }
                                                        />
                                                </label>
                                                <label className="field span-2">
                                                        <span>{t("ui.installHandoffNote")}</span>
                                                        <input
                                                                value={
                                                                        installNotePresetId
                                                                                ? t(installNotePresetId)
                                                                                : installNote
                                                                }
                                                                onChange={(event) =>
                                                                        setInstallNote(
                                                                                event.target.value,
                                                                        )
                                                                }
                                                        />
                                                </label>
                                                <label className="field span-2">
                                                        <span>{t("ui.recoveryNote")}</span>
                                                        <input
                                                                value={
                                                                        recoveryNotePresetId
                                                                                ? t(recoveryNotePresetId)
                                                                                : recoveryNote
                                                                }
                                                                onChange={(event) =>
                                                                        setRecoveryNote(
                                                                                event.target.value,
                                                                        )
                                                                }
                                                        />
                                                </label>
                                        </div>
                                        {boardPath === "legacyAbove4g" && (
                                                <div
                                                        className="legacy-analysis"
                                                        aria-labelledby="legacy-analysis-title"
                                                >
                                                        <div className="legacy-analysis-head">
                                                                <div>
                                                                        <span className="step">{t("ui.readOnly")}</span>
                                                                        <h4 id="legacy-analysis-title">{t("ui.legacyPatchAnalysis")}</h4>
                                                                        <p>{t("ui.theRustAnalyzerReportsMatchCountsForTheSelectedSourceImage")}</p>
                                                                </div>
                                                                <button
                                                                        type="button"
                                                                        onClick={() => void analyzeLegacy()}
                                                                        disabled={
                                                                                Boolean(busyAction) ||
                                                                                !firmware
                                                                        }
                                                                >
                                                                        {legacyAnalysisStatus ===
                                                                        "pending"
                                                                                ? t("ui.analyzingImage")
                                                                                : legacyAnalysisValid
                                                                                  ? t("ui.analyzeAgain")
                                                                                  : t("ui.analyzeImage")}
                                                                </button>
                                                        </div>
                                                        <p
                                                                className={`legacy-next-action ${legacyReady ? "ready" : "blocked"}`}
                                                                role="status"
                                                                aria-live="polite"
                                                        >
                                                                {legacyNextAction &&
                                                                        translateMessage(locale, legacyNextAction)}
                                                        </p>
                                                        {legacyAnalysis &&
                                                                legacyAnalysisValid && (
                                                                        <div className="legacy-results">
                                                                                <div className="legacy-fingerprint">
                                                                                        <span>{t("ui.analyzedSource")}</span>
                                                                                        <strong>
                                                                                                {legacyAnalysis.value.firmware.fileName} · {Math.round(legacyAnalysis.value.firmware.byteLength / 1048576)} MiB
                                                                                        </strong>
                                                                                        <small className="mono-wrap">
                                                                                                SHA-256 {legacyAnalysis.value.firmware.sha256}
                                                                                        </small>
                                                                                </div>
                                                                                {legacyAnalysis.value.catalogs.map(
                                                                                        (catalog) => {
                                                                                                const applicable =
                                                                                                        catalog.rules.filter(
                                                                                                                (rule) =>
                                                                                                                        rule.status ===
                                                                                                                        "applicable",
                                                                                                        );
                                                                                                const absent =
                                                                                                        catalog.rules.filter(
                                                                                                                (rule) =>
                                                                                                                        rule.status ===
                                                                                                                        "absent",
                                                                                                        );
                                                                                                const blocked =
                                                                                                        catalog.rules.filter(
                                                                                                                (rule) =>
                                                                                                                        rule.status ===
                                                                                                                        "blocked",
                                                                                                        );
                                                                                                return (
                                                                                                        <section
                                                                                                                className="legacy-catalog"
                                                                                                                key={catalog.catalog}
                                                                                                                aria-labelledby={`catalog-${catalog.catalog}`}
                                                                                                        >
                                                                                                                <div className="legacy-catalog-head">
                                                                                                                        <div>
                                                                                                                                <h5 id={`catalog-${catalog.catalog}`}>
                                                                                                                                        {t(catalogLabelIds[catalog.catalog])}
                                                                                                                                </h5>
                                                                                                                                <small>
                                                                                                                                        {n(applicable.length)} {t("ui.applicable")} · {n(absent.length)} {t("ui.absent")} · {n(blocked.length)} {t("ui.blockedState")}
                                                                                                                                </small>
                                                                                                                        </div>
                                                                                                                        <span className="mono-wrap">
                                                                                                                                {t("ui.source")} {shortHash(catalog.sourceSha256)}
                                                                                                                        </span>
                                                                                                                </div>
                                                                                                                {applicable.length >
                                                                                                                0 ? (
                                                                                                                        <div className="legacy-rule-list">
                                                                                                                                {applicable.map(
                                                                                                                                        (rule) => {
                                                                                                                                                const key =
                                                                                                                                                        legacyRuleKey(
                                                                                                                                                                catalog.catalog,
                                                                                                                                                                rule.ruleId,
                                                                                                                                                        );
                                                                                                                                                return (
                                                                                                                                                        <label
                                                                                                                                                                className="legacy-rule"
                                                                                                                                                                key={rule.ruleId}
                                                                                                                                                        >
                                                                                                                                                                <input
                                                                                                                                                                        type="checkbox"
                                                                                                                                                                        checked={selectedLegacyRules.includes(
                                                                                                                                                                                key,
                                                                                                                                                                        )}
                                                                                                                                                                        onChange={(event) =>
                                                                                                                                                                                toggleLegacyRule(
                                                                                                                                                                                        key,
                                                                                                                                                                                        event.target.checked,
                                                                                                                                                                                )
                                                                                                                                                                        }
                                                                                                                                                                />
                                                                                                                                                                <span>
                                                                                                                                                                        <strong>
                                                                                                                                                                                {t(legacyRuleDescriptionId(rule.ruleId))}
                                                                                                                                                                        </strong>
                                                                                                                                                                        <small>
                                                                                                                                                                                {exactMatches(rule.expectedMatches!)} · {t("ui.section")} 0x{rule.sectionType.toString(16).padStart(2, "0")}
                                                                                                                                                                        </small>
                                                                                                                                                                        {rule.requiredRisks.length >
                                                                                                                                                                                0 && (
                                                                                                                                                                                <em>
                                                                                                                                                                                        {t("ui.requires")} {rule.requiredRisks.map((risk) => t(riskLabelIds[risk])).join(" · ")}
                                                                                                                                                                                </em>
                                                                                                                                                                        )}
                                                                                                                                                                </span>
                                                                                                                                                                {rule.recommended && (
                                                                                                                                                                        <b>{t("ui.recommended")}</b>
                                                                                                                                                                )}
                                                                                                                                                        </label>
                                                                                                                                                );
                                                                                                                                        },
                                                                                                                                )}
                                                                                                                        </div>
                                                                                                                ) : (
                                                                                                                        <p className="legacy-empty">{t("ui.noApplicableRulesInThisCatalog")}</p>
                                                                                                                )}
                                                                                                                {absent.length > 0 && (
                                                                                                                        <p className="legacy-absent">
                                                                                                                                {absentRules(absent.length)}
                                                                                                                        </p>
                                                                                                                )}
                                                                                                                {blocked.map(
                                                                                                                        (rule) => (
                                                                                                                                <div
                                                                                                                                        className="legacy-blocked-rule"
                                                                                                                                        key={rule.ruleId}
                                                                                                                                >
                                                                                                                                        <strong>
                                                                                                                                                {t("ui.blocked")} · {t(legacyRuleDescriptionId(rule.ruleId))}
                                                                                                                                        </strong>
                                                                                                                                        <span>
                                                                                                                                                {t(legacyRuleBlockedReasonId(rule.ruleId))}
                                                                                                                                        </span>
                                                                                                                                </div>
                                                                                                                        ),
                                                                                                                )}
                                                                                                        </section>
                                                                                                );
                                                                                        },
                                                                                )}
                                                                                {selectedLegacyRisks.length >
                                                                                        0 && (
                                                                                        <section
                                                                                                className="legacy-risk-panel"
                                                                                                aria-labelledby="legacy-risk-title"
                                                                                        >
                                                                                                <h5 id="legacy-risk-title">{t("ui.explicitRiskAcknowledgements")}</h5>
                                                                                                <p>
                                                                                                        {t("ui.forEachSelectedRiskDescribeThisImageAndIncludeFingerprint")} <code>{acknowledgementHash}</code>. {t("ui.includeTheImageSpecificConsequence")}
                                                                                                </p>
                                                                                                {selectedLegacyRisks.map(
                                                                                                        (risk) => {
                                                                                                                const acknowledgement =
                                                                                                                        legacyAcknowledgements[
                                                                                                                                risk
                                                                                                                        ];
                                                                                                                const noteId = `risk-${risk}-note`;
                                                                                                                return (
                                                                                                                        <div
                                                                                                                                className="legacy-risk"
                                                                                                                                key={risk}
                                                                                                                        >
                                                                                                                                <label htmlFor={noteId}>
                                                                                                                                        <strong>
                                                                                                                                                {t(riskLabelIds[risk])}
                                                                                                                                        </strong>
                                                                                                                                        <span>{t("ui.imageSpecificAcknowledgementNote")}</span>
                                                                                                                                </label>
                                                                                                                                <textarea
                                                                                                                                        id={noteId}
                                                                                                                                        value={acknowledgement?.note ?? ""}
                                                                                                                                        onChange={(event) =>
                                                                                                                                                setLegacyRiskNote(
                                                                                                                                                        risk,
                                                                                                                                                        event.target.value,
                                                                                                                                                )
                                                                                                                                        }
                                                                                                                                        placeholder={`Describe the consequence for image ${acknowledgementHash}`}
                                                                                                                                />
                                                                                                                                <label className="consequence-check compact-check">
                                                                                                                                        <input
                                                                                                                                                type="checkbox"
                                                                                                                                                checked={acknowledgement?.confirmed ?? false}
                                                                                                                                                onChange={(event) =>
                                                                                                                                                        setLegacyRiskConfirmed(
                                                                                                                                                                risk,
                                                                                                                                                                event.target.checked,
                                                                                                                                                        )
                                                                                                                                                }
                                                                                                                                        />
                                                                                                                                        <span>
                                                                                                                                                <strong>{t("ui.iReviewedThisRiskForTheAnalyzedFirmware")}</strong>
                                                                                                                                        </span>
                                                                                                                                </label>
                                                                                                                        </div>
                                                                                                                );
                                                                                                        },
                                                                                                )}
                                                                                        </section>
                                                                                )}
                                                                        </div>
                                                                )}
                                                </div>
                                        )}
                                        <label className="consequence-check">
                                                <input
                                                        type="checkbox"
                                                        checked={routeConfirmed}
                                                        onChange={(event) =>
                                                                setRouteConfirmed(
                                                                        event.target.checked,
                                                                )
                                                        }
                                                />
                                                <span>
                                                        <strong>{t("ui.iCheckedTheVendorInstallAndRecoveryInstructionsForThisBoard")}</strong>
                                                        <small>{t("ui.thisRecordsTheSelectedInstallationAndRecoveryInstructions")}</small>
                                                </span>
                                        </label>
                                        <div className="panel-actions">
                                                <button
                                                        className="primary"
                                                        disabled={
                                                                Boolean(busyAction) ||
                                                                !firmware ||
                                                                !displayName.trim() ||
                                                                !instructionsUrl.startsWith(
                                                                        "https://",
                                                                ) ||
                                                                !installNote.trim() ||
                                                                !recoveryNote.trim() ||
                                                                !routeConfirmed ||
                                                                !legacyReady
                                                        }
                                                        onClick={createProfile}
                                                >
                                                        {busyAction === "profile"
                                                                ? t("ui.creatingProfile")
                                                                : t("ui.createProfileForThisComputer")}
                                                </button>
                                        </div>
                                </section>

                                <section className="journey-panel" aria-labelledby="artifact-title">
                                        <JourneyHeading
                                                number="02"
                                                title={t("ui.checkExport")}
                                                id="artifact-title"
                                                copy={t("ui.compareTheCurrentHardwareAndSourceImagePrepareTheRustFirmwareArtifactAndExportThePackage")}
                                        />
                                        <label className="field profile-select">
                                                <span>{t("ui.machineProfile")}</span>
                                                <select
                                                        value={selectedProfileId}
                                                        disabled={Boolean(busyAction)}
                                                        onChange={(event) =>
                                                                setSelectedProfileId(event.target.value)
                                                        }
                                                >
                                                        {!profiles.length && (
                                                                <option value="">{t("ui.noStoredProfiles")}</option>
                                                        )}
                                                        {profiles.map((profile) => (
                                                                <option
                                                                        key={profile.profileId}
                                                                        value={profile.profileId}
                                                                >
                                                                        {profile.displayName}
                                                                </option>
                                                        ))}
                                                </select>
                                        </label>
                                        {plan && (
                                                <div className="active-workflow" aria-live="polite">
                                                        <div className="active-workflow-head">
                                                                <div>
                                                                        <span className="step">{t("ui.activeStep")}</span>
                                                                        <h4>
                                                                                {activeStepTitleId ? t(activeStepTitleId) : t("ui.deploymentComplete")}
                                                                        </h4>
                                                                        <p>
                                                                                {activeStep
                                                                                        ? t("ui.completeTheActiveStepToContinue")
                                                                                        : t("ui.noRemainingSteps")}
                                                                        </p>
                                                                </div>
                                                                <strong>
                                                                        {plan.steps.filter((step) => step.state === "completed").length}/{plan.steps.length}
                                                                </strong>
                                                        </div>
                                                        <div className="active-workflow-action">
                                                                {activeAction()}
                                                        </div>
                                                        {workflowReceipt && (
                                                                <div className="workflow-receipt" role="status">
                                                                        <strong>{translateMessage(locale, workflowReceipt.title)}</strong>
                                                                        <span>{translateMessage(locale, workflowReceipt.detail)}</span>
                                                                </div>
                                                        )}
                                                        {barEvidence && (
                                                                <div className="workflow-receipt" role="status">
                                                                        <strong>{barEvidence.gpus[0]?.productName}</strong>
                                                                        <span>
                                                                                BAR1 {barEvidence.gpus[0]?.bar1TotalBytes ? `${Math.round(Number(barEvidence.gpus[0].bar1TotalBytes) / 1073741824)} GiB` : "unavailable"} · Driver {barEvidence.driverVersion}
                                                                        </span>
                                                                </div>
                                                        )}
                                                        {installation && activeStep?.id === "configureNvidiaApplications" && (
                                                                <div className="workflow-receipt">
                                                                        <strong>
                                                                                {t("ui.profileInspectorVersionInstalled", {
                                                                                        version: installation.manifest.version,
                                                                                })}
                                                                        </strong>
                                                                        <span>{t("ui.nextApplyTheNvidiaPolicyThenRecordTheResult")}</span>
                                                                </div>
                                                        )}
                                                        {backup && activeStep?.id === "configureNvidiaApplications" && (
                                                                <small className="verified-line mono-wrap">
                                                                        {t("ui.profileBackup")}: {backup.backupPath}
                                                                </small>
                                                        )}
                                                        {launch && activeStep?.id === "configureNvidiaApplications" && (
                                                                <small className="verified-line">
                                                                        {t("ui.editorProcessLaunched", {
                                                                                processId: launch.processId,
                                                                        })}
                                                                </small>
                                                        )}
                                                </div>
                                        )}
                                        {plan && (
                                                <ol className="plan-list" aria-label={t("ui.deploymentPlan")}>
                                                        {plan.steps.map((step) => (
                                                                <li
                                                                        key={step.id}
                                                                        className={`plan-step ${step.state}`}
                                                                >
                                                                        <i aria-hidden="true" />
                                                                        <div>
                                                                                <strong>{t(stepTitleIds[step.id])}</strong>
                                                                                <span>
                                                                                        {t(stepKindIds[step.kind])}
                                                                                </span>
                                                                        </div>
                                                                        <b>{t(stepStateIds[step.state])}</b>
                                                                </li>
                                                        ))}
                                                </ol>
                                        )}
                                        <div className="action-row">
                                                <button
                                                        onClick={compare}
                                                        disabled={Boolean(busyAction) || !selectedProfileId}
                                                >{t("ui.checkCurrentHardwareAndSourceImage")}</button>
                                        </div>
                                        {preparation?.patchedFirmware && (
                                                <div className="artifact-receipt" role="status">
                                                        <strong>{t("ui.preparedFirmwareArtifact")}</strong>
                                                        <span>
                                                                {n(preparation.patchedFirmware.byteLength)} {t("ui.bytes")} · SHA-256 {shortHash(preparation.patchedFirmware.sha256)}
                                                        </span>
                                                        <small>{t("ui.nextExportThisArtifactForTheVendorTool")}</small>
                                                </div>
                                        )}
                                        <div className="path-control export-control">
                                                <input
                                                        aria-label={t("ui.deploymentPackageDestination")}
                                                        value={destination}
                                                        placeholder={t("ui.chooseAnEmptyDestinationFolder")}
                                                        onChange={(event) =>
                                                                setDestination(event.target.value)
                                                        }
                                                />
                                                <button
                                                        className="quiet"
                                                        onClick={chooseDestination}
                                                        disabled={Boolean(busyAction)}
                                                >{t("ui.chooseFolder")}</button>
                                                <button
                                                        className="primary"
                                                        onClick={exportPackage}
                                                        disabled={
                                                                Boolean(busyAction) ||
                                                                plan?.steps.find((step) => step.id === "verifyPatchedArtifact")?.state !== "completed" ||
                                                                !destination
                                                        }
                                                >{t("ui.exportPackage")}</button>
                                        </div>
                                        {packageReceipt && (
                                                <div className="artifact-receipt" role="status">
                                                        <strong>{t("ui.packageExportedManualHandoffNext")}</strong>
                                                        <span className="mono-wrap">{packageReceipt.packagePath}</span>
                                                        <small>
                                                                {packageReceipt.manifest.files.length} files · manifest SHA-256 {shortHash(packageReceipt.manifestSha256)}
                                                        </small>
                                                </div>
                                        )}
                                </section>

                                <section className="journey-panel" aria-labelledby="firmware-title">
                                        <JourneyHeading
                                                number="03"
                                                title={t("ui.stepsCompletedOutsideThisApp")}
                                                id="firmware-title"
                                                copy={t("ui.useTheVendorToolForFlashingSetFirmwareValuesInTheFirmwareScreenThenReturnToContinueThePlan")}
                                        />
                                        <div className="manual-gates">
                                                <div>
                                                        <span>{t("ui.manual")}</span>
                                                        <strong>{t("ui.vendorFlash")}</strong>
                                                        <p>{t("ui.selectTheExportedArtifactInTheDocumentedVendorUtilityKeepPowerStable")}</p>
                                                </div>
                                                <div>
                                                        <span>{t("ui.physical")}</span>
                                                        <strong>{t("ui.recoveryFiles")}</strong>
                                                        <p>{t("ui.keepTheSelectedRecoveryRouteAndOriginalImageAvailableBeforeFlashing")}</p>
                                                </div>
                                                <div>
                                                        <span>{t("ui.manual")}</span>
                                                        <strong>{t("ui.uefiValues")}</strong>
                                                        <p>{t("ui.setAbove4gDecodingAndResizableBarInTheFirmwareScreen")}</p>
                                                </div>
                                        </div>
                                </section>
                        </main>

                        {showReboot && rebootPreview && (
                                <div className="modal-backdrop" role="presentation">
                                        <div
                                                ref={rebootDialog}
                                                className="modal reboot-modal"
                                                role="dialog"
                                                aria-modal="true"
                                                aria-labelledby="reboot-title"
                                        >
                                                <span className="kicker">{t("ui.immediateRestart")}</span>
                                                <h2 id="reboot-title">{t("ui.restartWindowsIntoFirmwareSetup")}</h2>
                                                <p>
                                                        {t("ui.thisSends")} <code>{rebootPreview.command} {rebootPreview.arguments.join(" ")}</code>. {t("ui.windowsOpensTheFirmwareSetupScreenContinueThereWithTheVendorInstructions")}
                                                </p>
                                                <div className="warning-box">
                                                        {firmwareRebootWarningIds.map((warningId) => (
                                                                <span key={warningId}>{t(warningId)}</span>
                                                        ))}
                                                </div>
                                                <label className="consequence-check">
                                                        <input
                                                                autoFocus
                                                                type="checkbox"
                                                                checked={savedWork}
                                                                onChange={(event) => setSavedWork(event.target.checked)}
                                                        />
                                                        <span>
                                                                <strong>{t("ui.iSavedAndClosedMyWork")}</strong>
                                                                <small>{t("ui.windowsRestartsImmediatelySaveAndCloseYourWorkFirst")}</small>
                                                        </span>
                                                </label>
                                                <div className="modal-actions">
                                                        <button className="quiet" onClick={() => setShowReboot(false)}>{t("ui.cancel")}</button>
                                                        <button
                                                                className="primary danger-button"
                                                                disabled={!savedWork}
                                                                onClick={reboot}
                                                        >{t("ui.restartToFirmwareUi")}</button>
                                                </div>
                                        </div>
                                </div>
                        )}
                        {showManual && manualPreview && (
                                <div className="modal-backdrop" role="presentation">
                                        <div
                                                ref={rebootDialog}
                                                className="modal reboot-modal"
                                                role="dialog"
                                                aria-modal="true"
                                                aria-labelledby="manual-confirm-title"
                                        >
                                                <span className="kicker">{t("ui.recordCompletedStepKicker")}</span>
                                                <h2 id="manual-confirm-title">
                                                        {t(stepTitleIds[manualPreview.stepId])}
                                                </h2>
                                                <p>{t("ui.reviewTheResultInTheOwningToolThenRecordThisStep")}</p>
                                                <div className="warning-box">
                                                        {manualWarningIds(
                                                                manualPreview.stepId,
                                                                boardPath === "legacyAbove4g",
                                                        ).map((warningId) => (
                                                                <span key={warningId}>{t(warningId)}</span>
                                                        ))}
                                                </div>
                                                <label className="consequence-check">
                                                        <input
                                                                autoFocus
                                                                type="checkbox"
                                                                checked={manualConfirmed}
                                                                onChange={(event) =>
                                                                        setManualConfirmed(
                                                                                event.target.checked,
                                                                        )
                                                                }
                                                        />
                                                        <span>
                                                                <strong>{t("ui.iCompletedThisStepAndReviewedTheResult")}</strong>
                                                        </span>
                                                </label>
                                                <div className="modal-actions">
                                                        <button className="quiet" onClick={() => setShowManual(false)}>{t("ui.cancel")}</button>
                                                        <button
                                                                className="primary danger-button"
                                                                disabled={!manualConfirmed || Boolean(busyAction)}
                                                                onClick={confirmManual}
                                                        >{t("ui.recordCompletedStep")}</button>
                                                </div>
                                        </div>
                                </div>
                        )}
                        {showConfigurationReboot && configurationRebootPreview && (
                                <div className="modal-backdrop" role="presentation">
                                        <div
                                                ref={rebootDialog}
                                                className="modal reboot-modal"
                                                role="dialog"
                                                aria-modal="true"
                                                aria-labelledby="configuration-reboot-title"
                                        >
                                                <span className="kicker">{t("ui.restartRequest")}</span>
                                                <h2 id="configuration-reboot-title">{t("ui.restartWindowsAfterConfiguration")}</h2>
                                                <p>
                                                        {t("ui.thisSends")} <code>{configurationRebootPreview.command} {configurationRebootPreview.arguments.join(" ")}</code>. {t("ui.returnAfterWindowsBootsSoTheAppCanCompareTheNewBootTime")}
                                                </p>
                                                <div className="warning-box">
                                                        {configurationRebootWarningIds.map((warningId) => (
                                                                <span key={warningId}>{t(warningId)}</span>
                                                        ))}
                                                </div>
                                                <label className="consequence-check">
                                                        <input
                                                                autoFocus
                                                                type="checkbox"
                                                                checked={savedWork}
                                                                onChange={(event) => setSavedWork(event.target.checked)}
                                                        />
                                                        <span>
                                                                <strong>{t("ui.iSavedAndClosedMyWork")}</strong>
                                                                <small>{t("ui.windowsRestartsImmediatelyReturnAfterWindowsBootsToContinue")}</small>
                                                        </span>
                                                </label>
                                                <div className="modal-actions">
                                                        <button className="quiet" onClick={() => setShowConfigurationReboot(false)}>{t("ui.cancel")}</button>
                                                        <button
                                                                className="primary danger-button"
                                                                disabled={!savedWork || Boolean(busyAction)}
                                                                onClick={requestConfigurationReboot}
                                                        >{t("ui.requestRestart")}</button>
                                                </div>
                                        </div>
                                </div>
                        )}
                </div>
        );
}

function StatusLine({
        label,
        state,
}: {
        label: string;
        state: "ok" | "bad" | "idle";
}) {
        return (
                <span className={`status ${state}`}>
                        <i />
                        {label}
                </span>
        );
}

function JourneyHeading({
        number,
        title,
        id,
        copy,
}: {
        number: string;
        title: string;
        id: string;
        copy: string;
}) {
        return (
                <div className="section-head journey-head">
                        <div>
                                <span className="step">{number}</span>
                                <h3 id={id}>{title}</h3>
                        </div>
                        <p>{copy}</p>
                </div>
        );
}
