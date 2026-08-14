import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge, previewMode } from "./bridge";
import { DeploymentWorkspace } from "./DeploymentWorkspace";
import { translateMessage, useI18n } from "./i18n";
import { message, type MessageDescriptor } from "./i18n-catalog";
import { presentMotherboardSupport } from "./hardware-support";
import {
        createRequestGenerationGuard,
        createResizableBarInspectionCoordinator,
        presentResizableBarStatus,
        type ResizableBarInspectionLoadState,
} from "./resizable-bar-status";
import { ThirdPartyLicensesDialog } from "./ThirdPartyLicensesDialog";
import { driverStatusMessageId, presentSystemNotices } from "./system-messages";
import {
        DEFAULT_DRAFT,
        type ConfigDraft,
        type GpuDevice,
        type GpuRule,
        type SaveReceipt,
        type SystemSnapshot,
        type ValidationReport,
} from "./types";
const sizes = [
        "64 MiB",
        "128 MiB",
        "256 MiB",
        "512 MiB",
        "1 GiB",
        "2 GiB",
        "4 GiB",
        "8 GiB",
        "16 GiB",
        "32 GiB",
        "64 GiB",
];
const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
const bytes = (s: string) => {
        const n = Number(s);
        return n >= 1073741824
                ? `${(n / 1073741824).toFixed(n % 1073741824 ? 1 : 0)} GiB`
                : `${Math.round(n / 1048576)} MiB`;
};
const ruleFor = (g: GpuDevice): GpuRule => ({
        matchScope: "location",
        deviceId: g.deviceId,
        subsystemVendorId: g.subsystemVendorId,
        subsystemDeviceId: g.subsystemDeviceId,
        bus: g.bus,
        device: g.device,
        function: g.function,
        barSizeSelector: g.recommendedBarSizeSelector,
        overrideBarSizeMask: null,
});
const ruleMatches = (r: GpuRule, g: GpuDevice) =>
        r.deviceId === g.deviceId &&
        (r.matchScope === "device" ||
                (r.subsystemVendorId === g.subsystemVendorId &&
                        r.subsystemDeviceId === g.subsystemDeviceId &&
                        (r.matchScope === "subsystem" ||
                                (r.bus === g.bus &&
                                        r.device === g.device &&
                                        r.function === g.function))));
