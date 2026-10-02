import type { ReactNode, Ref } from "react";
import { firmwareInstalled } from "../bar-settings-routing";
import { useConfigurationWorkspaceController } from "../configuration-workspace/context";
import { formatBytes } from "../configuration-workspace/model";
import { useDeploymentWorkspaceController } from "../deployment-workspace/context";
import { usesMsiProZ690Route } from "../hardware-support";
import { translateMessage, useI18n } from "../i18n";
import type { ResizableBarGpuPresentation } from "../resizable-bar-status";
import { Icon } from "./icons";
import { useGuidedNavigation } from "./navigation";
import { homeState, installInProgress, installScreen, stageFor } from "./routing";
import { ActionBar, Check, Fact, Facts, GpuRow, ListRow, Notice, SizeCompare, Step, Steps, TaskHead } from "./ui";

const stageNameIds = ["ui.stagePrepare", "ui.stageInstall", "ui.stageTurnOn", "ui.stageFinish", "ui.stageFinish"] as const;

/** BAR size cell for one GPU: observed size, and the target when it can grow. */
export const GpuSizes = ({ row }: { row: ResizableBarGpuPresentation }) => {
        const { t } = useI18n();
        const target = row.gpu.patchConfiguration.targetSizeBytes;
        if (row.gpu.state === "expanded")
                return <span className="nv-size expanded">{row.gpu.bar1TotalBytes ? formatBytes(row.gpu.bar1TotalBytes) : t("ui.apertureExpanded")}</span>;
        if (row.gpu.state === "legacy256MiB")
                return (
                        <>
                                <span className="nv-size legacy">256 MiB</span>
                                {target && <><span className="nv-muted"><Icon name="arrow" /></span><span className="nv-size target">{formatBytes(target)}</span></>}
                        </>
                );
        return <span className="nv-size unknown">?</span>;
};

const GpuRows = () => {
        const { t } = useI18n();
        const { rebarStatus } = useConfigurationWorkspaceController();
        return (
                <div className="nv-group">
                        {rebarStatus.gpus.map((row) => (
                                <GpuRow key={row.gpu.pciBusId} name={row.gpu.productName} detail={t(row.apertureId)}>
                                        <GpuSizes row={row} />
                                </GpuRow>
                        ))}
                </div>
        );
};

const HomeRows = () => {
        const { t } = useI18n();
        const { go } = useGuidedNavigation();
        return (
                <ul className="nv-rows">
                        <ListRow icon="sliders" title={t("ui.barSettings")} detail={t("ui.homeRowBarSettingsDetail")} onClick={() => go("bar")} />
                        <ListRow icon="game" title={t("ui.enablePerGame")} detail={t("ui.homeRowGamesDetail")} onClick={() => go("games")} />
                        <ListRow icon="save" title={t("ui.homeRowBackup")} detail={t("ui.homeRowBackupDetail")} onClick={() => go("bar", { settingsFile: true })} />
                        <ListRow icon="swap" title={t("ui.changesTitleShort")} detail={t("ui.homeRowChangesDetail")} onClick={() => go("changes")} />
                </ul>
        );
};

const HomeFrame = ({ children, bar }: { children: ReactNode; bar?: ReactNode }) => (
        <>
                <main className="nv-home" data-testid="home">
                        <div className="nv-task-body" style={{ paddingTop: 32, gap: 20 }}>{children}</div>
                </main>
                {bar}
        </>
);

