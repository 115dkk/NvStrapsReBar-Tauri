import { useI18n } from "../i18n";
import { useConfigurationWorkspaceController } from "./context";

export const SaveConfirmationDialog = () => {
        const { t } = useI18n();
        const { showConfirm, savePath, report, dialog, setShowConfirm, save } =
                useConfigurationWorkspaceController();
        const removesConfiguration = report?.variableWillExist === false;
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
                                                        {removesConfiguration
                                                                ? t(
                                                                          "ui.removeSavedOperationalConfiguration",
                                                                  )
                                                                : savePath ===
                                                                    "settings"
                                                                  ? t(
                                                                            "ui.saveTheseBarSettingsToUefi",
                                                                    )
                                                                  : t(
                                                                            "ui.writeThisDraftToUefiFirmware",
                                                                    )}
                                                </h2>
                                                <p>
                                                        {removesConfiguration
                                                                ? t(
                                                                          "ui.removingTheSavedConfigurationClearsAllOperationalRules",
                                                                  )
                                                                : savePath ===
                                                                    "settings"
                                                                  ? t(
                                                                            "ui.settingsSaveUsesTheCurrentTopologyAndConfigurationTokensThenReadsTheValueBack",
                                                                    )
                                                                  : t(
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
                                                                {removesConfiguration
                                                                        ? t(
                                                                                  "ui.removeSavedConfiguration",
                                                                          )
                                                                        : savePath ===
                                                                            "settings"
                                                                          ? t(
                                                                                    "ui.saveBarSettings",
                                                                            )
                                                                          : t(
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
