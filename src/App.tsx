import { useEffect, useMemo, useRef, useState } from "react";
import { bridge, previewMode } from "./bridge";
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
        const [snap, setSnap] = useState<SystemSnapshot | null>(null),
                [draft, setDraft] = useState<ConfigDraft>(DEFAULT_DRAFT),
                [baseline, setBaseline] = useState<ConfigDraft>(DEFAULT_DRAFT),
                [report, setReport] = useState<ValidationReport | null>(null),
                [error, setError] = useState(""),
                [busy, setBusy] = useState(true),
                [showConfirm, setShowConfirm] = useState(false),
                [receipt, setReceipt] = useState<SaveReceipt | null>(null);
        const validationSequence = useRef(0),
                reviewButton = useRef<HTMLButtonElement>(null),
                dialog = useRef<HTMLDivElement>(null);
        const dirty = useMemo(
                () => JSON.stringify(draft) !== JSON.stringify(baseline),
                [draft, baseline],
        );
        const load = async (refresh = false) => {
                if (
                        dirty &&
                        refresh &&
                        !confirm("Discard unsaved edits and refresh hardware?")
                )
                        return;
                setBusy(true);
                setError("");
                try {
                        const s = await (refresh
                                ? bridge.refresh()
                                : bridge.snapshot());
                        setSnap(s);
                        const d = s.config?.draft ?? DEFAULT_DRAFT;
                        setDraft(structuredClone(d));
                        setBaseline(structuredClone(d));
                        setReport(null);
                } catch (e) {
                        setError(
                                (e as { message?: string }).message ||
                                        String(e),
                        );
                } finally {
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
                                const next = await bridge.refresh();
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
                                        `Configuration was saved and verified, but system state could not be refreshed: ${(refreshError as { message?: string }).message || String(refreshError)}`,
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
                                <h1>Reading system state</h1>
                                <p>
                                        Inspecting UEFI access and NVIDIA
                                        adapters…
                                </p>
                        </main>
                );
        if (!snap)
                return (
                        <main className="center">
                                <h1>System state unavailable</h1>
                                <p>
                                        {error ||
                                                "The native bridge did not return a snapshot."}
                                </p>
                                <button onClick={() => load()}>
                                        Try again
                                </button>
                        </main>
                );
        return (
                <div className="app">
                        {previewMode && (
                                <div className="preview" role="status">
                                        PREVIEW DATA · Browser fixture only · No
                                        firmware is being read or written
                                </div>
                        )}
                        <header>
                                <div>
                                        <span className="product">
                                                NVSTRAPS / REBAR
                                        </span>
                                        <h1>Firmware configuration</h1>
                                </div>
                                <div className="header-actions">
                                        <span
                                                className={
                                                        dirty
                                                                ? "dirty"
                                                                : "saved"
                                                }
                                        >
                                                {dirty
                                                        ? "UNSAVED EDITS"
                                                        : "IN SYNC"}
                                        </span>
                                        <button
                                                className="quiet"
                                                onClick={() => void load(true)}
                                                disabled={busy}
                                        >
                                                Refresh system
                                        </button>
                                </div>
                        </header>
                        <div className="workspace">
                                <aside aria-label="System status">
                                        <h2>System gate</h2>
                                        <Status
                                                label="Windows"
                                                ok={snap.platform.supported}
                                        />
                                        <Status
                                                label="UEFI boot"
                                                ok={snap.platform.uefi}
                                        />
                                        <Status
                                                label="Administrator"
                                                ok={snap.platform.elevated}
                                        />
                                        <Status
                                                label="Firmware access"
                                                ok={snap.firmware.accessible}
                                        />
                                        <hr />
                                        <dl>
                                                <dt>Driver state</dt>
                                                <dd>
                                                        {snap.driverStatus
                                                                ?.label ??
                                                                "Unavailable"}
                                                </dd>
                                                <dt>Saved variable</dt>
                                                <dd>
                                                        {snap.firmware
                                                                .configVariablePresent ===
                                                        null
                                                                ? "Unknown"
                                                                : snap.firmware
                                                                            .configVariablePresent
                                                                  ? "Present"
                                                                  : "Not present"}
                                                </dd>
                                                <dt>Architecture</dt>
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
                                                >
                                                        Restart as administrator
                                                </button>
                                        )}
                                        <div className="rail-note">
                                                <strong>Hardware safety</strong>
                                                <p>
                                                        GPU or PCI topology
                                                        changes can invalidate
                                                        saved selectors. Refresh
                                                        and validate after any
                                                        hardware change.
                                                </p>
                                        </div>
                                </aside>
                                <main className="content">
                                        <section className="intro">
                                                <div>
                                                        <span className="kicker">
                                                                ACTIVE SYSTEM /
                                                                EDITABLE DRAFT
                                                        </span>
                                                        <h2>
                                                                Configure what
                                                                firmware applies
                                                                at next boot
                                                        </h2>
                                                        <p>
                                                                Changes are
                                                                written to a
                                                                UEFI variable.
                                                                They do not take
                                                                effect until
                                                                Windows is
                                                                restarted.
                                                        </p>
                                                </div>
                                                <div className="count">
                                                        <b>
                                                                {
                                                                        snap
                                                                                .devices
                                                                                .length
                                                                }
                                                        </b>
                                                        <span>
                                                                NVIDIA GPU
                                                                {snap.devices
                                                                        .length ===
                                                                1
                                                                        ? ""
                                                                        : "s"}
                                                        </span>
                                                </div>
                                        </section>
                                        {error && (
                                                <div
                                                        className="notice error"
                                                        role="alert"
                                                >
                                                        <strong>
                                                                Operation failed
                                                        </strong>
                                                        <span>{error}</span>
                                                        <button
                                                                onClick={() =>
                                                                        setError(
                                                                                "",
                                                                        )
                                                                }
                                                                aria-label="Dismiss error"
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
                                                        {n.message}
                                                </div>
                                        ))}
                                        <section className="panel">
                                                <div className="section-head">
                                                        <div>
                                                                <span className="step">
                                                                        01
                                                                </span>
                                                                <h3>
                                                                        Automatic
                                                                        policy
                                                                </h3>
                                                        </div>
                                                        <p>
                                                                Choose the
                                                                default behavior
                                                                before adding
                                                                device-specific
                                                                exceptions.
                                                        </p>
                                                </div>
                                                <div
                                                        className="mode-grid"
                                                        role="radiogroup"
                                                        aria-label="Automatic GPU policy"
                                                >
                                                        {[
                                                                [
                                                                        0,
                                                                        "Off",
                                                                        "Only explicit GPU rules are used.",
                                                                ],
                                                                [
                                                                        1,
                                                                        "Registry only",
                                                                        "Use sizes from the upstream Turing registry.",
                                                                ],
                                                                [
                                                                        2,
                                                                        "Registry + fallback",
                                                                        "Use the registry, or 2 GiB for otherwise unlisted Turing GPUs.",
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
                                                        <span>
                                                                Target PCI BAR
                                                                size
                                                        </span>
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
                                                                <option value="0">
                                                                        System
                                                                        default
                                                                </option>
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
                                                                <option value="32">
                                                                        Any
                                                                        supported
                                                                        size
                                                                </option>
                                                                <option value="64">
                                                                        Selected
                                                                        GPUs
                                                                        only
                                                                </option>
                                                                <option value="65">
                                                                        GPU
                                                                        straps
                                                                        only
                                                                </option>
                                                        </select>
                                                        <small>
                                                                Special modes 64
                                                                and 65 constrain
                                                                PCI-side
                                                                changes;
                                                                validation
                                                                remains
                                                                authoritative.
                                                        </small>
                                                </label>
                                        </section>
                                        <section className="panel">
                                                <div className="section-head">
                                                        <div>
                                                                <span className="step">
                                                                        02
                                                                </span>
                                                                <h3>
                                                                        Detected
                                                                        GPUs &
                                                                        rules
                                                                </h3>
                                                        </div>
                                                        <p>
                                                                Rules are
                                                                matched most
                                                                safely by PCI
                                                                location.
                                                                Maximum eight.
                                                        </p>
                                                </div>
                                                {snap.devices.length === 0 ? (
                                                        <div className="empty">
                                                                <strong>
                                                                        No
                                                                        NVIDIA
                                                                        display
                                                                        adapters
                                                                        detected
                                                                </strong>
                                                                <span>
                                                                        Refresh
                                                                        after
                                                                        verifying
                                                                        the
                                                                        device
                                                                        is
                                                                        present
                                                                        in
                                                                        Windows
                                                                        Device
                                                                        Manager.
                                                                </span>
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
                                                                                                        BAR0{" "}
                                                                                                        <b>
                                                                                                                {bytes(
                                                                                                                        g.currentBarSize,
                                                                                                                )}
                                                                                                        </b>
                                                                                                </span>
                                                                                                <span>
                                                                                                        Family{" "}
                                                                                                        <b>
                                                                                                                {g.isTuring
                                                                                                                        ? "Turing"
                                                                                                                        : "Other"}
                                                                                                        </b>
                                                                                                </span>
                                                                                                <span>
                                                                                                        Effective{" "}
                                                                                                        <b>
                                                                                                                {g.effectiveBarSizeSelector ===
                                                                                                                null
                                                                                                                        ? "None"
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
                                                                                                        +
                                                                                                        Add
                                                                                                        explicit
                                                                                                        rule
                                                                                                </button>
                                                                                        ) : (
                                                                                                <div className="rule">
                                                                                                        <label>
                                                                                                                Match
                                                                                                                scope
                                                                                                                <select
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
                                                                                                                        <option value="device">
                                                                                                                                Device
                                                                                                                                ID
                                                                                                                        </option>
                                                                                                                        <option value="subsystem">
                                                                                                                                Subsystem
                                                                                                                        </option>
                                                                                                                        <option value="location">
                                                                                                                                PCI
                                                                                                                                location
                                                                                                                        </option>
                                                                                                                </select>
                                                                                                        </label>
                                                                                                        <label>
                                                                                                                Action
                                                                                                                /
                                                                                                                size
                                                                                                                <select
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
                                                                                                                        <option value="">
                                                                                                                                No
                                                                                                                                explicit
                                                                                                                                size
                                                                                                                        </option>
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
                                                                                                                        <option value="254">
                                                                                                                                Exclude
                                                                                                                                GPU
                                                                                                                        </option>
                                                                                                                </select>
                                                                                                        </label>
                                                                                                        <label>
                                                                                                                Size-mask
                                                                                                                override
                                                                                                                <select
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
                                                                                                                        <option value="inherit">
                                                                                                                                Inherit
                                                                                                                                global
                                                                                                                        </option>
                                                                                                                        <option value="true">
                                                                                                                                Force
                                                                                                                                enabled
                                                                                                                        </option>
                                                                                                                        <option value="false">
                                                                                                                                Force
                                                                                                                                disabled
                                                                                                                        </option>
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
                                                                                                        >
                                                                                                                Remove
                                                                                                        </button>
                                                                                                </div>
                                                                                        )}
                                                                                </article>
                                                                        );
                                                                },
                                                        )
                                                )}
                                                {draft.rules.length > 0 && (
                                                        <div className="all-rules">
                                                                <h4>
                                                                        All
                                                                        configured
                                                                        rules
                                                                </h4>
                                                                <p>
                                                                        Every
                                                                        saved
                                                                        scope
                                                                        remains
                                                                        directly
                                                                        editable,
                                                                        including
                                                                        overlapping
                                                                        priority
                                                                        rules.
                                                                </p>
                                                                {draft.rules.map(
                                                                        (
                                                                                r,
                                                                                i,
                                                                        ) => (
                                                                                <div
                                                                                        className="rule"
                                                                                        key={`${r.matchScope}-${r.deviceId}-${r.subsystemVendorId}-${r.subsystemDeviceId}-${r.bus}-${r.device}-${r.function}`}
                                                                                >
                                                                                        <label>
                                                                                                Match
                                                                                                scope
                                                                                                <select
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
                                                                                                        <option value="device">
                                                                                                                Device
                                                                                                                ID
                                                                                                        </option>
                                                                                                        <option value="subsystem">
                                                                                                                Subsystem
                                                                                                        </option>
                                                                                                        <option value="location">
                                                                                                                PCI
                                                                                                                location
                                                                                                        </option>
                                                                                                </select>
                                                                                        </label>
                                                                                        <label>
                                                                                                Action
                                                                                                /
                                                                                                size
                                                                                                <select
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
                                                                                                        <option value="">
                                                                                                                No
                                                                                                                explicit
                                                                                                                size
                                                                                                        </option>
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
                                                                                                        <option value="254">
                                                                                                                Exclude
                                                                                                                GPU
                                                                                                        </option>
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
                                                                <h3>
                                                                        Advanced
                                                                        safety
                                                                </h3>
                                                        </div>
                                                        <p>
                                                                Defaults favor
                                                                change detection
                                                                and conservative
                                                                firmware
                                                                behavior.
                                                        </p>
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
                                                                        <strong>
                                                                                Guard
                                                                                against
                                                                                Setup
                                                                                variable
                                                                                changes
                                                                        </strong>
                                                                        <small>
                                                                                Keep
                                                                                the
                                                                                firmware
                                                                                setup
                                                                                fingerprint
                                                                                check
                                                                                enabled.
                                                                        </small>
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
                                                                        <strong>
                                                                                Override
                                                                                BAR
                                                                                size
                                                                                mask
                                                                                globally
                                                                        </strong>
                                                                        <small>
                                                                                Advertise
                                                                                the
                                                                                configured
                                                                                size
                                                                                when
                                                                                capability
                                                                                masks
                                                                                differ.
                                                                        </small>
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
                                                                        <strong>
                                                                                Skip
                                                                                S3
                                                                                resume
                                                                                reconfiguration
                                                                        </strong>
                                                                        <small>
                                                                                Resume
                                                                                behavior
                                                                                must
                                                                                be
                                                                                verified
                                                                                on
                                                                                this
                                                                                machine.
                                                                        </small>
                                                                </span>
                                                        </label>
                                                </div>
                                        </section>
                                        <section
                                                className="review"
                                                aria-live="polite"
                                        >
                                                <div>
                                                        <span className="kicker">
                                                                VALIDATION
                                                        </span>
                                                        {!dirty ? (
                                                                <h3>
                                                                        No
                                                                        pending
                                                                        changes
                                                                </h3>
                                                        ) : !report ? (
                                                                <h3>
                                                                        Checking
                                                                        draft…
                                                                </h3>
                                                        ) : report.valid ? (
                                                                <>
                                                                        <h3>
                                                                                Draft
                                                                                is
                                                                                ready
                                                                                for
                                                                                review
                                                                        </h3>
                                                                        <p>
                                                                                {
                                                                                        report
                                                                                                .affectedGpuIds
                                                                                                .length
                                                                                }{" "}
                                                                                detected
                                                                                GPU(s)
                                                                                affected
                                                                                ·{" "}
                                                                                {
                                                                                        report.encodedSize
                                                                                }{" "}
                                                                                bytes
                                                                                encoded
                                                                        </p>
                                                                </>
                                                        ) : (
                                                                <>
                                                                        <h3>
                                                                                Draft
                                                                                needs
                                                                                correction
                                                                        </h3>
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
                                                                                                {
                                                                                                        x
                                                                                                }
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
                                                        >
                                                                Discard edits
                                                        </button>
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
                                                        >
                                                                Review & save
                                                        </button>
                                                </div>
                                        </section>
                                        {report?.warnings.map((w) => (
                                                <div
                                                        className="notice warning"
                                                        key={w}
                                                >
                                                        {w}
                                                </div>
                                        ))}
                                        {receipt && (
                                                <div
                                                        className="receipt"
                                                        role="status"
                                                >
                                                        <strong>
                                                                Save verified by
                                                                read-back
                                                        </strong>
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
                                                        <p>
                                                                Restart Windows
                                                                when ready. The
                                                                firmware driver
                                                                cannot apply
                                                                this
                                                                configuration
                                                                until the next
                                                                boot.
                                                        </p>
                                                </div>
                                        )}
                                </main>
                        </div>
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
                                                <span className="kicker">
                                                        CONSEQUENTIAL WRITE
                                                </span>
                                                <h2 id="confirm-title">
                                                        Write this draft to UEFI
                                                        firmware?
                                                </h2>
                                                <p>
                                                        The application will
                                                        write and read back the
                                                        NvStrapsReBar
                                                        configuration variable.
                                                        A restart is required
                                                        before the driver can
                                                        apply it.
                                                </p>
                                                <div className="warning-box">
                                                        <strong>
                                                                Before you
                                                                continue
                                                        </strong>
                                                        <span>
                                                                Confirm the
                                                                detected GPU and
                                                                PCI topology
                                                                match this
                                                                machine.
                                                                Hardware changes
                                                                can make saved
                                                                selectors stale.
                                                        </span>
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
                                                        >
                                                                Cancel
                                                        </button>
                                                        <button
                                                                className="primary danger-button"
                                                                onClick={() =>
                                                                        void save()
                                                                }
                                                        >
                                                                Write
                                                                configuration
                                                        </button>
                                                </div>
                                        </div>
                                </div>
                        )}
                </div>
        );
}
