/**
 * Remembers which machine profile the user was working on, so a new system
 * snapshot (app launch after a restart, a refresh, a settings save) resumes
 * that record instead of the first one in storage order. Losing this entry
 * only means the first stored record opens.
 */

const KEY = "nvstraps-rebar.selected-profile";

export const rememberSelectedProfile = (profileId: string) => {
        if (!profileId) return;
        try {
                localStorage.setItem(KEY, profileId);
        } catch {
                // Storage can be unavailable; the first stored record opens instead.
        }
};

export const recallSelectedProfile = (): string | null => {
        try {
                return localStorage.getItem(KEY);
        } catch {
                return null;
        }
};
