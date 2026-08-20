import type { SystemSnapshot } from "./types";

export type ApplicationSurface = "bar" | "deploy";

/** The DXE driver left evidence in this boot, so step 1 (install) is done. */
export const firmwareInstalled = (snapshot: SystemSnapshot): boolean =>
        snapshot.barSettings.controlEvidence === "currentBootDxe" ||
        snapshot.barSettings.controlEvidence === "expandedTuringAperture";

/**
 * Open the step the user most likely needs next: BAR settings once the
 * driver is present, the firmware install journey before that.
 */
export const initialApplicationSurface = (
        snapshot: SystemSnapshot,
): ApplicationSurface => (firmwareInstalled(snapshot) ? "bar" : "deploy");
