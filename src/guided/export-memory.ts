import type { DeploymentPackageReceipt } from "../deployment-workspace/contract";

/**
 * Remembers, per profile, where the USB package was saved so the guide can
 * continue after the app restarts. This is a display convenience only: the
 * package itself and its manifest are the record, and losing this entry only
 * means the save screen is shown again.
 */

export type RememberedExport = {
        packagePath: string;
        recoveryShortcut: DeploymentPackageReceipt["recoveryShortcut"];
};

const key = (profileId: string) => `nvstraps-rebar.export.${profileId}`;

export const rememberExport = (profileId: string, receipt: DeploymentPackageReceipt) => {
        try {
                const value: RememberedExport = {
                        packagePath: receipt.packagePath,
                        recoveryShortcut: receipt.recoveryShortcut ?? null,
                };
                localStorage.setItem(key(profileId), JSON.stringify(value));
        } catch {
                // Storage can be unavailable; the save screen stays reachable.
        }
};

export const recallExport = (profileId: string): RememberedExport | null => {
        if (!profileId) return null;
        try {
                const raw = localStorage.getItem(key(profileId));
                if (!raw) return null;
                const value = JSON.parse(raw) as Partial<RememberedExport>;
                return typeof value.packagePath === "string"
                        ? { packagePath: value.packagePath, recoveryShortcut: value.recoveryShortcut ?? null }
                        : null;
        } catch {
                return null;
        }
};
