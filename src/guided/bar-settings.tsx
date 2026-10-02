import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { formatBytes, formatPciSelector, hex, pciTargetSizes } from "../configuration-workspace/model";
import { useConfigurationWorkspaceController } from "../configuration-workspace/context";
import { translateMessage, useI18n } from "../i18n";
import type { ConfigDraft, GpuDevice } from "../types";
import {
        applyGpuChoice,
        automaticSelector,
        changeItems,
        expansionOn,
        gpuChoice,
        leavesAlone,
        otherRules,
        pciLocation,
        shortGpuName,
        sizeText,
        withExpansion,
        type ChangeItem,
        type GpuChoice,
} from "./bar-settings-model";
import { Icon } from "./icons";
import { useGuidedNavigation } from "./navigation";
import { Crumb, GpuRow, Notice, Result, TaskHead } from "./ui";

type Translate = ReturnType<typeof useI18n>["t"];

/** A setting row that describes its on state, with a switch at the right. */
const SwitchRow = ({ title, detail, checked, disabled, onChange, card = false }: {
        title: ReactNode;
        detail?: ReactNode;
        checked: boolean;
        disabled?: boolean;
        onChange: (checked: boolean) => void;
        card?: boolean;
}) => {
        const id = useId();
        return (
                <div className={card ? "nv-card nv-switch-row" : "nv-switch-row"}>
                        <div className="nv-fact-text">
                                <span className="nv-strong" id={`${id}-title`}>{title}</span>
                                {detail && <span className="nv-supporting" id={`${id}-detail`}>{detail}</span>}
                        </div>
                        <button
                                type="button"
                                className="nv-switch"
                                role="switch"
                                aria-checked={checked}
                                aria-labelledby={`${id}-title`}
                                aria-describedby={detail ? `${id}-detail` : undefined}
                                disabled={disabled}
                                onClick={() => onChange(!checked)}
                        />
                </div>
        );
};

/** The size a choice gives: "Automatic" resolves to what the global mode gives this GPU. */
const resolvedText = (t: Translate, draft: ConfigDraft, gpu: GpuDevice, choice: GpuChoice) => {
        if (choice === "exclude") return t("ui.barSizeExcluded");
        if (choice !== "auto") return sizeText(choice);
        const automatic = automaticSelector(draft, gpu);
        return leavesAlone(automatic) ? t("ui.barSizeExcluded") : sizeText(automatic!);
};

const choiceText = (t: Translate, draft: ConfigDraft, gpu: GpuDevice, choice: GpuChoice) =>
        choice === "auto" ? t("ui.barSizeAutoWith", { size: resolvedText(t, draft, gpu, "auto") }) : resolvedText(t, draft, gpu, choice);

const changeText = (t: Translate, item: ChangeItem) => {
        switch (item.kind) {
                case "expansion":
                        return t(item.on ? "ui.changeExpansionOn" : "ui.changeExpansionOff");
                case "gpu":
                        return t("ui.changeGpuSize", {
                                gpu: shortGpuName(item.gpu.name),
                                from: resolvedText(t, item.fromDraft, item.gpu, item.from),
                                to: resolvedText(t, item.toDraft, item.gpu, item.to),
                        });
                case "advanced":
                        return t("ui.changeAdvanced");
                case "otherRules":
                        return t("ui.changeOtherRules");
                case "settings":
                        return t("ui.changeSettings");
        }
};

const GpuSizeRow = ({ gpu, draft, disabled, onChoose }: { gpu: GpuDevice; draft: ConfigDraft; disabled: boolean; onChoose: (choice: GpuChoice) => void }) => {
        const { t } = useI18n();
        const choice = gpuChoice(draft, gpu);
        const value = choice === "auto" ? "auto" : choice === "exclude" ? "exclude" : String(choice);
        const outside = typeof choice === "number" && pciTargetSizes[choice] === undefined;
        return (
                <GpuRow name={gpu.name} detail={t("ui.gpuSlotNow", { location: pciLocation(gpu), size: formatBytes(gpu.currentBarSize) })}>
                        <label className="nv-field nv-field-inline">
                                <span className="nv-label">{t("ui.afterRestart")}</span>
                                <select
                                        className="nv-select"
                                        aria-label={t("ui.gpuSizeFor", { gpu: shortGpuName(gpu.name) })}
                                        value={value}
                                        disabled={disabled}
                                        onChange={(event) => {
                                                const next = event.target.value;
                                                onChoose(next === "auto" || next === "exclude" ? next : Number(next));
                                        }}
                                >
                                        <option value="auto">{choiceText(t, draft, gpu, "auto")}</option>
                                        {pciTargetSizes.map((size, selector) => <option key={size} value={selector}>{size}</option>)}
                                        {outside && <option value={String(choice)}>{sizeText(choice as number)}</option>}
                                        <option value="exclude">{t("ui.barSizeExcluded")}</option>
                                </select>
                        </label>
                </GpuRow>
        );
};

