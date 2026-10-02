import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { previewMode } from "../bridge";
import { DeploymentWorkspaceProvider } from "../deployment-workspace/context";
import { useDeploymentWorkspace } from "../deployment-workspace/use-deployment-workspace";
import { useI18n } from "../i18n";
import type { SystemSnapshot } from "../types";
import { AppBar } from "./app-bar";
import { GuidedDialogs } from "./dialogs";
import { Home } from "./home";
import { InstallPage } from "./install";
import { GuidedNavigationProvider, initialInstallUi, type GuidedNavigation, type InstallUi } from "./navigation";
import { BarPage, ChangesPage, GamesPage, ProfilesPage, RecordPage } from "./pages";
import { installInProgress, type GuidedPage, type InstallScreen } from "./routing";

/**
 * Guided interface root. The system state picks the first page: an install in
 * progress opens its current step, everything else opens home. There is no
 * fixed navigation; home rows and the menu reach every other page.
 */
export const GuidedApp = ({ snapshot }: { snapshot: SystemSnapshot }) => {
        const { t, locale } = useI18n();
        // The session survives page changes; a new system snapshot still replaces it.
        const deployment = useDeploymentWorkspace(snapshot);
        const { view, commands } = deployment;
        const [chosenPage, setChosenPage] = useState<GuidedPage | null>(null);
        const [settingsFileOpen, setSettingsFileOpen] = useState(false);
        const [installUi, setInstallUiState] = useState<InstallUi>(initialInstallUi);
        const [screen, setScreen] = useState<InstallScreen | null>(null);
        const titleRef = useRef<HTMLHeadingElement>(null);
        const automatic: GuidedPage = installInProgress(view) || installUi.startNew ? "install" : "home";
        const page = chosenPage ?? automatic;

        // Once an install is under way it keeps the window, also while a refresh reloads the records.
        useEffect(() => {
                if (chosenPage === null && automatic === "install") setChosenPage("install");
        }, [chosenPage, automatic]);
        const go = useCallback((next: GuidedPage, options?: { settingsFile?: boolean }) => {
                setChosenPage(next);
                setSettingsFileOpen(Boolean(options?.settingsFile));
        }, []);
        const setInstallUi = useCallback((patch: Partial<InstallUi>) => setInstallUiState((current) => ({ ...current, ...patch })), []);
        const startNewPreparation = useCallback(() => {
                commands.setFirmwarePath("");
                commands.setRouteConfirmed(false);
                setInstallUiState({ ...initialInstallUi, startNew: true, startNewCreations: view.profileCreations });
                setChosenPage("install");
        }, [commands, view.profileCreations]);
        const navigation = useMemo<GuidedNavigation>(
                () => ({ page, go, settingsFileOpen, installUi, setInstallUi, startNewPreparation }),
                [page, go, settingsFileOpen, installUi, setInstallUi, startNewPreparation],
        );

        // Move focus to the new heading whenever the page or install screen changes.
        useEffect(() => {
                requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
        }, [page, screen]);
        // A refresh can remove the focused control without changing the screen; keep focus on the page.
        useEffect(() => {
                requestAnimationFrame(() => {
                        if (document.activeElement === document.body) titleRef.current?.focus({ preventScroll: true });
                });
        }, [snapshot, view.profilesLoaded]);
        // Until the records are read, the first page is unknown; a record switch also waits.
        const loading = !view.profilesLoaded && (chosenPage === null || page === "install");
        const onScreen = useCallback((next: InstallScreen) => setScreen(next), []);

        return (
                <DeploymentWorkspaceProvider value={deployment}>
                        <GuidedNavigationProvider value={navigation}>
                                <div className="nv-app nv-root" lang={locale} data-page={page}>
                                        {previewMode && <div className="nv-preview-band" role="status">{t("ui.previewDataBrowserFixture")}</div>}
                                        <AppBar />
                                        {loading ? <div className="nv-loading" role="status"><span className="nv-spinner" aria-hidden="true" /><span className="nv-visually-hidden">{t("ui.chipChecking")}</span></div>
                                                : page === "install" ? <InstallPage titleRef={titleRef} onScreen={onScreen} />
                                                : page === "bar" ? <BarPage titleRef={titleRef} />
                                                        : page === "games" ? <GamesPage titleRef={titleRef} />
                                                                : page === "changes" ? <ChangesPage titleRef={titleRef} />
                                                                        : page === "record" ? <RecordPage titleRef={titleRef} />
                                                                                : page === "profiles" ? <ProfilesPage titleRef={titleRef} />
                                                                                        : <Home titleRef={titleRef} />}
                                        <GuidedDialogs />
                                </div>
                        </GuidedNavigationProvider>
                </DeploymentWorkspaceProvider>
        );
};
