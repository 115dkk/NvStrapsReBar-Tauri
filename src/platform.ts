/**
 * The operating system the app runs on, as the Rust snapshot reports it
 * (`SystemSnapshot.platform.operatingSystem`). Anything other than Linux keeps the
 * Windows screens, so an older backend or a missing value behaves as before.
 */
export type HostOs = "windows" | "linux";

export function hostOsOf(operatingSystem: string | undefined): HostOs {
        return operatingSystem === "linux" ? "linux" : "windows";
}

/**
 * Whether the webview is the Linux one (WebKitGTK names Linux in its user agent; WebView2 names
 * Windows). For code that runs outside the screens and cannot wait for the first snapshot.
 */
export function runsOnLinux(): boolean {
        return /\bLinux\b/.test(navigator.userAgent);
}
