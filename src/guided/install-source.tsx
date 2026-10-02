import { useEffect, useId, useState } from "react";
import type { FirmwareInstallMethod, RecoveryMethod } from "../deployment-workspace/contract";
import { isBootIndependentRecoveryMethod } from "../deployment-workspace/machine-profile-draft";
import { catalogLabelIds, legacyRuleBlockedReasonId, legacyRuleDescriptionId, riskLabelIds } from "../deployment-workspace/messages";
import { legacyRuleKey } from "../deployment-workspace/session-projection";
import { messages, type StaticMessageId } from "../i18n-catalog";
import { translateMessage } from "../i18n";
import { Icon } from "./icons";
import type { InstallContext } from "./install-context";
import { ActionBar, FileCard, RouteCard, Step, Steps, TaskPanel } from "./ui";

export const installMethodIds: Record<FirmwareInstallMethod, { title: StaticMessageId; detail: StaticMessageId }> = {
        firmwareSetupUtility: { title: "ui.methodSetupUtility", detail: "ui.methodSetupUtilityDetail" },
        usbFlashback: { title: "ui.methodUsbFlashback", detail: "ui.methodUsbFlashbackDetail" },
        vendorWindowsUtility: { title: "ui.methodWindowsUtility", detail: "ui.methodWindowsUtilityDetail" },
        externalSpiProgrammer: { title: "ui.methodSpiProgrammer", detail: "ui.methodSpiProgrammerDetail" },
};

export const recoveryMethodIds: Record<RecoveryMethod, { title: StaticMessageId; detail: StaticMessageId }> = {
        dualBios: { title: "ui.recoveryDualBios", detail: "ui.recoveryDualBiosDetail" },
        usbFlashback: { title: "ui.recoveryUsbFlashback", detail: "ui.recoveryUsbFlashbackDetail" },
        vendorRecovery: { title: "ui.recoveryVendor", detail: "ui.recoveryVendorDetail" },
        externalSpiProgrammer: { title: "ui.recoverySpi", detail: "ui.recoverySpiDetail" },
        none: { title: "ui.recoveryNone", detail: "ui.recoveryNoneDetail" },
};

const fileSize = (bytes: number) => `${Math.round(bytes / 1048576)} MiB`;

const ChosenFile = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view, commands, busy } = ctx;
        if (!view.firmware) return null;
        return (
                <FileCard
                        name={view.firmware.fileName}
                        meta={t("ui.fileRead", { size: fileSize(view.firmware.byteLength) })}
                        action={{ label: t("ui.otherFile"), onClick: commands.chooseFirmware, disabled: busy }}
                />
        );
};

const stageLabel = (ctx: InstallContext, question?: 1 | 2 | 3) =>
        question ? ctx.t("ui.stageLabelPrepareQuestion", { number: question }) : ctx.t("ui.stageLabelPrepare");

export const PickFirmware = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view, commands, busy, msi, boardName, navigation } = ctx;
        const manualId = useId();
        return (
                <TaskPanel
                        label={stageLabel(ctx)}
                        title={t("ui.pickFirmwareTitle")}
                        lead={boardName ? t("ui.pickFirmwareLeadBoard", { board: boardName }) : t("ui.pickFirmwareLeadGeneric")}
                        titleRef={ctx.titleRef}
                        bar={
                                <ActionBar
                                        hint={t("ui.pickFirmwareHint")}
                                        secondary={navigation.installUi.startNew && view.plan ? [{ label: t("ui.backToCurrentPreparation"), onClick: () => navigation.setInstallUi({ startNew: false }) }] : []}
                                        primary={{ label: t("ui.pickFile"), icon: "folder", onClick: commands.chooseFirmware, busy: view.busyAction === "firmware", disabled: busy }}
                                />
                        }
                >
                        <Steps>
                                <Step title={t(msi ? "ui.pickFirmwareStepDownloadMsi" : "ui.pickFirmwareStepDownload")} detail={t(msi ? "ui.pickFirmwareStepDownloadDetailMsi" : "ui.pickFirmwareStepDownloadDetail")} />
                                <Step title={t(msi ? "ui.pickFirmwareStepChooseMsi" : "ui.pickFirmwareStepChoose")} detail={t(msi ? "ui.pickFirmwareStepChooseDetailMsi" : "ui.pickFirmwareStepChooseDetail")} />
                        </Steps>
                        <div className="nv-file nv-file-empty">
                                <Icon name="folder" />
                                <div className="nv-file-body"><span className="nv-strong">{t("ui.noFileChosen")}</span><span className="nv-supporting">{t("ui.noFileChosenDetail")}</span></div>
                        </div>
                        <details className="nv-disclosure">
                                <summary><Icon name="chevron" />{t("ui.enterPathInstead")}</summary>
                                <div className="nv-group" style={{ paddingTop: 8 }}>
                                        <label className="nv-field" htmlFor={manualId}>
                                                <span>{t("ui.selectedFirmwareImage")}</span>
                                                <input id={manualId} className="nv-input" value={view.firmwarePath} placeholder={t("ui.chooseAVendorBiosImageOrEnterAnAbsolutePath")} onChange={(event) => commands.setFirmwarePath(event.target.value)} />
                                        </label>
                                        <div><button type="button" className="nv-btn nv-btn-quiet" disabled={busy || !view.firmwarePath} onClick={commands.inspectManualPath}>{t("ui.readFile")}</button></div>
                                </div>
                        </details>
                </TaskPanel>
        );
};

