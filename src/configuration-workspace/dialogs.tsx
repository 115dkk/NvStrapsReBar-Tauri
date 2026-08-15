import { useI18n } from "../i18n";
import { useConfigurationWorkspaceController } from "./context";

export const SaveConfirmationDialog = () => {
        const { t } = useI18n();
        const { showConfirm, dialog, setShowConfirm, save } =
                useConfigurationWorkspaceController();
        return (
                <>
                        {showConfirm && (
                                <div
                                        className="modal-backdrop"
                                        role="presentation"
                                >
                                        <div
                                                ref={dialog}
                                                className="modal"
                                                role="dialog"
                                                aria-modal="true"
                                                aria-labelledby="confirm-title"
                                        >
                                                <span className="kicker">
                                                        {t(
                                                                "ui.consequentialWrite",
                                                        )}
                                                </span>
                                                <h2 id="confirm-title">
                                                        {t(
                                                                "ui.writeThisDraftToUefiFirmware",
                                                        )}
                                                </h2>
                                                <p>
                                                        {t(
                                                                "ui.theApplicationWillWriteAndReadBackTheNvstrapsrebarConfigurationVariableARestartIsRequiredBeforeTheDriverCanApplyIt",
                                                        )}
                                                </p>
                                                <div className="warning-box">
                                                        <strong>
                                                                {t(
                                                                        "ui.beforeYouContinue",
                                                                )}
                                                        </strong>
                                                        <span>
                                                                {t(
                                                                        "ui.confirmTheDetectedGpuAndPciTopologyMatchThisMachineHardwareChangesCanMakeSavedSelectorsStale",
                                                                )}
                                                        </span>
                                                </div>
                                                <div className="modal-actions">
                                                        <button
                                                                className="quiet"
                                                                autoFocus
                                                                onClick={() =>
                                                                        setShowConfirm(
                                                                                false,
                                                                        )
                                                                }
                                                        >
                                                                {t("ui.cancel")}
                                                        </button>
                                                        <button
                                                                className="primary danger-button"
                                                                onClick={() =>
                                                                        void save()
                                                                }
                                                        >
                                                                {t(
                                                                        "ui.writeConfiguration",
                                                                )}
                                                        </button>
                                                </div>
                                        </div>
                                </div>
                        )}
                </>
        );
};