const pciSize = (selector: number) => {
        const unit =
                selector < 10
                        ? "MiB"
                        : selector < 20
                          ? "GiB"
                          : selector < 30
                            ? "TiB"
                            : "PiB";
        return `${2 ** (selector % 10)} ${unit}`;
};
function Status({ label, ok }: { label: string; ok: boolean }) {
        return (
                <span className={`status ${ok ? "ok" : "bad"}`}>
                        <i />
                        {label}
                </span>
        );
}
export function App() {
        const { locale, setLocale, t, validationSummary, gpuCountLabel } = useI18n();
        const [snap, setSnap] = useState<SystemSnapshot | null>(null),
                [draft, setDraft] = useState<ConfigDraft>(DEFAULT_DRAFT),
                [baseline, setBaseline] = useState<ConfigDraft>(DEFAULT_DRAFT),
                [report, setReport] = useState<ValidationReport | null>(null),
                [error, setError] = useState<MessageDescriptor | null>(null),
                [busy, setBusy] = useState(true),
                [showConfirm, setShowConfirm] = useState(false),
                [showLicenses, setShowLicenses] = useState(false),
                [receipt, setReceipt] = useState<SaveReceipt | null>(null),
                [surface, setSurface] = useState<"configure" | "deploy">(
                        "configure",
                );
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
                        const s = await (refresh
                                ? bridge.refresh()
                                : bridge.snapshot());
                        if (!systemSnapshotGeneration.isCurrent(sequence))
                                return;
                        setSnap(s);
                        const d = s.config?.draft ?? DEFAULT_DRAFT;
                        setDraft(structuredClone(d));
                        setBaseline(structuredClone(d));
                        setReport(null);
                } catch (e) {
                        if (systemSnapshotGeneration.isCurrent(sequence))
                                setError(
                                        message("ui.configureOperationFailed", {
                                                detail:
                                                        (e as { message?: string })
                                                                .message || String(e),
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
                                                (e) =>
                                                        sequence ===
                                                                validationSequence.current &&
                                                        setError(
                                                                message(
                                                                        "ui.configureOperationFailed",
                                                                        {
                                                                                detail:
                                                                                        (
                                                                                                e as {
                                                                                                        message?: string;
                                                                                                }
                                                                                        ).message ||
                                                                                        String(e),
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
                const onKey = (e: KeyboardEvent) => {
                        if (e.key === "Escape") {
                                setShowConfirm(false);
                                return;
                        }
                        if (e.key === "Tab" && dialog.current) {
                                const controls = [
                                        ...dialog.current.querySelectorAll<HTMLElement>(
                                                "button:not([disabled])",
                                        ),
                                ];
                                if (!controls.length) return;
                                const first = controls[0],
                                        last = controls.at(-1)!;
                                if (
                                        e.shiftKey &&
                                        document.activeElement === first
                                ) {
                                        e.preventDefault();
                                        last.focus();
                                } else if (
                                        !e.shiftKey &&
                                        document.activeElement === last
                                ) {
                                        e.preventDefault();
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
                const guard = (e: BeforeUnloadEvent) => {
                        if (dirty) e.preventDefault();
                };
                addEventListener("beforeunload", guard);
                return () => removeEventListener("beforeunload", guard);
        }, [dirty]);
        const patch = (p: Partial<ConfigDraft>) =>
                setDraft((d) => ({ ...d, ...p }));
        const add = (g: GpuDevice) =>
                patch({ rules: [...draft.rules, ruleFor(g)] });
        const updateRule = (i: number, p: Partial<GpuRule>) =>
                patch({
                        rules: draft.rules.map((r, n) =>
                                n === i ? { ...r, ...p } : r,
                        ),
                });
        const save = async () => {
                setShowConfirm(false);
                setError(null);
                setBusy(true);
                try {
                        const r = await bridge.save(draft);
                        setReceipt(r);
                        setDraft(structuredClone(r.draft));
                        setBaseline(structuredClone(r.draft));
                        setReport(null);
                        try {
                                const sequence =
                                        systemSnapshotGeneration.begin();
                                void rebarInspectionCoordinator.current?.run(
                                        () =>
                                                bridge.inspectResizableBarStatus(),
                                );
                                const next = await bridge.refresh();
                                if (!systemSnapshotGeneration.isCurrent(sequence))
                                        return;
                                setSnap(next);
                                setDraft(
                                        structuredClone(
                                                next.config?.draft ?? r.draft,
                                        ),
                                );
                                setBaseline(
                                        structuredClone(
                                                next.config?.draft ?? r.draft,
                                        ),
                                );
                        } catch (refreshError) {
                                setError(
                                        message("ui.configureOperationFailed", {
                                                detail:
                                                        (refreshError as { message?: string })
                                                                .message || String(refreshError),
                                        }),
                                );
                        }
                } catch (e) {
                        setError(
                                message("ui.configureOperationFailed", {
                                        detail:
                                                (e as { message?: string }).message ||
                                                String(e),
                                }),
                        );
                } finally {
                        setBusy(false);
                }
        };
        if (busy && !snap)
                return (
                        <main className="center">
                                <div className="loader" />
                                <h1>{t("ui.readingSystemState")}</h1>
                                <p>{t("ui.inspectingUefiAccessAndNvidiaAdapters")}</p>
                        </main>
                );
        if (!snap)
                return (
                        <main className="center">
                                <h1>{t("ui.systemStateUnavailable")}</h1>
                                <p>
                                        {error
                                                ? translateMessage(locale, error)
                                                : t("ui.theNativeBridgeDidNotReturnASnapshot")}
                                </p>
                                <button onClick={() => load()}>{t("ui.tryAgain")}</button>
                        </main>
                );
        const rebarStatus = presentResizableBarStatus(rebarInspection);
        const motherboardSupport = presentMotherboardSupport(snap);
        const systemNotices = presentSystemNotices(snap);
        return (
                <div className="app">
                        {previewMode && (
                                <div className="preview" role="status">{t("ui.previewDataBrowserFixture")}</div>
                        )}
                        <header>
                                <div className="product-heading">
                                        <span className="product">
                                                NVSTRAPS / REBAR
                                        </span>
                                        <div className="title-row">
                                                <h1>
                                                        {surface === "configure"
                                                                ? t("ui.firmwareConfiguration")
                                                                : t("ui.deploymentWorkspace")}
                                                </h1>
                                                <button
                                                        ref={licenseButton}
                                                        className="license-button quiet"
                                                        onClick={() =>
                                                                setShowLicenses(
                                                                        true,
                                                                )
                                                        }
                                                >
                                                        {t("ui.licenses")}
                                                </button>
                                        </div>
                                </div>
                                <div className="header-actions">
                                        <label className="language-select">
                                                <span>{t("ui.language")}</span>
                                                <select
                                                        data-testid="language-select"
                                                        aria-label={t("ui.language")}
                                                        value={locale}
                                                        onChange={(event) => setLocale(event.target.value as "en" | "ko")}
                                                >
                                                        <option value="en">English</option>
                                                        <option value="ko">한국어</option>
                                                </select>
                                        </label>
                                        <nav
                                                className="surface-nav"
                                                aria-label={t("ui.applicationWorkspace")}
                                        >
                                                <button
                                                        aria-current={
                                                                surface ===
                                                                        "configure"
                                                                        ? "page"
                                                                        : undefined
                                                        }
                                                        onClick={() =>
                                                                setSurface(
                                                                        "configure",
                                                                )
                                                        }
                                                >{t("ui.configure")}</button>
                                                <button
                                                        aria-current={
                                                                surface ===
                                                                        "deploy"
                                                                        ? "page"
                                                                        : undefined
                                                        }
                                                        onClick={() =>
                                                                setSurface(
                                                                        "deploy",
                                                                )
                                                        }
                                                >{t("ui.deploy")}</button>
                                        </nav>
                                        {surface === "configure" && (
                                                <span
                                                        className={
                                                                dirty
                                                                        ? "dirty"
                                                                        : "saved"
                                                        }
                                                >
                                                        {dirty
                                                                ? t("ui.unsavedEdits")
                                                                : t("ui.inSync")}
                                                </span>
                                        )}
                                        <button
                                                className="quiet"
                                                onClick={() => void load(true)}
                                                disabled={busy}
                                        >{t("ui.refreshSystem")}</button>
                                </div>
                        </header>
                        <section
                                className="rebar-status-strip"
                                aria-label={t("ui.resizableBarStatus")}
                        >
                                <div
                                        className={`motherboard-support-status ${motherboardSupport.tone}`}
                                        aria-label={t(
                                                "ui.motherboardResizableBarSupportState",
                                                { status: t(motherboardSupport.statusId) },
                                        )}
                                >
                                        <span>{t("ui.motherboardResizableBarSupport")}</span>
                                        <strong aria-hidden="true">{motherboardSupport.symbol}</strong>
                                        <span className="visually-hidden">
                                                {t(motherboardSupport.statusId)}
                                        </span>
                                        {motherboardSupport.boardProduct && (
                                                <span>{motherboardSupport.boardProduct}</span>
                                        )}
                                </div>
                                <div
                                        className={`rebar-current-status ${rebarStatus.tone}`}
                                        role="status"
                                        aria-live="polite"
                                        aria-label={t(rebarStatus.headingId)}
                                >
                                        <strong>{t(rebarStatus.headingId)}</strong>
                                        {rebarStatus.aggregateSymbol && (
                                                <b
                                                        className="rebar-aggregate-symbol"
                                                        aria-hidden="true"
                                                >
                                                        {rebarStatus.aggregateSymbol}
                                                </b>
                                        )}
                                        {rebarStatus.gpus.length > 0 && (
                                                <div className="rebar-status-gpus">
                                                        {rebarStatus.gpus.map((row) => (
                                                                <span
                                                                        className="rebar-gpu-row"
                                                                        key={row.gpu.pciBusId}
                                                                >
                                                                        <b>{row.gpu.productName}</b>
                                                                        {row.gpu.bar1TotalBytes && (
                                                                                <>
                                                                                        {" · "}BAR1 {bytes(row.gpu.bar1TotalBytes)}
                                                                                </>
                                                                        )}
                                                                        {" · "}{t(row.apertureId)}
                                                                        {rebarStatus.driverVersion && (
                                                                                <>
                                                                                        {" · "}{t("ui.driver")} {rebarStatus.driverVersion}
                                                                                </>
                                                                        )}
                                                                        <span
                                                                                className={`rebar-patch-state ${row.patchTone}`}
                                                                                aria-label={t(
                                                                                        "ui.patchConfigurationState",
                                                                                        {
                                                                                                status: t(row.patchStateId),
                                                                                        },
                                                                                )}
                                                                        >
                                                                                {" · "}{t("ui.patchConfiguration")}{" "}
                                                                                <b aria-hidden="true">
                                                                                        {row.patchTone === "not-needed"
                                                                                                ? t(row.patchStateId)
                                                                                                : row.patchSymbol}
                                                                                </b>
                                                                                <span className="visually-hidden">
                                                                                        {t(row.patchStateId)}
                                                                                </span>
                                                                        </span>
                                                                        {row.gpu.patchConfiguration.targetSizeBytes && (
                                                                                <>
                                                                                        {" · "}
                                                                                        {t("ui.targetSize", {
                                                                                                size: bytes(
                                                                                                        row.gpu.patchConfiguration.targetSizeBytes,
                                                                                                ),
                                                                                        })}
                                                                                </>
                                                                        )}
                                                                </span>
                                                        ))}
                                                </div>
                                        )}
                                        </div>
                        </section>
                        {surface === "deploy" ? (
                                <DeploymentWorkspace snapshot={snap} />
                        ) : (
                        <div className="workspace">
                                <aside aria-label={t("ui.systemStatus")}>
                                        <h2>{t("ui.systemGate")}</h2>
                                        <Status
                                                label={t("ui.windows")}
                                                ok={snap.platform.supported}
                                        />
                                        <Status
                                                label={t("ui.uefiBoot")}
                                                ok={snap.platform.uefi}
                                        />
                                        <Status
                                                label={t("ui.administrator")}
                                                ok={snap.platform.elevated}
                                        />
                                        <Status
                                                label={t("ui.firmwareAccess")}
                                                ok={snap.firmware.accessible}
                                        />
                                        <hr />
                                        <dl>
                                                <dt>{t("ui.driverState")}</dt>
                                                <dd>
                                                        {snap.driverStatus
                                                                ? t(driverStatusMessageId(snap.driverStatus)) :
                                                                t("ui.unavailable")}
                                                </dd>
                                                <dt>{t("ui.savedVariable")}</dt>
                                                <dd>
                                                        {snap.firmware
                                                                .configVariablePresent ===
                                                        null
                                                                ? t("ui.unknown")
                                                                : snap.firmware
                                                                            .configVariablePresent
                                                                  ? t("ui.present")
                                                                  : t("ui.notPresent")}
                                                </dd>
                                                <dt>{t("ui.architecture")}</dt>
                                                <dd>
                                                        {
                                                                snap.platform
                                                                        .architecture
                                                        }
                                                </dd>
                                        </dl>
                                        {!snap.platform.elevated && (
                                                <button
                                                        className="elevate"
                                                        onClick={() =>
                                                                void bridge.elevate()
                                                        }
                                                >{t("ui.restartAsAdministrator")}</button>
                                        )}
                                        <div className="rail-note">
                                                <strong>{t("ui.hardwareChanges")}</strong>
                                                <p>{t("ui.afterChangingAGpuOrPciTopologyRefreshTheSystemAndReviewTheSavedSelectors")}</p>
                                        </div>
                                </aside>
                                <main className="content">
                                        <section className="intro">
                                                <div>
                                                        <span className="kicker">{t("ui.activeSystemEditableDraft")}</span>
                                                        <h2>{t("ui.configureWhatFirmwareAppliesAtNextBoot")}</h2>
                                                        <p>{t("ui.changesAreWrittenToAUefiVariableAndTakeEffectAfterWindowsRestarts")}</p>
                                                </div>
                                                <div className="count">
                                                        <b>
                                                                {
                                                                        snap
                                                                                .devices
                                                                                .length
                                                                }
                                                        </b>
                                                        <span>{gpuCountLabel(snap.devices.length)}</span>
                                                </div>
                                        </section>
                                        {error && (
                                                <div
                                                        className="notice error"
                                                        role="alert"
                                                >
                                                        <strong>{t("ui.operationFailed")}</strong>
                                                        <span>{translateMessage(locale, error)}</span>
                                                        <button
                                                                onClick={() =>
                                                                        setError(null)
                                                                }
                                                                aria-label={t("ui.dismissError")}
                                                        >
                                                                ×
                                                        </button>
                                                </div>
                                        )}
                                        {systemNotices.map((notice) => (
                                                <div
                                                        className={`notice ${notice.tone}`}
                                                        key={notice.id}
                                                >
                                                        {t(notice.id)}
                                                </div>
                                        ))}
                                        <section className="panel">
                                                <div className="section-head">
                                                        <div>
                                                                <span className="step">
                                                                        01
                                                                </span>
                                                                <h3>{t("ui.automaticPolicy")}</h3>
                                                        </div>
                                                        <p>{t("ui.chooseTheDefaultBehaviorBeforeAddingDeviceSpecificExceptions")}</p>
                                                </div>
                                                <div
                                                        className="mode-grid"
                                                        role="radiogroup"
                                                        aria-label={t("ui.automaticGpuPolicy")}
                                                >
                                                        {[
                                                                [
                                                                        0,
                                                                        t("ui.off"),
                                                                        t("ui.onlyExplicitGpuRulesAreUsed"),
                                                                ],
                                                                [
                                                                        1,
                                                                        t("ui.registryOnly"),
                                                                        t("ui.useSizesFromTheUpstreamTuringRegistry"),
                                                                ],
                                                                [
                                                                        2,
                                                                        t("ui.registryFallback"),
                                                                        t("ui.useTheRegistryOr2GibForOtherwiseUnlistedTuringGpus"),
                                                                ],
                                                        ].map(([v, l, d]) => (
                                                                <label
                                                                        className={
                                                                                draft.globalMode ===
                                                                                v
                                                                                        ? "selected"
                                                                                        : ""
                                                                        }
                                                                        key={v}
                                                                >
                                                                        <input
                                                                                type="radio"
                                                                                name="mode"
                                                                                checked={
                                                                                        draft.globalMode ===
                                                                                        v
                                                                                }
                                                                                onChange={() =>
                                                                                        patch(
                                                                                                {
                                                                                                        globalMode: v as
                                                                                                                | 0
                                                                                                                | 1
                                                                                                                | 2,
                                                                                                },
                                                                                        )
                                                                                }
                                                                        />
                                                                        <strong>
                                                                                {
                                                                                        l
                                                                                }
                                                                        </strong>
                                                                        <span>
                                                                                {
                                                                                        d
                                                                                }
                                                                        </span>
                                                                </label>
                                                        ))}
                                                </div>
                                                <label className="field">
                                                        <span>{t("ui.targetPciBarSize")}</span>
                                                        <select
                                                                value={
                                                                        draft.targetPciBarSize
                                                                }
                                                                onChange={(e) =>
                                                                        patch({
                                                                                targetPciBarSize:
                                                                                        Number(
                                                                                                e
                                                                                                        .target
                                                                                                        .value,
                                                                                        ),
                                                                        })
                                                                }
                                                        >
                                                                <option value="0">{t("ui.systemDefault")}</option>
                                                                {Array.from(
                                                                        {
                                                                                length: 31,
                                                                        },
                                                                        (
                                                                                _,
                                                                                i,
                                                                        ) => (
                                                                                <option
                                                                                        value={
                                                                                                i +
                                                                                                1
                                                                                        }
                                                                                        key={
                                                                                                i
                                                                                        }
                                                                                >
                                                                                        {pciSize(
                                                                                                i +
                                                                                                        1,
                                                                                        )}
                                                                                </option>
                                                                        ),
                                                                )}
                                                                <option value="32">{t("ui.anySupportedSize")}</option>
                                                                <option value="64">{t("ui.selectedGpusOnly")}</option>
                                                                <option value="65">{t("ui.gpuStrapsOnly")}</option>
                                                        </select>
                                                        <small>{t("ui.specialModes64And65LimitPciSideChangesReviewValidationErrorsBeforeSaving")}</small>
                                                </label>
                                        </section>
                                        <section className="panel">
                                                <div className="section-head">
                                                        <div>
                                                                <span className="step">
                                                                        02
                                                                </span>
                                                                <h3>{t("ui.detectedGpusRules")}</h3>
                                                        </div>
                                                        <p>{t("ui.matchRulesByPciLocationMaximumEight")}</p>
                                                </div>
                                                {snap.devices.length === 0 ? (
                                                        <div className="empty">
                                                                <strong>{t("ui.noNvidiaDisplayAdaptersDetected")}</strong>
                                                                <span>{t("ui.refreshAfterVerifyingTheDeviceIsPresentInWindowsDeviceManager")}</span>
                                                        </div>
                                                ) : (
                                                        snap.devices.map(
                                                                (g) => {
                                                                        const idx =
                                                                                draft.rules.findIndex(
                                                                                        (
                                                                                                r,
                                                                                        ) =>
                                                                                                ruleMatches(
                                                                                                        r,
                                                                                                        g,
                                                                                                ),
                                                                                );
                                                                        return (
                                                                                <article
                                                                                        className="gpu"
                                                                                        key={
                                                                                                g.id
                                                                                        }
                                                                                >
                                                                                        <div className="gpu-id">
                                                                                                <span className="pci">
                                                                                                        {g.bus
                                                                                                                .toString(
                                                                                                                        16,
                                                                                                                )
                                                                                                                .padStart(
                                                                                                                        2,
                                                                                                                        "0",
                                                                                                                )
                                                                                                                .toUpperCase()}

                                                                                                        :
                                                                                                        {g.device
                                                                                                                .toString(
                                                                                                                        16,
                                                                                                                )
                                                                                                                .padStart(
                                                                                                                        2,
                                                                                                                        "0",
                                                                                                                )
                                                                                                                .toUpperCase()}

                                                                                                        .
                                                                                                        {
                                                                                                                g.function
                                                                                                        }
                                                                                                </span>
                                                                                                <div>
                                                                                                        <h4>
                                                                                                                {
                                                                                                                        g.name
                                                                                                                }
                                                                                                        </h4>
                                                                                                        <p>
                                                                                                                DEV{" "}
                                                                                                                {hex(
                                                                                                                        g.deviceId,
                                                                                                                )}{" "}
                                                                                                                ·
                                                                                                                SUBSYS{" "}
                                                                                                                {hex(
                                                                                                                        g.subsystemDeviceId,
                                                                                                                )}

                                                                                                                :
                                                                                                                {hex(
                                                                                                                        g.subsystemVendorId,
                                                                                                                )}{" "}
                                                                                                                ·{" "}
                                                                                                                {bytes(
                                                                                                                        g.dedicatedVideoMemory,
                                                                                                                )}{" "}
                                                                                                                VRAM
                                                                                                        </p>
                                                                                                </div>
                                                                                        </div>
                                                                                        <div className="gpu-facts">
                                                                                                <span>
                                                                                                        {t("ui.currentBarAperture")}{" "}
                                                                                                        <b>
                                                                                                                {bytes(
                                                                                                                        g.currentBarSize,
                                                                                                                )}
                                                                                                        </b>
                                                                                                </span>
                                                                                                <span>
                                                                                                        {t("ui.family")}{" "}
                                                                                                        <b>
                                                                                                                {g.isTuring
                                                                                                                        ? "Turing"
                                                                                                                        : t("ui.other")}
                                                                                                        </b>
                                                                                                </span>
                                                                                                <span>
                                                                                                        {t("ui.effective")}{" "}
                                                                                                        <b>
                                                                                                                {g.effectiveBarSizeSelector ===
                                                                                                                null
                                                                                                                        ? t("ui.none")
                                                                                                                        : sizes[
                                                                                                                                  g
                                                                                                                                          .effectiveBarSizeSelector
                                                                                                                          ]}
                                                                                                        </b>
                                                                                                </span>
                                                                                        </div>
                                                                                        {idx <
                                                                                        0 ? (
                                                                                                <button
                                                                                                        className="add"
                                                                                                        onClick={() =>
                                                                                                                add(
                                                                                                                        g,
                                                                                                                )
                                                                                                        }
                                                                                                        disabled={
                                                                                                                draft
                                                                                                                        .rules
                                                                                                                        .length >=
                                                                                                                8
                                                                                                        }
                                                                                                >
                                                                                                        + {t("ui.addExplicitRule")}
                                                                                                </button>
                                                                                        ) : (
                                                                                                <div className="rule">
                                                                                                        <label>{t("ui.matchScope")}<select
                                                                                                                        value={
                                                                                                                                draft
                                                                                                                                        .rules[
                                                                                                                                        idx
                                                                                                                                ]
                                                                                                                                        .matchScope
                                                                                                                        }
                                                                                                                        onChange={(
                                                                                                                                e,
                                                                                                                        ) =>
                                                                                                                                updateRule(
                                                                                                                                        idx,
                                                                                                                                        {
                                                                                                                                                matchScope: e
                                                                                                                                                        .target
                                                                                                                                                        .value as GpuRule["matchScope"],
                                                                                                                                        },
                                                                                                                                )
                                                                                                                        }
                                                                                                                >
                                                                                                                        <option value="device">{t("ui.deviceId")}</option>
                                                                                                                        <option value="subsystem">{t("ui.subsystem")}</option>
                                                                                                                        <option value="location">{t("ui.pciLocation")}</option>
                                                                                                                </select>
                                                                                                        </label>
                                                                                                        <label>{t("ui.actionSize")}<select
                                                                                                                        value={
                                                                                                                                draft
                                                                                                                                        .rules[
                                                                                                                                        idx
                                                                                                                                ]
                                                                                                                                        .barSizeSelector ??
                                                                                                                                ""
                                                                                                                        }
                                                                                                                        onChange={(
                                                                                                                                e,
                                                                                                                        ) =>
                                                                                                                                updateRule(
                                                                                                                                        idx,
                                                                                                                                        {
                                                                                                                                                barSizeSelector:
                                                                                                                                                        e
                                                                                                                                                                .target
                                                                                                                                                                .value ===
                                                                                                                                                        ""
                                                                                                                                                                ? null
                                                                                                                                                                : Number(
                                                                                                                                                                          e
                                                                                                                                                                                  .target
                                                                                                                                                                                  .value,
                                                                                                                                                                  ),
                                                                                                                                        },
                                                                                                                                )
                                                                                                                        }
                                                                                                                >
                                                                                                                        <option value="">{t("ui.noExplicitSize")}</option>
                                                                                                                        {sizes.map(
                                                                                                                                (
                                                                                                                                        s,
                                                                                                                                        i,
                                                                                                                                ) => (
                                                                                                                                        <option
                                                                                                                                                value={
                                                                                                                                                        i
                                                                                                                                                }
                                                                                                                                                key={
                                                                                                                                                        s
                                                                                                                                                }
                                                                                                                                        >
                                                                                                                                                {
                                                                                                                                                        s
                                                                                                                                                }
                                                                                                                                        </option>
                                                                                                                                ),
                                                                                                                        )}
                                                                                                                        <option value="254">{t("ui.excludeGpu")}</option>
                                                                                                                </select>
                                                                                                        </label>
                                                                                                        <label>{t("ui.sizeMaskOverride")}<select
                                                                                                                        value={
                                                                                                                                draft
                                                                                                                                        .rules[
                                                                                                                                        idx
                                                                                                                                ]
                                                                                                                                        .overrideBarSizeMask ===
                                                                                                                                null
                                                                                                                                        ? "inherit"
                                                                                                                                        : String(
                                                                                                                                                  draft
                                                                                                                                                          .rules[
                                                                                                                                                          idx
                                                                                                                                                  ]
                                                                                                                                                          .overrideBarSizeMask,
                                                                                                                                          )
                                                                                                                        }
                                                                                                                        onChange={(
                                                                                                                                e,
                                                                                                                        ) =>
                                                                                                                                updateRule(
                                                                                                                                        idx,
                                                                                                                                        {
                                                                                                                                                overrideBarSizeMask:
                                                                                                                                                        e
                                                                                                                                                                .target
                                                                                                                                                                .value ===
                                                                                                                                                        "inherit"
                                                                                                                                                                ? null
                                                                                                                                                                : e
                                                                                                                                                                          .target
                                                                                                                                                                          .value ===
                                                                                                                                                                  "true",
                                                                                                                                        },
                                                                                                                                )
                                                                                                                        }
                                                                                                                >
                                                                                                                        <option value="inherit">{t("ui.inheritGlobal")}</option>
                                                                                                                        <option value="true">{t("ui.forceEnabled")}</option>
                                                                                                                        <option value="false">{t("ui.forceDisabled")}</option>
                                                                                                                </select>
                                                                                                        </label>
                                                                                                        <button
                                                                                                                className="remove"
                                                                                                                onClick={() =>
                                                                                                                        patch(
                                                                                                                                {
                                                                                                                                        rules: draft.rules.filter(
                                                                                                                                                (
                                                                                                                                                        _,
                                                                                                                                                        i,
                                                                                                                                                ) =>
                                                                                                                                                        i !==
                                                                                                                                                        idx,
                                                                                                                                        ),
                                                                                                                                },
                                                                                                                        )
                                                                                                                }
                                                                                                        >{t("ui.remove")}</button>
                                                                                                </div>
                                                                                        )}
                                                                                </article>
                                                                        );
                                                                },
                                                        )
                                                )}
                                                {draft.rules.length > 0 && (
                                                        <div className="all-rules">
                                                                <h4>{t("ui.allConfiguredRules")}</h4>
                                                                <p>{t("ui.everySavedScopeRemainsDirectlyEditableIncludingOverlappingPriorityRules")}</p>
                                                                {draft.rules.map(
                                                                        (
                                                                                r,
                                                                                i,
                                                                        ) => (
                                                                                <div
                                                                                        className="rule"
                                                                                        key={`${r.matchScope}-${r.deviceId}-${r.subsystemVendorId}-${r.subsystemDeviceId}-${r.bus}-${r.device}-${r.function}`}
                                                                                >
                                                                                        <label>{t("ui.matchScope")}<select
                                                                                                        aria-label={t("ui.ruleMatchScope", { rule: i + 1 })}
                                                                                                        value={
                                                                                                                r.matchScope
                                                                                                        }
                                                                                                        onChange={(
                                                                                                                e,
                                                                                                        ) =>
                                                                                                                updateRule(
                                                                                                                        i,
                                                                                                                        {
                                                                                                                                matchScope: e
                                                                                                                                        .target
                                                                                                                                        .value as GpuRule["matchScope"],
                                                                                                                        },
                                                                                                                )
                                                                                                        }
                                                                                                >
                                                                                                        <option value="device">{t("ui.deviceId")}</option>
                                                                                                        <option value="subsystem">{t("ui.subsystem")}</option>
                                                                                                        <option value="location">{t("ui.pciLocation")}</option>
                                                                                                </select>
                                                                                        </label>
                                                                                        <label>{t("ui.actionSize")}<select
                                                                                                        aria-label={t("ui.ruleActionSize", { rule: i + 1 })}
                                                                                                        value={
                                                                                                                r.barSizeSelector ??
                                                                                                                ""
                                                                                                        }
                                                                                                        onChange={(
                                                                                                                e,
                                                                                                        ) =>
                                                                                                                updateRule(
                                                                                                                        i,
                                                                                                                        {
                                                                                                                                barSizeSelector:
                                                                                                                                        e
                                                                                                                                                .target
                                                                                                                                                .value ===
                                                                                                                                        ""
                                                                                                                                                ? null
                                                                                                                                                : Number(
                                                                                                                                                          e
                                                                                                                                                                  .target
                                                                                                                                                                  .value,
                                                                                                                                                  ),
                                                                                                                        },
                                                                                                                )
                                                                                                        }
                                                                                                >
                                                                                                        <option value="">{t("ui.noExplicitSize")}</option>
                                                                                                        {sizes.map(
                                                                                                                (
                                                                                                                        s,
                                                                                                                        n,
                                                                                                                ) => (
                                                                                                                        <option
                                                                                                                                value={
                                                                                                                                        n
                                                                                                                                }
                                                                                                                                key={
                                                                                                                                        s
                                                                                                                                }
                                                                                                                        >
                                                                                                                                {
                                                                                                                                        s
                                                                                                                                }
                                                                                                                        </option>
                                                                                                                ),
                                                                                                        )}
                                                                                                        <option value="254">{t("ui.excludeGpu")}</option>
                                                                                                </select>
                                                                                        </label>
                                                                                        <span className="rule-identity">
                                                                                                {r.matchScope ===
                                                                                                "location"
                                                                                                        ? `${r.bus.toString(16).padStart(2, "0")}:${r.device.toString(16).padStart(2, "0")}.${r.function}`
                                                                                                        : r.matchScope ===
                                                                                                            "subsystem"
                                                                                                          ? `DEV ${hex(r.deviceId)} / SUBSYS ${hex(r.subsystemDeviceId)}:${hex(r.subsystemVendorId)}`
                                                                                                          : `DEV ${hex(r.deviceId)}`}
                                                                                        </span>
                                                                                        <button
                                                                                                className="remove"
                                                                                                onClick={() =>
                                                                                                        patch(
                                                                                                                {
                                                                                                                        rules: draft.rules.filter(
                                                                                                                                (
                                                                                                                                        _,
                                                                                                                                        n,
                                                                                                                                ) =>
                                                                                                                                        n !==
                                                                                                                                        i,
                                                                                                                        ),
                                                                                                                },
                                                                                                        )
                                                                                                }
                                                                                        >
                                                                                                Remove
                                                                                                rule{" "}
                                                                                                {i +
                                                                                                        1}
                                                                                        </button>
                                                                                </div>
                                                                        ),
                                                                )}
                                                        </div>
                                                )}
                                        </section>
                                        <section className="panel">
                                                <div className="section-head">
                                                        <div>
                                                                <span className="step">
                                                                        03
                                                                </span>
                                                                <h3>{t("ui.firmwareBehavior")}</h3>
                                                        </div>
                                                                <p>{t("ui.chooseChangeDetectionBarMaskAndResumeBehavior")}</p>
                                                </div>
                                                <div className="checks">
                                                        <label>
                                                                <input
                                                                        type="checkbox"
                                                                        checked={
                                                                                draft.guardSetupChanges
                                                                        }
                                                                        onChange={(
                                                                                e,
                                                                        ) =>
                                                                                patch(
                                                                                        {
                                                                                                guardSetupChanges:
                                                                                                        e
                                                                                                                .target
                                                                                                                .checked,
                                                                                        },
                                                                                )
                                                                        }
                                                                />
                                                                <span>
                                                                        <strong>{t("ui.checkSetupVariableChanges")}</strong>
                                                                        <small>{t("ui.compareTheSetupVariableFingerprintBeforeApplyingConfiguration")}</small>
                                                                </span>
                                                        </label>
                                                        <label>
                                                                <input
                                                                        type="checkbox"
                                                                        checked={
                                                                                draft.overrideBarSizeMask
                                                                        }
                                                                        onChange={(
                                                                                e,
                                                                        ) =>
                                                                                patch(
                                                                                        {
                                                                                                overrideBarSizeMask:
                                                                                                        e
                                                                                                                .target
                                                                                                                .checked,
                                                                                        },
                                                                                )
                                                                        }
                                                                />
                                                                <span>
                                                                        <strong>{t("ui.overrideBarSizeMaskGlobally")}</strong>
                                                                        <small>{t("ui.advertiseTheConfiguredSizeWhenCapabilityMasksDiffer")}</small>
                                                                </span>
                                                        </label>
                                                        <label className="danger-check">
                                                                <input
                                                                        type="checkbox"
                                                                        checked={
                                                                                draft.skipS3Resume
                                                                        }
                                                                        onChange={(
                                                                                e,
                                                                        ) =>
                                                                                patch(
                                                                                        {
                                                                                                skipS3Resume:
                                                                                                        e
                                                                                                                .target
                                                                                                                .checked,
                                                                                        },
                                                                                )
                                                                        }
                                                                />
                                                                <span>
                                                                        <strong>{t("ui.skipS3ResumeReconfiguration")}</strong>
                                                                        <small>{t("ui.testS3ResumeOnThisComputerAfterEnablingThisOption")}</small>
                                                                </span>
                                                        </label>
                                                </div>
                                        </section>
                                        <section
                                                className="review"
                                                aria-live="polite"
                                        >
                                                <div>
                                                        <span className="kicker">{t("ui.validation")}</span>
                                                        {!dirty ? (
                                                                <h3>{t("ui.noPendingChanges")}</h3>
                                                        ) : !report ? (
                                                                <h3>{t("ui.checkingDraft")}</h3>
                                                        ) : report.valid ? (
                                                                <>
                                                                        <h3>{t("ui.draftIsReadyForReview")}</h3>
                                                                        <p>
                                                                                {validationSummary(report.affectedGpuIds.length, report.encodedSize)}
                                                                        </p>
                                                                </>
                                                        ) : (
                                                                <>
                                                                        <h3>{t("ui.draftNeedsCorrection")}</h3>
                                                                        {report.errors.map(
                                                                                (
                                                                                        x,
                                                                                ) => (
                                                                                        <p
                                                                                                className="validation-error"
                                                                                                key={
                                                                                                        x
                                                                                                }
                                                                                        >
                                                                                                {x}
                                                                                        </p>
                                                                                ),
                                                                        )}
                                                                </>
                                                        )}
                                                </div>
                                                <div className="commit">
                                                        <button
                                                                className="quiet"
                                                                disabled={
                                                                        !dirty
                                                                }
                                                                onClick={() => {
                                                                        setDraft(
                                                                                structuredClone(
                                                                                        baseline,
                                                                                ),
                                                                        );
                                                                        setReport(
                                                                                null,
                                                                        );
                                                                }}
                                                        >{t("ui.discardEdits")}</button>
                                                        <button
                                                                ref={
                                                                        reviewButton
                                                                }
                                                                className="primary"
                                                                disabled={
                                                                        !dirty ||
                                                                        !report?.valid ||
                                                                        busy ||
                                                                        !snap
                                                                                .firmware
                                                                                .accessible
                                                                }
                                                                onClick={() =>
                                                                        setShowConfirm(
                                                                                true,
                                                                        )
                                                                }
                                                        >{t("ui.reviewSave")}</button>
                                                </div>
                                        </section>
                                        {report && [
                                                ...(draft.skipS3Resume
                                                        ? ["ui.s3ResumeReconfigurationIsDisabledTestS3ResumeOnThisComputer" as const]
                                                        : []),
                                                ...(report.affectedGpuIds.length === 0 && report.encodedSize > 0
                                                        ? ["ui.theCurrentSettingsDoNotSelectAnyDetectedNvidiaGpu" as const]
                                                        : []),
                                        ].map((warningId) => (
                                                <div
                                                        className="notice warning"
                                                        key={warningId}
                                                >
                                                        {t(warningId)}
                                                </div>
                                        ))}
                                        {receipt && (
                                                <div
                                                        className="receipt"
                                                        role="status"
                                                >
                                                        <strong>{t("ui.configurationWrittenAndReadBack")}</strong>
                                                        <span>
                                                                {
                                                                        receipt.bytesWritten
                                                                }{" "}
                                                                bytes written ·
                                                                UEFI variable{" "}
                                                                {receipt.variablePresent
                                                                        ? "present"
                                                                        : "removed"}
                                                        </span>
                                                        <p>{t("ui.restartWindowsWhenReadyTheFirmwareDriverCannotApplyThisConfigurationUntilTheNextBoot")}</p>
                                                </div>
                                        )}
                                </main>
                        </div>
                        )}
                        {showConfirm && (
                                <div
                                        className="modal-backdrop"
                                        role="presentation"
                                >
                                        <div
                                                ref={dialog}
                                                className="modal"
                                                role="dialog"
                                                aria-modal="true"
                                                aria-labelledby="confirm-title"
                                        >
                                                <span className="kicker">{t("ui.consequentialWrite")}</span>
                                                <h2 id="confirm-title">{t("ui.writeThisDraftToUefiFirmware")}</h2>
                                                <p>{t("ui.theApplicationWillWriteAndReadBackTheNvstrapsrebarConfigurationVariableARestartIsRequiredBeforeTheDriverCanApplyIt")}</p>
                                                <div className="warning-box">
                                                        <strong>{t("ui.beforeYouContinue")}</strong>
                                                        <span>{t("ui.confirmTheDetectedGpuAndPciTopologyMatchThisMachineHardwareChangesCanMakeSavedSelectorsStale")}</span>
                                                </div>
                                                <div className="modal-actions">
                                                        <button
                                                                className="quiet"
                                                                autoFocus
                                                                onClick={() =>
                                                                        setShowConfirm(
                                                                                false,
                                                                        )
                                                                }
                                                        >{t("ui.cancel")}</button>
                                                        <button
                                                                className="primary danger-button"
                                                                onClick={() =>
                                                                        void save()
                                                                }
                                                        >{t("ui.writeConfiguration")}</button>
                                                </div>
                                        </div>
                                </div>
                        )}
                        {showLicenses && (
                                <ThirdPartyLicensesDialog
                                        onClose={closeLicenses}
                                        returnFocus={licenseButton}
                                />
                        )}
                </div>
        );
}