type Choice<T extends string> = { value: T; title: string; detail: string; disabled?: boolean };

const Choices = <T extends string>({ name, legend, value, choices, onChange }: { name: string; legend: string; value: T | null; choices: Choice<T>[]; onChange: (value: T) => void }) => (
        <fieldset className="nv-choices" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="nv-sr">{legend}</legend>
                {choices.map((choice) => (
                        <label key={choice.value} className={`nv-choice compact${choice.disabled ? " disabled" : ""}`}>
                                <input type="radio" name={name} value={choice.value} checked={value === choice.value} disabled={choice.disabled} onChange={() => onChange(choice.value)} />
                                <span className="nv-choice-text"><span className="nv-strong">{choice.title}</span><span className="nv-supporting">{choice.detail}</span></span>
                        </label>
                ))}
        </fieldset>
);

export const BoardQuestion = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view, commands, navigation, busy } = ctx;
        return (
                <TaskPanel
                        label={stageLabel(ctx, 1)}
                        title={t("ui.boardQuestionTitle")}
                        lead={t("ui.boardQuestionLead")}
                        titleRef={ctx.titleRef}
                        bar={<ActionBar hint={t("ui.boardQuestionHint")} primary={{ label: t("ui.next"), icon: "arrow", disabled: busy, onClick: () => navigation.setInstallUi({ question: 2, legacyAccepted: false }) }} />}
                >
                        <ChosenFile ctx={ctx} />
                        <Choices
                                name="board-path"
                                legend={t("ui.boardQuestionTitle")}
                                value={view.boardPath}
                                onChange={commands.setBoardPath}
                                choices={[
                                        { value: "nativeResizableBar", title: t("ui.boardNativeTitle"), detail: t("ui.boardNativeDetail") },
                                        { value: "legacyAbove4g", title: t("ui.boardLegacyTitle"), detail: t("ui.boardLegacyDetail") },
                                ]}
                        />
                </TaskPanel>
        );
};

