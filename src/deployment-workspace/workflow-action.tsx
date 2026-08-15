import { translateMessage, useI18n } from "../i18n";
import { useDeploymentWorkspaceController } from "./context";

export const WorkflowAction = () => {
        const { locale, t } = useI18n();
        const { view, commands, rebootButton } =
                useDeploymentWorkspaceController();
        const {
                nextAction,
                busyAction,
                recommendationStatus,
                recommendationError,
                configRecommendation,
                guardedConfigConfirmed,
                installation,
        } = view;
        const {
                prepare,
                previewReboot,
                openManualConfirmation,
                verifyDriver,
                setGuardedConfigConfirmed,
                saveGuardedConfig,
                openConfigurationReboot,
                verifyConfigurationBoot,
                collectBar,
                installInspector,
                backupProfiles,
                launchInspector,
        } = commands;
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

