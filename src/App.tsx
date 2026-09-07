import { useState } from "react";
import { previewMode } from "./bridge";
import { BarSettingsWorkspace } from "./BarSettingsWorkspace";
import { initialApplicationSurface, type ApplicationSurface } from "./bar-settings-routing";
import { DeploymentWorkspace } from "./DeploymentWorkspace";
import { translateMessage, useI18n } from "./i18n";
import { ThirdPartyLicensesDialog } from "./ThirdPartyLicensesDialog";
import { useConfigurationWorkspace } from "./configuration-workspace/use-configuration-workspace";
import { ConfigurationWorkspaceProvider } from "./configuration-workspace/context";
import { AutomaticPolicyPanel, ConfigurationIntro, ConfigurationReview, FirmwareBehaviorPanel, GpuRulesPanel } from "./configuration-workspace/panels";
import { ApplicationHeader, ResizableBarHero } from "./configuration-workspace/workspace-shell";
import { SaveConfirmationDialog } from "./configuration-workspace/dialogs";
import { WorkspaceNavigation } from "./application-shell/navigation";
import { Overview } from "./application-shell/overview";
import { DeploymentWorkspaceProvider } from "./deployment-workspace/context";
import { useDeploymentWorkspace } from "./deployment-workspace/use-deployment-workspace";
import type { SystemSnapshot } from "./types";

const ReadyWorkspaces = ({ snapshot }: { snapshot: SystemSnapshot }) => {
        const [surface, setSurface] = useState<ApplicationSurface>(initialApplicationSurface);
        // The session survives navigation; a new system snapshot still replaces it.
        const deployment = useDeploymentWorkspace(snapshot);
        const selectSurface = (next: ApplicationSurface) => {
                if (surface === next) return;
                setSurface(next);
                requestAnimationFrame(() => {
                        window.scrollTo(0, 0);
                        document.querySelector<HTMLElement>(".workspace-header h1")?.focus();
                });
        };
        return (
                <DeploymentWorkspaceProvider value={deployment}>
                        <div className="app-layout">
                                <WorkspaceNavigation surface={surface} onSelect={selectSurface} />
                                <div className="workspace-area">
                                        <ApplicationHeader surface={surface} />
                                        {surface !== "overview" && <ResizableBarHero compact />}
                                        {surface === "overview" ? <Overview onSelect={selectSurface} />
                                                : surface === "deploy" ? <DeploymentWorkspace />
                                                        : snapshot.barSettings.settingsAvailable ? <BarSettingsWorkspace />
                                                                : <div className="workspace"><main className="content"><ConfigurationIntro /><AutomaticPolicyPanel /><GpuRulesPanel /><FirmwareBehaviorPanel /><ConfigurationReview savePath="configure" /></main></div>}
                                </div>
                        </div>
                </DeploymentWorkspaceProvider>
        );
};

export function App() {
        const { locale, t } = useI18n();
        const workspace = useConfigurationWorkspace();
        const { snap, error, busy, showLicenses, licenseButton, load, closeLicenses } = workspace;
        if (busy && !snap) return (
                <main className="center"><div className="loader" /><h1>{t("ui.readingSystemState")}</h1><p>{t("ui.inspectingUefiAccessAndNvidiaAdapters")}</p></main>
        );
        if (!snap) return (
                <main className="center"><h1>{t("ui.systemStateUnavailable")}</h1><p>{error ? translateMessage(locale, error) : t("ui.theNativeBridgeDidNotReturnASnapshot")}</p><button onClick={() => load()}>{t("ui.tryAgain")}</button></main>
        );
        return (
                <ConfigurationWorkspaceProvider value={workspace}>
                        <div className="app">
                                {previewMode && <div className="preview" role="status">{t("ui.previewDataBrowserFixture")}</div>}
                                <ReadyWorkspaces snapshot={snap} />
                                <SaveConfirmationDialog />
                                {showLicenses && <ThirdPartyLicensesDialog onClose={closeLicenses} returnFocus={licenseButton} />}
                        </div>
                </ConfigurationWorkspaceProvider>
        );
}
