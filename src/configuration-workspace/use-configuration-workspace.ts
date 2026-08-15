import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../bridge";
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
        type SaveReceipt,
        type SystemSnapshot,
        type ValidationReport,
} from "../types";
import { ruleForGpu } from "./model";

export const useConfigurationWorkspace = () => {
        const { t } = useI18n();
        const [snap, setSnap] = useState<SystemSnapshot | null>(null),
                [draft, setDraft] = useState<ConfigDraft>(DEFAULT_DRAFT),
                [baseline, setBaseline] = useState<ConfigDraft>(DEFAULT_DRAFT),
                [report, setReport] = useState<ValidationReport | null>(null),
                [error, setError] = useState<MessageDescriptor | null>(null),
                [busy, setBusy] = useState(true),
                [showConfirm, setShowConfirm] = useState(false),
                [showLicenses, setShowLicenses] = useState(false),
                [receipt, setReceipt] = useState<SaveReceipt | null>(null);
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
                > | null>(null);
        if (!rebarInspectionCoordinator.current)
                rebarInspectionCoordinator.current =
                        createResizableBarInspectionCoordinator(
                                setRebarInspection,
                        );
        if (!snapshotGeneration.current)
                snapshotGeneration.current = createRequestGenerationGuard();
        const systemSnapshotGeneration = snapshotGeneration.current;
        const closeLicenses = useCallback(() => setShowLicenses(false), []);
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
                if (!showConfirm) return;
                const previous = document.activeElement as HTMLElement | null;
                const onKey = (event: KeyboardEvent) => {
                        if (event.key === "Escape") {
                                setShowConfirm(false);
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
        }, [showConfirm]);

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
                setShowConfirm(false);
                setError(null);
                setBusy(true);
                try {
                        const saved = await bridge.save(draft);
                        setReceipt(saved);
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
                        setError(
                                message("ui.configureOperationFailed", {
                                        detail:
                                                (cause as { message?: string })
                                                        .message ||
                                                String(cause),
                                }),
                        );
                } finally {
                        setBusy(false);
                }
        };

        return {
                snap,
                draft,
                baseline,
                report,
                error,
                busy,
                showConfirm,
                showLicenses,
                receipt,
                reviewButton,
                dialog,
                licenseButton,
                dirty,
                load,
                patch,
                add,
                updateRule,
                save,
                setDraft,
                setError,
                setReport,
                setShowConfirm,
                setShowLicenses,
                closeLicenses,
                rebarStatus: presentResizableBarStatus(rebarInspection),
                motherboardSupport: snap
                        ? presentMotherboardSupport(snap)
                        : null,
                systemNotices: snap ? presentSystemNotices(snap) : [],
        };
};

export type ConfigurationWorkspaceController = ReturnType<
        typeof useConfigurationWorkspace
>;
