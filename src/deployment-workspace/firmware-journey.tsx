import { useI18n } from "../i18n";
import { useDeploymentWorkspaceController } from "./context";
import { JourneyHeading } from "./presentation";

export const FirmwareJourney = () => {
        const { t } = useI18n();
        const { view } = useDeploymentWorkspaceController();
        const activeStep = view.activeStep?.id;

        if (
                activeStep !== "flashWithVendorRoute" &&
                activeStep !== "configureFirmwareSetup"
        )
                return null;

        const isVendorFlash = activeStep === "flashWithVendorRoute";

        return (
                <section
                        className="journey-panel"
                        aria-labelledby="manual-handoff-title"
                        data-manual-step={activeStep}
                >
                        <JourneyHeading
                                number="03"
                                title={t(
                                        isVendorFlash
                                                ? "ui.vendorFlashTaskTitle"
                                                : "ui.uefiSetupTaskTitle",
                                )}
                                id="manual-handoff-title"
                                copy={t(
                                        isVendorFlash
                                                ? "ui.vendorFlashTaskSummary"
                                                : "ui.uefiSetupTaskSummary",
                                )}
                        />
                        <article
                                className={`manual-handoff-task${
                                        isVendorFlash ? "" : " single"
                                }`}
                                aria-label={t("ui.currentManualTask")}
                        >
                                <div className="manual-handoff-main">
                                        <span>{t("ui.doThisNow")}</span>
                                        <strong>
                                                {t(
                                                        isVendorFlash
                                                                ? "ui.useTheVendorTool"
                                                                : "ui.updateTheUefiSettings",
                                                )}
                                        </strong>
                                        <p>
                                                {t(
                                                        isVendorFlash
                                                                ? "ui.vendorFlashTaskInstructions"
                                                                : "ui.uefiSetupTaskInstructions",
                                                )}
                                        </p>
                                </div>
                                {isVendorFlash && (
                                        <div
                                                className="manual-handoff-prerequisite"
                                                role="note"
                                                aria-label={t("ui.beforeYouBegin")}
                                        >
                                                <span>{t("ui.beforeYouBegin")}</span>
                                                <strong>{t("ui.prepareRecoveryFiles")}</strong>
                                                <p>{t("ui.recoveryFilesPrerequisite")}</p>
                                        </div>
                                )}
                        </article>
                </section>
        );
};
