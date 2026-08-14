import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { SystemSnapshot } from "./types";
import { useI18n } from "./i18n";
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

const shortHash = (value?: string) =>
        value ? `${value.slice(0, 10)}…${value.slice(-8)}` : "—";
const legacyRuleKey = (catalog: string, ruleId: string) =>
        `${catalog}:${ruleId}`;
const catalogLabels = {
        general: "General",
        haswellAbove4g: "Haswell Above 4G",
        ivyBridgeUsb3: "Ivy Bridge USB 3",
        haswellUsb3: "Haswell USB 3",
        broadwellUsb3: "Broadwell USB 3",
} as const;
const riskLabels: Record<LegacyPatchRisk, string> = {
        dsdtModification: "DSDT modification",
        nvramWhitelist: "NVRAM whitelist change",
        usbControllerBlacklist: "USB controller blacklist",
        experimentalX79: "Experimental X79 patch",
};

type Props = { snapshot: SystemSnapshot };

export function DeploymentWorkspace({ snapshot }: Props) {
        const { t, n, exactMatches, absentRules } = useI18n();
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
                routeConfirmed, legacyAnalysis, legacyAnalysisStatus,
                legacyAnalysisError, selectedLegacyRules, legacyAcknowledgements,
                profiles, selectedProfileId, selectedProfile, plan, activeStep,
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
        const setActivity = (value: null) => { if (value === null) send({ type: "dismissActivity" }); };
        const msi = snapshot.machineIdentity?.boardManufacturer === "Micro-Star International Co., Ltd." &&
                snapshot.machineIdentity.boardProduct === "PRO Z690-A DDR4(MS-7D25)" &&
                snapshot.machineIdentity.boardVersion === "1.0";
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
                                        <strong>{t("Deployment plan complete")}</strong>
                                        <span>{t("Every durable gate has a persisted receipt.")}</span>
                                </div>
                        );
                switch (nextAction) {
                        case "prepare":
                                return (
                                        <button
                                                className="primary"
                                                onClick={prepare}
                                                disabled={Boolean(busyAction)}
                                        >{t("Prepare and verify firmware artifact")}</button>
                                );
                        case "manual":
                                return (
                                        <div className="workflow-actions">
                                                <button
                                                        ref={rebootButton}
                                                        className="quiet"
                                                        onClick={previewReboot}
                                                        disabled={Boolean(busyAction)}
                                                >{t("Review restart to firmware UI")}</button>
                                                <button
                                                        className="primary danger-button"
                                                        onClick={openManualConfirmation}
                                                        disabled={Boolean(busyAction)}
                                                >{t("Review & confirm completed step")}</button>
                                        </div>
                                );
                        case "verifyDriver":
                                return (
                                        <button
                                                className="primary"
                                                onClick={verifyDriver}
                                                disabled={Boolean(busyAction)}
                                        >{t("Verify current boot + Rust DXE")}</button>
                                );
                        case "writeConfig":
                                return (
                                        <div className="guarded-config">
                                                {recommendationStatus === "pending" && (
                                                        <p role="status">{t("Loading the backend-owned recommendation for this exact profile…")}</p>
                                                )}
                                                {recommendationStatus === "error" && (
                                                        <p className="blocked-copy" role="alert">
                                                                {t(recommendationError)} {t("Use Configure or retry after reloading the exact profile.")}
                                                        </p>
                                                )}
                                                {configRecommendation && recommendationStatus === "ready" && (
                                                        <div className="recommended-config">
                                                                <strong>{t("Backend-recommended deployment configuration")}</strong>
                                                                <dl className="recommendation-facts">
                                                                        <div><dt>{t("Turing GPUs")}</dt><dd>{configRecommendation.value.turingGpuCount}</dd></div>
                                                                        <div><dt>{t("Registry managed")}</dt><dd>{configRecommendation.value.registryManagedGpuCount}</dd></div>
                                                                        <div><dt>{t("Exact fallback rules")}</dt><dd>{configRecommendation.value.exactFallbackRuleCount}</dd></div>
                                                                </dl>
                                                                <code>
                                                                        {t("global mode")} {configRecommendation.value.draft.globalMode} · {t("target selector")} {configRecommendation.value.draft.targetPciBarSize} · {t("skip S3")} {String(configRecommendation.value.draft.skipS3Resume)} · {t("mask override")} {String(configRecommendation.value.draft.overrideBarSizeMask)} · {t("setup guard")} {String(configRecommendation.value.draft.guardSetupChanges)}
                                                                </code>
                                                                {configRecommendation.value.draft.rules.length > 0 ? (
                                                                        <ul className="recommendation-rules" aria-label={t("Exact fallback rules")}>
                                                                                {configRecommendation.value.draft.rules.map((rule) => (
                                                                                        <li key={`${rule.bus}-${rule.device}-${rule.function}`}>
                                                                                                <strong>{rule.bus.toString(16).padStart(2, "0")}:{rule.device.toString(16).padStart(2, "0")}.{rule.function}</strong>
                                                                                                <span>device {rule.deviceId.toString(16).padStart(4, "0")} · BAR selector {rule.barSizeSelector} · exact location only</span>
                                                                                        </li>
                                                                                ))}
                                                                        </ul>
                                                                ) : (
                                                                        <p>{t("Every detected Turing GPU is covered by the built-in registry; no fallback rule is added.")}</p>
                                                                )}
                                                                <p>{t("This draft was generated and prevalidated by the backend for the current topology. To choose another policy or size, switch to Configure instead of confirming here.")}</p>
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
                                                                <strong>{t("I reviewed this exact backend recommendation for the selected profile.")}</strong>
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
                                                >{t("Write and verify guarded configuration")}</button>
                                        </div>
                                );
                        case "configurationReboot":
                                return (
                                        <div className="workflow-actions">
                                                <button
                                                        className="quiet"
                                                        onClick={openConfigurationReboot}
                                                        disabled={Boolean(busyAction)}
                                                >{t("Review restart after configuration")}</button>
                                                <button
                                                        className="primary"
                                                        onClick={verifyConfigurationBoot}
                                                        disabled={Boolean(busyAction)}
                                                >{t("Verify returned Windows boot")}</button>
                                        </div>
                                );
                        case "collectBar":
                                return (
                                        <button
                                                className="primary"
                                                onClick={collectBar}
                                                disabled={Boolean(busyAction)}
                                        >{t("Collect and verify BAR1 evidence")}</button>
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
                                                                >{t("Install verified Profile Inspector")}</button>
                                                        ) : (
                                                                <>
                                                                        <button
                                                                                className="quiet"
                                                                                onClick={backupProfiles}
                                                                                disabled={Boolean(busyAction)}
                                                                        >{t("Back up profiles")}</button>
                                                                        <button
                                                                                className="quiet"
                                                                                onClick={launchInspector}
                                                                                disabled={Boolean(busyAction)}
                                                                        >{t("Back up & launch editor")}</button>
                                                                </>
                                                        )}
                                                </div>
                                                <p>{t("Installing, backing up, or launching the editor does not complete policy application.")}</p>
                                                <button
                                                        className="primary danger-button"
                                                        onClick={openManualConfirmation}
                                                        disabled={Boolean(busyAction)}
                                                >{t("Review & confirm applied NVIDIA policy")}</button>
                                        </div>
                                );
                        default:
                                return (
                                        <p className="blocked-copy" role="alert">{t("This durable step has no frontend action. Reload the plan or use Configure for configuration changes.")}</p>
                                );
                }
        };

        return (
                <div className="deployment-shell">
                        <aside className="deployment-rail" aria-label={t("Deployment status")}>
                                <span className="kicker">{t("PINNED DEPLOYMENT")}</span>
                                <h2>{selectedProfile?.displayName ?? t("No profile yet")}</h2>
                                {selectedProfile ? (
                                        <>
                                                <StatusLine
                                                        label={t("Machine preflight")}
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
                                                        label={t("Artifact prepared")}
                                                        state={
                                                                stepCompleted("verifyPatchedArtifact")
                                                                        ? "ok"
                                                                        : "idle"
                                                        }
                                                />
                                                <StatusLine
                                                        label={t("Package exported")}
                                                        state={
                                                                packageReceipt
                                                                        ? "ok"
                                                                        : "idle"
                                                        }
                                                />
                                                <StatusLine
                                                        label={t("BAR1 observed")}
                                                        state={
                                                                stepCompleted("verifyResizableBar")
                                                                        ? "ok"
                                                                        : "idle"
                                                        }
                                                />
                                                <hr />
                                                <dl>
                                                        <dt>{t("Profile ID")}</dt>
                                                        <dd className="mono-wrap">
                                                                {selectedProfile.profileId}
                                                        </dd>
                                                        <dt>{t("Active gate")}</dt>
                                                        <dd>
                                                                {activeStep
                                                                        ? t(activeStep.title)
                                                                        : t("No ready step")}
                                                        </dd>
                                                        <dt>{t("Plan revision")}</dt>
                                                        <dd>
                                                                {plan?.revision ??
                                                                        "—"}
                                                        </dd>
                                                </dl>
                                        </>
                                ) : (
                                        <p className="muted-copy">{t("Select a source image and pin it to this exact machine first.")}</p>
                                )}
                                <div className="rail-note safety-note">
                                        <strong>{t("Manual boundary")}</strong>
                                        <p>{t("This app prepares and verifies a package. You perform vendor flashing, setup changes, power cycles, and hardware work.")}</p>
                                </div>
                        </aside>

                        <main className="deployment-content">
                                <section className="deployment-intro">
                                        <div>
                                                <span className="kicker">{t("EXACT MACHINE / RECOVERABLE ARTIFACT")}</span>
                                                <h2>{t("Prepare, hand off, then verify")}</h2>
                                                <p>{t("Automated steps stop at signed evidence. Physical and firmware-screen steps stay visible as gates.")}</p>
                                        </div>
                                        <div className="truth-badge">
                                                <strong>{t("NO AUTO-FLASH")}</strong>
                                                <span>{t("Manual vendor handoff")}</span>
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
                                                <span>{t(activity.text)}</span>
                                                <button
                                                        aria-label={t("Dismiss operation status")}
                                                        onClick={() =>
                                                                setActivity(null)
                                                        }
                                                >
                                                        ×
                                                </button>
                                        </div>
                                )}

                                <section className="journey-panel" aria-labelledby="source-title">
                                        <JourneyHeading
                                                number="01"
                                                title={t("Pin source & recovery")}
                                                id="source-title"
                                                copy={t("Read and hash the exact vendor image, then document the install and recovery route.")}
                                        />
                                        {msi && (
                                                <div className="detected-route">
                                                        <strong>{t("Exact MSI board recognized")}</strong>
                                                        <span>{t("Native ReBAR, M-FLASH, and Flash BIOS Button defaults are prefilled from the official manual. Confirm them below.")}</span>
                                                </div>
                                        )}
                                        <div className="form-grid">
                                                <label className="field span-2">
                                                        <span>{t("Profile name")}</span>
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
                                                        <span>{t("Exact firmware image")}</span>
                                                        <div className="path-control">
                                                                <input
                                                                        value={firmwarePath}
                                                                        placeholder={t("Choose a vendor BIOS image or enter an absolute path")}
                                                onChange={(event) => {
                                                                                setFirmwarePath(
                                                                                        event.target.value,
                                                                                );
                                                                        }}
                                                                />
                                                                <button
                                                                        onClick={chooseFirmware}
                                                                        disabled={Boolean(busyAction)}
                                                                >{t("Choose file")}</button>
                                                                <button
                                                                        className="quiet"
                                                                        onClick={inspectManualPath}
                                                                        disabled={
                                                                                Boolean(busyAction) ||
                                                                                !firmwarePath ||
                                                                                Boolean(firmware)
                                                                        }
                                                                >{t("Inspect")}</button>
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
                                                        <span>{t("Board path")}</span>
                                                        <select
                                                                value={boardPath}
                                                                onChange={(event) => {
                                                                        setBoardPath(
                                                                                event.target.value as BoardPath,
                                                                        );
                                                                }}
                                                        >
                                                                <option value="nativeResizableBar">{t("Native Resizable BAR")}</option>
                                                                <option value="legacyAbove4g">{t("Legacy Above 4G")}</option>
                                                        </select>
                                                </label>
                                                <label className="field">
                                                        <span>{t("Vendor install route")}</span>
                                                        <select
                                                                value={installMethod}
                                                                onChange={(event) =>
                                                                        setInstallMethod(
                                                                                event.target.value as FirmwareInstallMethod,
                                                                        )
                                                                }
                                                        >
                                                                <option value="firmwareSetupUtility">{t("Firmware setup utility")}</option>
                                                                <option value="usbFlashback">{t("USB flashback")}</option>
                                                                <option value="vendorWindowsUtility">{t("Vendor Windows utility")}</option>
                                                                <option value="externalSpiProgrammer">{t("External SPI programmer")}</option>
                                                        </select>
                                                </label>
                                                <label className="field">
                                                        <span>{t("Recovery route")}</span>
                                                        <select
                                                                value={recoveryMethod}
                                                                onChange={(event) =>
                                                                        setRecoveryMethod(
                                                                                event.target.value as RecoveryMethod,
                                                                        )
                                                                }
                                                        >
                                                                <option value="usbFlashback">{t("USB flashback")}</option>
                                                                <option value="dualBios">{t("Dual BIOS")}</option>
                                                                <option value="vendorRecovery">{t("Vendor recovery")}</option>
                                                                <option value="externalSpiProgrammer">{t("External SPI programmer")}</option>
                                                                <option value="none">{t("None — profile will be refused")}</option>
                                                        </select>
                                                </label>
                                                <label className="field">
                                                        <span>{t("Official instructions URL")}</span>
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
                                                        <span>{t("Install handoff note")}</span>
                                                        <input
                                                                value={t(installNote)}
                                                                onChange={(event) =>
                                                                        setInstallNote(
                                                                                event.target.value,
                                                                        )
                                                                }
                                                        />
                                                </label>
                                                <label className="field span-2">
                                                        <span>{t("Recovery note")}</span>
                                                        <input
                                                                value={t(recoveryNote)}
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
                                                                        <span className="step">{t("READ-ONLY")}</span>
                                                                        <h4 id="legacy-analysis-title">{t("Exact legacy patch analysis")}</h4>
                                                                        <p>{t("Match counts come only from the pinned Rust analyzer. Analysis does not mutate or flash the image.")}</p>
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
                                                                                ? t("Analyzing exact image…")
                                                                                : legacyAnalysisValid
                                                                                  ? t("Analyze again")
                                                                                  : t("Analyze exact image")}
                                                                </button>
                                                        </div>
                                                        <p
                                                                className={`legacy-next-action ${legacyReady ? "ready" : "blocked"}`}
                                                                role="status"
                                                                aria-live="polite"
                                                        >
                                                                {t(legacyNextAction)}
                                                        </p>
                                                        {legacyAnalysis &&
                                                                legacyAnalysisValid && (
                                                                        <div className="legacy-results">
                                                                                <div className="legacy-fingerprint">
                                                                                        <span>{t("Analyzed source")}</span>
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
                                                                                                                                        {t(catalogLabels[catalog.catalog])}
                                                                                                                                </h5>
                                                                                                                                <small>
                                                                                                                                        {n(applicable.length)} {t("applicable")} · {n(absent.length)} {t("absent")} · {n(blocked.length)} {t("blocked")}
                                                                                                                                </small>
                                                                                                                        </div>
                                                                                                                        <span className="mono-wrap">
                                                                                                                                {t("source")} {shortHash(catalog.sourceSha256)}
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
                                                                                                                                                                                {t(rule.description ?? "Pinned compatibility rule")}
                                                                                                                                                                        </strong>
                                                                                                                                                                        <small>
                                                                                                                                                                                {exactMatches(rule.expectedMatches!)} · {t("section")} 0x{rule.sectionType.toString(16).padStart(2, "0")}
                                                                                                                                                                        </small>
                                                                                                                                                                        {rule.requiredRisks.length >
                                                                                                                                                                                0 && (
                                                                                                                                                                                <em>
                                                                                                                                                                                        {t("Requires")} {rule.requiredRisks.map((risk) => t(riskLabels[risk])).join(" · ")}
                                                                                                                                                                                </em>
                                                                                                                                                                        )}
                                                                                                                                                                </span>
                                                                                                                                                                {rule.recommended && (
                                                                                                                                                                        <b>{t("RECOMMENDED")}</b>
                                                                                                                                                                )}
                                                                                                                                                        </label>
                                                                                                                                                );
                                                                                                                                        },
                                                                                                                                )}
                                                                                                                        </div>
                                                                                                                ) : (
                                                                                                                        <p className="legacy-empty">{t("No applicable rules in this catalog.")}</p>
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
                                                                                                                                                {t("Blocked")} · {t(rule.description ?? "Pinned compatibility rule")}
                                                                                                                                        </strong>
                                                                                                                                        <span>
                                                                                                                                                {t(rule.blockedReason ?? "The analyzer could not prove a safe match.")}
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
                                                                                                <h5 id="legacy-risk-title">{t("Explicit risk acknowledgements")}</h5>
                                                                                                <p>
                                                                                                        {t("For each selected risk, describe this exact image and include fingerprint")} <code>{acknowledgementHash}</code>. {t("A generic confirmation is refused.")}
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
                                                                                                                                                {t(riskLabels[risk])}
                                                                                                                                        </strong>
                                                                                                                                        <span>{t("Image-specific acknowledgement note")}</span>
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
                                                                                                                                                <strong>{t("I reviewed this risk for the exact analyzed firmware.")}</strong>
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
                                                        <strong>{t("I checked the vendor install and recovery instructions for this board.")}</strong>
                                                        <small>{t("This confirmation records a documented route; it does not prove a recovery attempt.")}</small>
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
                                                                ? t("Pinning profile…")
                                                                : t("Create machine-bound profile")}
                                                </button>
                                        </div>
                                </section>

                                <section className="journey-panel" aria-labelledby="artifact-title">
                                        <JourneyHeading
                                                number="02"
                                                title={t("Preflight & export")}
                                                id="artifact-title"
                                                copy={t("Refuse drift, prepare the Rust firmware artifact, and export a read-back verified package.")}
                                        />
                                        <label className="field profile-select">
                                                <span>{t("Machine profile")}</span>
                                                <select
                                                        value={selectedProfileId}
                                                        disabled={Boolean(busyAction)}
                                                        onChange={(event) =>
                                                                setSelectedProfileId(event.target.value)
                                                        }
                                                >
                                                        {!profiles.length && (
                                                                <option value="">{t("No stored profiles")}</option>
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
                                                                        <span className="step">{t("ACTIVE STEP")} · {t("REVISION")} {plan.revision}</span>
                                                                        <h4>
                                                                                {activeStep ? t(activeStep.title) : t("Deployment complete")}
                                                                        </h4>
                                                                        <p>
                                                                                {activeStep
                                                                                        ? t("Only this step can advance the durable plan. Completed receipts survive reload.")
                                                                                        : t("No remaining step is ready; every gate has durable evidence.")}
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
                                                                        <strong>{t(workflowReceipt.title)}</strong>
                                                                        <span>{t(workflowReceipt.detail)}</span>
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
                                                                        <strong>Profile Inspector {installation.manifest.version} verified</strong>
                                                                        <span>{t("Tool launch is a handoff only; policy remains incomplete until manual confirmation.")}</span>
                                                                </div>
                                                        )}
                                                        {backup && activeStep?.id === "configureNvidiaApplications" && (
                                                                <small className="verified-line mono-wrap">
                                                                        Backup preserved: {backup.backupPath}
                                                                </small>
                                                        )}
                                                        {launch && activeStep?.id === "configureNvidiaApplications" && (
                                                                <small className="verified-line">
                                                                        Editor process {launch.processId} launched; the plan did not advance.
                                                                </small>
                                                        )}
                                                </div>
                                        )}
                                        {plan && (
                                                <ol className="plan-list" aria-label={t("Deployment plan")}>
                                                        {plan.steps.map((step) => (
                                                                <li
                                                                        key={step.id}
                                                                        className={`plan-step ${step.state}`}
                                                                >
                                                                        <i aria-hidden="true" />
                                                                        <div>
                                                                                <strong>{t(step.title)}</strong>
                                                                                <span>
                                                                                        {step.kind === "automated"
                                                                                                ? t("Automated")
                                                                                                : step.kind === "physicalConfirmation"
                                                                                                  ? t("Physical confirmation")
                                                                                                  : step.kind === "firmwareManual"
                                                                                                    ? t("Manual firmware gate")
                                                                                                    : step.kind === "externalTool"
                                                                                                      ? t("Verified external tool")
                                                                                                      : t("Restart gate")}
                                                                                </span>
                                                                        </div>
                                                                        <b>{step.state}</b>
                                                                </li>
                                                        ))}
                                                </ol>
                                        )}
                                        <div className="action-row">
                                                <button
                                                        onClick={compare}
                                                        disabled={Boolean(busyAction) || !selectedProfileId}
                                                >{t("Run exact-machine preflight")}</button>
                                        </div>
                                        {preparation?.patchedFirmware && (
                                                <div className="artifact-receipt" role="status">
                                                        <strong>{t("Patched artifact verified")}</strong>
                                                        <span>
                                                                {n(preparation.patchedFirmware.byteLength)} {t("bytes")} · SHA-256 {shortHash(preparation.patchedFirmware.sha256)}
                                                        </span>
                                                        <small>{t("No BIOS flash has occurred.")}</small>
                                                </div>
                                        )}
                                        <div className="path-control export-control">
                                                <input
                                                        aria-label={t("Deployment package destination")}
                                                        value={destination}
                                                        placeholder={t("Choose an empty destination folder")}
                                                        onChange={(event) =>
                                                                setDestination(event.target.value)
                                                        }
                                                />
                                                <button
                                                        className="quiet"
                                                        onClick={chooseDestination}
                                                        disabled={Boolean(busyAction)}
                                                >{t("Choose folder")}</button>
                                                <button
                                                        className="primary"
                                                        onClick={exportPackage}
                                                        disabled={
                                                                Boolean(busyAction) ||
                                                                plan?.steps.find((step) => step.id === "verifyPatchedArtifact")?.state !== "completed" ||
                                                                !destination
                                                        }
                                                >{t("Export package")}</button>
                                        </div>
                                        {packageReceipt && (
                                                <div className="artifact-receipt" role="status">
                                                        <strong>{t("Package exported — manual handoff next")}</strong>
                                                        <span className="mono-wrap">{packageReceipt.packagePath}</span>
                                                        <small>
                                                                {packageReceipt.manifest.files.length} files verified · manifest {shortHash(packageReceipt.manifestSha256)}
                                                        </small>
                                                </div>
                                        )}
                                </section>

                                <section className="journey-panel" aria-labelledby="firmware-title">
                                        <JourneyHeading
                                                number="03"
                                                title={t("Manual boundaries remain explicit")}
                                                id="firmware-title"
                                                copy={t("Vendor flash, setup values, returned boot, and NVIDIA policy are never inferred from a local click.")}
                                        />
                                        <div className="manual-gates">
                                                <div>
                                                        <span>{t("MANUAL")}</span>
                                                        <strong>{t("Vendor flash")}</strong>
                                                        <p>{t("Select the exported artifact in the documented vendor utility. Keep power stable.")}</p>
                                                </div>
                                                <div>
                                                        <span>{t("PHYSICAL")}</span>
                                                        <strong>{t("Recovery readiness")}</strong>
                                                        <p>{t("Keep the pinned recovery route and original image available before flashing.")}</p>
                                                </div>
                                                <div>
                                                        <span>{t("MANUAL")}</span>
                                                        <strong>{t("UEFI values")}</strong>
                                                        <p>{t("Confirm Above 4G Decoding and Resizable BAR in firmware. The app does not change them.")}</p>
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
                                                <span className="kicker">{t("IMMEDIATE RESTART")}</span>
                                                <h2 id="reboot-title">{t("Restart Windows into firmware setup?")}</h2>
                                                <p>
                                                        {t("This sends")} <code>{rebootPreview.command} {rebootPreview.arguments.join(" ")}</code>. {t("It does not flash firmware or change setup values.")}
                                                </p>
                                                <div className="warning-box">
                                                        {rebootPreview.warnings.map((warning) => (
                                                                <span key={warning}>{t(warning)}</span>
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
                                                                <strong>{t("I saved and closed my work.")}</strong>
                                                                <small>{t("The restart is immediate. Applications are not explicitly force-closed.")}</small>
                                                        </span>
                                                </label>
                                                <div className="modal-actions">
                                                        <button className="quiet" onClick={() => setShowReboot(false)}>{t("Cancel")}</button>
                                                        <button
                                                                className="primary danger-button"
                                                                disabled={!savedWork}
                                                                onClick={reboot}
                                                        >{t("Restart to firmware UI")}</button>
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
                                                <span className="kicker">{t("OPERATOR ATTESTATION")} · {t("REVISION")} {manualPreview.planRevision}</span>
                                                <h2 id="manual-confirm-title">{t(manualPreview.title)}</h2>
                                                <p>
                                                        {t("This records a durable attestation for only")} <code>{manualPreview.stepId}</code>. {t("It cannot prove the external operation automatically.")}
                                                </p>
                                                <div className="warning-box">
                                                        {manualPreview.warnings.map((warning) => (
                                                                <span key={warning}>{t(warning)}</span>
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
                                                                <strong>{t("I completed and independently reviewed this exact step.")}</strong>
                                                                <small>{t("The token is bound to this profile, active step, and plan revision.")}</small>
                                                        </span>
                                                </label>
                                                <div className="modal-actions">
                                                        <button className="quiet" onClick={() => setShowManual(false)}>{t("Cancel")}</button>
                                                        <button
                                                                className="primary danger-button"
                                                                disabled={!manualConfirmed || Boolean(busyAction)}
                                                                onClick={confirmManual}
                                                        >{t("Record completed step")}</button>
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
                                                <span className="kicker">{t("RESTART REQUEST · PLAN DOES NOT ADVANCE")}</span>
                                                <h2 id="configuration-reboot-title">{t("Restart Windows after configuration?")}</h2>
                                                <p>
                                                        {t("This sends")} <code>{configurationRebootPreview.command} {configurationRebootPreview.arguments.join(" ")}</code>. {t("A later Windows boot must be verified separately.")}
                                                </p>
                                                <div className="warning-box">
                                                        {configurationRebootPreview.warnings.map((warning) => (
                                                                <span key={warning}>{t(warning)}</span>
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
                                                                <strong>{t("I saved and closed my work.")}</strong>
                                                                <small>{t("The command omits /f and the restart request itself does not complete this step.")}</small>
                                                        </span>
                                                </label>
                                                <div className="modal-actions">
                                                        <button className="quiet" onClick={() => setShowConfigurationReboot(false)}>{t("Cancel")}</button>
                                                        <button
                                                                className="primary danger-button"
                                                                disabled={!savedWork || Boolean(busyAction)}
                                                                onClick={requestConfigurationReboot}
                                                        >{t("Request restart")}</button>
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
