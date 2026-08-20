import {
        firmwareInstalled,
        type ApplicationSurface,
} from "../bar-settings-routing";
import { useI18n } from "../i18n";
import type { StaticMessageId } from "../i18n-catalog";
import type { ResizableBarStatusPresentation } from "../resizable-bar-status";
import { driverStatusMessageId } from "../system-messages";
import { useConfigurationWorkspaceController } from "./context";
import { formatBytes } from "./model";

const Status = ({ label, ok }: { label: string; ok: boolean }) => (
        <span className={"status " + (ok ? "ok" : "bad")}>
                <i />
                {label}
        </span>
);

const SurfaceStep = ({
        number,
        label,
        done,
        current,
        onSelect,
}: {
        number: number;
        label: string;
        done: boolean;
        current: boolean;
        onSelect: () => void;
}) => (
        <button
                className="surface-step"
                aria-label={label}
                aria-current={current ? "page" : undefined}
                onClick={onSelect}
        >
                <i className={done ? "done" : "todo"} aria-hidden="true">
                        {done ? "✓" : number}
                </i>
                <span>{label}</span>
        </button>
);

export const ApplicationHeader = ({
        surface,
        setSurface,
}: {
        surface: ApplicationSurface;
        setSurface: (surface: ApplicationSurface) => void;
}) => {
        const { locale, setLocale, t } = useI18n();
        const {
                licenseButton,
                setShowLicenses,
                dirty,
                load,
                busy,
                snap,
                rebarStatus,
        } = useConfigurationWorkspaceController();
        return (
                <header>
                        <div className="product-heading">
                                <span className="product">NVSTRAPS / REBAR</span>
                                <div className="title-row">
                                        <h1>
                                                {surface === "bar"
                                                        ? t("ui.barSettings")
                                                        : t("ui.stepInstallFirmware")}
                                        </h1>
                                        <button
                                                ref={licenseButton}
                                                className="license-button quiet"
                                                onClick={() => setShowLicenses(true)}
                                        >
                                                {t("ui.licenses")}
                                        </button>
                                </div>
                                <p className="tagline">{t("ui.tagline")}</p>
                        </div>
                        <div className="header-actions">
                                <label className="language-select">
                                        <span>{t("ui.language")}</span>
                                        <select
                                                data-testid="language-select"
                                                aria-label={t("ui.language")}
                                                value={locale}
                                                onChange={(event) =>
                                                        setLocale(
                                                                event.target.value as "en" | "ko",
                                                        )
                                                }
                                        >
                                                <option value="en">English</option>
                                                <option value="ko">한국어</option>
                                        </select>
                                </label>
                                <nav
                                        className="surface-nav"
                                        aria-label={t("ui.applicationWorkspace")}
                                >
                                        <SurfaceStep
                                                number={1}
                                                label={t("ui.stepInstallFirmware")}
                                                done={Boolean(snap && firmwareInstalled(snap))}
                                                current={surface === "deploy"}
                                                onSelect={() => setSurface("deploy")}
                                        />
                                        <SurfaceStep
                                                number={2}
                                                label={t("ui.barSettings")}
                                                done={rebarStatus.tone === "expanded"}
                                                current={surface === "bar"}
                                                onSelect={() => setSurface("bar")}
                                        />
                                </nav>
                                {surface === "bar" && (
                                        <span className={dirty ? "dirty" : "saved"}>
                                                {dirty ? t("ui.unsavedEdits") : t("ui.inSync")}
                                        </span>
                                )}
                                <button
                                        className="quiet"
                                        onClick={() => void load(true)}
                                        disabled={busy}
                                >
                                        {t("ui.refreshSystem")}
                                </button>
                        </div>
                </header>
        );
};

const verdictIds: Record<
        ResizableBarStatusPresentation["tone"],
        { headingId: StaticMessageId; detailId: StaticMessageId }
> = {
        loading: {
                headingId: "ui.checkingResizableBar",
                detailId: "ui.rebarVerdictCheckingDetail",
        },
        expanded: {
                headingId: "ui.rebarVerdictActive",
                detailId: "ui.rebarVerdictActiveDetail",
        },
        legacy: {
                headingId: "ui.rebarVerdictLegacy",
                detailId: "ui.rebarVerdictLegacyDetail",
        },
        mixed: {
                headingId: "ui.rebarVerdictMixed",
                detailId: "ui.rebarVerdictMixedDetail",
        },
        unavailable: {
                headingId: "ui.rebarVerdictUnavailable",
                detailId: "ui.rebarVerdictUnavailableDetail",
        },
};

