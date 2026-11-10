import { useLayoutEffect } from "react";
import { translateMessage, useI18n } from "./i18n";
import { hostOsOf } from "./platform";
import { useConfigurationWorkspace } from "./configuration-workspace/use-configuration-workspace";
import { ConfigurationWorkspaceProvider } from "./configuration-workspace/context";
import { GuidedApp } from "./guided/guided-app";

export function App() {
        const { locale, os, setOs, t } = useI18n();
        const workspace = useConfigurationWorkspace();
        const { snap, error, busy, load } = workspace;
        const snapshotOs = snap ? hostOsOf(snap.platform.operatingSystem) : null;
        // A layout effect, so the screens re-render for the host OS before anything is painted.
        useLayoutEffect(() => {
                if (snapshotOs) setOs(snapshotOs);
        }, [snapshotOs, setOs]);
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
                        <p className="nv-supporting">{error ? translateMessage(locale, error, os) : t("ui.theNativeBridgeDidNotReturnASnapshot")}</p>
                        <button type="button" className="nv-btn nv-btn-primary" onClick={() => load()}>{t("ui.tryAgain")}</button>
                </main>
        );
        // The guided screens mount only once they know the host OS, so a Windows-only page never starts on Linux.
        if (snapshotOs !== os) return null;
        return (
                <ConfigurationWorkspaceProvider value={workspace}>
                        <GuidedApp snapshot={snap} />
                </ConfigurationWorkspaceProvider>
        );
}
