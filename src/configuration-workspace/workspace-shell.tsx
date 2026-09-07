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
import { useDeploymentWorkspaceController } from "../deployment-workspace/context";

const Status = ({ label, ok }: { label: string; ok: boolean }) => (
        <span className={"status " + (ok ? "ok" : "bad")}>
                <i />
                {label}
        </span>
);

export const ApplicationHeader = ({ surface }: { surface: ApplicationSurface }) => {
        const { locale, setLocale, t } = useI18n();
        const { dirty, load, busy } = useConfigurationWorkspaceController();
        const { view } = useDeploymentWorkspaceController();
        const deploymentBusy = Boolean(view.busyAction) || view.showManual || view.showReboot || view.showConfigurationReboot;
        return (
                <header className="workspace-header">
                        <h1 tabIndex={-1}>{t(surface === "overview" ? "ui.overview" : surface === "deploy" ? "ui.stepInstallFirmware" : "ui.barSettings")}</h1>
                        <div className="header-actions">
                                {surface === "bar" && dirty && <span className="dirty">{t("ui.unsavedEdits")}</span>}
                                <label className="language-select"><span>{t("ui.language")}</span>
                                        <select data-testid="language-select" aria-label={t("ui.language")} value={locale} onChange={(event) => setLocale(event.target.value as "en" | "ko")}>
                                                <option value="en">English</option><option value="ko">한국어</option>
                                        </select>
                                </label>
                                <button className="quiet" onClick={() => void load(true)} disabled={busy || deploymentBusy}>{t("ui.refreshSystem")}</button>
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

export const ResizableBarHero = ({ compact = false }: { compact?: boolean }) => {
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
                        className={`rebar-hero ${rebarStatus.tone}${compact ? " compact" : ""}`}
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
                                                        role="group"
                                                        aria-label={t("ui.gpuObservedState", {
                                                                gpu: row.gpu.productName,
                                                                state: t(row.apertureId),
                                                                size: row.gpu.bar1TotalBytes ? formatBytes(row.gpu.bar1TotalBytes) : t("ui.unavailable"),
                                                        })}
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