const GpuBarVisual = ({
        row,
}: {
        row: ResizableBarStatusPresentation["gpus"][number];
}) => {
        const { t } = useI18n();
        const target = row.gpu.patchConfiguration.targetSizeBytes;
        if (row.gpu.state === "expanded")
                return (
                        <span className="bar-visual" aria-hidden="true">
                                <b className="bar-block expanded">
                                        {row.gpu.bar1TotalBytes
                                                ? formatBytes(row.gpu.bar1TotalBytes)
                                                : t("ui.apertureExpanded")}
                                </b>
                        </span>
                );
        if (row.gpu.state === "legacy256MiB")
                return (
                        <span className="bar-visual" aria-hidden="true">
                                <b className="bar-block small">256 MiB</b>
                                <i className="bar-arrow">→</i>
                                <b className="bar-block target">
                                        {target ? formatBytes(target) : "≥ 1 GiB"}
                                </b>
                        </span>
                );
        return (
                <span className="bar-visual" aria-hidden="true">
                        <b className="bar-block indeterminate">?</b>
                </span>
        );
};

export const ResizableBarHero = () => {
        const { t } = useI18n();
        const { snap, motherboardSupport, rebarStatus } =
                useConfigurationWorkspaceController();
        if (!snap || !motherboardSupport) return null;
        const verdict = verdictIds[rebarStatus.tone];
        const detailId =
                rebarStatus.tone === "legacy" && !firmwareInstalled(snap)
                        ? "ui.heroNextInstall"
                        : verdict.detailId;
        return (
                <section
                        className={`rebar-hero ${rebarStatus.tone}`}
                        aria-label={t("ui.resizableBarStatus")}
                >
                        <div
                                className="hero-verdict"
                                role="status"
                                aria-live="polite"
                        >
                                <strong>
                                        <i className="verdict-dot" aria-hidden="true" />
                                        {t(verdict.headingId)}
                                </strong>
                                <p>{t(detailId)}</p>
                                <span
                                        className={`motherboard-support-status ${motherboardSupport.tone}`}
                                        aria-label={t(
                                                "ui.motherboardResizableBarSupportState",
                                                {
                                                        status: t(motherboardSupport.statusId),
                                                },
                                        )}
                                >
                                        {t("ui.motherboardResizableBarSupport")}{" "}
                                        <b>{t(motherboardSupport.statusId)}</b>
                                        {motherboardSupport.boardProduct && (
                                                <>
                                                        {" · "}
                                                        {motherboardSupport.boardProduct}
                                                </>
                                        )}
                                </span>
                        </div>
                        {rebarStatus.gpus.length > 0 && (
                                <div className="hero-gpus">
                                        {rebarStatus.gpus.map((row) => (
                                                <div
                                                        className="rebar-gpu-row"
                                                        key={row.gpu.pciBusId}
                                                >
                                                        <span className="hero-gpu-name">
                                                                {row.gpu.productName}
                                                        </span>
                                                        <GpuBarVisual row={row} />
                                                        <span className="hero-gpu-caption">
                                                                {row.gpu.bar1TotalBytes && (
                                                                        <>
                                                                                BAR1{" "}
                                                                                {formatBytes(
                                                                                        row.gpu.bar1TotalBytes,
                                                                                )}
                                                                                {" · "}
                                                                        </>
                                                                )}
                                                                {t(row.apertureId)}
                                                                <span
                                                                        className={`rebar-patch-state ${row.patchTone}`}
                                                                        aria-label={t(
                                                                                "ui.patchConfigurationState",
                                                                                {
                                                                                        status: t(
                                                                                                row.patchStateId,
                                                                                        ),
                                                                                },
                                                                        )}
                                                                >
                                                                        {" · "}
                                                                        {t("ui.patchConfiguration")}{" "}
                                                                        <b>{t(row.patchStateId)}</b>
                                                                </span>
                                                                {rebarStatus.driverVersion && (
                                                                        <>
                                                                                {" · "}
                                                                                {t("ui.driver")}{" "}
                                                                                {rebarStatus.driverVersion}
                                                                        </>
                                                                )}
                                                        </span>
                                                </div>
                                        ))}
                                </div>
                        )}
                </section>
        );
};

export const SystemStatusSidebar = () => {
        const { t } = useI18n();
        const { snap, busy, elevate } = useConfigurationWorkspaceController();
        if (!snap) return null;
        return (
                <aside aria-label={t("ui.systemStatus")}>
                        <h2>{t("ui.systemGate")}</h2>
                        <Status
                                label={t("ui.windows")}
                                ok={snap.platform.supported}
                        />
                        <Status label={t("ui.uefiBoot")} ok={snap.platform.uefi} />
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
                                                ? t(
                                                                driverStatusMessageId(
                                                                        snap.driverStatus,
                                                                ),
                                                        )
                                                : t("ui.unavailable")}
                                </dd>
                        </dl>
                        {!snap.platform.elevated && (
                                <button
                                        className="elevate"
                                        disabled={busy}
                                        onClick={() => void elevate()}
                                >
                                        {t("ui.restartAsAdministrator")}
                                </button>
                        )}
                </aside>
        );
};
