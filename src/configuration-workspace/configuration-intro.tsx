import { useI18n } from "../i18n";
import type { StaticMessageId } from "../i18n-catalog";
import type { ResizableBarStatusPresentation } from "../resizable-bar-status";
import { useConfigurationWorkspaceController } from "./context";
import { WorkspaceNotices } from "./workspace-notices";

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

export const ConfigurationIntro = () => {
        const { t, gpuCountLabel } = useI18n();
        const { snap, rebarStatus } =
                useConfigurationWorkspaceController();
        if (!snap) return null;
        const verdict = verdictIds[rebarStatus.tone];
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
                                <div
                                        className={`rebar-verdict ${rebarStatus.tone}`}
                                >
                                        <strong>{t(verdict.headingId)}</strong>
                                        <p>{t(verdict.detailId)}</p>
                                        <span className="verdict-count">
                                                <b>{snap.devices.length}</b>
                                                <span>
                                                        {gpuCountLabel(
                                                                snap.devices
                                                                        .length,
                                                        )}
                                                </span>
                                        </span>
                                </div>
                        </section>
                        <WorkspaceNotices />
                </>
        );
};
