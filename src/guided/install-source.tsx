import { useEffect, useId, useRef, useState } from "react";
import type { FirmwareInstallMethod, RecoveryMethod } from "../deployment-workspace/contract";
import { instructionsUrlAcceptable, isBootIndependentRecoveryMethod } from "../deployment-workspace/machine-profile-draft";
import { catalogLabelIds, legacyRuleBlockedReasonId, legacyRuleDescriptionId, riskLabelIds } from "../deployment-workspace/messages";
import { legacyRuleKey } from "../deployment-workspace/session-projection";
import { MSI_MANUAL } from "../deployment-workspace/session-state";
import { useFirmwareDrop } from "../deployment-workspace/use-firmware-drop";
import { setupUtilityName } from "../hardware-support";
import { messages, type StaticMessageId } from "../i18n-catalog";
import { translateMessage } from "../i18n";
import type { HostOs } from "../platform";
import { Icon } from "./icons";
import type { InstallContext } from "./install-context";
import { pageAvailable } from "./routing";
import { ActionBar, Caution, Choices, ConfirmDialog, FileCard, Notice, RouteCard, Step, Steps, TaskPanel } from "./ui";

export const installMethodIds: Record<FirmwareInstallMethod, { title: StaticMessageId; detail: StaticMessageId }> = {
        firmwareSetupUtility: { title: "ui.methodSetupUtility", detail: "ui.methodSetupUtilityDetail" },
        usbFlashback: { title: "ui.methodUsbFlashback", detail: "ui.methodUsbFlashbackDetail" },
        vendorWindowsUtility: { title: "ui.methodWindowsUtility", detail: "ui.methodWindowsUtilityDetail" },
        externalSpiProgrammer: { title: "ui.methodSpiProgrammer", detail: "ui.methodSpiProgrammerDetail" },
};

/** Methods that run only on Windows; a plan that already uses one still shows its guide. */
const WINDOWS_ONLY_METHODS: readonly FirmwareInstallMethod[] = ["vendorWindowsUtility"];

/** Install methods offered in the method choice on this OS, in catalog order. */
export const offeredInstallMethods = (os: HostOs): FirmwareInstallMethod[] =>
        (Object.keys(installMethodIds) as FirmwareInstallMethod[]).filter((method) => os === "windows" || !WINDOWS_ONLY_METHODS.includes(method));

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

/**
 * Reading the file and making the record start on these screens, so their failures show here too,
 * the BIOS-file refusals (signed capsule, several DXE areas) included: no later screen is reached.
 */
const SourceFailure = ({ ctx }: { ctx: InstallContext }) => {
        const { t, locale, os, view } = ctx;
        if (view.activity?.tone !== "error") return null;
        return <Notice title={t("ui.taskDidNotFinish")}>{translateMessage(locale, view.activity.message, os)}</Notice>;
};

/**
 * The screens that make the file say so first when the maker's signature covers what the driver changes,
 * and point to the route that leaves the BIOS file alone.
 */
const SignedFirmwareWarning = ({ ctx }: { ctx: InstallContext }) => {
        const { t, os, view, navigation, busy } = ctx;
        if (!view.signedUpdateCoversDriver) return null;
        return (
                <Caution title={t("ui.signedFirmwareWarningTitle")}>
                        {t("ui.signedFirmwareWarningDetail")}
                        {pageAvailable("external", os) && (
                                <>
                                        <br />
                                        <button type="button" className="nv-btn nv-btn-text" disabled={busy} onClick={() => navigation.go("external")}>{t("ui.externalOpenFromWarning")}</button>
                                </>
                        )}
                </Caution>
        );
};

