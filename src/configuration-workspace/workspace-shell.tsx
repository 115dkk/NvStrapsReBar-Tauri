import {
        settingsLockMessageId,
        type ApplicationSurface,
} from "../bar-settings-routing";
import { useI18n } from "../i18n";
import { driverStatusMessageId } from "../system-messages";
import { useConfigurationWorkspaceController } from "./context";
import { formatBytes } from "./model";

const Status = ({ label, ok }: { label: string; ok: boolean }) => (
        <span className={"status " + (ok ? "ok" : "bad")}>
                <i />
                {label}
        </span>
);

export const ApplicationHeader = ({
        surface,
        setSurface,
}: {
        surface: ApplicationSurface;
        setSurface: (surface: ApplicationSurface) => void;
}) => {
        const { locale, setLocale, t } = useI18n();
        const { licenseButton, setShowLicenses, dirty, load, busy, snap } =
                useConfigurationWorkspaceController();
        const lockMessageId = snap ? settingsLockMessageId(snap) : null;
        return (
                <header>
                        <div className="product-heading">
                                <span className="product">
                                        NVSTRAPS / REBAR
                                </span>
                                <div className="title-row">
                                        <h1>
                                                {surface === "configure"
                                                        ? t(
                                                                  "ui.firmwareConfiguration",
                                                          )
                                                        : surface === "settings"
                                                          ? t(
                                                                    "ui.barSettings",
                                                            )
                                                          : t(
                                                                  "ui.deploymentWorkspace",
                                                          )}
                                        </h1>
                                        <button
                                                ref={licenseButton}
                                                className="license-button quiet"
                                                onClick={() =>
                                                        setShowLicenses(true)
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
                                                onChange={(event) =>
                                                        setLocale(
                                                                event.target
                                                                        .value as
                                                                        | "en"
                                                                        | "ko",
                                                        )
                                                }
                                        >
                                                <option value="en">
                                                        English
                                                </option>
                                                <option value="ko">
                                                        한국어
                                                </option>
                                        </select>
                                </label>
                                <nav
                                        className="surface-nav"
                                        aria-label={t(
                                                "ui.applicationWorkspace",
                                        )}
                                >
                                        <button
                                                aria-current={
                                                        surface === "configure"
                                                                ? "page"
                                                                : undefined
                                                }
                                                onClick={() =>
                                                        setSurface("configure")
                                                }
                                        >
                                                {t("ui.configure")}
                                        </button>
                                        <button
                                                aria-current={
                                                        surface === "settings"
                                                                ? "page"
                                                                : undefined
                                                }
                                                aria-describedby={
                                                        lockMessageId
                                                                ? "settings-lock-reason"
                                                                : undefined
                                                }
                                                disabled={Boolean(lockMessageId)}
                                                onClick={() =>
                                                        setSurface("settings")
                                                }
                                        >
                                                {t("ui.settings")}
                                        </button>
                                        <button
                                                aria-current={
                                                        surface === "deploy"
                                                                ? "page"
                                                                : undefined
                                                }
                                                onClick={() =>
                                                        setSurface("deploy")
                                                }
                                        >
                                                {t("ui.deploy")}
                                        </button>
                                </nav>
                                {(surface === "configure" ||
                                        surface === "settings") && (
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
                                >
                                        {t("ui.refreshSystem")}
                                </button>
                        </div>
                </header>
        );
};

export const ResizableBarStatusStrip = () => {
        const { t } = useI18n();
        const { motherboardSupport, rebarStatus } =
                useConfigurationWorkspaceController();
        if (!motherboardSupport) return null;
        return (
                <section
                        className="rebar-status-strip"
                        aria-label={t("ui.resizableBarStatus")}
                >
                        <div
                                className={`motherboard-support-status ${motherboardSupport.tone}`}
                                aria-label={t(
                                        "ui.motherboardResizableBarSupportState",
                                        {
                                                status: t(
                                                        motherboardSupport.statusId,
                                                ),
                                        },
                                )}
                        >
                                <span>
                                        {t("ui.motherboardResizableBarSupport")}
                                </span>
                                <strong aria-hidden="true">
                                        {motherboardSupport.symbol}
                                </strong>
                                <span className="visually-hidden">
                                        {t(motherboardSupport.statusId)}
                                </span>
                                {motherboardSupport.boardProduct && (
                                        <span>
                                                {
                                                        motherboardSupport.boardProduct
                                                }
                                        </span>
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
                                                                key={
                                                                        row.gpu
                                                                                .pciBusId
                                                                }
                                                        >
                                                                <b>
                                                                        {
                                                                                row
                                                                                        .gpu
                                                                                        .productName
                                                                        }
                                                                </b>
                                                                {row.gpu
                                                                        .bar1TotalBytes && (
                                                                        <>
                                                                                {
                                                                                        " · "
                                                                                }
                                                                                BAR1{" "}
                                                                                {formatBytes(
                                                                                        row
                                                                                                .gpu
                                                                                                .bar1TotalBytes,
                                                                                )}
                                                                        </>
                                                                )}
                                                                {" · "}
                                                                {t(
                                                                        row.apertureId,
                                                                )}
                                                                {rebarStatus.driverVersion && (
                                                                        <>
                                                                                {
                                                                                        " · "
                                                                                }
                                                                                {t(
                                                                                        "ui.driver",
                                                                                )}{" "}
                                                                                {
                                                                                        rebarStatus.driverVersion
                                                                                }
                                                                        </>
                                                                )}
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
                                                                        {t(
                                                                                "ui.patchConfiguration",
                                                                        )}{" "}
                                                                        <b>
                                                                                {t(
                                                                                        row.patchStateId,
                                                                                )}
                                                                        </b>
                                                                </span>
                                                                {row.gpu
                                                                        .patchConfiguration
                                                                        .targetSizeBytes && (
                                                                        <>
                                                                                {
                                                                                        " · "
                                                                                }
                                                                                {t(
                                                                                        "ui.targetSize",
                                                                                        {
                                                                                                size: formatBytes(
                                                                                                        row
                                                                                                                .gpu
                                                                                                                .patchConfiguration
                                                                                                                .targetSizeBytes,
                                                                                                ),
                                                                                        },
                                                                                )}
                                                                        </>
                                                                )}
                                                        </span>
                                                ))}
                                        </div>
                                )}
                        </div>
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
                                                ? t(
                                                          driverStatusMessageId(
                                                                  snap.driverStatus,
                                                          ),
                                                  )
                                                : t("ui.unavailable")}
                                </dd>
                                <dt>{t("ui.savedVariable")}</dt>
                                <dd>
                                        {snap.firmware.configVariablePresent ===
                                        null
                                                ? t("ui.unknown")
                                                : snap.firmware
                                                            .configVariablePresent
                                                  ? t("ui.present")
                                                  : t("ui.notPresent")}
                                </dd>
                                <dt>{t("ui.architecture")}</dt>
                                <dd>{snap.platform.architecture}</dd>
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
                        <div className="rail-note">
                                <strong>{t("ui.hardwareChanges")}</strong>
                                <p>
                                        {t(
                                                "ui.afterChangingAGpuOrPciTopologyRefreshTheSystemAndReviewTheSavedSelectors",
                                        )}
                                </p>
                        </div>
                </aside>
        );
};
