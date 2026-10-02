import { translateMessage, useI18n } from "./i18n";
import { ThirdPartyLicensesDialog } from "./ThirdPartyLicensesDialog";
import { useConfigurationWorkspace } from "./configuration-workspace/use-configuration-workspace";
import { ConfigurationWorkspaceProvider } from "./configuration-workspace/context";
import { SaveConfirmationDialog } from "./configuration-workspace/dialogs";
import { GuidedApp } from "./guided/guided-app";

export function App() {
        const { locale, t } = useI18n();
        const workspace = useConfigurationWorkspace();
        const { snap, error, busy, showLicenses, licenseButton, load, closeLicenses } = workspace;
        if (busy && !snap) return (
                <main className="nv-app nv-root nv-center" lang={locale} role="status">
                        <span className="nv-spinner" aria-hidden="true" />
                        <h1 className="nv-section">{t("ui.readingSystemState")}</h1>
                        <p className="nv-supporting">{t("ui.inspectingUefiAccessAndNvidiaAdapters")}</p>
                </main>
        );
        if (!snap) return (
                <main className="nv-app nv-root nv-center" lang={locale}>
                        <h1 className="nv-section">{t("ui.systemStateUnavailable")}</h1>
                        <p className="nv-supporting">{error ? translateMessage(locale, error) : t("ui.theNativeBridgeDidNotReturnASnapshot")}</p>
                        <button type="button" className="nv-btn nv-btn-primary" onClick={() => load()}>{t("ui.tryAgain")}</button>
                </main>
        );
        return (
                <ConfigurationWorkspaceProvider value={workspace}>
                        <GuidedApp snapshot={snap} />
                        <SaveConfirmationDialog />
                        {showLicenses && <ThirdPartyLicensesDialog onClose={closeLicenses} returnFocus={licenseButton} />}
                </ConfigurationWorkspaceProvider>
        );
}