export const PickFirmware = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view, commands, busy, msi, boardName, navigation } = ctx;
        const manualId = useId();
        // A file dropped anywhere on the window is read; the box says so while one is dragged over it.
        const dropping = useFirmwareDrop(true).over && !busy;
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
                        <SourceFailure ctx={ctx} />
                        <Steps>
                                <Step title={t(msi ? "ui.pickFirmwareStepDownloadMsi" : "ui.pickFirmwareStepDownload")} detail={t(msi ? "ui.pickFirmwareStepDownloadDetailMsi" : "ui.pickFirmwareStepDownloadDetail")} />
                                <Step title={t(msi ? "ui.pickFirmwareStepChooseMsi" : "ui.pickFirmwareStepChoose")} detail={t(msi ? "ui.pickFirmwareStepChooseDetailMsi" : "ui.pickFirmwareStepChooseDetail")} />
                        </Steps>
                        <button type="button" className={dropping ? "nv-file nv-file-empty nv-file-pick over" : "nv-file nv-file-empty nv-file-pick"} disabled={busy} onClick={commands.chooseFirmware}>
                                <Icon name="folder" />
                                <span className="nv-file-body">
                                        <span className="nv-strong">{t(dropping ? "ui.dropFileHere" : "ui.noFileChosen")}</span>
                                        {!dropping && <span className="nv-supporting">{t("ui.noFileChosenDetail")}</span>}
                                </span>
                        </button>
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
        const { t, n, exactMatches, absentRules, locale, os, view, commands, navigation, busy, routing } = ctx;
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
                                        hint={view.legacyNextAction ? translateMessage(locale, view.legacyNextAction, os) : undefined}
                                        secondary={routing.catalogBoard ? [] : [{ label: t("ui.previousQuestion"), onClick: () => navigation.setInstallUi({ question: 1 }) }]}
                                        primary={analyzed
                                                ? { label: t("ui.next"), icon: "arrow", disabled: busy || !view.legacyReady, onClick: next }
                                                : { label: t(view.legacyAnalysisStatus === "pending" ? "ui.analyzingFile" : "ui.analyzeFile"), busy: view.legacyAnalysisStatus === "pending", disabled: busy || !view.firmware, onClick: commands.analyzeLegacy }}
                                />
                        }
                >
                        <ChosenFile ctx={ctx} />
                        {view.legacyAnalysisStatus === "error" && view.legacyNextAction && (
                                <div className="nv-notice" role="alert"><Icon name="alert" /><div className="nv-fact-text"><strong>{t("ui.legacyAnalysisFailed")}</strong><span>{translateMessage(locale, view.legacyNextAction, os)}</span></div></div>
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

/**
 * Records the routes the screen showed, confirms them, then creates the record. The guided
 * screens do not edit handoff notes, so the notes always follow the methods: the catalog
 * routes on the Routes screen, otherwise the answered methods. Local intents apply in order
 * before createProfile reads the session.
 */
const confirmAndCreate = (ctx: InstallContext) => {
        const { view, commands } = ctx;
        if (ctx.routing.catalogBoard) {
                commands.setInstallMethod("firmwareSetupUtility");
                commands.setRecoveryMethod("usbFlashback");
                commands.setInstructionsUrl(MSI_MANUAL);
                commands.setInstallNote(messages["ui.useMFlashToSelectTheExportedVendorFormatImage"].en);
                commands.setRecoveryNote(messages["ui.msiFlashBiosButtonRecoveryMsiRomAtUsbRootRearFlashBiosPortPhysicalButton"].en);
        } else {
                commands.setInstallNote(messages[installMethodIds[view.installMethod].title].en);
                commands.setRecoveryNote(messages[recoveryMethodIds[view.recoveryMethod].title].en);
        }
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
                        <SourceFailure ctx={ctx} />
                        <ChosenFile ctx={ctx} />
                        <SignedFirmwareWarning ctx={ctx} />
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
        const { t, os, view, commands, navigation, busy, snapshot } = ctx;
        const urlId = useId();
        const urlField = useRef<HTMLDivElement>(null);
        const urlInput = useRef<HTMLInputElement>(null);
        // Presses of Next that the address stopped. The message stays until the address is acceptable.
        const [urlRefusals, setUrlRefusals] = useState(0);
        const urlAcceptable = instructionsUrlAcceptable(view.instructionsUrl);
        const urlError = urlRefusals > 0 && !urlAcceptable;
        const tool = setupUtilityName(snapshot.machineIdentity?.boardManufacturer);
        // Once the message is on the screen, focus goes to the field, and a short window scrolls until the message under it shows.
        useEffect(() => {
                if (!urlRefusals) return;
                urlInput.current?.focus({ preventScroll: true });
                urlField.current?.scrollIntoView({ block: "nearest" });
        }, [urlRefusals]);
        const next = () => {
                if (urlAcceptable) navigation.setInstallUi({ question: 3 });
                else setUrlRefusals((count) => count + 1);
        };
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
                                        primary={{ label: t("ui.next"), icon: "arrow", disabled: busy, onClick: next }}
                                />
                        }
                >
                        <Choices
                                name="install-method"
                                legend={t("ui.installQuestionTitle")}
                                value={view.installMethod}
                                onChange={commands.setInstallMethod}
                                choices={offeredInstallMethods(os).map((value) => ({
                                        value,
                                        title: t(installMethodIds[value].title),
                                        detail: value === "firmwareSetupUtility" && tool ? t("ui.methodSetupUtilityDetailNamed", { tool }) : t(installMethodIds[value].detail),
                                }))}
                        />
                        <div ref={urlField} className="nv-field">
                                <label className="nv-label" htmlFor={urlId}>{t("ui.manualAddressLabel")}</label>
                                <input
                                        ref={urlInput}
                                        id={urlId}
                                        className="nv-input"
                                        type="url"
                                        value={view.instructionsUrl}
                                        placeholder="https://"
                                        aria-invalid={urlError || undefined}
                                        aria-describedby={urlError ? `${urlId}-error ${urlId}-detail` : `${urlId}-detail`}
                                        onChange={(event) => {
                                                if (instructionsUrlAcceptable(event.target.value)) setUrlRefusals(0);
                                                commands.setInstructionsUrl(event.target.value);
                                        }}
                                />
                                {urlError && <span className="nv-field-error" id={`${urlId}-error`}>{t("ui.manualAddressInvalid")}</span>}
                                <span className="nv-supporting" id={`${urlId}-detail`}>{t("ui.manualAddressDetail")}</span>
                        </div>
                </TaskPanel>
        );
};

