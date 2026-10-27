import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { previewMode } from "../bridge";
import type { ExternalBootBridge, ExternalBootStatus, ExternalMedium, ExternalReport, PciSlot } from "./contract";
import { activeRoute, externalError, externalScreen, type ExternalError } from "./model";
import { nativeExternalBootBridge } from "./native-bridge";
import { previewExternalBootBridge } from "./preview-bridge";

export const externalBootBridge: ExternalBootBridge = previewMode ? previewExternalBootBridge : nativeExternalBootBridge;

type Busy = null | "inspect" | "prepare" | "report" | "loader" | "permanent" | "remove" | "restart";

export const useExternalBoot = (bridge: ExternalBootBridge = externalBootBridge) => {
        const [status, setStatus] = useState<ExternalBootStatus | null>(null);
        const [loadFailed, setLoadFailed] = useState<ExternalError | null>(null);
        const [busy, setBusy] = useState<Busy>(null);
        const [error, setError] = useState<ExternalError | null>(null);
        const [loadedReport, setLoadedReport] = useState<{ key: string; report: ExternalReport } | null>(null);
        const generation = useRef(0);
        const mounted = useRef(false);
        // A ref also blocks a second click before React renders the busy state.
        const running = useRef<Busy>(null);
        const attemptedReport = useRef<string | null>(null);

        const apply = useCallback((next: ExternalBootStatus) => {
                setStatus(next);
                setLoadFailed(null);
        }, []);

        const reload = useCallback(async () => {
                if (!mounted.current || running.current) return;
                const current = ++generation.current;
                running.current = "inspect";
                setBusy("inspect");
                setLoadFailed(null);
                setError(null);
                try {
                        const next = await bridge.inspect();
                        if (current === generation.current) apply(next);
                } catch (cause) {
                        console.error("[external-boot] inspecting the boot route failed", cause);
                        if (current === generation.current) setLoadFailed(externalError(cause));
                } finally {
                        if (current === generation.current) {
                                running.current = null;
                                setBusy(null);
                        }
                }
        }, [apply, bridge]);

        useEffect(() => {
                mounted.current = true;
                attemptedReport.current = null;
                setLoadedReport(null);
                void reload();
                return () => {
                        mounted.current = false;
                        generation.current++;
                        running.current = null;
                };
        }, [reload]);

        const active = useMemo(() => status ? activeRoute(status) : null, [status]);
        const screen = externalScreen(status, loadFailed !== null);
        const reportKey = screen === "pickGpu" && active
                ? JSON.stringify([active.medium, active.state.stage, active.state.stageWrittenUnixMs])
                : null;
        const report = reportKey && loadedReport?.key === reportKey ? loadedReport.report : null;

        useEffect(() => {
                if (!mounted.current || running.current || !reportKey || !active || attemptedReport.current === reportKey) return;
                attemptedReport.current = reportKey;
                running.current = "report";
                setBusy("report");
                setError(null);
                const current = generation.current;
                const medium = active.medium;
                void (async () => {
                        try {
                                const next = await bridge.readReport(medium);
                                if (current === generation.current) setLoadedReport({ key: reportKey, report: next });
                        } catch (cause) {
                                console.error("[external-boot] reading the diagnostic report failed", cause);
                                if (current === generation.current) setError(externalError(cause));
                        } finally {
                                if (current === generation.current) {
                                        running.current = null;
                                        setBusy(null);
                                }
                        }
                })();
        }, [active, bridge, busy, reportKey]);

        const run = useCallback(async (kind: "prepare" | "loader" | "permanent" | "remove" | "restart", work: () => Promise<ExternalBootStatus>) => {
                if (!mounted.current || running.current) return;
                running.current = kind;
                setBusy(kind);
                setError(null);
                const current = generation.current;
                try {
                        const next = await work();
                        if (current !== generation.current) return;
                        if (kind === "prepare" || kind === "loader" || kind === "remove") {
                                attemptedReport.current = null;
                                setLoadedReport(null);
                        }
                        apply(next);
                } catch (cause) {
                        console.error(`[external-boot] ${kind} failed`, cause);
                        if (current === generation.current) setError(externalError(cause));
                } finally {
                        if (current === generation.current) {
                                running.current = null;
                                setBusy(null);
                        }
                }
        }, [apply]);

        const prepareDiagnostic = useCallback((medium: ExternalMedium) => run("prepare", () => bridge.prepareDiagnostic(medium)), [bridge, run]);
        const writeLoader = useCallback(async (target: PciSlot, sizeBytes: number) => {
                if (active) await run("loader", () => bridge.writeLoader(active.medium, target, sizeBytes));
        }, [active, bridge, run]);
        const makePermanent = useCallback(() => run("permanent", () => bridge.makePermanent()), [bridge, run]);
        const remove = useCallback(async () => {
                if (active) await run("remove", () => bridge.remove(active.medium));
        }, [active, bridge, run]);
        const restart = useCallback((suspendBitLocker: boolean) => run("restart", async () => {
                await bridge.restart(suspendBitLocker);
                // The browser preview stays mounted across its simulated restart.
                return bridge.inspect();
        }), [bridge, run]);

        return useMemo(() => ({
                status, loadFailed, screen, active, report, busy, error,
                reload, prepareDiagnostic, writeLoader, makePermanent, remove, restart,
        }), [status, loadFailed, screen, active, report, busy, error, reload, prepareDiagnostic, writeLoader, makePermanent, remove, restart]);
};

export type ExternalBootController = ReturnType<typeof useExternalBoot>;
