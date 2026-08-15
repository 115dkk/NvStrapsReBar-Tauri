import type {
        BoardPath,
        FirmwareInstallMethod,
        RecoveryMethod,
} from "./contract";
import { translateMessage, useI18n } from "../i18n";
import {
        catalogLabelIds,
        legacyRuleBlockedReasonId,
        legacyRuleDescriptionId,
        riskLabelIds,
} from "./messages";
import { useDeploymentWorkspaceController } from "./context";
import { JourneyHeading, legacyRuleKey, shortHash } from "./presentation";
export const SourceJourney = () => {
        const { locale, t, n, exactMatches, absentRules } = useI18n();
        const { view, commands, msi } = useDeploymentWorkspaceController();
        const snapshot = view.snapshot;
        const {
                displayName,
                boardPath,
                firmwarePath,
                firmware,
                recoveryMethod,
                installMethod,
                instructionsUrl,
                recoveryNote,
                installNote,
                recoveryNotePresetId,
                installNotePresetId,
                routeConfirmed,
                legacyAnalysis,
                legacyAnalysisStatus,
                legacyAnalysisError,
                selectedLegacyRules,
                legacyAcknowledgements,
                busyAction,
                legacyAnalysisValid,
                selectedLegacyEntries,
                selectedLegacyRisks,
                acknowledgementHash,
                missingLegacyRisk,
                legacyReady,
                legacyNextAction,
        } = view;
        const {
                setDisplayName,
                setBoardPath,
                setFirmwarePath,
                setRecoveryMethod,
                setInstallMethod,
                setInstructionsUrl,
                setRecoveryNote,
                setInstallNote,
                setRouteConfirmed,
                toggleLegacyRule,
                setLegacyRiskNote,
                setLegacyRiskConfirmed,
                chooseFirmware,
                inspectManualPath,
                analyzeLegacy,
                createProfile,
        } = commands;
        return (
                                <section className="journey-panel" aria-labelledby="source-title">
                                        <JourneyHeading
                                                number="01"
                                                title={t("ui.sourceImageAndRecoveryFiles")}
                                                id="source-title"
                                                copy={t("ui.selectTheVendorImageInspectItsSizeAndSha256AndRecordTheInstallationAndRecoveryInstructions")}
                                        />
                                        {msi && (
                                                <div className="detected-route">
                                                        <strong>MSI {snapshot.machineIdentity?.boardProduct ?? t("ui.boardDetected")}</strong>
                                                        <span>{t("ui.nativeRebarMFlashAndFlashBiosButtonDefaultsArePrefilledFromTheOfficialManualConfirmThemBelow")}</span>
                                                </div>
                                        )}
                                        <div className="form-grid">
                                                <label className="field span-2">
                                                        <span>{t("ui.profileName")}</span>
                                                        <input
                                                                value={displayName}
                                                                onChange={(event) =>
                                                                        setDisplayName(
                                                                                event.target.value,
                                                                        )
                                                                }
                                                        />
                                                </label>
                                                <label className="field span-2">
                                                        <span>{t("ui.selectedFirmwareImage")}</span>
                                                        <div className="path-control">
                                                                <input
                                                                        value={firmwarePath}
                                                                        placeholder={t("ui.chooseAVendorBiosImageOrEnterAnAbsolutePath")}
                                                onChange={(event) => {
                                                                                setFirmwarePath(
                                                                                        event.target.value,
                                                                                );
                                                                        }}
                                                                />
                                                                <button
                                                                        onClick={chooseFirmware}
                                                                        disabled={Boolean(busyAction)}
                                                                >{t("ui.chooseFile")}</button>
                                                                <button
                                                                        className="quiet"
                                                                        onClick={inspectManualPath}
                                                                        disabled={
                                                                                Boolean(busyAction) ||
                                                                                !firmwarePath ||
                                                                                Boolean(firmware)
                                                                        }
                                                                >{t("ui.inspect")}</button>
                                                        </div>
                                                        {firmware && (
                                                                <small className="verified-line">
                                                                        {firmware.fileName} · {Math.round(
                                                                                firmware.byteLength /
                                                                                        1048576,
                                                                        )}{" "}
                                                                        MiB · SHA-256 {shortHash(
                                                                                firmware.sha256,
                                                                        )}
                                                                </small>
                                                        )}
                                                </label>
                                                <label className="field">
                                                        <span>{t("ui.boardPath")}</span>
                                                        <select
                                                                value={boardPath}
                                                                onChange={(event) => {
                                                                        setBoardPath(
                                                                                event.target.value as BoardPath,
                                                                        );
                                                                }}
                                                        >
                                                                <option value="nativeResizableBar">{t("ui.nativeResizableBar")}</option>
                                                                <option value="legacyAbove4g">{t("ui.legacyAbove4g")}</option>
                                                        </select>
                                                </label>
                                                <label className="field">
                                                        <span>{t("ui.vendorInstallRoute")}</span>
                                                        <select
                                                                value={installMethod}
                                                                onChange={(event) =>
                                                                        setInstallMethod(
                                                                                event.target.value as FirmwareInstallMethod,
                                                                        )
                                                                }
                                                        >
                                                                <option value="firmwareSetupUtility">{t("ui.firmwareSetupUtility")}</option>
                                                                <option value="usbFlashback">{t("ui.usbFlashback")}</option>
                                                                <option value="vendorWindowsUtility">{t("ui.vendorWindowsUtility")}</option>
                                                                <option value="externalSpiProgrammer">{t("ui.externalSpiProgrammer")}</option>
                                                        </select>
                                                </label>
                                                <label className="field">
                                                        <span>{t("ui.recoveryRoute")}</span>
                                                        <select
                                                                value={recoveryMethod}
                                                                onChange={(event) =>
                                                                        setRecoveryMethod(
                                                                                event.target.value as RecoveryMethod,
                                                                        )
                                                                }
                                                        >
                                                                <option value="usbFlashback">{t("ui.usbFlashback")}</option>
                                                                <option value="dualBios">{t("ui.dualBios")}</option>
                                                                <option value="vendorRecovery">{t("ui.vendorRecovery")}</option>
                                                                <option value="externalSpiProgrammer">{t("ui.externalSpiProgrammer")}</option>
                                                                <option value="none">{t("ui.noneProfileWillBeRefused")}</option>
                                                        </select>
                                                </label>
                                                <label className="field">
                                                        <span>{t("ui.officialInstructionsUrl")}</span>
                                                        <input
                                                                type="url"
                                                                value={instructionsUrl}
                                                                onChange={(event) =>
                                                                        setInstructionsUrl(
                                                                                event.target.value,
                                                                        )
                                                                }
                                                        />
                                                </label>
                                                <label className="field span-2">
                                                        <span>{t("ui.installHandoffNote")}</span>
                                                        <input
                                                                value={
                                                                        installNotePresetId
                                                                                ? t(installNotePresetId)
                                                                                : installNote
                                                                }
                                                                onChange={(event) =>
                                                                        setInstallNote(
                                                                                event.target.value,
                                                                        )
                                                                }
                                                        />
                                                </label>
                                                <label className="field span-2">
                                                        <span>{t("ui.recoveryNote")}</span>
                                                        <input
                                                                value={
                                                                        recoveryNotePresetId
                                                                                ? t(recoveryNotePresetId)
                                                                                : recoveryNote
                                                                }
                                                                onChange={(event) =>
                                                                        setRecoveryNote(
                                                                                event.target.value,
                                                                        )
                                                                }
                                                        />
                                                </label>
                                        </div>
                                        {boardPath === "legacyAbove4g" && (
                                                <div
                                                        className="legacy-analysis"
                                                        aria-labelledby="legacy-analysis-title"
                                                >
                                                        <div className="legacy-analysis-head">
                                                                <div>
                                                                        <span className="step">{t("ui.readOnly")}</span>
                                                                        <h4 id="legacy-analysis-title">{t("ui.legacyPatchAnalysis")}</h4>
                                                                        <p>{t("ui.theRustAnalyzerReportsMatchCountsForTheSelectedSourceImage")}</p>
                                                                </div>
                                                                <button
                                                                        type="button"
                                                                        onClick={() => void analyzeLegacy()}
                                                                        disabled={
                                                                                Boolean(busyAction) ||
                                                                                !firmware
                                                                        }
                                                                >
                                                                        {legacyAnalysisStatus ===
                                                                        "pending"
                                                                                ? t("ui.analyzingImage")
                                                                                : legacyAnalysisValid
                                                                                  ? t("ui.analyzeAgain")
                                                                                  : t("ui.analyzeImage")}
                                                                </button>
                                                        </div>
                                                        <p
                                                                className={`legacy-next-action ${legacyReady ? "ready" : "blocked"}`}
                                                                role="status"
                                                                aria-live="polite"
                                                        >
                                                                {legacyNextAction &&
                                                                        translateMessage(locale, legacyNextAction)}
                                                        </p>
                                                        {legacyAnalysis &&
                                                                legacyAnalysisValid && (
                                                                        <div className="legacy-results">
                                                                                <div className="legacy-fingerprint">
                                                                                        <span>{t("ui.analyzedSource")}</span>
                                                                                        <strong>
                                                                                                {legacyAnalysis.value.firmware.fileName} · {Math.round(legacyAnalysis.value.firmware.byteLength / 1048576)} MiB
                                                                                        </strong>
                                                                                        <small className="mono-wrap">
                                                                                                SHA-256 {legacyAnalysis.value.firmware.sha256}
                                                                                        </small>
                                                                                </div>
                                                                                {legacyAnalysis.value.catalogs.map(
                                                                                        (catalog) => {
                                                                                                const applicable =
                                                                                                        catalog.rules.filter(
                                                                                                                (rule) =>
                                                                                                                        rule.status ===
                                                                                                                        "applicable",
                                                                                                        );
                                                                                                const absent =
                                                                                                        catalog.rules.filter(
                                                                                                                (rule) =>
                                                                                                                        rule.status ===
                                                                                                                        "absent",
                                                                                                        );
                                                                                                const blocked =
                                                                                                        catalog.rules.filter(
                                                                                                                (rule) =>
                                                                                                                        rule.status ===
                                                                                                                        "blocked",
                                                                                                        );
                                                                                                return (
                                                                                                        <section
                                                                                                                className="legacy-catalog"
                                                                                                                key={catalog.catalog}
                                                                                                                aria-labelledby={`catalog-${catalog.catalog}`}
                                                                                                        >
                                                                                                                <div className="legacy-catalog-head">
                                                                                                                        <div>
                                                                                                                                <h5 id={`catalog-${catalog.catalog}`}>
                                                                                                                                        {t(catalogLabelIds[catalog.catalog])}
                                                                                                                                </h5>
                                                                                                                                <small>
                                                                                                                                        {n(applicable.length)} {t("ui.applicable")} · {n(absent.length)} {t("ui.absent")} · {n(blocked.length)} {t("ui.blockedState")}
                                                                                                                                </small>
                                                                                                                        </div>
                                                                                                                        <span className="mono-wrap">
                                                                                                                                {t("ui.source")} {shortHash(catalog.sourceSha256)}
                                                                                                                        </span>
                                                                                                                </div>
                                                                                                                {applicable.length >
                                                                                                                0 ? (
                                                                                                                        <div className="legacy-rule-list">
                                                                                                                                {applicable.map(
                                                                                                                                        (rule) => {
                                                                                                                                                const key =
                                                                                                                                                        legacyRuleKey(
                                                                                                                                                                catalog.catalog,
                                                                                                                                                                rule.ruleId,
                                                                                                                                                        );
                                                                                                                                                return (
                                                                                                                                                        <label
                                                                                                                                                                className="legacy-rule"
                                                                                                                                                                key={rule.ruleId}
                                                                                                                                                        >
                                                                                                                                                                <input
                                                                                                                                                                        type="checkbox"
                                                                                                                                                                        checked={selectedLegacyRules.includes(
                                                                                                                                                                                key,
                                                                                                                                                                        )}
                                                                                                                                                                        onChange={(event) =>
                                                                                                                                                                                toggleLegacyRule(
                                                                                                                                                                                        key,
                                                                                                                                                                                        event.target.checked,
                                                                                                                                                                                )
                                                                                                                                                                        }
                                                                                                                                                                />
                                                                                                                                                                <span>
                                                                                                                                                                        <strong>
                                                                                                                                                                                {t(legacyRuleDescriptionId(rule.ruleId))}
                                                                                                                                                                        </strong>
                                                                                                                                                                        <small>
                                                                                                                                                                                {exactMatches(rule.expectedMatches!)} · {t("ui.section")} 0x{rule.sectionType.toString(16).padStart(2, "0")}
                                                                                                                                                                        </small>
                                                                                                                                                                        {rule.requiredRisks.length >
                                                                                                                                                                                0 && (
                                                                                                                                                                                <em>
                                                                                                                                                                                        {t("ui.requires")} {rule.requiredRisks.map((risk) => t(riskLabelIds[risk])).join(" · ")}
                                                                                                                                                                                </em>
                                                                                                                                                                        )}
                                                                                                                                                                </span>
                                                                                                                                                                {rule.recommended && (
                                                                                                                                                                        <b>{t("ui.recommended")}</b>
                                                                                                                                                                )}
                                                                                                                                                        </label>
                                                                                                                                                );
                                                                                                                                        },
                                                                                                                                )}
                                                                                                                        </div>
                                                                                                                ) : (
                                                                                                                        <p className="legacy-empty">{t("ui.noApplicableRulesInThisCatalog")}</p>
                                                                                                                )}
                                                                                                                {absent.length > 0 && (
                                                                                                                        <p className="legacy-absent">
                                                                                                                                {absentRules(absent.length)}
                                                                                                                        </p>
                                                                                                                )}
                                                                                                                {blocked.map(
                                                                                                                        (rule) => (
                                                                                                                                <div
                                                                                                                                        className="legacy-blocked-rule"
                                                                                                                                        key={rule.ruleId}
                                                                                                                                >
                                                                                                                                        <strong>
                                                                                                                                                {t("ui.blocked")} · {t(legacyRuleDescriptionId(rule.ruleId))}
                                                                                                                                        </strong>
                                                                                                                                        <span>
                                                                                                                                                {t(legacyRuleBlockedReasonId(rule.ruleId))}
                                                                                                                                        </span>
                                                                                                                                </div>
                                                                                                                        ),
                                                                                                                )}
                                                                                                        </section>
                                                                                                );
                                                                                        },
                                                                                )}
                                                                                {selectedLegacyRisks.length >
                                                                                        0 && (
                                                                                        <section
                                                                                                className="legacy-risk-panel"
                                                                                                aria-labelledby="legacy-risk-title"
                                                                                        >
                                                                                                <h5 id="legacy-risk-title">{t("ui.explicitRiskAcknowledgements")}</h5>
                                                                                                <p>
                                                                                                        {t("ui.forEachSelectedRiskDescribeThisImageAndIncludeFingerprint")} <code>{acknowledgementHash}</code>. {t("ui.includeTheImageSpecificConsequence")}
                                                                                                </p>
                                                                                                {selectedLegacyRisks.map(
                                                                                                        (risk) => {
                                                                                                                const acknowledgement =
                                                                                                                        legacyAcknowledgements[
                                                                                                                                risk
                                                                                                                        ];
                                                                                                                const noteId = `risk-${risk}-note`;
                                                                                                                return (
                                                                                                                        <div
                                                                                                                                className="legacy-risk"
                                                                                                                                key={risk}
                                                                                                                        >
                                                                                                                                <label htmlFor={noteId}>
                                                                                                                                        <strong>
                                                                                                                                                {t(riskLabelIds[risk])}
                                                                                                                                        </strong>
                                                                                                                                        <span>{t("ui.imageSpecificAcknowledgementNote")}</span>
                                                                                                                                </label>
                                                                                                                                <textarea
                                                                                                                                        id={noteId}
                                                                                                                                        value={acknowledgement?.note ?? ""}
                                                                                                                                        onChange={(event) =>
                                                                                                                                                setLegacyRiskNote(
                                                                                                                                                        risk,
                                                                                                                                                        event.target.value,
                                                                                                                                                )
                                                                                                                                        }
                                                                                                                                        placeholder={`Describe the consequence for image ${acknowledgementHash}`}
                                                                                                                                />
                                                                                                                                <label className="consequence-check compact-check">
                                                                                                                                        <input
                                                                                                                                                type="checkbox"
                                                                                                                                                checked={acknowledgement?.confirmed ?? false}
                                                                                                                                                onChange={(event) =>
                                                                                                                                                        setLegacyRiskConfirmed(
                                                                                                                                                                risk,
                                                                                                                                                                event.target.checked,
                                                                                                                                                        )
                                                                                                                                                }
                                                                                                                                        />
                                                                                                                                        <span>
                                                                                                                                                <strong>{t("ui.iReviewedThisRiskForTheAnalyzedFirmware")}</strong>
                                                                                                                                        </span>
                                                                                                                                </label>
                                                                                                                        </div>
                                                                                                                );
                                                                                                        },
                                                                                                )}
                                                                                        </section>
                                                                                )}
                                                                        </div>
                                                                )}
                                                </div>
                                        )}
                                        <label className="consequence-check">
                                                <input
                                                        type="checkbox"
                                                        checked={routeConfirmed}
                                                        onChange={(event) =>
                                                                setRouteConfirmed(
                                                                        event.target.checked,
                                                                )
                                                        }
                                                />
                                                <span>
                                                        <strong>{t("ui.iCheckedTheVendorInstallAndRecoveryInstructionsForThisBoard")}</strong>
                                                        <small>{t("ui.thisRecordsTheSelectedInstallationAndRecoveryInstructions")}</small>
                                                </span>
                                        </label>
                                        <div className="panel-actions">
                                                <button
                                                        className="primary"
                                                        disabled={
                                                                Boolean(busyAction) ||
                                                                !firmware ||
                                                                !displayName.trim() ||
                                                                !instructionsUrl.startsWith(
                                                                        "https://",
                                                                ) ||
                                                                !installNote.trim() ||
                                                                !recoveryNote.trim() ||
                                                                !routeConfirmed ||
                                                                !legacyReady
                                                        }
                                                        onClick={createProfile}
                                                >
                                                        {busyAction === "profile"
                                                                ? t("ui.creatingProfile")
                                                                : t("ui.createProfileForThisComputer")}
                                                </button>
                                        </div>
                                </section>
        );
};
