import type { SystemSnapshot } from "./types";

export type ApplicationSurface = "overview" | "bar" | "deploy";

/** The DXE driver left evidence in this boot, so step 1 (install) is done. */
export const firmwareInstalled = (snapshot: SystemSnapshot): boolean =>
        snapshot.barSettings.controlEvidence === "currentBootDxe" ||
        snapshot.barSettings.controlEvidence === "expandedTuringAperture";

/**
 * Every launch explains the program and current PC state before editing.
 */
export const initialApplicationSurface = (): ApplicationSurface => "overview";
