import { useI18n } from "../i18n";
import { useConfigurationWorkspaceController } from "./context";

export const FirmwareBehaviorPanel = () => {
        const { t } = useI18n();
        const { draft, patch } = useConfigurationWorkspaceController();
        return (
                <section className="panel">
                        <div className="section-head">
                                <div>
                                        <span className="step">03</span>
                                        <h3>{t("ui.firmwareBehavior")}</h3>
                                </div>
                                <p>
                                        {t(
                                                "ui.chooseChangeDetectionBarMaskAndResumeBehavior",
                                        )}
                                </p>
                        </div>
                        <div className="checks">
                                <label>
                                        <input
                                                type="checkbox"
                                                checked={
                                                        draft.guardSetupChanges
                                                }
                                                onChange={(e) =>
                                                        patch({
                                                                guardSetupChanges:
                                                                        e.target
                                                                                .checked,
                                                        })
                                                }
                                        />
                                        <span>
                                                <strong>
                                                        {t(
                                                                "ui.checkSetupVariableChanges",
                                                        )}
                                                </strong>
                                                <small>
                                                        {t(
                                                                "ui.compareTheSetupVariableFingerprintBeforeApplyingConfiguration",
                                                        )}
                                                </small>
                                        </span>
                                </label>
                                <label>
                                        <input
                                                type="checkbox"
                                                checked={
                                                        draft.overrideBarSizeMask
                                                }
                                                onChange={(e) =>
                                                        patch({
                                                                overrideBarSizeMask:
                                                                        e.target
                                                                                .checked,
                                                        })
                                                }
                                        />
                                        <span>
                                                <strong>
                                                        {t(
                                                                "ui.overrideBarSizeMaskGlobally",
                                                        )}
                                                </strong>
                                                <small>
                                                        {t(
                                                                "ui.advertiseTheConfiguredSizeWhenCapabilityMasksDiffer",
                                                        )}
                                                </small>
                                        </span>
                                </label>
                                <label className="danger-check">
                                        <input
                                                type="checkbox"
                                                checked={draft.skipS3Resume}
                                                onChange={(e) =>
                                                        patch({
                                                                skipS3Resume:
                                                                        e.target
                                                                                .checked,
                                                        })
                                                }
                                        />
                                        <span>
                                                <strong>
                                                        {t(
                                                                "ui.skipS3ResumeReconfiguration",
                                                        )}
                                                </strong>
                                                <small>
                                                        {t(
                                                                "ui.testS3ResumeOnThisComputerAfterEnablingThisOption",
                                                        )}
                                                </small>
                                        </span>
                                </label>
                        </div>
                </section>
        );
};
