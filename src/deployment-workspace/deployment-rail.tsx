import { firmwareInstalled } from "../bar-settings-routing";
import { useI18n } from "../i18n";
import { above4gDecodingConfirmed } from "../system-readiness";
import { useDeploymentWorkspaceController } from "./context";

export const DeploymentRail = () => {
        const { t } = useI18n();
        const { view, snapshot } = useDeploymentWorkspaceController();
        const showBiosChecklist = !firmwareInstalled(snapshot);
        if (!view.nextStep && !showBiosChecklist) return null;
        return (
                <aside className="deployment-rail" aria-label={t("ui.deploymentStatus")}>
                        {view.nextStep && (
                                <div className="rail-note">
                                        <strong>{t("ui.nextStep")}</strong>
                                        <p>{t(view.nextStepTitleId!)}</p>
                                </div>
                        )}
                        {showBiosChecklist && (
                                <div className="rail-note bios-checklist">
                                        <strong>{t("ui.beforeFlashingInBiosSetup")}</strong>
                                        <p>{t(above4gDecodingConfirmed(snapshot) ? "ui.above4gDecodingAlreadyOn" : "ui.turnOnAbove4gDecoding")}</p>
                                        <p>{t("ui.turnOffCsm")}</p>
                                        {snapshot.hardwareSupport?.motherboardNativeResizableBar.state === "supported" && <p>{t("ui.turnOnNativeRebarToo")}</p>}
                                </div>
                        )}
                </aside>
        );
};
