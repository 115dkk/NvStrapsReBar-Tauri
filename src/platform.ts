/**
 * The operating system the app runs on, as the Rust snapshot reports it
 * (`SystemSnapshot.platform.operatingSystem`). Anything other than Linux keeps the
 * Windows screens, so an older backend or a missing value behaves as before.
 */
export type HostOs = "windows" | "linux";

export function hostOsOf(operatingSystem: string | undefined): HostOs {
        return operatingSystem === "linux" ? "linux" : "windows";
}
