import { translateMessage, useI18n } from "../i18n";
import { useConfigurationWorkspaceController } from "./context";

export const ConfigurationIntro = () => {
        const { locale, t, gpuCountLabel } = useI18n();
        const { snap, error, setError, systemNotices } =
                useConfigurationWorkspaceController();
        if (!snap) return null;
        return (
                <>
                        <section className="intro">
                                <div>
                                        <span className="kicker">
                                                {t(
                                                        "ui.activeSystemEditableDraft",
                                                )}
                                        </span>
                                        <h2>
                                                {t(
                                                        "ui.configureWhatFirmwareAppliesAtNextBoot",
                                                )}
                                        </h2>
                                        <p>
                                                {t(
                                                        "ui.changesAreWrittenToAUefiVariableAndTakeEffectAfterWindowsRestarts",
                                                )}
                                        </p>
                                </div>
                                <div className="count">
                                        <b>{snap.devices.length}</b>
                                        <span>
                                                {gpuCountLabel(
                                                        snap.devices.length,
                                                )}
                                        </span>
                                </div>
                        </section>
                        {error && (
                                <div className="notice error" role="alert">
                                        <strong>
                                                {t("ui.operationFailed")}
                                        </strong>
                                        <span>
                                                {translateMessage(
                                                        locale,
                                                        error,
                                                )}
                                        </span>
                                        <button
                                                onClick={() => setError(null)}
                                                aria-label={t(
                                                        "ui.dismissError",
                                                )}
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
                </>
        );
};
