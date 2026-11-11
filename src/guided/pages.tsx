import { useEffect, useId, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { useConfigurationWorkspaceController } from "../configuration-workspace/context";
import { useDeploymentWorkspaceController } from "../deployment-workspace/context";
import { stepKindIds, stepStateIds, stepTitleIds } from "../deployment-workspace/messages";
import { translateMessage, useI18n } from "../i18n";
import { BarSettingsPage } from "./bar-settings";
import { recallExport } from "./export-memory";
import { Icon } from "./icons";
import { initialInstallUi, useGuidedNavigation } from "./navigation";
import { OPTIONAL_FINAL_STEP, listedSteps } from "./routing";
import { ActionBar, type ActionBarProps, ConfirmDialog, Crumb, Fact, Facts, FileCard, Notice, Result, Step, Steps, TaskHead } from "./ui";

const SubPage = ({ here, title, lead, titleRef, children, bar, wide = false, testId }: {
        here: ReactNode;
        title: ReactNode;
        lead?: ReactNode;
        titleRef: Ref<HTMLHeadingElement>;
        children: ReactNode;
        bar?: ActionBarProps;
        wide?: boolean;
        testId?: string;
}) => {
        const { go } = useGuidedNavigation();
        return (
                <>
                        <main className="nv-home" data-testid={testId}>
                                <div className={wide ? "nv-task-body wide" : "nv-task-body"} style={{ paddingTop: 32, gap: 24 }}>
                                        <Crumb here={here} onHome={() => go("home")} />
                                        <TaskHead title={title} lead={lead} titleRef={titleRef} />
                                        {children}
                                </div>
                        </main>
                        {bar && <ActionBar center {...bar} />}
                </>
        );
};

/** BAR settings; the screen itself lives in bar-settings.tsx. */
export const BarPage = BarSettingsPage;

export const ChangesPage = ({ titleRef }: { titleRef: Ref<HTMLHeadingElement> }) => {
        const { t } = useI18n();
        const { snap, exportSettings, busy, settingsFile } = useConfigurationWorkspaceController();
        const { go } = useGuidedNavigation();
        const canExport = Boolean(snap?.config);
        return (
                <SubPage
                        here={t("ui.changesTitleShort")}
                        title={t("ui.changesTitle")}
                        titleRef={titleRef}
                        testId="changes-page"
                        bar={{
                                hint: t("ui.changesHint"),
                                primary: canExport
                                        ? { label: t("ui.saveSettingsToFile"), icon: "save", disabled: busy, onClick: () => void exportSettings() }
                                        : { label: t("ui.openBarSettings"), onClick: () => go("bar") },
                        }}
                >
                        {settingsFile?.kind === "exported" && <Result title={t("ui.settingsFileSaved")} detail={settingsFile.path} />}
                        <Facts>
                                <Fact icon="sliders" title={t("ui.changesSetupChanged")} detail={t("ui.changesSetupChangedDetail")} />
                                <Fact icon="file" title={t("ui.changesBiosUpdated")} detail={t("ui.changesBiosUpdatedDetail")} />
                        </Facts>
                        <section className="nv-group" aria-labelledby="swap">
                                <h2 className="nv-section" id="swap">{t("ui.changesSwapTitle")}</h2>
                                <Steps>
                                        <Step title={t("ui.changesSwapSave")} />
                                        <Step title={t("ui.changesSwapOff")} />
                                        <Step title={t("ui.changesSwapPower")} detail={t("ui.changesSwapPowerDetail")} />
                                </Steps>
                        </section>
                </SubPage>
        );
};

export const RecordPage = ({ titleRef }: { titleRef: Ref<HTMLHeadingElement> }) => {
        const { t, locale, os } = useI18n();
        const { view, commands } = useDeploymentWorkspaceController();
        const busy = Boolean(view.busyAction);
        const remembered = view.packageReceipt ?? recallExport(view.selectedProfileId);
        return (
                <SubPage
                        here={t("ui.menuInstallRecord")}
                        title={t("ui.menuInstallRecord")}
                        lead={view.selectedProfile?.displayName}
                        titleRef={titleRef}
                        testId="record-page"
                        bar={{ hint: t("ui.recordCompareHint"), primary: { label: t("ui.compareWithThisPc"), disabled: busy || !view.selectedProfileId, busy: view.busyAction === "preflight", onClick: commands.compare } }}
                >
                        {view.activity && (
                                view.activity.tone === "success"
                                        ? <Result title={translateMessage(locale, view.activity.message, os)} />
                                        : <Notice title={t("ui.taskDidNotFinish")}>{translateMessage(locale, view.activity.message, os)}</Notice>
                        )}
                        {view.plan && (
                                <ol className="nv-ledger" aria-label={t("ui.deploymentPlan")}>
                                        {listedSteps(view.plan.steps, os).map((step) => (
                                                <li key={step.id} className={`nv-check ${step.state === "completed" ? "done" : step.state === "ready" ? "running" : "waiting"}`}>
                                                        <span className="nv-check-mark" aria-hidden="true">{step.state === "completed" ? <Icon name="check" /> : null}</span>
                                                        <span className="nv-fact-text"><span>{t(stepTitleIds[step.id])}</span><span className="nv-supporting">{t(stepKindIds[step.kind])}{step.id === OPTIONAL_FINAL_STEP ? ` · ${t("ui.optional")}` : ""}</span></span>
                                                        <span className="nv-check-state">{t(stepStateIds[step.state])}</span>
                                                </li>
                                        ))}
                                </ol>
                        )}
                        {remembered && <FileCard icon="usb" name={t("ui.recordPackage")} mono={false} meta={<span className="nv-mono">{remembered.packagePath}</span>} />}
                </SubPage>
        );
};

/** The record a delete is about, and where its row is in the list. */
type DeleteTarget = { profileId: string; displayName: string; fileName: string; index: number; selected: boolean };

export const ProfilesPage = ({ titleRef }: { titleRef: Ref<HTMLHeadingElement> }) => {
        const { t, locale, os } = useI18n();
        const { view, commands } = useDeploymentWorkspaceController();
        const { go, setInstallUi } = useGuidedNavigation();
        const id = useId();
        const rows = useRef<HTMLUListElement>(null);
        const busy = Boolean(view.busyAction);
        // The record the open dialog asks about, then the record whose delete is running.
        const [asking, setAsking] = useState<DeleteTarget | null>(null);
        const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
        // An error left by another page is not shown here; only a delete made on this page reports its failure.
        const [attempted, setAttempted] = useState(false);

        // When the delete ends, focus goes to the delete button of the row now in that place, or to the title when no row is left.
        useEffect(() => {
                if (!deleting || view.busyAction) return;
                setDeleting(null);
                const kept = view.profiles.findIndex((profile) => profile.profileId === deleting.profileId);
                // The open record is gone: the install screens start over, as they do when a record is opened from this list.
                if (kept < 0 && deleting.selected) setInstallUi({ ...initialInstallUi });
                // One frame later, after the closed dialog has returned focus to the button that opened it.
                requestAnimationFrame(() => {
                        const buttons = rows.current?.querySelectorAll<HTMLButtonElement>(".nv-row-delete");
                        const next = buttons?.[kept >= 0 ? kept : Math.min(deleting.index, buttons.length - 1)];
                        (next ?? (titleRef as RefObject<HTMLHeadingElement> | null)?.current)?.focus();
                });
        }, [deleting, view.busyAction, view.profiles, setInstallUi, titleRef]);

        return (
                <>
                        <SubPage here={t("ui.menuOpenPreparation")} title={t("ui.profilesTitle")} lead={t("ui.profilesLead")} titleRef={titleRef} testId="profiles-page">
                                {attempted && view.activity?.tone === "error" && <Notice title={t("ui.taskDidNotFinish")}>{translateMessage(locale, view.activity.message, os)}</Notice>}
                                {view.profiles.length > 0 && (
                                        <ul ref={rows} className="nv-rows">
                                                {view.profiles.map((profile, index) => {
                                                        const selected = profile.profileId === view.selectedProfileId;
                                                        return (
                                                                <li key={profile.profileId} className="nv-row-split">
                                                                        <button
                                                                                type="button"
                                                                                className="nv-row"
                                                                                aria-current={selected || undefined}
                                                                                disabled={busy}
                                                                                onClick={() => {
                                                                                        if (!selected) commands.setSelectedProfileId(profile.profileId);
                                                                                        setInstallUi({ ...initialInstallUi });
                                                                                        go("install");
                                                                                }}
                                                                        >
                                                                                <Icon name="file" />
                                                                                <span className="nv-row-text" id={`${id}-${index}`}>
                                                                                        <span className="nv-strong">{profile.displayName}</span>
                                                                                        <span className="nv-supporting">{profile.originalFirmware.fileName}{selected ? ` · ${t("ui.profileCurrent")}` : ""}</span>
                                                                                </span>
                                                                                <span className="nv-row-chevron"><Icon name="chevron" /></span>
                                                                        </button>
                                                                        <button
                                                                                type="button"
                                                                                className="nv-iconbtn nv-row-delete"
                                                                                aria-label={t("ui.deleteProfile")}
                                                                                aria-describedby={`${id}-${index}`}
                                                                                title={t("ui.deleteProfile")}
                                                                                disabled={busy}
                                                                                onClick={() => setAsking({ profileId: profile.profileId, displayName: profile.displayName, fileName: profile.originalFirmware.fileName, index, selected })}
                                                                        >
                                                                                <Icon name="trash" />
                                                                        </button>
                                                                </li>
                                                        );
                                                })}
                                        </ul>
                                )}
                                {view.profiles.length === 0 && view.profilesLoaded && <p className="nv-body">{t("ui.profilesEmpty")}</p>}
                        </SubPage>
                        {asking && (
                                <ConfirmDialog
                                        title={t("ui.deleteProfileConfirmTitle")}
                                        confirmLabel={t("ui.deleteProfileConfirmAction")}
                                        onClose={() => setAsking(null)}
                                        onConfirm={() => {
                                                setAsking(null);
                                                setAttempted(true);
                                                setDeleting(asking);
                                                commands.deleteProfile(asking.profileId);
                                        }}
                                >
                                        <span className="nv-dialog-subject">
                                                <span className="nv-strong">{asking.displayName}</span>
                                                <span className="nv-supporting">{asking.fileName}</span>
                                        </span>
                                        {t("ui.deleteProfileConfirmBody")}
                                </ConfirmDialog>
                        )}
                </>
        );
};
