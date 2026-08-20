import { useI18n } from "./i18n";
import {
        AutomaticPolicyPanel,
        ConfigurationReview,
        FirmwareBehaviorPanel,
        GpuRulesPanel,
} from "./configuration-workspace/panels";
import { SystemStatusSidebar } from "./configuration-workspace/workspace-shell";
import { useConfigurationWorkspaceController } from "./configuration-workspace/context";
import { WorkspaceNotices } from "./configuration-workspace/workspace-notices";

const SettingsIntro = () => {
        const { t } = useI18n();
        return (
                <section className="intro">
                        <div>
                                <h2>{t("ui.editSavedBarSettings")}</h2>
                                <p>{t("ui.settingsIntroDetail")}</p>
                        </div>
                </section>
        );
};

const SettingsAccessRequired = () => {
        const { t } = useI18n();
        const { snap, busy, elevate } = useConfigurationWorkspaceController();
        if (!snap) return null;
        return (
                <section className="panel settings-access-state" role="status">
                        <h3>{t("ui.loadSavedConfigurationToEdit")}</h3>
                        <p>
                                {snap.platform.elevated
                                        ? t("ui.savedConfigurationUnavailableRefresh")
                                        : t(
                                                        "ui.restartAsAdministratorToEditBarSettings",
                                                )}
                        </p>
                        {!snap.platform.elevated && (
                                <button
                                        className="elevate settings-elevate"
                                        disabled={busy}
                                        onClick={() => void elevate()}
                                >
                                        {t("ui.restartAsAdministrator")}
                                </button>
                        )}
                </section>
        );
};

export const BarSettingsWorkspace = () => {
        const { t } = useI18n();
        const { snap } = useConfigurationWorkspaceController();
        const configurationLoaded = Boolean(
                snap?.config && snap.barSettings.configToken !== null,
        );
        return (
                <div
                        className="workspace settings-workspace"
                        data-testid="bar-settings-workspace"
                >
                        <SystemStatusSidebar />
                        <main className="content">
                                <SettingsIntro />
                                <WorkspaceNotices />
                                {snap?.barSettings.savedConfigurationState ===
                                        "invalid" && (
                                        <div className="notice warning">
                                                {t("ui.savedConfigurationInvalidNotice")}
                                        </div>
                                )}
                                {configurationLoaded ? (
                                        <>
                                                <AutomaticPolicyPanel />
                                                <GpuRulesPanel />
                                                <FirmwareBehaviorPanel />
                                                <ConfigurationReview savePath="settings" />
                                        </>
                                ) : (
                                        <SettingsAccessRequired />
                                )}
                        </main>
                </div>
        );
};
