import { createContext, useContext, type ReactNode } from "react";
import type { GuidedPage, InstallUiState } from "./routing";

export type InstallUi = Omit<InstallUiState, "catalogBoard" | "exported" | "restartedSinceSave"> & {
        /** The user chose to answer the route questions on a catalog board. */
        customRoutes: boolean;
        /** The user reviewed the legacy patch selection and moved on. */
        legacyAccepted: boolean;
        /** Profile creations counted when a new preparation started; one more ends it. */
        startNewCreations: number;
};

export const initialInstallUi: InstallUi = {
        startNew: false,
        question: 1,
        claimedInstalled: false,
        savingAgain: false,
        showGuide: false,
        customRoutes: false,
        legacyAccepted: false,
        startNewCreations: 0,
};

export type GuidedNavigation = {
        page: GuidedPage;
        /** Opens a page; `settingsFile` opens BAR settings with the settings file section expanded. */
        go(page: GuidedPage, options?: { settingsFile?: boolean }): void;
        settingsFileOpen: boolean;
        installUi: InstallUi;
        setInstallUi(patch: Partial<InstallUi>): void;
        /** Starts stage 1 again with a new BIOS file, keeping earlier records. */
        startNewPreparation(): void;
};

const NavigationContext = createContext<GuidedNavigation | null>(null);

export const GuidedNavigationProvider = ({ value, children }: { value: GuidedNavigation; children: ReactNode }) => (
        <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
);

export const useGuidedNavigation = () => {
        const value = useContext(NavigationContext);
        if (!value) throw new Error("Guided screens require the navigation provider.");
        return value;
};
