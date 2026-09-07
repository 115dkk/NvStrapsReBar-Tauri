import { useI18n } from "../i18n";
import type { ApplicationSurface } from "../bar-settings-routing";
import { useConfigurationWorkspaceController } from "../configuration-workspace/context";
import { useDeploymentWorkspaceController } from "../deployment-workspace/context";

export const WorkspaceIcon = ({ kind }: { kind: ApplicationSurface }) => (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                {kind === "overview" ? <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M7 9h4M7 12h8" /></>
                        : kind === "deploy" ? <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4M18 9h4m-4 6h4M9 9h6v6H9z" /></>
                                : <><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 3v6m8 0v6M10 15v6" strokeWidth="3" /></>}
        </svg>
);

export const WorkspaceNavigation = ({ surface, onSelect }: {
        surface: ApplicationSurface;
        onSelect: (surface: ApplicationSurface) => void;
}) => {
        const { t } = useI18n();
        const { licenseButton, setShowLicenses, busy, showConfirm } = useConfigurationWorkspaceController();
        const { view } = useDeploymentWorkspaceController();
        const navigationLocked = busy || showConfirm || Boolean(view.busyAction) || view.showManual || view.showReboot || view.showConfigurationReboot;
        const items = [
                ["overview", "ui.overview"], ["deploy", "ui.stepInstallFirmware"], ["bar", "ui.barSettings"],
        ] as const;
        return (
                <aside className="app-sidebar" aria-label={t("ui.applicationWorkspace")}>
                        <div className="app-brand"><WorkspaceIcon kind="deploy" /><strong>NvStrapsReBar</strong></div>
                        <p className="app-category">{t("ui.hardwareUtility")}</p>
                        <nav className="workspace-nav" aria-label={t("ui.applicationWorkspace")}>
                                {items.map(([id, label]) => (
                                        <button key={id} disabled={navigationLocked} aria-current={surface === id ? "page" : undefined} onClick={() => onSelect(id)}>
                                                <WorkspaceIcon kind={id} /><span>{t(label)}</span>
                                        </button>
                                ))}
                        </nav>
                        <div className="sidebar-footer">
                                <span>Windows · NVIDIA Turing</span>
                                <button ref={licenseButton} className="license-button quiet" onClick={() => setShowLicenses(true)}>{t("ui.licenses")}</button>
                        </div>
                </aside>
        );
};