/** What can go wrong on a board that cannot put its BIOS back, as the confirmation lists it. */
const RECOVERY_NONE_RISKS: readonly StaticMessageId[] = [
        "ui.recoveryNoneRiskInterrupted",
        "ui.recoveryNoneRiskNoStart",
        "ui.recoveryNoneRiskWarranty",
];

export const RecoveryQuestion = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view, commands, navigation, busy } = ctx;
        const ready = policyReady(ctx) && view.legacyReady;
        const none = view.recoveryMethod === "none";
        // A board with no way to recover is a true answer, so it goes on, after one question that says what can go wrong.
        const [asking, setAsking] = useState(false);
        return (
                <>
                        <TaskPanel
                                label={stageLabel(ctx, 3)}
                                title={t("ui.recoveryQuestionTitle")}
                                lead={t("ui.recoveryQuestionLead")}
                                titleRef={ctx.titleRef}
                                bar={
                                        <ActionBar
                                                hint={t(none ? "ui.recoveryNoneHint" : "ui.recoveryQuestionHint")}
                                                secondary={[{ label: t("ui.previousQuestion"), onClick: () => navigation.setInstallUi({ question: 2 }) }]}
                                                primary={{ label: t("ui.confirmAndMakeFile"), icon: "arrow", busy: view.busyAction === "profile", disabled: busy || !ready, onClick: () => (none ? setAsking(true) : confirmAndCreate(ctx)) }}
                                        />
                                }
                        >
                                <SourceFailure ctx={ctx} />
                                <SignedFirmwareWarning ctx={ctx} />
                                <Choices
                                        name="recovery-method"
                                        legend={t("ui.recoveryQuestionTitle")}
                                        value={view.recoveryMethod}
                                        onChange={commands.setRecoveryMethod}
                                        choices={(Object.keys(recoveryMethodIds) as RecoveryMethod[]).map((value) => ({ value, title: t(recoveryMethodIds[value].title), detail: t(recoveryMethodIds[value].detail) }))}
                                />
                                <AdvancedPolicy ctx={ctx} />
                        </TaskPanel>
                        {asking && (
                                <ConfirmDialog
                                        title={t("ui.recoveryNoneConfirmTitle")}
                                        confirmLabel={t("ui.recoveryNoneConfirmAction")}
                                        onClose={() => setAsking(false)}
                                        onConfirm={() => {
                                                setAsking(false);
                                                confirmAndCreate(ctx);
                                        }}
                                >
                                        {t("ui.recoveryNoneConfirmLead")}
                                        <span className="nv-dialog-list" role="list">
                                                {RECOVERY_NONE_RISKS.map((id) => <span key={id} role="listitem">{t(id)}</span>)}
                                        </span>
                                        {/* Below the line: not one more thing that can go wrong, but what there is to do when it has. */}
                                        <span className="nv-dialog-remedy">
                                                <span className="nv-strong">{t("ui.recoveryNoneRemedyLabel")}</span>
                                                <span>{t("ui.recoveryNoneRemedy")}</span>
                                        </span>
                                </ConfirmDialog>
                        )}
                </>
        );
};
