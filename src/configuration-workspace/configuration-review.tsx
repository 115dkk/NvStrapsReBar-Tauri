import { useI18n } from "../i18n";
import { useConfigurationWorkspaceController } from "./context";

export const ConfigurationReview = ({
        savePath,
}: {
        savePath: "configure" | "settings";
}) => {
        const { t, validationSummary } = useI18n();
        const {
                draft,
                baseline,
                report,
                dirty,
                busy,
                snap,
                receipt,
                reviewButton,
                setDraft,
                setReport,
                openSaveConfirmation,
                settingsFile,
                exportSettings,
                importSettings,
        } = useConfigurationWorkspaceController();
        if (!snap) return null;
        return (
                <>
                        <section className="review" aria-live="polite">
                                <div>
                                        <span className="kicker">
                                                {t("ui.validation")}
                                        </span>
                                        {!dirty ? (
                                                <h3>
                                                        {t(
                                                                "ui.noPendingChanges",
                                                        )}
                                                </h3>
                                        ) : !report ? (
                                                <h3>{t("ui.checkingDraft")}</h3>
                                        ) : report.valid ? (
                                                <>
                                                        <h3>
                                                                {t(
                                                                        "ui.draftIsReadyForReview",
                                                                )}
                                                        </h3>
                                                        <p>
                                                                {validationSummary(
                                                                        report
                                                                                .affectedGpuIds
                                                                                .length,
                                                                        report.encodedSize,
                                                                )}
                                                        </p>
                                                </>
                                        ) : (
                                                <>
                                                        <h3>
                                                                {t(
                                                                        "ui.draftNeedsCorrection",
                                                                )}
                                                        </h3>
                                                        {report.errors.map(
                                                                (x) => (
                                                                        <p
                                                                                className="validation-error"
                                                                                key={
                                                                                        x
                                                                                }
                                                                        >
                                                                                {
                                                                                        x
                                                                                }
                                                                        </p>
                                                                ),
                                                        )}
                                                </>
                                        )}
                                </div>
                                <div className="commit">
                                        <button
                                                className="quiet"
                                                disabled={!dirty}
                                                onClick={() => {
                                                        setDraft(
                                                                structuredClone(
                                                                        baseline,
                                                                ),
                                                        );
                                                        setReport(null);
                                                }}
                                        >
                                                {t("ui.discardEdits")}
                                        </button>
                                        <button
                                                ref={reviewButton}
                                                className="primary"
                                                disabled={
                                                        !dirty ||
                                                        !report?.valid ||
                                                        busy ||
                                                        !snap.firmware
                                                                .accessible
                                                }
                                                onClick={() =>
                                                        openSaveConfirmation(
                                                                savePath,
                                                        )
                                                }
                                        >
                                                {report &&
                                                !report.variableWillExist
                                                        ? t(
                                                                  "ui.reviewConfigurationRemoval",
                                                          )
                                                        : t("ui.reviewSave")}
                                        </button>
                                </div>
                        </section>
                        {report &&
                                [
                                        ...(draft.skipS3Resume
                                                ? [
                                                          "ui.s3ResumeReconfigurationIsDisabledTestS3ResumeOnThisComputer" as const,
                                                  ]
                                                : []),
                                        ...(report.affectedGpuIds.length ===
                                                0 && report.encodedSize > 0
                                                ? [
                                                          "ui.theCurrentSettingsDoNotSelectAnyDetectedNvidiaGpu" as const,
                                                  ]
                                                : []),
                                ].map((warningId) => (
                                        <div
                                                className="notice warning"
                                                key={warningId}
                                        >
                                                {t(warningId)}
                                        </div>
                                ))}
                        <section className="settings-file">
                                <div>
                                        <strong>{t("ui.settingsFile")}</strong>
                                        <p>{t("ui.settingsFileHint")}</p>
                                </div>
                                <div className="commit">
                                        <button
                                                className="quiet"
                                                disabled={busy || !snap.config}
                                                onClick={() =>
                                                        void exportSettings()
                                                }
                                        >
                                                {t("ui.saveSettingsToFile")}
                                        </button>
                                        <button
                                                className="quiet"
                                                disabled={busy}
                                                onClick={() =>
                                                        void importSettings()
                                                }
                                        >
                                                {t("ui.loadSettingsFromFile")}
                                        </button>
                                </div>
                        </section>
                        {settingsFile && (
                                <div className="receipt" role="status">
                                        <strong>
                                                {settingsFile.kind ===
                                                "exported"
                                                        ? t(
                                                                  "ui.settingsFileSaved",
                                                          )
                                                        : t(
                                                                  "ui.settingsFileLoaded",
                                                          )}
                                        </strong>
                                        <span>
                                                {settingsFile.kind ===
                                                "exported"
                                                        ? settingsFile.path
                                                        : t(
                                                                  "ui.reviewTheLoadedDraftThenSave",
                                                          )}
                                        </span>
                                </div>
                        )}
                        {receipt?.path === savePath && (
                                <div className="receipt" role="status">
                                        <strong>
                                                {savePath === "settings"
                                                        ? t(
                                                                  "ui.barSettingsSavedAndReadBack",
                                                          )
                                                        : t(
                                                                  "ui.configurationWrittenAndReadBack",
                                                          )}
                                        </strong>
                                        <span>
                                                {t("ui.saveReceiptSummary", {
                                                        bytes: receipt.save
                                                                .bytesWritten,
                                                        state: receipt.save
                                                                .variablePresent
                                                                ? t("ui.present")
                                                                : t("ui.removed"),
                                                })}
                                        </span>
                                        <p>
                                                {t(
                                                        "ui.restartWindowsWhenReadyTheFirmwareDriverCannotApplyThisConfigurationUntilTheNextBoot",
                                                )}
                                        </p>
                                </div>
                        )}
                </>
        );
};