export const LegacyAnalysis = ({ ctx }: { ctx: InstallContext }) => {
        const { t, n, exactMatches, absentRules, locale, view, commands, navigation, busy, routing } = ctx;
        const analyzed = Boolean(view.legacyAnalysis && view.legacyAnalysisValid);
        useEffect(() => {
                // Analysis only reads the chosen file, so it starts on its own.
                if (view.firmware && view.legacyAnalysisStatus === "idle" && !view.busyAction) commands.analyzeLegacy();
        }, [view.firmware, view.legacyAnalysisStatus, view.busyAction, commands]);
        const next = () => navigation.setInstallUi(routing.catalogBoard ? { legacyAccepted: true } : { legacyAccepted: true, question: 2 });
        return (
                <TaskPanel
                        label={stageLabel(ctx, routing.catalogBoard ? undefined : 1)}
                        title={t("ui.legacyTitle")}
                        lead={t("ui.legacyLead")}
                        titleRef={ctx.titleRef}
                        bar={
                                <ActionBar
                                        hint={view.legacyNextAction ? translateMessage(locale, view.legacyNextAction) : undefined}
                                        secondary={routing.catalogBoard ? [] : [{ label: t("ui.previousQuestion"), onClick: () => navigation.setInstallUi({ question: 1 }) }]}
                                        primary={analyzed
                                                ? { label: t("ui.next"), icon: "arrow", disabled: busy || !view.legacyReady, onClick: next }
                                                : { label: t(view.legacyAnalysisStatus === "pending" ? "ui.analyzingFile" : "ui.analyzeFile"), busy: view.legacyAnalysisStatus === "pending", disabled: busy || !view.firmware, onClick: commands.analyzeLegacy }}
                                />
                        }
                >
                        <ChosenFile ctx={ctx} />
                        {view.legacyAnalysisStatus === "error" && view.legacyNextAction && (
                                <div className="nv-notice" role="alert"><Icon name="alert" /><div className="nv-fact-text"><strong>{t("ui.legacyAnalysisFailed")}</strong><span>{translateMessage(locale, view.legacyNextAction)}</span></div></div>
                        )}
                        {analyzed && view.legacyAnalysis!.value.catalogs.map((catalog) => {
                                const applicable = catalog.rules.filter((rule) => rule.status === "applicable");
                                const absent = catalog.rules.filter((rule) => rule.status === "absent");
                                const blocked = catalog.rules.filter((rule) => rule.status === "blocked");
                                return (
                                        <section className="nv-group" key={catalog.catalog} aria-labelledby={`catalog-${catalog.catalog}`}>
                                                <h2 className="nv-section" id={`catalog-${catalog.catalog}`}>{t(catalogLabelIds[catalog.catalog])}</h2>
                                                <p className="nv-supporting">{n(applicable.length)} {t("ui.applicable")} · {n(absent.length)} {t("ui.absent")} · {n(blocked.length)} {t("ui.blockedState")}</p>
                                                {applicable.length ? (
                                                        <div className="nv-choices">
                                                                {applicable.map((rule) => {
                                                                        const key = legacyRuleKey(catalog.catalog, rule.ruleId);
                                                                        return (
                                                                                <label key={rule.ruleId} className="nv-choice compact">
                                                                                        <input type="checkbox" checked={view.selectedLegacyRules.includes(key)} onChange={(event) => commands.toggleLegacyRule(key, event.target.checked)} />
                                                                                        <span className="nv-choice-text">
                                                                                                <span className="nv-strong">{t(legacyRuleDescriptionId(rule.ruleId))}{rule.recommended && <> <span className="nv-tag ok">{t("ui.recommended")}</span></>}</span>
                                                                                                <span className="nv-supporting">{exactMatches(rule.expectedMatches!)} · {t("ui.section")} 0x{rule.sectionType.toString(16).padStart(2, "0")}</span>
                                                                                                {rule.requiredRisks.length > 0 && <span className="nv-supporting">{t("ui.requires")} {rule.requiredRisks.map((risk) => t(riskLabelIds[risk])).join(" · ")}</span>}
                                                                                        </span>
                                                                                </label>
                                                                        );
                                                                })}
                                                        </div>
                                                ) : <p className="nv-supporting">{t("ui.noApplicableRulesInThisCatalog")}</p>}
                                                {absent.length > 0 && <p className="nv-supporting">{absentRules(absent.length)}</p>}
                                                {blocked.map((rule) => (
                                                        <RouteCard key={rule.ruleId} icon="alert" title={`${t("ui.blocked")} · ${t(legacyRuleDescriptionId(rule.ruleId))}`} detail={t(legacyRuleBlockedReasonId(rule.ruleId))} />
                                                ))}
                                        </section>
                                );
                        })}
                        {analyzed && view.selectedLegacyRisks.length > 0 && (
                                <section className="nv-group" aria-labelledby="legacy-risk-title">
                                        <h2 className="nv-section" id="legacy-risk-title">{t("ui.explicitRiskAcknowledgements")}</h2>
                                        <div className="nv-choices">
                                                {view.selectedLegacyRisks.map((risk) => (
                                                        <label key={risk} className="nv-choice compact">
                                                                <input type="checkbox" checked={view.legacyAcknowledgements[risk]?.confirmed ?? false} onChange={(event) => commands.setLegacyRiskConfirmed(risk, event.target.checked)} />
                                                                <span className="nv-choice-text"><span className="nv-strong">{t(riskLabelIds[risk])}</span><span className="nv-supporting">{t("ui.iReviewedThisRiskForTheAnalyzedFirmware")}</span></span>
                                                        </label>
                                                ))}
                                        </div>
                                </section>
                        )}
                        {analyzed && <div><button type="button" className="nv-btn nv-btn-text" disabled={busy} onClick={commands.analyzeLegacy}>{t("ui.analyzeFileAgain")}</button></div>}
                </TaskPanel>
        );
};