export const Home = ({ titleRef }: { titleRef: Ref<HTMLHeadingElement> }) => {
        const { t, locale } = useI18n();
        const config = useConfigurationWorkspaceController();
        const { snap, rebarStatus, busy, load, elevate, error } = config;
        const { view } = useDeploymentWorkspaceController();
        const { go } = useGuidedNavigation();
        if (!snap) return null;
        const continuing = installInProgress(view) || Boolean(view.firmware && !view.plan);
        const state = homeState(snap, rebarStatus.tone, continuing);
        const errorNotice = error && <Notice title={t("ui.taskDidNotFinish")}>{translateMessage(locale, error)}</Notice>;
        const currentGpu = rebarStatus.gpus.find((row) => row.gpu.state === "legacy256MiB") ?? rebarStatus.gpus[0];
        const eyebrow = currentGpu ? t("ui.homeEyebrowGpu", { gpu: currentGpu.gpu.productName.replace(/^NVIDIA GeForce /, "") }) : t("ui.homeEyebrow");
        const disabled = busy || Boolean(view.busyAction);

        if (state === "continue") {
                const stage = view.plan ? stageFor(installScreen(view, snap, { startNew: false, catalogBoard: true, question: 1, claimedInstalled: false, savingAgain: false, showGuide: false, exported: true, restartedSinceSave: false })) : 1;
                return (
                        <HomeFrame bar={<ActionBar center hint={t("ui.homeContinueHint")} primary={{ label: t("ui.continueSetup"), icon: "arrow", onClick: () => go("install"), disabled }} />}>
                                {errorNotice}
                                <TaskHead label={eyebrow} title={t("ui.homeContinueTitle")} lead={t("ui.homeContinueLead", { stage: t(stageNameIds[Math.min(stage, 5) - 1]) })} titleRef={titleRef} />
                                <HomeRows />
                        </HomeFrame>
                );
        }

        if (state === "on") {
                const identity = snap.machineIdentity;
                return (
                        <HomeFrame>
                                {errorNotice}
                                <TaskHead label={t("ui.homeEyebrow")} title={t("ui.homeOnTitle")} titleRef={titleRef} />
                                <GpuRows />
                                <HomeRows />
                                <p className="nv-meta">
                                        {[rebarStatus.driverVersion && t("ui.homeMetaDriver", { version: rebarStatus.driverVersion }), identity && `BIOS ${identity.biosVersion}`, identity && `${identity.boardManufacturer} ${identity.boardProduct}`].filter(Boolean).join(" · ")}
                                </p>
                        </HomeFrame>
                );
        }

        if (state === "mixed" || state === "off") {
                const legacyGpus = rebarStatus.gpus.filter((row) => row.gpu.state === "legacy256MiB").map((row) => row.gpu.productName);
                return (
                        <HomeFrame bar={<ActionBar center hint={t("ui.homeSavedSettingsApplyAfterRestart")} primary={{ label: t("ui.openBarSettings"), onClick: () => go("bar"), disabled }} />}>
                                {errorNotice}
                                <TaskHead
                                        label={t("ui.homeEyebrow")}
                                        title={t(state === "mixed" ? "ui.homeMixedTitle" : "ui.homeOffTitle")}
                                        lead={state === "mixed" && legacyGpus.length ? t("ui.homeMixedLead", { gpu: legacyGpus.join(", ") }) : t("ui.homeOffLead")}
                                        titleRef={titleRef}
                                />
                                <GpuRows />
                                <HomeRows />
                        </HomeFrame>
                );
        }

        if (state === "start") {
                const msi = usesMsiProZ690Route(snap);
                const target = currentGpu?.gpu.patchConfiguration.targetSizeBytes;
                return (
                        <HomeFrame bar={<ActionBar center hint={t("ui.homeStartHint")} primary={{ label: t("ui.getStarted"), icon: "arrow", onClick: () => go("install"), disabled }} />}>
                                {errorNotice}
                                <TaskHead label={eyebrow} title={t("ui.homeStartTitle")} lead={target ? t("ui.homeStartLead", { size: formatBytes(target) }) : t("ui.homeStartLeadGeneric")} titleRef={titleRef} />
                                {target && <SizeCompare fromLabel={t("ui.now")} from="256 MiB" toLabel={t("ui.whenOn")} to={formatBytes(target)} label={t("ui.compareNowAndOn", { size: formatBytes(target) })} />}
                                <div className="nv-cols">
                                        <section className="nv-group" aria-labelledby="home-todo">
                                                <h2 className="nv-section" id="home-todo">{t("ui.yourSteps")}</h2>
                                                <Steps>
                                                        <Step title={t("ui.homeTodoPick")} detail={t(msi ? "ui.homeTodoPickDetailMsi" : "ui.homeTodoPickDetail")} />
                                                        <Step title={t("ui.homeTodoInstall")} detail={t(msi ? "ui.homeTodoInstallDetailMsi" : "ui.homeTodoInstallDetail")} />
                                                        <Step title={t("ui.homeTodoRestart")} detail={t("ui.homeTodoRestartDetail")} />
                                                </Steps>
                                        </section>
                                        <section className="nv-group" aria-labelledby="home-needs">
                                                <h2 className="nv-section" id="home-needs">{t("ui.whatYouNeed")}</h2>
                                                <Facts>
                                                        <Fact icon="file" title={t("ui.needBiosFile")} detail={t(msi ? "ui.needBiosFileDetailMsi" : "ui.needBiosFileDetail")} />
                                                        <Fact icon="usb" title={t("ui.needUsb")} detail={t("ui.needUsbDetail")} />
                                                        <Fact icon="restart" title={t("ui.needRestarts")} detail={t("ui.needRestartsDetail")} />
                                                </Facts>
                                        </section>
                                </div>
                                <section className="nv-group" aria-labelledby="home-checked">
                                        <h2 className="nv-label" id="home-checked">{t("ui.checkedBeforeInstall")}</h2>
                                        <ul className="nv-pills">
                                                <li className="nv-pill"><Icon name="check" />{t("ui.pillTuringGpu")}</li>
                                                <li className="nv-pill"><Icon name="check" />{t("ui.pillUefi")}</li>
                                                <li className="nv-pill"><Icon name="check" />{t("ui.pillAdmin")}</li>
                                                {snap.hardwareSupport.motherboardNativeResizableBar.state === "supported" && <li className="nv-pill"><Icon name="check" />{t("ui.pillCatalogBoard")}</li>}
                                        </ul>
                                </section>
                        </HomeFrame>
                );
        }

        const blocked = {
                checking: { title: "ui.homeCheckingTitle", lead: "ui.rebarVerdictCheckingDetail", action: null },
                uefiRequired: { title: "ui.overviewUefiRequired", lead: "ui.windowsIsNotRunningInUefiModeFirmwareVariablesAreUnavailable", action: "refresh" },
                adminRequired: { title: "ui.homeAdminTitle", lead: "ui.homeAdminLead", action: "elevate" },
                unavailable: { title: "ui.homeUnavailableTitle", lead: snap.barSettings.controlEvidence === "indeterminate" ? "ui.driverStatusUnavailable" : "ui.rebarVerdictUnavailableDetail", action: "refresh" },
                noTargetGpu: { title: "ui.overviewNoTargetGpu", lead: "ui.overviewNoTargetGpuDetail", action: "refresh" },
        } as const;
        const blockedState = blocked[state];
        const turing = snap.devices.find((gpu) => gpu.isTuring);
        return (
                <HomeFrame
                        bar={blockedState.action && (
                                <ActionBar
                                        center
                                        hint={t(blockedState.action === "elevate" ? "ui.homeAdminHint" : "ui.homeRefreshHint")}
                                        primary={blockedState.action === "elevate"
                                                ? { label: t("ui.reopenAsAdministrator"), icon: "key", onClick: () => void elevate(), disabled }
                                                : { label: t("ui.retryStatusCheck"), icon: "restart", onClick: () => void load(true), disabled }}
                                />
                        )}
                >
                        {errorNotice}
                        <TaskHead label={t("ui.homeEyebrow")} title={t(blockedState.title)} lead={t(blockedState.lead)} titleRef={titleRef} />
                        <ul className="nv-checklist">
                                {turing
                                        ? <Check state="done" label={t("ui.homeCheckGpu", { gpu: turing.name })} word={t("ui.checkWordSupported")} />
                                        : <Check state="waiting" label={t("ui.pillTuringGpu")} word={t("ui.checkWordNotFound")} />}
                                <Check state={snap.platform.uefi ? "done" : "waiting"} label={t("ui.homeCheckUefi")} word={t(snap.platform.uefi ? "ui.checkWordConfirmed" : "ui.checkWordNeeded")} />
                                <Check state={snap.platform.elevated ? "done" : "waiting"} label={t("ui.pillAdmin")} word={t(snap.platform.elevated ? "ui.checkWordConfirmed" : "ui.checkWordNeeded")} />
                                {state === "checking" && <Check state="running" label={t("ui.resizableBarStatus")} word={t("ui.checkWordChecking")} />}
                        </ul>
                        {firmwareInstalled(snap) && <HomeRows />}
                </HomeFrame>
        );
};
