import { useI18n } from "../i18n";
import { useDeploymentWorkspaceController } from "./context";
import { StatusLine } from "./presentation";
export const DeploymentRail = () => {
        const { t } = useI18n();
        const { view, stepCompleted } = useDeploymentWorkspaceController();
        const {
                selectedProfile,
                preflightExact,
                packageReceipt,
                activeStep,
                activeStepTitleId,
                nextStep,
                nextStepTitleId,
        } = view;
        return (
                <aside
                        className="deployment-rail"
                        aria-label={t("ui.deploymentStatus")}
                >
                        <span className="kicker">
                                {t("ui.deploymentProfile")}
                        </span>
                        <h2>
                                {selectedProfile?.displayName ??
                                        t("ui.noProfileYet")}
                        </h2>
                        {selectedProfile ? (
                                <>
                                        <StatusLine
                                                label={t("ui.hardwareCheck")}
                                                state={
                                                        preflightExact === false
                                                                ? "bad"
                                                                : stepCompleted(
                                                                            "verifyProfile",
                                                                    ) ||
                                                                    preflightExact ===
                                                                            true
                                                                  ? "ok"
                                                                  : "idle"
                                                }
                                        />
                                        <StatusLine
                                                label={t("ui.artifactPrepared")}
                                                state={
                                                        stepCompleted(
                                                                "verifyPatchedArtifact",
                                                        )
                                                                ? "ok"
                                                                : "idle"
                                                }
                                        />
                                        <StatusLine
                                                label={t("ui.packageExported")}
                                                state={
                                                        packageReceipt
                                                                ? "ok"
                                                                : "idle"
                                                }
                                        />
                                        <StatusLine
                                                label={t("ui.bar1Observed")}
                                                state={
                                                        stepCompleted(
                                                                "verifyResizableBar",
                                                        )
                                                                ? "ok"
                                                                : "idle"
                                                }
                                        />
                                        <hr />
                                        <dl>
                                                <dt>{t("ui.activeGate")}</dt>
                                                <dd>
                                                        {activeStep
                                                                ? t(
                                                                          activeStepTitleId!,
                                                                  )
                                                                : t(
                                                                          "ui.noReadyStep",
                                                                  )}
                                                </dd>
                                        </dl>
                                </>
                        ) : (
                                <p className="muted-copy">
                                        {t(
                                                "ui.selectASourceImageAndCreateAProfileForThisComputerFirst",
                                        )}
                                </p>
                        )}
                        {nextStep && (
                                <div className="rail-note safety-note">
                                        <strong>{t("ui.nextStep")}</strong>
                                        <p>{t(nextStepTitleId!)}</p>
                                </div>
                        )}
                </aside>
        );
};
