import { useI18n } from "../i18n";
import { useConfigurationWorkspaceController } from "./context";
import { WorkspaceNotices } from "./workspace-notices";

export const ConfigurationIntro = () => {
        const { t } = useI18n();
        const { snap } = useConfigurationWorkspaceController();
        if (!snap) return null;
        return (
                <>
                        <section className="intro">
                                <div>
                                        <h2>
                                                {t(
                                                        "ui.configureWhatFirmwareAppliesAtNextBoot",
                                                )}
                                        </h2>
                                        <p>
                                                {t(
                                                        "ui.changesAreWrittenToAUefiVariableAndTakeEffectAfterWindowsRestarts",
                                                )}
                                        </p>
                                </div>
                        </section>
                        <WorkspaceNotices />
                </>
        );
};
