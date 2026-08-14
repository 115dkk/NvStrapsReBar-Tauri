import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge, previewMode } from "./bridge";
import { DeploymentWorkspace } from "./DeploymentWorkspace";
import { useI18n } from "./i18n";
import { presentMotherboardSupport } from "./hardware-support";
import {
        createRequestGenerationGuard,
        createResizableBarInspectionCoordinator,
        presentResizableBarStatus,
        type ResizableBarInspectionLoadState,
} from "./resizable-bar-status";
import { ThirdPartyLicensesDialog } from "./ThirdPartyLicensesDialog";
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
                [error, setError] = useState(""),
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
                        !confirm(t("Discard unsaved edits and refresh hardware?"))
                )
                        return;
                const sequence = systemSnapshotGeneration.begin();
                void rebarInspectionCoordinator.current?.run(() =>
                        bridge.inspectResizableBarStatus(),
                );
                setBusy(true);
                setError("");
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
                        if (systemSnapshotGeneration.isCurrent(sequence)) setError(
                                (e as { message?: string }).message ||
                                        String(e),
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
                                                                (
                                                                        e as {
                                                                                message?: string;
                                                                        }
                                                                ).message ||
                                                                        String(
                                                                                e,
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
                setError("");
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
                                        `Configuration was written and read back, but system state could not be refreshed: ${(refreshError as { message?: string }).message || String(refreshError)}`,
                                );
                        }
                } catch (e) {
                        setError(
                                (e as { message?: string }).message ||
                                        String(e),
                        );
                } finally {
                        setBusy(false);
                }
        };
        if (busy && !snap)
                return (
                        <main className="center">
                                <div className="loader" />
                                <h1>{t("Reading system state")}</h1>
                                <p>{t("Inspecting UEFI access and NVIDIA adapters…")}</p>
                        </main>
                );
        if (!snap)
                return (
                        <main className="center">
                                <h1>{t("System state unavailable")}</h1>
                                <p>
                                        {error ||
                                                t("The native bridge did not return a snapshot.")}
                                </p>
                                <button onClick={() => load()}>{t("Try again")}</button>
                        </main>
                );
        const rebarStatus = presentResizableBarStatus(rebarInspection);
        const motherboardSupport = presentMotherboardSupport(snap);
        return (
                <div className="app">
                        {previewMode && (
                                <div className="preview" role="status">{t("PREVIEW DATA · Browser fixture")}</div>
                        )}
                        <header>
                                <div className="product-heading">
                                        <span className="product">
                                                NVSTRAPS / REBAR
                                        </span>
                                        <div className="title-row">
                                                <h1>
                                                        {surface === "configure"
                                                                ? t("Firmware configuration")
                                                                : t("Deployment workspace")}
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
                                                        {t("Licenses")}
                                                </button>
                                        </div>
                                </div>
                                <div className="header-actions">
                                        <label className="language-select">
                                                <span>{t("Language")}</span>
                                                <select
                                                        data-testid="language-select"
                                                        aria-label={t("Language")}
                                                        value={locale}
                                                        onChange={(event) => setLocale(event.target.value as "en" | "ko")}
                                                >
                                                        <option value="en">English</option>
                                                        <option value="ko">한국어</option>
                                                </select>
                                        </label>
                                        <nav
                                                className="surface-nav"
                                                aria-label={t("Application workspace")}
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
                                                >{t("Configure")}</button>
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
                                                >{t("Deploy")}</button>
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
                                                                ? t("UNSAVED EDITS")
                                                                : t("IN SYNC")}
                                                </span>
                                        )}
                                        <button
                                                className="quiet"
                                                onClick={() => void load(true)}
                                                disabled={busy}
                                        >{t("Refresh system")}</button>
                                </div>
                        </header>
                        <section
                                className="rebar-status-strip"
                                aria-label={t("Resizable BAR status")}
                        >
                                <div
                                        className={`motherboard-support-status ${motherboardSupport.tone}`}
                                        aria-label={`${t("Motherboard support")}: ${t(motherboardSupport.label)}`}
                                >
                                        <span>{t("Motherboard support")}</span>
                                        <strong>{t(motherboardSupport.label)}</strong>
                                        {motherboardSupport.boardProduct && (
                                                <span>{motherboardSupport.boardProduct}</span>
                                        )}
                                </div>
                                <div
                                        className={`rebar-current-status ${rebarStatus.tone}`}
                                        role="status"
                                        aria-live="polite"
                                        aria-label={t(rebarStatus.heading)}
                                >
                                        <strong>{t(rebarStatus.heading)}</strong>
                                        {rebarStatus.gpus.length > 0 && (
                                                <div className="rebar-status-gpus">
                                                        {rebarStatus.gpus.map((gpu) => (
                                                                <span key={gpu.pciBusId}>
                                                                        <b>{gpu.productName}</b>
                                                                        {gpu.bar1TotalBytes && (
                                                                                <>
                                                                                        {" · "}BAR1 {bytes(gpu.bar1TotalBytes)}
                                                                                </>
                                                                        )}
                                                                        {rebarStatus.tone === "expanded" &&
                                                                                rebarStatus.driverVersion && (
                                                                                        <>
                                                                                                {" · "}{t("Driver")} {rebarStatus.driverVersion}
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
                                <aside aria-label={t("System status")}>
                                        <h2>{t("System gate")}</h2>
                                        <Status
                                                label={t("Windows")}
                                                ok={snap.platform.supported}
                                        />
                                        <Status
                                                label={t("UEFI boot")}
                                                ok={snap.platform.uefi}
                                        />
                                        <Status
                                                label={t("Administrator")}
                                                ok={snap.platform.elevated}
                                        />
                                        <Status
                                                label={t("Firmware access")}
                                                ok={snap.firmware.accessible}
                                        />
                                        <hr />
                                        <dl>
                                                <dt>{t("Driver state")}</dt>
                                                <dd>
                                                        {snap.driverStatus
                                                                ? t(snap.driverStatus.label) :
                                                                t("Unavailable")}
                                                </dd>
                                                <dt>{t("Saved variable")}</dt>
                                                <dd>
                                                        {snap.firmware
                                                                .configVariablePresent ===
                                                        null
                                                                ? t("Unknown")
                                                                : snap.firmware
                                                                            .configVariablePresent
                                                                  ? t("Present")
                                                                  : t("Not present")}
                                                </dd>
                                                <dt>{t("Architecture")}</dt>
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
                                                >{t("Restart as administrator")}</button>
                                        )}
                                        <div className="rail-note">
                                                <strong>{t("Hardware changes")}</strong>
                                                <p>{t("After changing a GPU or PCI topology, refresh the system and review the saved selectors.")}</p>
                                        </div>
                                </aside>
                                <main className="content">
                                        <section className="intro">
                                                <div>
                                                        <span className="kicker">{t("ACTIVE SYSTEM / EDITABLE DRAFT")}</span>
                                                        <h2>{t("Configure what firmware applies at next boot")}</h2>
                                                        <p>{t("Changes are written to a UEFI variable and take effect after Windows restarts.")}</p>
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
                                                        <strong>{t("Operation failed")}</strong>
                                                        <span>{t(error)}</span>
                                                        <button
                                                                onClick={() =>
                                                                        setError(
                                                                                "",
                                                                        )
                                                                }
                                                                aria-label={t("Dismiss error")}
                                                        >
                                                                ×
                                                        </button>
                                                </div>
                                        )}
                                        {snap.notices.map((n, i) => (
                                                <div
                                                        className={`notice ${n.kind}`}
                                                        key={i}
                                                >
                                                        {t(n.message)}
                                                </div>
                                        ))}
                                        <section className="panel">
                                                <div className="section-head">
                                                        <div>
                                                                <span className="step">
                                                                        01
                                                                </span>
                                                                <h3>{t("Automatic policy")}</h3>
                                                        </div>
                                                        <p>{t("Choose the default behavior before adding device-specific exceptions.")}</p>
                                                </div>
                                                <div
                                                        className="mode-grid"
                                                        role="radiogroup"
                                                        aria-label={t("Automatic GPU policy")}
                                                >
                                                        {[
                                                                [
                                                                        0,
                                                                        t("Off"),
                                                                        t("Only explicit GPU rules are used."),
                                                                ],
                                                                [
                                                                        1,
                                                                        t("Registry only"),
                                                                        t("Use sizes from the upstream Turing registry."),
                                                                ],
                                                                [
                                                                        2,
                                                                        t("Registry + fallback"),
                                                                        t("Use the registry, or 2 GiB for otherwise unlisted Turing GPUs."),
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
                                                        <span>{t("Target PCI BAR size")}</span>
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
                                                                <option value="0">{t("System default")}</option>
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
                                                                <option value="32">{t("Any supported size")}</option>
                                                                <option value="64">{t("Selected GPUs only")}</option>
                                                                <option value="65">{t("GPU straps only")}</option>
                                                        </select>
                                                        <small>{t("Special modes 64 and 65 limit PCI-side changes. Review validation errors before saving.")}</small>
                                                </label>
                                        </section>
                                        <section className="panel">
                                                <div className="section-head">
                                                        <div>
                                                                <span className="step">
                                                                        02
                                                                </span>
                                                                <h3>{t("Detected GPUs & rules")}</h3>
                                                        </div>
                                                        <p>{t("Match rules by PCI location. Maximum eight.")}</p>
                                                </div>
                                                {snap.devices.length === 0 ? (
                                                        <div className="empty">
                                                                <strong>{t("No NVIDIA display adapters detected")}</strong>
                                                                <span>{t("Refresh after verifying the device is present in Windows Device Manager.")}</span>
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
                                                                                                        {t("Current BAR aperture")}{" "}
                                                                                                        <b>
                                                                                                                {bytes(
                                                                                                                        g.currentBarSize,
                                                                                                                )}
                                                                                                        </b>
                                                                                                </span>
                                                                                                <span>
                                                                                                        {t("Family")}{" "}
                                                                                                        <b>
                                                                                                                {g.isTuring
                                                                                                                        ? "Turing"
                                                                                                                        : t("Other")}
                                                                                                        </b>
                                                                                                </span>
                                                                                                <span>
                                                                                                        {t("Effective")}{" "}
                                                                                                        <b>
                                                                                                                {g.effectiveBarSizeSelector ===
                                                                                                                null
                                                                                                                        ? t("None")
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
                                                                                                        + {t("Add explicit rule")}
                                                                                                </button>
                                                                                        ) : (
                                                                                                <div className="rule">
                                                                                                        <label>{t("Match scope")}<select
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
                                                                                                                        <option value="device">{t("Device ID")}</option>
                                                                                                                        <option value="subsystem">{t("Subsystem")}</option>
                                                                                                                        <option value="location">{t("PCI location")}</option>
                                                                                                                </select>
                                                                                                        </label>
                                                                                                        <label>{t("Action / size")}<select
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
                                                                                                                        <option value="">{t("No explicit size")}</option>
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
                                                                                                                        <option value="254">{t("Exclude GPU")}</option>
                                                                                                                </select>
                                                                                                        </label>
                                                                                                        <label>{t("Size-mask override")}<select
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
                                                                                                                        <option value="inherit">{t("Inherit global")}</option>
                                                                                                                        <option value="true">{t("Force enabled")}</option>
                                                                                                                        <option value="false">{t("Force disabled")}</option>
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
                                                                                                        >{t("Remove")}</button>
                                                                                                </div>
                                                                                        )}
                                                                                </article>
                                                                        );
                                                                },
                                                        )
                                                )}
                                                {draft.rules.length > 0 && (
                                                        <div className="all-rules">
                                                                <h4>{t("All configured rules")}</h4>
                                                                <p>{t("Every saved scope remains directly editable, including overlapping priority rules.")}</p>
                                                                {draft.rules.map(
                                                                        (
                                                                                r,
                                                                                i,
                                                                        ) => (
                                                                                <div
                                                                                        className="rule"
                                                                                        key={`${r.matchScope}-${r.deviceId}-${r.subsystemVendorId}-${r.subsystemDeviceId}-${r.bus}-${r.device}-${r.function}`}
                                                                                >
                                                                                        <label>{t("Match scope")}<select
                                                                                                        aria-label={`Rule ${i + 1} match scope`}
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
                                                                                                        <option value="device">{t("Device ID")}</option>
                                                                                                        <option value="subsystem">{t("Subsystem")}</option>
                                                                                                        <option value="location">{t("PCI location")}</option>
                                                                                                </select>
                                                                                        </label>
                                                                                        <label>{t("Action / size")}<select
                                                                                                        aria-label={`Rule ${i + 1} action / size`}
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
                                                                                                        <option value="">{t("No explicit size")}</option>
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
                                                                                                        <option value="254">{t("Exclude GPU")}</option>
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
                                                                <h3>{t("Firmware behavior")}</h3>
                                                        </div>
                                                                <p>{t("Choose change detection, BAR mask, and resume behavior.")}</p>
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
                                                                        <strong>{t("Check Setup variable changes")}</strong>
                                                                        <small>{t("Compare the Setup variable fingerprint before applying configuration.")}</small>
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
                                                                        <strong>{t("Override BAR size mask globally")}</strong>
                                                                        <small>{t("Advertise the configured size when capability masks differ.")}</small>
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
                                                                        <strong>{t("Skip S3 resume reconfiguration")}</strong>
                                                                        <small>{t("Test S3 resume on this computer after enabling this option.")}</small>
                                                                </span>
                                                        </label>
                                                </div>
                                        </section>
                                        <section
                                                className="review"
                                                aria-live="polite"
                                        >
                                                <div>
                                                        <span className="kicker">{t("VALIDATION")}</span>
                                                        {!dirty ? (
                                                                <h3>{t("No pending changes")}</h3>
                                                        ) : !report ? (
                                                                <h3>{t("Checking draft…")}</h3>
                                                        ) : report.valid ? (
                                                                <>
                                                                        <h3>{t("Draft is ready for review")}</h3>
                                                                        <p>
                                                                                {validationSummary(report.affectedGpuIds.length, report.encodedSize)}
                                                                        </p>
                                                                </>
                                                        ) : (
                                                                <>
                                                                        <h3>{t("Draft needs correction")}</h3>
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
                                                                                                {t(x)}
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
                                                        >{t("Discard edits")}</button>
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
                                                        >{t("Review & save")}</button>
                                                </div>
                                        </section>
                                        {report?.warnings.map((w) => (
                                                <div
                                                        className="notice warning"
                                                        key={w}
                                                >
                                                        {t(w)}
                                                </div>
                                        ))}
                                        {receipt && (
                                                <div
                                                        className="receipt"
                                                        role="status"
                                                >
                                                        <strong>{t("Configuration written and read back")}</strong>
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
                                                        <p>{t("Restart Windows when ready. The firmware driver cannot apply this configuration until the next boot.")}</p>
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
                                                <span className="kicker">{t("CONSEQUENTIAL WRITE")}</span>
                                                <h2 id="confirm-title">{t("Write this draft to UEFI firmware?")}</h2>
                                                <p>{t("The application will write and read back the NvStrapsReBar configuration variable. A restart is required before the driver can apply it.")}</p>
                                                <div className="warning-box">
                                                        <strong>{t("Before you continue")}</strong>
                                                        <span>{t("Confirm the detected GPU and PCI topology match this machine. Hardware changes can make saved selectors stale.")}</span>
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
                                                        >{t("Cancel")}</button>
                                                        <button
                                                                className="primary danger-button"
                                                                onClick={() =>
                                                                        void save()
                                                                }
                                                        >{t("Write configuration")}</button>
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
