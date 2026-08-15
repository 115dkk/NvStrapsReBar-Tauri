import { useEffect, useRef, useState } from "react";
import { previewMode } from "./bridge";
import { BarSettingsWorkspace } from "./BarSettingsWorkspace";
import {
        initialApplicationSurface,
        settingsLockMessageId,
        type ApplicationSurface,
} from "./bar-settings-routing";
import { DeploymentWorkspace } from "./DeploymentWorkspace";
import { translateMessage, useI18n } from "./i18n";
import { ThirdPartyLicensesDialog } from "./ThirdPartyLicensesDialog";
import { useConfigurationWorkspace } from "./configuration-workspace/use-configuration-workspace";
import { ConfigurationWorkspaceProvider } from "./configuration-workspace/context";
import {
        AutomaticPolicyPanel,
        ConfigurationIntro,
        ConfigurationReview,
        FirmwareBehaviorPanel,
        GpuRulesPanel,
} from "./configuration-workspace/panels";
import {
        ApplicationHeader,
        ResizableBarStatusStrip,
        SystemStatusSidebar,
} from "./configuration-workspace/workspace-shell";
import { SaveConfirmationDialog } from "./configuration-workspace/dialogs";
export function App() {
        const { locale, t } = useI18n();
        const workspace = useConfigurationWorkspace();
        const {
                snap,
                error,
                busy,
                showLicenses,
                licenseButton,
                load,
                closeLicenses,
        } = workspace;
        const [surface, setSurface] =
                useState<ApplicationSurface>("configure");
        const userSelectedSurface = useRef(false);
        const initialSurfaceResolved = useRef(false);
        useEffect(() => {
                if (
                        initialSurfaceResolved.current ||
                        userSelectedSurface.current ||
                        !snap ||
                        workspace.rebarInspection.status === "loading"
                )
                        return;
                setSurface(
                        initialApplicationSurface(
                                snap,
                                workspace.rebarInspection,
                        ),
                );
                initialSurfaceResolved.current = true;
        }, [snap, workspace.rebarInspection]);
        const selectSurface = (next: ApplicationSurface) => {
                userSelectedSurface.current = true;
                initialSurfaceResolved.current = true;
                setSurface(next);
        };
        const settingsLockId = snap ? settingsLockMessageId(snap) : null;
        if (busy && !snap)
                return (
                        <main className="center">
                                <div className="loader" />
                                <h1>{t("ui.readingSystemState")}</h1>
                                <p>
                                        {t(
                                                "ui.inspectingUefiAccessAndNvidiaAdapters",
                                        )}
                                </p>
                        </main>
                );
        if (!snap)
                return (
                        <main className="center">
                                <h1>{t("ui.systemStateUnavailable")}</h1>
                                <p>
                                        {error
                                                ? translateMessage(
                                                          locale,
                                                          error,
                                                  )
                                                : t(
                                                          "ui.theNativeBridgeDidNotReturnASnapshot",
                                                  )}
                                </p>
                                <button onClick={() => load()}>
                                        {t("ui.tryAgain")}
                                </button>
                        </main>
                );
        return (
                <ConfigurationWorkspaceProvider value={workspace}>
                        <div className="app">
                                {previewMode && (
                                        <div className="preview" role="status">
                                                {t(
                                                        "ui.previewDataBrowserFixture",
                                                )}
                                        </div>
                                )}
                                <ApplicationHeader
                                        surface={surface}
                                        setSurface={selectSurface}
                                />
                                {settingsLockId && (
                                        <div
                                                id="settings-lock-reason"
                                                className="settings-lock-banner"
                                                role="status"
                                        >
                                                <strong>{t("ui.settings")}</strong>
                                                <span>{t(settingsLockId)}</span>
                                        </div>
                                )}
                                <ResizableBarStatusStrip />
                                {surface === "deploy" ? (
                                        <DeploymentWorkspace snapshot={snap} />
                                ) : surface === "settings" ? (
                                        <BarSettingsWorkspace />
                                ) : (
                                        <div className="workspace">
                                                <SystemStatusSidebar />
                                                <main className="content">
                                                        <ConfigurationIntro />
                                                        <AutomaticPolicyPanel />
                                                        <GpuRulesPanel />
                                                        <FirmwareBehaviorPanel />
                                                        <ConfigurationReview savePath="configure" />
                                                </main>
                                        </div>
                                )}
                                <SaveConfirmationDialog />
                                {showLicenses && (
                                        <ThirdPartyLicensesDialog
                                                onClose={closeLicenses}
                                                returnFocus={licenseButton}
                                        />
                                )}
                        </div>
                </ConfigurationWorkspaceProvider>
        );
}