const AdvancedPolicy = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view, commands } = ctx;
        const active = view.firmwareTargetPolicy === "patchEveryDxeDomain";
        return (
                <details className="nv-disclosure" open={active || undefined}>
                        <summary><Icon name="chevron" />{t("ui.advancedOptions")}</summary>
                        <div className="nv-choices" style={{ paddingTop: 8 }}>
                                <label className="nv-choice compact">
                                        <input type="checkbox" checked={active} aria-describedby="patch-every-dxe-description" onChange={(event) => commands.setFirmwareTargetPolicy(event.target.checked ? "patchEveryDxeDomain" : "requireUnique")} />
                                        <span className="nv-choice-text"><span className="nv-strong">{t("ui.patchEveryDetectedDxeFirmwareDomain")}</span><span className="nv-supporting" id="patch-every-dxe-description">{t("ui.patchEveryDxeDomainExplanation")}</span></span>
                                </label>
                                {active && !isBootIndependentRecoveryMethod(view.recoveryMethod) && <p className="nv-supporting" role="status">{t("ui.patchEveryDxeDomainNeedsFlashbackOrSpi")}</p>}
                        </div>
                </details>
        );
};

/** Fills empty handoff notes from the chosen methods, confirms the route, then creates the record. */
const confirmAndCreate = (ctx: InstallContext) => {
        const { view, commands } = ctx;
        if (!view.installNote.trim()) commands.setInstallNote(messages[installMethodIds[view.installMethod].title].en);
        if (!view.recoveryNote.trim()) commands.setRecoveryNote(messages[recoveryMethodIds[view.recoveryMethod].title].en);
        if (!view.displayName.trim()) commands.setDisplayName(ctx.boardName || view.firmware?.fileName || "NvStrapsReBar");
        commands.setRouteConfirmed(true);
        commands.createProfile();
};

/** The manual link cannot open a browser from the app, so its address is copied instead. */
const ManualAddress = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view } = ctx;
        const [copied, setCopied] = useState(false);
        const copy = async () => {
                try {
                        await navigator.clipboard.writeText(view.instructionsUrl);
                        setCopied(true);
                } catch {
                        setCopied(false);
                }
        };
        return (
                <div className="nv-group" style={{ gap: 4 }}>
                        <p className="nv-body nv-muted">{t("ui.routesCheckManual")}</p>
                        <p className="nv-manual-address">
                                <span className="nv-mono nv-muted" title={view.instructionsUrl}>{view.instructionsUrl}</span>
                                <button type="button" className="nv-btn nv-btn-text" onClick={() => void copy()}>{t(copied ? "ui.addressCopied" : "ui.copyAddress")}</button>
                        </p>
                </div>
        );
};

const policyReady = (ctx: InstallContext) =>
        ctx.view.firmwareTargetPolicy !== "patchEveryDxeDomain" || isBootIndependentRecoveryMethod(ctx.view.recoveryMethod);