const AdvancedSettings = ({ draft, patch, setDraft, devices, disabled }: {
        draft: ConfigDraft;
        patch: (value: Partial<ConfigDraft>) => void;
        setDraft: (draft: ConfigDraft) => void;
        devices: GpuDevice[];
        disabled: boolean;
}) => {
        const { t } = useI18n();
        const limitId = useId();
        const others = otherRules(draft, devices);
        return (
                <details className="nv-disclosure" data-testid="advanced-settings">
                        <summary><Icon name="chevron" />{t("ui.advancedBarSummary")}</summary>
                        <div className="nv-group nv-disclosure-body">
                                {draft.globalMode !== 0 && (
                                        <SwitchRow
                                                title={t("ui.expandUnlistedGpus")}
                                                detail={t("ui.expandUnlistedGpusDetail")}
                                                checked={draft.globalMode === 2}
                                                disabled={disabled}
                                                onChange={(checked) => patch({ globalMode: checked ? 2 : 1 })}
                                        />
                                )}
                                <label className="nv-field" htmlFor={limitId}>
                                        <span className="nv-label">{t("ui.motherboardSizeLimit")}</span>
                                        <select id={limitId} className="nv-select" value={draft.targetPciBarSize} disabled={disabled} onChange={(event) => patch({ targetPciBarSize: Number(event.target.value) })}>
                                                <option value="0">{t("ui.defaultNoPciResize")}</option>
                                                {Array.from({ length: 31 }, (_, index) => <option key={index} value={index + 1}>{formatPciSelector(index + 1)}</option>)}
                                                <option value="32">{t("ui.anySupportedSize")}</option>
                                                <option value="64">{t("ui.selectedGpusOnly")}</option>
                                                <option value="65">{t("ui.gpuStrapsOnly")}</option>
                                        </select>
                                        <span className="nv-supporting">{t("ui.targetPciBarSizeGuidance")}</span>
                                </label>
                                <SwitchRow
                                        title={t("ui.checkSetupVariableChanges")}
                                        detail={t("ui.compareTheSetupVariableFingerprintBeforeApplyingConfiguration")}
                                        checked={draft.guardSetupChanges}
                                        disabled={disabled}
                                        onChange={(checked) => patch({ guardSetupChanges: checked })}
                                />
                                <SwitchRow
                                        title={t("ui.overrideBarSizeMaskGlobally")}
                                        detail={t("ui.advertiseTheConfiguredSizeWhenCapabilityMasksDiffer")}
                                        checked={draft.overrideBarSizeMask}
                                        disabled={disabled}
                                        onChange={(checked) => patch({ overrideBarSizeMask: checked })}
                                />
                                <SwitchRow
                                        title={t("ui.reapplyAfterSleep")}
                                        detail={t("ui.reapplyAfterSleepDetail")}
                                        checked={!draft.skipS3Resume}
                                        disabled={disabled}
                                        onChange={(checked) => patch({ skipS3Resume: !checked })}
                                />
                                {others.length > 0 && (
                                        <section className="nv-group" aria-labelledby={`${limitId}-others`}>
                                                <h3 className="nv-label" id={`${limitId}-others`}>{t("ui.otherGpuRules")}</h3>
                                                {others.map(({ rule, index }) => (
                                                        <GpuRow key={index} name={t("ui.otherGpuRule", { device: hex(rule.deviceId), location: pciLocation(rule) })} detail={rule.barSizeSelector === null ? t("ui.barSizeAuto") : rule.barSizeSelector >= 254 ? t("ui.barSizeExcluded") : sizeText(rule.barSizeSelector)}>
                                                                <button type="button" className="nv-btn nv-btn-text" disabled={disabled} onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, current) => current !== index) })}>{t("ui.removeRule")}</button>
                                                        </GpuRow>
                                                ))}
                                        </section>
                                )}
                        </div>
                </details>
        );
};

const SettingsFile = ({ open }: { open: boolean }) => {
        const { t } = useI18n();
        const { snap, busy, settingsFile, exportSettings, importSettings } = useConfigurationWorkspaceController();
        const ref = useRef<HTMLDetailsElement>(null);
        useEffect(() => {
                if (open) ref.current?.scrollIntoView({ block: "nearest" });
        }, [open]);
        return (
                <details ref={ref} className="nv-disclosure" data-testid="settings-file" open={open || Boolean(settingsFile) || undefined}>
                        <summary><Icon name="chevron" />{t("ui.settingsFileSummary")}</summary>
                        <div className="nv-group nv-disclosure-body">
                                <p className="nv-supporting">{t("ui.settingsFileHint")}</p>
                                <div className="nv-button-row">
                                        <button type="button" className="nv-btn nv-btn-quiet" disabled={busy || !snap?.config} onClick={() => void exportSettings()}><Icon name="save" />{t("ui.saveSettingsToFile")}</button>
                                        <button type="button" className="nv-btn nv-btn-quiet" disabled={busy} onClick={() => void importSettings()}><Icon name="folder" />{t("ui.loadSettingsFromFile")}</button>
                                </div>
                                {settingsFile?.kind === "exported" && <Result title={t("ui.settingsFileSaved")} detail={<span className="nv-mono">{settingsFile.path}</span>} />}
                                {settingsFile?.kind === "imported" && <Result title={t("ui.settingsFileLoaded")} detail={t("ui.reviewTheLoadedDraftThenSave")} />}
                        </div>
                </details>
        );
};

