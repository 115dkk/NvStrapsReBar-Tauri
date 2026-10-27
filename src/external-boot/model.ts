import type { ExternalBootStatus, ExternalCandidate, ExternalMedium, ExternalMediumState, ExternalReport, PciSlot } from "./contract";

export type ExternalMode = "experiment" | "install";
export type ExternalScreen =
        | "loading" | "failed" | "blocked" | "choose"
        | "diagnosticReady" | "diagnosticMissing" | "pickGpu"
        | "loaderReady" | "loaderMissing" | "result" | "installed";
export type ExternalActive = { mode: ExternalMode; medium: ExternalMedium; state: ExternalMediumState } | null;
export type BlockReason = "uefi" | "admin" | "secureBoot" | "noEsp";

export const activeRoute = (status: ExternalBootStatus): ExternalActive => {
        if (status.install?.stage) return { mode: "install", medium: { kind: "esp" }, state: status.install };
        const drive = status.usbDrives.find((drive) => drive.state?.stage);
        return drive?.state ? { mode: "experiment", medium: { kind: "usb", root: drive.root }, state: drive.state } : null;
};

export const externalScreen = (status: ExternalBootStatus | null, loadFailed: boolean): ExternalScreen => {
        if (!status) return loadFailed ? "failed" : "loading";
        if (!status.uefi || !status.elevated) return "blocked";
        const active = activeRoute(status);
        if (!active) return status.secureBoot === true || !status.esp.found ? "blocked" : "choose";
        if (active.mode === "install" && status.install?.loaderFirst) return "installed";
        if (active.state.stage === "diagnostic") {
                if (active.state.report) return "pickGpu";
                return active.state.restartedSinceStage ? "diagnosticMissing" : "diagnosticReady";
        }
        if (active.state.receipt) return "result";
        return active.state.restartedSinceStage ? "loaderMissing" : "loaderReady";
};

export const blockReasons = (status: ExternalBootStatus): BlockReason[] => {
        const reasons: BlockReason[] = [];
        if (!status.uefi) reasons.push("uefi");
        if (!status.elevated) reasons.push("admin");
        if (status.secureBoot === true) reasons.push("secureBoot");
        if (!status.esp.found) reasons.push("noEsp");
        return reasons;
};

export const bootMenuKey = (boardManufacturer: string | null): string | null => {
        const name = boardManufacturer?.toLowerCase() ?? "";
        if (/\bmsi\b|micro[ -]?star/.test(name)) return "F11";
        if (/\basus\b|asustek/.test(name)) return "F8";
        if (/\bgigabyte\b/.test(name)) return "F12";
        if (/\basrock\b/.test(name)) return "F11";
        return null;
};

/** Backend codes select translated copy; the original message is kept for diagnostics. */
export type ExternalError = { code: string; message: string };

export const externalError = (cause: unknown): ExternalError => {
        const record = cause && typeof cause === "object" ? (cause as { code?: unknown; message?: unknown }) : null;
        const code = typeof record?.code === "string" ? record.code.trim() : "";
        const message = typeof record?.message === "string" ? record.message : typeof cause === "string" ? cause : "";
        return { code: code || "externalWrite", message: message.trim() };
};

export const defaultSize = (candidate: ExternalCandidate): number | null => {
        const sizes = candidate.sizes.filter((size) => size.error === null);
        if (sizes.some((size) => size.bytes === candidate.recommendedBytes)) return candidate.recommendedBytes;
        return sizes.length ? Math.max(...sizes.map((size) => size.bytes)) : null;
};

export const usableCandidates = (report: ExternalReport): ExternalCandidate[] =>
        report.candidates.filter((candidate) => candidate.sizes.some((size) => size.error === null));

export const formatSlot = (slot: PciSlot): string =>
        `${slot.segment.toString(16).padStart(4, "0")}:${slot.bus.toString(16).padStart(2, "0")}:${slot.device.toString(16).padStart(2, "0")}.${slot.function.toString(16)}`;
