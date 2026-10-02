import type { ReactNode } from "react";
import { useDeploymentWorkspaceController } from "../deployment-workspace/context";
import { manualWarningIds, stepTitleIds } from "../deployment-workspace/messages";
import { useI18n } from "../i18n";

const Dialog = ({ id, title, children, close, confirm, confirmDisabled }: {
        id: string;
        title: ReactNode;
        children: ReactNode;
        close: () => void;
        confirm: { label: ReactNode; onClick: () => void };
        confirmDisabled?: boolean;
}) => {
        const { t } = useI18n();
        const { rebootDialog } = useDeploymentWorkspaceController();
        return (
                <div className="nv-scrim" role="presentation">
                        <div ref={rebootDialog} className="nv-dialog" role="dialog" aria-modal="true" aria-labelledby={id}>
                                <h2 id={id}>{title}</h2>
                                {children}
                                <div className="nv-dialog-actions">
                                        <button type="button" className="nv-btn nv-btn-quiet" autoFocus onClick={close}>{t("ui.close")}</button>
                                        <button type="button" className="nv-btn nv-btn-primary" disabled={confirmDisabled} onClick={confirm.onClick}>{confirm.label}</button>
                                </div>
                        </div>
                </div>
        );
};

/** Restart and manual-record confirmations. Each one is the explicit gate the backend requires. */
export const GuidedDialogs = () => {
        const { t } = useI18n();
        const { view, commands } = useDeploymentWorkspaceController();
        const busy = Boolean(view.busyAction);
        if (view.showReboot && view.rebootPreview)
                return (
                        <Dialog id="reboot-title" title={t("ui.restartDialogBiosTitle")} close={() => commands.setShowReboot(false)} confirm={{ label: t("ui.restart"), onClick: commands.reboot }}>
                                <p className="nv-body">{t("ui.restartDialogSaveWork")}</p>
                                <p className="nv-supporting">{t("ui.restartDialogBiosDetail")}</p>
                        </Dialog>
                );
        if (view.showConfigurationReboot && view.configurationRebootPreview)
                return (
                        <Dialog id="configuration-reboot-title" title={t("ui.restartDialogTitle")} close={() => commands.setShowConfigurationReboot(false)} confirm={{ label: t("ui.restart"), onClick: commands.requestConfigurationReboot }} confirmDisabled={busy}>
                                <p className="nv-body">{t("ui.restartDialogSaveWork")}</p>
                                <p className="nv-supporting">{t("ui.restartDialogConfigurationDetail")}</p>
                        </Dialog>
                );
        if (view.showManual && view.manualPreview)
                return (
                        <Dialog id="manual-confirm-title" title={t(stepTitleIds[view.manualPreview.stepId])} close={() => commands.setShowManual(false)} confirm={{ label: t("ui.record"), onClick: commands.confirmManual }} confirmDisabled={busy}>
                                <p className="nv-body">{t("ui.reviewTheResultInTheOwningToolThenRecordThisStep")}</p>
                                <ul className="nv-facts">
                                        {manualWarningIds(view.manualPreview.stepId, view.boardPath === "legacyAbove4g").map((warningId) => (
                                                <li key={warningId} className="nv-supporting">{t(warningId)}</li>
                                        ))}
                                </ul>
                        </Dialog>
                );
        return null;
};
