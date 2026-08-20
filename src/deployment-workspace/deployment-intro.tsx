import { translateMessage, useI18n } from "../i18n";
import { useDeploymentWorkspaceController } from "./context";
export const DeploymentIntro = () => {
        const { locale, t } = useI18n();
        const { view } = useDeploymentWorkspaceController();
        const { activity } = view;
        return (
                <>
                        <section className="deployment-intro">
                                <div>
                                        <h2>
                                                {t(
                                                        "ui.firmwarePreparationAndInstallation",
                                                )}
                                        </h2>
                                        <p>
                                                {t(
                                                        "ui.prepareAndInspectFirmwareFilesHereFlashThePreparedImageWithTheVendorToolThenReturnToRecordTheResult",
                                                )}
                                        </p>
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
                                        <span>
                                                {translateMessage(
                                                        locale,
                                                        activity.message,
                                                )}
                                        </span>
                                </div>
                        )}
                </>
        );
};
