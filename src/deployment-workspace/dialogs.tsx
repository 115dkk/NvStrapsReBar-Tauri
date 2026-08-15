import { useI18n } from "../i18n";
import {
        configurationRebootWarningIds,
        firmwareRebootWarningIds,
        manualWarningIds,
        stepTitleIds,
} from "./messages";
import { useDeploymentWorkspaceController } from "./context";
export const DeploymentDialogs = () => {
        const { t } = useI18n();
        const { view, commands, rebootDialog } =
                useDeploymentWorkspaceController();
        const {
                showReboot,
                rebootPreview,
                showManual,
                manualPreview,
                showConfigurationReboot,
                configurationRebootPreview,
                savedWork,
                manualConfirmed,
                busyAction,
                boardPath,
        } = view;
        const {
                setSavedWork,
                setShowReboot,
                reboot,
                setShowManual,
                setManualConfirmed,
                confirmManual,
                setShowConfigurationReboot,
                requestConfigurationReboot,
        } = commands;
        return (
                                <>
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
                                </>
        );
};
