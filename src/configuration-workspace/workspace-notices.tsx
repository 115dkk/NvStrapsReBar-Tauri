import { translateMessage, useI18n } from "../i18n";
import { useConfigurationWorkspaceController } from "./context";

export const WorkspaceNotices = () => {
        const { locale, t } = useI18n();
        const { error, setError, systemNotices } =
                useConfigurationWorkspaceController();
        return (
                <>
                        {error && (
                                <div className="notice error" role="alert">
                                        <strong>{t("ui.operationFailed")}</strong>
                                        <span>
                                                {translateMessage(locale, error)}
                                        </span>
                                        <button
                                                onClick={() => setError(null)}
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
                </>
        );
};
