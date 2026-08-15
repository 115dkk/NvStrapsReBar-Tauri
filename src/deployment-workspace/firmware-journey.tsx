import { useI18n } from "../i18n";
import { JourneyHeading } from "./presentation";
export const FirmwareJourney = () => {
        const { t } = useI18n();
        return (
                <section
                        className="journey-panel"
                        aria-labelledby="firmware-title"
                >
                        <JourneyHeading
                                number="03"
                                title={t("ui.stepsCompletedOutsideThisApp")}
                                id="firmware-title"
                                copy={t(
                                        "ui.useTheVendorToolForFlashingSetFirmwareValuesInTheFirmwareScreenThenReturnToContinueThePlan",
                                )}
                        />
                        <div className="manual-gates">
                                <div>
                                        <span>{t("ui.manual")}</span>
                                        <strong>{t("ui.vendorFlash")}</strong>
                                        <p>
                                                {t(
                                                        "ui.selectTheExportedArtifactInTheDocumentedVendorUtilityKeepPowerStable",
                                                )}
                                        </p>
                                </div>
                                <div>
                                        <span>{t("ui.physical")}</span>
                                        <strong>{t("ui.recoveryFiles")}</strong>
                                        <p>
                                                {t(
                                                        "ui.keepTheSelectedRecoveryRouteAndOriginalImageAvailableBeforeFlashing",
                                                )}
                                        </p>
                                </div>
                                <div>
                                        <span>{t("ui.manual")}</span>
                                        <strong>{t("ui.uefiValues")}</strong>
                                        <p>
                                                {t(
                                                        "ui.setAbove4gDecodingAndResizableBarInTheFirmwareScreen",
                                                )}
                                        </p>
                                </div>
                        </div>
                </section>
        );
};
