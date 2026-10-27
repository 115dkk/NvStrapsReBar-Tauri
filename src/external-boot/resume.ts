import type { ExternalScreen } from "./model";

/**
 * Remembers on this PC that the external route waits for the user after a restart, so the app opens
 * that page again. Losing the mark only means starting from the home page.
 */
const RESUME_KEY = "nvstraps-external-resume";

const WAITING: ExternalScreen[] = ["diagnosticReady", "diagnosticMissing", "pickGpu", "loaderReady", "loaderMissing", "result"];

export const shouldResumeExternal = () => {
        try {
                return localStorage.getItem(RESUME_KEY) === "1";
        } catch {
                return false;
        }
};

/** Loading and failed screens say nothing about the route, so they keep the mark as it is. */
export const rememberExternalScreen = (screen: ExternalScreen) => {
        if (screen === "loading" || screen === "failed") return;
        try {
                if (WAITING.includes(screen)) localStorage.setItem(RESUME_KEY, "1");
                else localStorage.removeItem(RESUME_KEY);
        } catch {
                // Storage can be unavailable; the page still works without the mark.
        }
};
