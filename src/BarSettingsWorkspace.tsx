import { useI18n } from "./i18n";
import {
        AutomaticPolicyPanel,
        ConfigurationReview,
        FirmwareBehaviorPanel,
        GpuRulesPanel,
} from "./configuration-workspace/panels";
import { SystemStatusSidebar } from "./configuration-workspace/workspace-shell";
import { useConfigurationWorkspaceController } from "./configuration-workspace/context";
import type { StaticMessageId } from "./i18n-catalog";
import { WorkspaceNotices } from "./configuration-workspace/workspace-notices";

const savedConfigurationMessageIds: Record<
        "enabled" | "disabled" | "invalid" | "unreadable",
        StaticMessageId
> = {
        enabled: "ui.savedConfiguration.enabled",
        disabled: "ui.savedConfiguration.disabled",
        invalid: "ui.savedConfiguration.invalid",
        unreadable: "ui.savedConfiguration.unreadable",
};
const controlEvidenceMessageIds: Record<
        "currentBootDxe" | "expandedTuringAperture" | "notObserved" | "indeterminate",
        { summary: StaticMessageId; detail: StaticMessageId }
> = {
        currentBootDxe: {
                summary: "ui.controlEvidenceCurrentBootDxe",
                detail: "ui.controlEvidenceCurrentBootDxeDetail",
        },
        expandedTuringAperture: {
                summary: "ui.controlEvidenceExpandedTuringAperture",
                detail: "ui.controlEvidenceExpandedTuringApertureDetail",
        },
        notObserved: {
                summary: "ui.controlEvidenceNotObserved",
                detail: "ui.settingsLockedControlNotObserved",
        },
        indeterminate: {
                summary: "ui.controlEvidenceIndeterminate",
                detail: "ui.settingsLockedDriverStateIndeterminate",
        },
};

const SettingsIntro = () => {
        const { t } = useI18n();
        const { snap } = useConfigurationWorkspaceController();
        if (!snap) return null;
        const evidence =
                controlEvidenceMessageIds[snap.barSettings.controlEvidence];
        return (
                <section className="intro settings-intro">
                        <div>
                                <span className="kicker">
                                        {t("ui.postInstallBarSettings")}
                                </span>
                                <h2>{t("ui.editSavedBarSettings")}</h2>
                                <p>{t(evidence.detail)}</p>
                        </div>
                        <dl className="settings-summary">
                                <div>
                                        <dt>{t("ui.settingsEvidence")}</dt>
                                        <dd>{t(evidence.summary)}</dd>
                                </div>
                                <div>
                                        <dt>{t("ui.savedConfiguration")}</dt>
                                        <dd>
                                                {t(
                                                        savedConfigurationMessageIds[
                                                                snap.barSettings
                                                                        .savedConfigurationState
                                                        ],
                                                )}
                                        </dd>
                                </div>
                        </dl>
                </section>
        );
};

const SettingsAccessRequired = () => {
        const { t } = useI18n();
        const { snap, busy, elevate } = useConfigurationWorkspaceController();
        if (!snap) return null;
        return (
                <section className="panel settings-access-state" role="status">
                        <span className="kicker">
                                {t("ui.configurationAccess")}
                        </span>
                        <h3>{t("ui.loadSavedConfigurationToEdit")}</h3>
                        <p>
                                {snap.platform.elevated
                                        ? t("ui.savedConfigurationUnavailableRefresh")
                                        : t("ui.restartAsAdministratorToEditBarSettings")}
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
        const { snap } = useConfigurationWorkspaceController();
        const configurationLoaded = Boolean(
                snap?.config && snap.barSettings.configToken !== null,
        );
        return (
                <div className="workspace settings-workspace" data-testid="bar-settings-workspace">
                        <SystemStatusSidebar />
                        <main className="content">
                                <SettingsIntro />
                                <WorkspaceNotices />
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
