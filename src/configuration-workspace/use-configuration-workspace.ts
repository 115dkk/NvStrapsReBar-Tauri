import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../bridge";
import { barSettingsErrorMessageId } from "../bar-settings-errors";
import { settingsLockMessageId } from "../bar-settings-routing";
import { presentMotherboardSupport } from "../hardware-support";
import { useI18n } from "../i18n";
import { message, type MessageDescriptor } from "../i18n-catalog";
import {
        createRequestGenerationGuard,
        createResizableBarInspectionCoordinator,
        presentResizableBarStatus,
        type ResizableBarInspectionLoadState,
} from "../resizable-bar-status";
import { presentSystemNotices } from "../system-messages";
import {
        DEFAULT_DRAFT,
        type ConfigDraft,
        type GpuDevice,
        type GpuRule,
        type SaveBarSettingsRequest,
        type SaveReceipt,
        type SystemSnapshot,
        type ValidationReport,
} from "../types";
import { ruleForGpu } from "./model";

export const runSingleFlight = async <Result,>(
        inFlight: { current: boolean },
        operation: () => Promise<Result>,
) => {
        if (inFlight.current) return undefined;
        inFlight.current = true;
        try {
                return await operation();
        } finally {
                inFlight.current = false;
        }
};

export const useConfigurationWorkspace = () => {
        const { t } = useI18n();
        const [snap, setSnap] = useState<SystemSnapshot | null>(null),
                [draft, setDraft] = useState<ConfigDraft>(DEFAULT_DRAFT),
                [baseline, setBaseline] = useState<ConfigDraft>(DEFAULT_DRAFT),
                [report, setReport] = useState<ValidationReport | null>(null),
                [error, setError] = useState<MessageDescriptor | null>(null),
                [busy, setBusy] = useState(true),
                [savePath, setSavePath] = useState<
                        "configure" | "settings" | null
                >(null),
                [showLicenses, setShowLicenses] = useState(false),
                [receipt, setReceipt] = useState<{
                        path: "configure" | "settings";
                        save: SaveReceipt;
                } | null>(null);
        const [rebarInspection, setRebarInspection] =
                useState<ResizableBarInspectionLoadState>({
                        status: "loading",
                });
        const validationSequence = useRef(0),
                reviewButton = useRef<HTMLButtonElement>(null),
                dialog = useRef<HTMLDivElement>(null),
                licenseButton = useRef<HTMLButtonElement>(null),
                rebarInspectionCoordinator = useRef<ReturnType<
                        typeof createResizableBarInspectionCoordinator
                > | null>(null),
                snapshotGeneration = useRef<ReturnType<
                        typeof createRequestGenerationGuard
                > | null>(null),
                elevationInFlight = useRef(false);
        if (!rebarInspectionCoordinator.current)
                rebarInspectionCoordinator.current =
                        createResizableBarInspectionCoordinator(
                                setRebarInspection,
                        );
        if (!snapshotGeneration.current)
                snapshotGeneration.current = createRequestGenerationGuard();
        const systemSnapshotGeneration = snapshotGeneration.current;
        const closeLicenses = useCallback(() => setShowLicenses(false), []);
        const showConfirm = savePath !== null;
        const dirty = useMemo(
                () => JSON.stringify(draft) !== JSON.stringify(baseline),
                [draft, baseline],
        );

        const load = async (refresh = false) => {
                if (
                        dirty &&
                        refresh &&
                        !confirm(t("ui.discardUnsavedEditsAndRefreshHardware"))
                )
                        return;
                const sequence = systemSnapshotGeneration.begin();
                void rebarInspectionCoordinator.current?.run(() =>
                        bridge.inspectResizableBarStatus(),
                );
                setBusy(true);
                setError(null);
                try {
                        const next = await (refresh
                                ? bridge.refresh()
                                : bridge.snapshot());
                        if (!systemSnapshotGeneration.isCurrent(sequence))
                                return;
                        setSnap(next);
                        const nextDraft = next.config?.draft ?? DEFAULT_DRAFT;
                        setDraft(structuredClone(nextDraft));
                        setBaseline(structuredClone(nextDraft));
                        setReport(null);
                } catch (cause) {
                        if (systemSnapshotGeneration.isCurrent(sequence))
                                setError(
                                        message("ui.configureOperationFailed", {
                                                detail:
                                                        (
                                                                cause as {
                                                                        message?: string;
                                                                }
                                                        ).message ||
                                                        String(cause),
                                        }),
                                );
                } finally {
                        if (systemSnapshotGeneration.isCurrent(sequence))
                                setBusy(false);
                }
        };

        useEffect(() => {
                void load();
        }, []);

        useEffect(() => {
                const sequence = ++validationSequence.current;
                if (!snap || !dirty) {
                        setReport(null);
                        return;
                }
                const id = setTimeout(
                        () =>
                                bridge
                                        .validate(draft)
                                        .then((next) => {
                                                if (
                                                        sequence ===
                                                        validationSequence.current
                                                )
                                                        setReport(next);
                                        })
                                        .catch(
                                                (cause) =>
                                                        sequence ===
                                                                validationSequence.current &&
                                                        setError(
                                                                message(
                                                                        "ui.configureOperationFailed",
                                                                        {
                                                                                detail:
                                                                                        (
                                                                                                cause as {
                                                                                                        message?: string;
                                                                                                }
                                                                                        )
                                                                                                .message ||
                                                                                        String(
                                                                                                cause,
                                                                                        ),
                                                                        },
                                                                ),
                                                        ),
                                        ),
                        180,
                );
                return () => clearTimeout(id);
        }, [draft, dirty, snap]);

        useEffect(() => {
                if (!savePath) return;
                const previous = document.activeElement as HTMLElement | null;
                const onKey = (event: KeyboardEvent) => {
                        if (event.key === "Escape") {
                                setSavePath(null);
                                return;
                        }
                        if (event.key === "Tab" && dialog.current) {
                                const controls = [
                                        ...dialog.current.querySelectorAll<HTMLElement>(
                                                "button:not([disabled])",
                                        ),
                                ];
                                if (!controls.length) return;
                                const first = controls[0],
                                        last = controls.at(-1)!;
                                if (
                                        event.shiftKey &&
                                        document.activeElement === first
                                ) {
                                        event.preventDefault();
                                        last.focus();
                                } else if (
                                        !event.shiftKey &&
                                        document.activeElement === last
                                ) {
                                        event.preventDefault();
                                        first.focus();
                                }
                        }
                };
                addEventListener("keydown", onKey);
                return () => {
                        removeEventListener("keydown", onKey);
                        (reviewButton.current ?? previous)?.focus();
                };
        }, [savePath]);

        useEffect(() => {
                const guard = (event: BeforeUnloadEvent) => {
                        if (dirty) event.preventDefault();
                };
                addEventListener("beforeunload", guard);
                return () => removeEventListener("beforeunload", guard);
        }, [dirty]);

        const patch = (value: Partial<ConfigDraft>) =>
                setDraft((current) => ({ ...current, ...value }));
        const add = (gpu: GpuDevice) =>
                patch({ rules: [...draft.rules, ruleForGpu(gpu)] });
        const updateRule = (index: number, value: Partial<GpuRule>) =>
                patch({
                        rules: draft.rules.map((rule, currentIndex) =>
                                currentIndex === index
                                        ? { ...rule, ...value }
                                        : rule,
                        ),
                });

        const save = async () => {
                if (!savePath) return;
                const requestedPath = savePath;
                setSavePath(null);
                setError(null);
                let settingsRequest: SaveBarSettingsRequest | null = null;
                if (requestedPath === "settings") {
                        const status = snap?.barSettings;
                        if (
                                !status?.settingsAvailable ||
                                status.configToken === null
                        ) {
                                setError(
                                        message(
                                                snap
                                                        ? (settingsLockMessageId(
                                                                  snap,
                                                          ) ??
                                                                  "ui.settingsLockedCurrentConfigurationUnavailable")
                                                        : "ui.settingsLockedCurrentConfigurationUnavailable",
                                        ),
                                );
                                return;
                        }
                        settingsRequest = {
                                draft,
                                expectedTopologyToken: status.topologyToken,
                                expectedConfigToken: status.configToken,
                        };
                }
                setBusy(true);
                try {
                        let saved: SaveReceipt;
                        if (requestedPath === "settings") {
                                if (!settingsRequest) return;
                                saved = (
                                        await bridge.saveBarSettings(
                                                settingsRequest,
                                        )
                                ).save;
                        } else {
                                saved = await bridge.save(draft);
                        }
                        setReceipt({ path: requestedPath, save: saved });
                        setDraft(structuredClone(saved.draft));
                        setBaseline(structuredClone(saved.draft));
                        setReport(null);
                        try {
                                const sequence =
                                        systemSnapshotGeneration.begin();
                                void rebarInspectionCoordinator.current?.run(
                                        () =>
                                                bridge.inspectResizableBarStatus(),
                                );
                                const next = await bridge.refresh();
                                if (
                                        !systemSnapshotGeneration.isCurrent(
                                                sequence,
                                        )
                                )
                                        return;
                                setSnap(next);
                                setDraft(
                                        structuredClone(
                                                next.config?.draft ??
                                                        saved.draft,
                                        ),
                                );
                                setBaseline(
                                        structuredClone(
                                                next.config?.draft ??
                                                        saved.draft,
                                        ),
                                );
                        } catch (cause) {
                                setError(
                                        message("ui.configureOperationFailed", {
                                                detail:
                                                        (
                                                                cause as {
                                                                        message?: string;
                                                                }
                                                        ).message ||
                                                        String(cause),
                                        }),
                                );
                        }
                } catch (cause) {
                        const typedId =
                                requestedPath === "settings"
                                        ? barSettingsErrorMessageId(cause)
                                        : null;
                        setError(
                                typedId
                                        ? message(typedId)
                                        : message(
                                                  "ui.configureOperationFailed",
                                                  {
                                                          detail:
                                                                  (
                                                                          cause as {
                                                                                  message?: string;
                                                                          }
                                                                  ).message ||
                                                                  String(cause),
                                                  },
                                          ),
                        );
                } finally {
                        setBusy(false);
                }
        };

        const elevate = async () => {
                if (busy) return;
                await runSingleFlight(elevationInFlight, async () => {
                        setBusy(true);
                        setError(null);
                        try {
                                await bridge.elevate();
                        } catch (cause) {
                                setError(
                                        message("ui.configureOperationFailed", {
                                                detail:
                                                        (
                                                                cause as {
                                                                        message?: string;
                                                                }
                                                        ).message ||
                                                        String(cause),
                                        }),
                                );
                        } finally {
                                setBusy(false);
                        }
                });
        };

        return {
                snap,
                draft,
                baseline,
                report,
                error,
                busy,
                showConfirm,
                savePath,
                showLicenses,
                receipt,
                reviewButton,
                dialog,
                licenseButton,
                dirty,
                load,
                elevate,
                openSaveConfirmation: (
                        path: "configure" | "settings",
                ) => setSavePath(path),
                patch,
                add,
                updateRule,
                save,
                setDraft,
                setError,
                setReport,
                setShowConfirm: (show: boolean) => {
                        if (!show) setSavePath(null);
                },
                setShowLicenses,
                closeLicenses,
                rebarStatus: presentResizableBarStatus(rebarInspection),
                rebarInspection,
                motherboardSupport: snap
                        ? presentMotherboardSupport(snap)
                        : null,
                systemNotices: snap ? presentSystemNotices(snap) : [],
        };
};

export type ConfigurationWorkspaceController = ReturnType<
        typeof useConfigurationWorkspace
>;
