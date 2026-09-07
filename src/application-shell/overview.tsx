import type { ApplicationSurface } from "../bar-settings-routing";
import { useI18n } from "../i18n";
import { useConfigurationWorkspaceController } from "../configuration-workspace/context";
import { ResizableBarHero, SystemStatusSidebar } from "../configuration-workspace/workspace-shell";
import { useDeploymentWorkspaceController } from "../deployment-workspace/context";
import { overviewAction } from "./overview-action";
import { WorkspaceNotices } from "../configuration-workspace/workspace-notices";

export const Overview = ({ onSelect }: { onSelect: (surface: ApplicationSurface) => void }) => {
        const { t } = useI18n();
        const { snap, rebarStatus, busy, load, elevate } = useConfigurationWorkspaceController();
        const { view } = useDeploymentWorkspaceController();
        if (!snap) return null;
        const continuing = Boolean(view.plan && view.activeStep) || Boolean(view.firmware && !view.plan);
        const next = overviewAction(snap, rebarStatus.tone, continuing);
        const continueAction = () => {
                if (next.action === "refresh") void load(true);
                else if (next.action === "elevate") void elevate();
                else if (next.action) onSelect(next.action);
        };
        return (
                <main className="overview-page" data-testid="overview-workspace">
                        <section className="purpose-intro">
                                <span className="eyebrow">NvStrapsReBar</span>
                                <h2>{t("ui.programPurpose")}</h2>
                                <p>{t("ui.programPurposeDetail")}</p>
                        </section>
                        <WorkspaceNotices systemDetails={false} />
                        <section className="overview-system" aria-labelledby="your-pc-title">
                                <div className="overview-section-heading"><h3 id="your-pc-title">{t("ui.yourPc")}</h3><span>{t("ui.currentBoot")}</span></div>
                                <ResizableBarHero />
                        </section>
                        <section className="next-action-card" aria-labelledby="overview-next-title">
                                <div>
                                        <span className="eyebrow">{t("ui.nextStep")}</span>
                                        <h3 id="overview-next-title">{t(next.title)}</h3>
                                        <p>{t(next.detail)}</p>
                                </div>
                                {next.action && <button className="primary" disabled={busy || Boolean(view.busyAction)} onClick={continueAction}>{t(next.label)}<span aria-hidden="true">→</span></button>}
                        </section>
                        <section className="setup-outline" aria-labelledby="setup-outline-title">
                                <h3 id="setup-outline-title">{t("ui.howSetupWorks")}</h3>
                                <ol>
                                        {([
                                                ["ui.outlinePrepare", "ui.outlinePrepareDetail"],
                                                ["ui.outlineInstall", "ui.outlineInstallDetail"],
                                                ["ui.outlineConfigure", "ui.outlineConfigureDetail"],
                                        ] as const).map(([title, detail], index) => (
                                                <li key={title}><span className="outline-number">{index + 1}</span><div><strong>{t(title)}</strong><p>{t(detail)}</p></div></li>
                                        ))}
                                </ol>
                        </section>
                        <details className="environment-details"><summary>{t("ui.systemStatus")}</summary><SystemStatusSidebar /></details>
                </main>
        );
};
