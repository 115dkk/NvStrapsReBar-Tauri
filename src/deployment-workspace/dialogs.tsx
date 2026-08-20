import { useI18n } from "../i18n";
import { manualWarningIds, stepTitleIds } from "./messages";
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
                busyAction,
                boardPath,
        } = view;
        const {
                setShowReboot,
                reboot,
                setShowManual,
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
                                                <h2 id="reboot-title">
                                                        {t("ui.restartWindowsIntoFirmwareSetup")}
                                                </h2>
                                                <p>{t("ui.windowsRestartsImmediately")}</p>
                                                <p>
                                                        {t(
                                                                "ui.windowsOpensTheFirmwareSetupScreenContinueThereWithTheVendorInstructions",
                                                        )}
                                                </p>
                                                <div className="modal-actions">
                                                        <button
                                                                className="quiet"
                                                                autoFocus
                                                                onClick={() => setShowReboot(false)}
                                                        >
                                                                {t("ui.cancel")}
                                                        </button>
                                                        <button
                                                                className="primary danger-button"
                                                                onClick={reboot}
                                                        >
                                                                {t("ui.restartToFirmwareUi")}
                                                        </button>
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
                                                <h2 id="manual-confirm-title">
                                                        {t(stepTitleIds[manualPreview.stepId])}
                                                </h2>
                                                <p>
                                                        {t(
                                                                "ui.reviewTheResultInTheOwningToolThenRecordThisStep",
                                                        )}
                                                </p>
                                                <div className="warning-box">
                                                        {manualWarningIds(
                                                                manualPreview.stepId,
                                                                boardPath === "legacyAbove4g",
                                                        ).map((warningId) => (
                                                                <span key={warningId}>
                                                                        {t(warningId)}
                                                                </span>
                                                        ))}
                                                </div>
                                                <div className="modal-actions">
                                                        <button
                                                                className="quiet"
                                                                autoFocus
                                                                onClick={() => setShowManual(false)}
                                                        >
                                                                {t("ui.cancel")}
                                                        </button>
                                                        <button
                                                                className="primary danger-button"
                                                                disabled={Boolean(busyAction)}
                                                                onClick={confirmManual}
                                                        >
                                                                {t("ui.recordCompletedStep")}
                                                        </button>
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
                                                <h2 id="configuration-reboot-title">
                                                        {t("ui.restartWindowsAfterConfiguration")}
                                                </h2>
                                                <p>{t("ui.windowsRestartsImmediately")}</p>
                                                <p>
                                                        {t(
                                                                "ui.returnAfterWindowsBootsSoTheAppCanCompareTheNewBootTime",
                                                        )}
                                                </p>
                                                <div className="modal-actions">
                                                        <button
                                                                className="quiet"
                                                                autoFocus
                                                                onClick={() =>
                                                                        setShowConfigurationReboot(false)
                                                                }
                                                        >
                                                                {t("ui.cancel")}
                                                        </button>
                                                        <button
                                                                className="primary danger-button"
                                                                disabled={Boolean(busyAction)}
                                                                onClick={requestConfigurationReboot}
                                                        >
                                                                {t("ui.requestRestart")}
                                                        </button>
                                                </div>
                                        </div>
                                </div>
                        )}
                </>
        );
};