const AccessRequired = () => {
        const { t } = useI18n();
        const { snap, busy, elevate, load } = useConfigurationWorkspaceController();
        if (!snap) return null;
        const elevated = snap.platform.elevated;
        return (
                <section className="nv-card" aria-labelledby="load-settings">
                        <h2 className="nv-section" id="load-settings">{t("ui.loadSavedSettings")}</h2>
                        <p className="nv-body nv-muted">{t(elevated ? "ui.readPcToLoadSettings" : "ui.reopenAdminToLoadSettings")}</p>
                        <div>
                                {elevated ? (
                                        <button type="button" className="nv-btn nv-btn-primary" disabled={busy} onClick={() => void load(true)}><Icon name="restart" />{t("ui.menuRefresh")}</button>
                                ) : (
                                        <button type="button" className="nv-btn nv-btn-primary" disabled={busy} onClick={() => void elevate()}><Icon name="key" />{t("ui.reopenAsAdministrator")}</button>
                                )}
                        </div>
                </section>
        );
};

/** One confirmation with one factual line; Close sits on the left and has focus. */
const SaveDialog = () => {
        const { t } = useI18n();
        const { showConfirm, report, dialog, setShowConfirm, save } = useConfigurationWorkspaceController();
        if (!showConfirm) return null;
        const removes = report?.variableWillExist === false;
        return (
                <div className="nv-scrim" role="presentation">
                        <div ref={dialog} className="nv-dialog" role="dialog" aria-modal="true" aria-labelledby="bar-save-title" aria-describedby="bar-save-detail">
                                <h2 id="bar-save-title">{t(removes ? "ui.turnOffDialogTitle" : "ui.saveBarDialogTitle")}</h2>
                                <p className="nv-body" id="bar-save-detail">{t(removes ? "ui.turnOffDialogDetail" : "ui.saveBarDialogDetail")}</p>
                                <div className="nv-dialog-actions">
                                        <button type="button" className="nv-btn nv-btn-quiet" autoFocus onClick={() => setShowConfirm(false)}>{t("ui.close")}</button>
                                        <button type="button" className="nv-btn nv-btn-primary" onClick={() => void save()}>{t(removes ? "ui.turnOff" : "ui.save")}</button>
                                </div>
                        </div>
                </div>
        );
};