export const Routes = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view, navigation, busy } = ctx;
        return (
                <TaskPanel
                        label={stageLabel(ctx)}
                        title={t("ui.routesTitle")}
                        lead={t("ui.routesLead")}
                        titleRef={ctx.titleRef}
                        bar={
                                <ActionBar
                                        hint={t("ui.routesHint")}
                                        primary={{ label: t("ui.confirmAndMakeFile"), icon: "arrow", busy: view.busyAction === "profile", disabled: busy || !view.firmware || !view.legacyReady || !policyReady(ctx), onClick: () => confirmAndCreate(ctx) }}
                                />
                        }
                >
                        <ChosenFile ctx={ctx} />
                        <div className="nv-group">
                                <RouteCard icon="tool" label={t("ui.routeInstall")} title={t("ui.routeInstallMsiTitle")} detail={t("ui.routeInstallMsiDetail")} />
                                <RouteCard icon="undo" label={t("ui.routeRecovery")} title={t("ui.routeRecoveryMsiTitle")} detail={t("ui.routeRecoveryMsiDetail")} />
                        </div>
                        <ManualAddress ctx={ctx} />
                        <details className="nv-disclosure">
                                <summary><Icon name="chevron" />{t("ui.chooseOtherRoutes")}</summary>
                                <div className="nv-group" style={{ paddingTop: 8 }}>
                                        <p className="nv-supporting">{t("ui.chooseOtherRoutesDetail")}</p>
                                        <div><button type="button" className="nv-btn nv-btn-quiet" onClick={() => navigation.setInstallUi({ customRoutes: true, question: 1 })}>{t("ui.answerRouteQuestions")}</button></div>
                                        <AdvancedPolicy ctx={ctx} />
                                </div>
                        </details>
                </TaskPanel>
        );
};

export const InstallQuestion = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view, commands, navigation, busy } = ctx;
        const urlId = useId();
        const urlValid = view.instructionsUrl.startsWith("https://");
        return (
                <TaskPanel
                        label={stageLabel(ctx, 2)}
                        title={t("ui.installQuestionTitle")}
                        lead={t("ui.installQuestionLead")}
                        titleRef={ctx.titleRef}
                        bar={
                                <ActionBar
                                        hint={t("ui.installQuestionHint")}
                                        secondary={[{ label: t("ui.previousQuestion"), onClick: () => navigation.setInstallUi({ question: 1 }) }]}
                                        primary={{ label: t("ui.next"), icon: "arrow", disabled: busy || !urlValid, onClick: () => navigation.setInstallUi({ question: 3 }) }}
                                />
                        }
                >
                        <Choices
                                name="install-method"
                                legend={t("ui.installQuestionTitle")}
                                value={view.installMethod}
                                onChange={commands.setInstallMethod}
                                choices={(Object.keys(installMethodIds) as FirmwareInstallMethod[]).map((value) => ({ value, title: t(installMethodIds[value].title), detail: t(installMethodIds[value].detail) }))}
                        />
                        <label className="nv-field" htmlFor={urlId}>
                                <span>{t("ui.manualAddressLabel")}</span>
                                <input id={urlId} className="nv-input" type="url" value={view.instructionsUrl} placeholder="https://" onChange={(event) => commands.setInstructionsUrl(event.target.value)} />
                                <span className="nv-supporting">{t("ui.manualAddressDetail")}</span>
                        </label>
                </TaskPanel>
        );
};

export const RecoveryQuestion = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view, commands, navigation, busy } = ctx;
        const ready = view.recoveryMethod !== "none" && policyReady(ctx) && view.legacyReady;
        return (
                <TaskPanel
                        label={stageLabel(ctx, 3)}
                        title={t("ui.recoveryQuestionTitle")}
                        lead={t("ui.recoveryQuestionLead")}
                        titleRef={ctx.titleRef}
                        bar={
                                <ActionBar
                                        hint={t(view.recoveryMethod === "none" ? "ui.recoveryNoneHint" : "ui.recoveryQuestionHint")}
                                        secondary={[{ label: t("ui.previousQuestion"), onClick: () => navigation.setInstallUi({ question: 2 }) }]}
                                        primary={{ label: t("ui.confirmAndMakeFile"), icon: "arrow", busy: view.busyAction === "profile", disabled: busy || !ready, onClick: () => confirmAndCreate(ctx) }}
                                />
                        }
                >
                        <Choices
                                name="recovery-method"
                                legend={t("ui.recoveryQuestionTitle")}
                                value={view.recoveryMethod}
                                onChange={commands.setRecoveryMethod}
                                choices={(Object.keys(recoveryMethodIds) as RecoveryMethod[]).map((value) => ({ value, title: t(recoveryMethodIds[value].title), detail: t(recoveryMethodIds[value].detail) }))}
                        />
                        <AdvancedPolicy ctx={ctx} />
                </TaskPanel>
        );
};
