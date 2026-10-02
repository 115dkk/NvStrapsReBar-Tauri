import type { ReactNode, Ref } from "react";
import { BarSettingsWorkspace } from "../BarSettingsWorkspace";
import { useConfigurationWorkspaceController } from "../configuration-workspace/context";
import { AutomaticPolicyPanel, ConfigurationIntro, ConfigurationReview, FirmwareBehaviorPanel, GpuRulesPanel } from "../configuration-workspace/panels";
import { useDeploymentWorkspaceController } from "../deployment-workspace/context";
import { stepKindIds, stepStateIds, stepTitleIds } from "../deployment-workspace/messages";
import { translateMessage, useI18n } from "../i18n";
import { recallExport } from "./export-memory";
import { Icon } from "./icons";
import { initialInstallUi, useGuidedNavigation } from "./navigation";
import { OPTIONAL_FINAL_STEP } from "./routing";
import { ActionBar, type ActionBarProps, Crumb, Fact, Facts, FileCard, Notice, Result, Step, Steps, TaskHead } from "./ui";

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

export const BarPage = ({ titleRef }: { titleRef: Ref<HTMLHeadingElement> }) => {
        const { t } = useI18n();
        const { snap } = useConfigurationWorkspaceController();
        if (!snap) return null;
        return (
                <SubPage here={t("ui.barSettings")} title={t("ui.barSettings")} lead={t("ui.barSettingsLead")} titleRef={titleRef} wide testId="bar-page">
                        <div className="nv-legacy-panels">
                                {snap.barSettings.settingsAvailable ? (
                                        <BarSettingsWorkspace embedded />
                                ) : (
                                        <div className="workspace"><div className="content"><ConfigurationIntro /><AutomaticPolicyPanel /><GpuRulesPanel /><FirmwareBehaviorPanel /><ConfigurationReview savePath="configure" /></div></div>
                                )}
                        </div>
                </SubPage>
        );
};

export const GamesPage = ({ titleRef }: { titleRef: Ref<HTMLHeadingElement> }) => {
        const { t, locale } = useI18n();
        const { view, commands } = useDeploymentWorkspaceController();
        const busy = Boolean(view.busyAction);
        const hasProfile = Boolean(view.selectedProfileId);
        const canRecord = view.activeStep?.id === OPTIONAL_FINAL_STEP;
        const recorded = view.plan?.steps.find((step) => step.id === OPTIONAL_FINAL_STEP)?.state === "completed";
        return (
                <SubPage
                        here={t("ui.enablePerGame")}
                        title={t("ui.gamesTitle")}
                        lead={t("ui.gamesLead")}
                        titleRef={titleRef}
                        testId="games-page"
                        bar={{
                                hint: t(hasProfile ? "ui.gamesHint" : "ui.gamesHintNoRecord"),
                                secondary: canRecord ? [{ label: t("ui.recordGamesDone"), onClick: commands.openManualConfirmation, disabled: busy }] : [],
                                primary: hasProfile ? { label: t("ui.openProfileInspector"), icon: "external", busy: view.busyAction === "launch-inspector", disabled: busy, onClick: commands.openInspector } : undefined,
                        }}
                >
                        {view.activity?.tone === "error" && <Notice title={t("ui.taskDidNotFinish")}>{translateMessage(locale, view.activity.message)}</Notice>}
                        {recorded && <Result title={t("ui.gamesRecorded")} />}
                        <Steps>
                                <Step title={t(hasProfile ? "ui.gamesStepOpen" : "ui.gamesStepOpenManual")} detail={t(hasProfile ? "ui.gamesStepOpenDetail" : "ui.gamesStepOpenManualDetail")} />
                                <Step title={t("ui.gamesStepProfile")} />
                                <Step title={t("ui.gamesStepFeature")} />
                                <Step title={t("ui.gamesStepApply")} />
                        </Steps>
                        {view.backup && (
                                <>
                                        <FileCard icon="save" name={t("ui.gamesBackup")} mono={false} meta={<span className="nv-mono">{view.backup.backupPath}</span>} />
                                        <p className="nv-supporting">{t("ui.gamesBackupRestore")}</p>
                                </>
                        )}
                </SubPage>
        );
};

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
        const { t, locale } = useI18n();
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
                                        ? <Result title={translateMessage(locale, view.activity.message)} />
                                        : <Notice title={t("ui.taskDidNotFinish")}>{translateMessage(locale, view.activity.message)}</Notice>
                        )}
                        {view.plan && (
                                <ol className="nv-ledger" aria-label={t("ui.deploymentPlan")}>
                                        {view.plan.steps.map((step) => (
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

export const ProfilesPage = ({ titleRef }: { titleRef: Ref<HTMLHeadingElement> }) => {
        const { t } = useI18n();
        const { view, commands } = useDeploymentWorkspaceController();
        const { go, setInstallUi } = useGuidedNavigation();
        return (
                <SubPage here={t("ui.menuOpenPreparation")} title={t("ui.profilesTitle")} lead={t("ui.profilesLead")} titleRef={titleRef} testId="profiles-page">
                        <ul className="nv-rows">
                                {view.profiles.map((profile) => (
                                        <li key={profile.profileId}>
                                                <button
                                                        type="button"
                                                        className="nv-row"
                                                        aria-current={profile.profileId === view.selectedProfileId || undefined}
                                                        disabled={Boolean(view.busyAction)}
                                                        onClick={() => {
                                                                if (profile.profileId !== view.selectedProfileId) commands.setSelectedProfileId(profile.profileId);
                                                                setInstallUi({ ...initialInstallUi });
                                                                go("install");
                                                        }}
                                                >
                                                        <Icon name="file" />
                                                        <span className="nv-row-text">
                                                                <span className="nv-strong">{profile.displayName}</span>
                                                                <span className="nv-supporting">{profile.originalFirmware.fileName}{profile.profileId === view.selectedProfileId ? ` · ${t("ui.profileCurrent")}` : ""}</span>
                                                        </span>
                                                        <span className="nv-row-chevron"><Icon name="chevron" /></span>
                                                </button>
                                        </li>
                                ))}
                        </ul>
                </SubPage>
        );
};