/** BAR settings: expansion switch, size for each GPU, advanced options and the settings file; a save bar appears on change. */
export const BarSettingsPage = ({ titleRef }: { titleRef: Ref<HTMLHeadingElement> }) => {
        const { t, locale } = useI18n();
        const config = useConfigurationWorkspaceController();
        const { snap, draft, baseline, dirty, report, busy, receipt, error, systemNotices, patch, setDraft, setReport, openSaveConfirmation, reviewButton } = config;
        const navigation = useGuidedNavigation();
        // Turning expansion off clears the rules; turning it back on restores them until the draft is reverted or saved.
        const [restore, setRestore] = useState<Pick<ConfigDraft, "globalMode" | "rules"> | null>(null);
        useEffect(() => setRestore(null), [baseline]);
        if (!snap) return null;

        const savePath = snap.barSettings.settingsAvailable ? "settings" : "configure";
        const loaded = savePath === "configure" || Boolean(snap.config && snap.barSettings.configToken !== null);
        const turing = snap.devices.filter((gpu) => gpu.isTuring);
        const on = expansionOn(draft);
        const items = dirty ? changeItems(baseline, draft, snap.devices) : [];
        const disabled = busy;
        const canSave = dirty && Boolean(report?.valid) && !busy && snap.firmware.accessible;
        const warnings = report
                ? [
                          ...(draft.skipS3Resume ? (["ui.s3ResumeReconfigurationIsDisabledTestS3ResumeOnThisComputer"] as const) : []),
                          ...(report.affectedGpuIds.length === 0 && report.encodedSize > 0 ? (["ui.theCurrentSettingsDoNotSelectAnyDetectedNvidiaGpu"] as const) : []),
                  ]
                : [];
        const expansionDetail = on && draft.globalMode === 0 ? "ui.barExpansionDetailRules" : draft.globalMode === 1 ? "ui.barExpansionDetailListed" : "ui.barExpansionDetailFallback";

        return (
                <>
                        <div className="nv-page">
                                <main className="nv-home" data-testid="bar-page">
                                        <div className="nv-task-body" style={{ paddingTop: 32, gap: 24, paddingBottom: dirty && loaded ? 120 : 32 }}>
                                                <Crumb here={t("ui.barSettings")} onHome={() => navigation.go("home")} />
                                                <TaskHead title={t("ui.barSettings")} lead={t("ui.barSettingsLead")} titleRef={titleRef} />
                                                {error && <Notice title={t("ui.taskDidNotFinish")}>{translateMessage(locale, error)}</Notice>}
                                                {systemNotices.map((notice) => (
                                                        <div className="nv-caution" role="note" key={notice.id}><Icon name="alert" /><div className="nv-fact-text"><span>{t(notice.id)}</span></div></div>
                                                ))}
                                                {snap.barSettings.savedConfigurationState === "invalid" && (
                                                        <div className="nv-caution" role="note"><Icon name="alert" /><div className="nv-fact-text"><span>{t("ui.savedConfigurationInvalidNotice")}</span></div></div>
                                                )}
                                                {receipt?.path === savePath && !dirty && (
                                                        <Result title={t(savePath === "settings" ? "ui.barSettingsSavedAndReadBack" : "ui.configurationWrittenAndReadBack")} detail={t("ui.appliesAfterRestart")} />
                                                )}
                                                {loaded ? (
                                                        <>
                                                                <SwitchRow
                                                                        card
                                                                        title={t("ui.barExpansion")}
                                                                        detail={t(expansionDetail)}
                                                                        checked={on}
                                                                        disabled={disabled}
                                                                        onChange={(checked) => {
                                                                                if (!checked) setRestore({ globalMode: draft.globalMode, rules: draft.rules });
                                                                                setDraft(withExpansion(draft, checked, checked ? restore : null));
                                                                                if (checked) setRestore(null);
                                                                        }}
                                                                />
                                                                {on && (
                                                                        <section className="nv-group" aria-labelledby="gpu-sizes">
                                                                                <h2 className="nv-section" id="gpu-sizes">{t("ui.gpuSizesTitle")}</h2>
                                                                                {turing.length ? (
                                                                                        turing.map((gpu) => (
                                                                                                <GpuSizeRow key={gpu.id} gpu={gpu} draft={draft} disabled={disabled} onChoose={(choice) => setDraft(applyGpuChoice(draft, gpu, choice))} />
                                                                                        ))
                                                                                ) : (
                                                                                        <p className="nv-supporting">{t("ui.noTuringGpuFound")}</p>
                                                                                )}
                                                                        </section>
                                                                )}
                                                                {dirty && report && !report.valid && (
                                                                        <Notice title={t("ui.fixBeforeSaving")}>{report.errors.join(" ")}</Notice>
                                                                )}
                                                                {warnings.map((id) => (
                                                                        <div className="nv-caution" role="note" key={id}><Icon name="alert" /><div className="nv-fact-text"><span>{t(id)}</span></div></div>
                                                                ))}
                                                                <AdvancedSettings draft={draft} patch={patch} setDraft={setDraft} devices={snap.devices} disabled={disabled} />
                                                                <SettingsFile open={navigation.settingsFileOpen} />
                                                        </>
                                                ) : (
                                                        <AccessRequired />
                                                )}
                                        </div>
                                </main>
                                {dirty && loaded && (
                                        <div className="nv-savebar-dock">
                                                <div className="nv-savebar" role="region" aria-label={t("ui.unsavedChanges")}>
                                                        <span className="nv-strong nv-savebar-text">
                                                                {items.length === 1
                                                                        ? t("ui.changesOne", { item: changeText(t, items[0]!) })
                                                                        : t("ui.changesMany", { count: items.length, item: changeText(t, items[0]!), more: items.length - 1 })}
                                                        </span>
                                                        <button
                                                                type="button"
                                                                className="nv-btn nv-btn-text"
                                                                disabled={busy}
                                                                onClick={() => {
                                                                        setDraft(structuredClone(baseline));
                                                                        setReport(null);
                                                                        setRestore(null);
                                                                }}
                                                        >
                                                                {t("ui.revert")}
                                                        </button>
                                                        <button ref={reviewButton} type="button" className="nv-btn nv-btn-primary" disabled={!canSave} aria-busy={dirty && !report ? true : undefined} onClick={() => openSaveConfirmation(savePath)}>
                                                                {t("ui.save")}
                                                        </button>
                                                </div>
                                        </div>
                                )}
                        </div>
                        <SaveDialog />
                </>
        );
};
