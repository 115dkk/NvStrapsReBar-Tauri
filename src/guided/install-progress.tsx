import { useEffect, useRef } from "react";
import { formatBytes } from "../configuration-workspace/model";
import type { StepId } from "../deployment-workspace/contract";
import { translateMessage } from "../i18n";
import type { StaticMessageId } from "../i18n-catalog";
import type { InstallContext } from "./install-context";
import {
        ActionBar,
        Caution,
        Check,
        Fact,
        Facts,
        FileCard,
        GpuRow,
        ListRow,
        Notice,
        Result,
        RouteCard,
        SizeCompare,
        Step,
        Steps,
        TaskPanel,
        type CheckState,
} from "./ui";
import { GpuSizes } from "./home";

const preparationRows: { id: StepId; label: StaticMessageId }[] = [
        { id: "verifyProfile", label: "ui.makingRowRecord" },
        { id: "confirmRecovery", label: "ui.makingRowRecovery" },
        { id: "preserveOriginalFirmware", label: "ui.makingRowOriginal" },
        { id: "prepareRustDriver", label: "ui.makingRowDriver" },
        { id: "applyLegacyBoardPatches", label: "ui.makingRowLegacy" },
        { id: "verifyPatchedArtifact", label: "ui.makingRowInsert" },
];

/** True when the latest failure is about the BIOS file itself rather than the app. */
const firmwareFileFailure = (ctx: InstallContext) =>
        ctx.view.activity?.tone === "error" && ctx.view.activity.message.id.startsWith("ui.firmwareInjection");

export const ActivityNotice = ({ ctx }: { ctx: InstallContext }) => {
        const { t, locale, view } = ctx;
        if (view.activity?.tone !== "error" || firmwareFileFailure(ctx)) return null;
        return <Notice title={t("ui.taskDidNotFinish")}>{translateMessage(locale, view.activity.message)}</Notice>;
};

export const Making = ({ ctx }: { ctx: InstallContext }) => {
        const { t, locale, view, commands, busy, navigation } = ctx;
        const attempted = useRef<string>("");
        const plan = view.plan!;
        const failed = firmwareFileFailure(ctx);
        useEffect(() => {
                // The file is made right after the record is created; the button stays as the retry.
                const key = `${plan.profileId}:${plan.revision}`;
                if (attempted.current === key || view.busyAction || view.activity?.tone === "error") return;
                attempted.current = key;
                commands.prepare();
        }, [plan.profileId, plan.revision, view.busyAction, view.activity, commands]);
        const making = view.busyAction === "prepare";
        if (failed)
                return (
                        <TaskPanel
                                label={t("ui.stageLabelPrepare")}
                                title={t("ui.makingFailedTitle")}
                                titleRef={ctx.titleRef}
                                bar={<ActionBar hint={t("ui.makingFailedHint")} primary={{ label: t("ui.chooseAnotherFile"), icon: "folder", disabled: busy, onClick: () => { navigation.setInstallUi({ startNew: true }); commands.chooseFirmware(); } }} />}
                        >
                                {view.firmware && <FileCard name={view.firmware.fileName} />}
                                <Notice title={translateMessage(locale, view.activity!.message)}>{t("ui.makingFailedDetail")}</Notice>
                                <Facts><Fact icon="info" title={t("ui.makingFailedOtherVersion")} detail={t("ui.makingFailedOtherVersionDetail")} /></Facts>
                        </TaskPanel>
                );
        return (
                <TaskPanel
                        label={t("ui.stageLabelPrepare")}
                        title={t("ui.makingTitle")}
                        titleRef={ctx.titleRef}
                        bar={<ActionBar hint={t("ui.makingHint")} primary={{ label: t(making ? "ui.makingBusy" : "ui.makeBiosFile"), busy: making, disabled: busy, onClick: commands.prepare }} />}
                >
                        <ActivityNotice ctx={ctx} />
                        <ol className="nv-checklist" aria-live="polite">
                                {preparationRows.filter((row) => plan.steps.some((step) => step.id === row.id)).map((row) => {
                                        const step = plan.steps.find((candidate) => candidate.id === row.id)!;
                                        const state: CheckState = step.state === "completed" ? "done" : making ? "running" : "waiting";
                                        return <Check key={row.id} state={state} label={t(row.label)} word={t(state === "done" ? "ui.checkWordDone" : state === "running" ? "ui.checkWordRunning" : "ui.checkWordWaiting")} />;
                                })}
                        </ol>
                        <RouteCard icon="usb" title={t("ui.makingNextUsb")} detail={t("ui.makingNextUsbDetail")} />
                </TaskPanel>
        );
};

export const SaveToUsb = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view, commands, busy, msi, artifactName, navigation } = ctx;
        const recoveryFile = msi && view.selectedProfile?.recovery.method === "usbFlashback";
        return (
                <TaskPanel
                        label={t("ui.stageLabelPrepare")}
                        title={t("ui.saveTitle")}
                        lead={t("ui.saveLead")}
                        titleRef={ctx.titleRef}
                        bar={
                                <ActionBar
                                        hint={t(recoveryFile ? "ui.saveHintWithRecovery" : "ui.saveHint")}
                                        secondary={navigation.installUi.savingAgain ? [{ label: t("ui.close"), onClick: () => navigation.setInstallUi({ savingAgain: false }) }] : []}
                                        primary={{ label: t("ui.saveToUsb"), icon: "usb", busy: view.busyAction === "export", disabled: busy, onClick: commands.saveToUsb }}
                                />
                        }
                >
                        <ActivityNotice ctx={ctx} />
                        {view.preparation?.patchedFirmware
                                ? <Result title={t("ui.saveFileMade")} detail={t("ui.saveFileMadeDetail", { file: artifactName })} />
                                : null}
                        <section className="nv-group" aria-labelledby="usb-files">
                                <h2 className="nv-section" id="usb-files">{t("ui.saveFilesTitle")}</h2>
                                <Facts>
                                        <Fact icon="file" title={t("ui.saveFileInstaller")} detail={t("ui.saveFileInstallerDetail", { file: artifactName })} />
                                        {recoveryFile
                                                ? <Fact icon="undo" title={t("ui.saveFileRecoveryMsi")} detail={t("ui.saveFileRecoveryMsiDetail")} />
                                                : <Fact icon="undo" title={t("ui.saveFileRecovery")} detail={t("ui.saveFileRecoveryDetail")} />}
                                        <Fact icon="doc" title={t("ui.saveFileGuide")} detail={t("ui.saveFileGuideDetail")} />
                                </Facts>
                        </section>
                </TaskPanel>
        );
};

const RecoveryCaution = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view, remembered } = ctx;
        const method = view.selectedProfile?.recovery.method ?? view.recoveryMethod;
        const shortcut = remembered?.recoveryShortcut;
        const text =
                method === "usbFlashback" && shortcut
                        ? t("ui.cautionFlashbackFile", { file: shortcut.fileName })
                        : t(({
                                  usbFlashback: "ui.cautionFlashback",
                                  dualBios: "ui.cautionDualBios",
                                  vendorRecovery: "ui.cautionVendorRecovery",
                                  externalSpiProgrammer: "ui.cautionSpi",
                                  none: "ui.cautionVendorRecovery",
                          } as const)[method]);
        return <Caution title={t("ui.cautionTitle")}>{text}</Caution>;
};

const installStepFor = (ctx: InstallContext) => {
        const method = ctx.view.selectedProfile?.firmwareInstall?.method ?? ctx.view.installMethod;
        if (ctx.msi && method === "firmwareSetupUtility") return "ui.guideInstallMsi" as const;
        return ({
                firmwareSetupUtility: "ui.guideInstallSetupUtility",
                usbFlashback: "ui.guideInstallFlashback",
                vendorWindowsUtility: "ui.guideInstallWindowsUtility",
                externalSpiProgrammer: "ui.guideInstallSpi",
        } as const)[method];
};

export const BiosSettingsList = ({ ctx }: { ctx: InstallContext }) => {
        const { t } = ctx;
        const native = (ctx.view.selectedProfile?.boardPath ?? ctx.view.boardPath) === "nativeResizableBar";
        return (
                <ul className="nv-inline">
                        <li>{t("ui.settingAbove4gOn")}</li>
                        <li>{t("ui.settingCsmOff")}</li>
                        {native && <li>{t("ui.settingRebarOn")}</li>}
                </ul>
        );
};

export const Guide = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view, commands, busy, remembered, artifactName, navigation, rebootButton, msi, locale } = ctx;
        const shortcut = remembered?.recoveryShortcut;
        const flashActive = view.activeStep?.id === "flashWithVendorRoute";
        const savedDetail = shortcut?.atVolumeRoot
                ? t("ui.guideSavedWithRecovery", { file: shortcut.fileName })
                : t("ui.guideSavedAt", { path: remembered?.packagePath ?? "" });
        return (
                <TaskPanel
                        label={t("ui.stageLabelInstall")}
                        title={t("ui.guideTitle")}
                        lead={t(locale === "ko" ? "ui.guideLeadKorean" : "ui.guideLead")}
                        titleRef={ctx.titleRef}
                        bar={
                                <ActionBar
                                        hint={t("ui.restartAsksFirst")}
                                        secondary={[
                                                { label: t("ui.finishedInBios"), onClick: () => navigation.setInstallUi({ claimedInstalled: true, showGuide: false }), disabled: busy },
                                                ...(flashActive ? [{ label: t("ui.saveSomewhereElse"), onClick: () => navigation.setInstallUi({ savingAgain: true }), disabled: busy }] : []),
                                        ]}
                                        primary={{ label: t("ui.restartIntoBios"), icon: "restart", busy: view.busyAction === "reboot-preview", disabled: busy, onClick: commands.previewReboot, buttonRef: rebootButton }}
                                />
                        }
                >
                        <ActivityNotice ctx={ctx} />
                        <Steps>
                                {shortcut && !shortcut.atVolumeRoot && <Step title={t("ui.guideMoveRecoveryFile", { file: shortcut.fileName })} detail={t("ui.guideMoveRecoveryFileDetail", { path: shortcut.path })} />}
                                <Step title={t("ui.guideRestart")} detail={savedDetail} />
                                {flashActive && <Step title={t(installStepFor(ctx), { file: artifactName })} detail={t(msi ? "ui.guideInstallDetailMsi" : "ui.guideInstallDetail")} />}
                                {flashActive && <Step title={t("ui.guideKeepPower")} detail={t(msi ? "ui.guideKeepPowerDetailMsi" : "ui.guideKeepPowerDetail")} />}
                                <Step title={t("ui.guideSettings")}><BiosSettingsList ctx={ctx} /></Step>
                                <Step title={t("ui.guideReopen")} />
                        </Steps>
                        <RecoveryCaution ctx={ctx} />
                </TaskPanel>
        );
};

export const ReturnRecord = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view, commands, busy, msi, navigation } = ctx;
        const flashActive = view.activeStep?.id === "flashWithVendorRoute";
        const native = (view.selectedProfile?.boardPath ?? view.boardPath) === "nativeResizableBar";
        const recording = view.busyAction === "manual-confirm";
        return (
                <TaskPanel
                        label={t("ui.stageLabelInstall")}
                        title={t("ui.returnTitle")}
                        titleRef={ctx.titleRef}
                        bar={
                                <ActionBar
                                        hint={t("ui.returnHint")}
                                        secondary={[
                                                { label: t("ui.showInstallSteps"), onClick: () => navigation.setInstallUi({ showGuide: true }), disabled: busy },
                                                ...(flashActive ? [{ label: t("ui.recordInstallOnly"), onClick: () => commands.recordFirmwareHandoff(false), disabled: busy }] : []),
                                        ]}
                                        primary={{ label: t(flashActive ? "ui.recordInstallAndSettings" : "ui.recordSettings"), busy: recording, disabled: busy, onClick: () => commands.recordFirmwareHandoff(true) }}
                                />
                        }
                >
                        <ActivityNotice ctx={ctx} />
                        <section className="nv-group" aria-labelledby="observed">
                                <h2 className="nv-label" id="observed">{t("ui.observedThisBoot")}</h2>
                                <ul className="nv-checklist"><Check state="done" label={t("ui.driverRanThisBoot")} word={t("ui.checkWordConfirmed")} /></ul>
                        </section>
                        <hr className="nv-divider" />
                        <section className="nv-group" aria-labelledby="attest">
                                <h2 className="nv-label" id="attest">{t(flashActive ? "ui.returnRecordBoth" : "ui.returnRecordSettings")}</h2>
                                <Facts>
                                        {flashActive && <Fact icon="tool" title={t(msi ? "ui.attestFlashMsi" : "ui.attestFlash")} />}
                                        <Fact icon="sliders" title={t(native ? "ui.attestSettingsNative" : "ui.attestSettingsLegacy")} />
                                </Facts>
                                {flashActive && <p className="nv-supporting">{t("ui.returnInstallOnlyDetail")}</p>}
                        </section>
                </TaskPanel>
        );
};

export const CheckingDriver = ({ ctx }: { ctx: InstallContext }) => {
        const { t } = ctx;
        return (
                <TaskPanel
                        label={t("ui.stageLabelInstall")}
                        title={t("ui.checkingDriverTitle")}
                        titleRef={ctx.titleRef}
                        bar={<ActionBar hint={t("ui.checkingDriverHint")} primary={{ label: t("ui.checkWordChecking"), busy: true, onClick: () => undefined }} />}
                >
                        <ActivityNotice ctx={ctx} />
                        <ul className="nv-checklist"><Check state="running" label={t("ui.driverRunState")} word={t("ui.checkWordChecking")} /></ul>
                </TaskPanel>
        );
};

export const Missing = ({ ctx }: { ctx: InstallContext }) => {
        const { t, locale, view, commands, busy, navigation, config, rebootButton } = ctx;
        const canRestart = view.activeStep?.id === "flashWithVendorRoute" || view.activeStep?.id === "configureFirmwareSetup";
        const recheck = () => {
                if (canRestart) void config.load(true);
                else commands.autoCheck();
        };
        return (
                <TaskPanel
                        label={t("ui.stageLabelInstall")}
                        title={t("ui.missingTitle")}
                        lead={t("ui.missingLead")}
                        titleRef={ctx.titleRef}
                        bar={
                                <ActionBar
                                        hint={t(canRestart ? "ui.missingHint" : "ui.missingHintManualRestart")}
                                        secondary={canRestart
                                                ? [{ label: t("ui.checkAgainNow"), onClick: recheck, disabled: busy }, { label: t("ui.backToGuide"), onClick: () => navigation.setInstallUi({ claimedInstalled: false }), disabled: busy }]
                                                : []}
                                        primary={canRestart
                                                ? { label: t("ui.restartIntoBios"), icon: "restart", busy: view.busyAction === "reboot-preview", disabled: busy, onClick: commands.previewReboot, buttonRef: rebootButton }
                                                : { label: t("ui.checkAgainNow"), icon: "restart", busy: view.busyAction === "auto-check", disabled: busy, onClick: recheck }}
                                />
                        }
                >
                        <ActivityNotice ctx={ctx} />
                        <ul className="nv-checklist"><Check state="waiting" label={t("ui.driverRunState")} word={t("ui.checkWordNotFound")} /></ul>
                        {view.autoCheck?.status === "failed" && view.autoCheck.message && <p className="nv-supporting">{translateMessage(locale, view.autoCheck.message)}</p>}
                        <section className="nv-group" aria-labelledby="try">
                                <h2 className="nv-section" id="try">{t("ui.thingsToCheck")}</h2>
                                <Steps>
                                        <Step title={t("ui.missingCheckFlash")} detail={t("ui.missingCheckFlashDetail")} />
                                        <Step title={t("ui.missingCheckCsm")} detail={t("ui.missingCheckCsmDetail")} />
                                </Steps>
                        </section>
                </TaskPanel>
        );
};

export const AdminNeeded = ({ ctx }: { ctx: InstallContext }) => {
        const { t, config, busy, snapshot } = ctx;
        const elevated = snapshot.platform.elevated;
        return (
                <TaskPanel
                        label={t("ui.stageLabelInstall")}
                        title={t(elevated ? "ui.statusUnreadableTitle" : "ui.adminNeededTitle")}
                        lead={t(elevated ? "ui.statusUnreadableLead" : "ui.adminNeededLead")}
                        titleRef={ctx.titleRef}
                        bar={
                                <ActionBar
                                        hint={t(elevated ? "ui.homeRefreshHint" : "ui.homeAdminHint")}
                                        primary={elevated
                                                ? { label: t("ui.checkAgainNow"), icon: "restart", disabled: busy, onClick: () => void config.load(true) }
                                                : { label: t("ui.reopenAsAdministrator"), icon: "key", disabled: busy, onClick: () => void config.elevate() }}
                                />
                        }
                >
                        <ul className="nv-checklist"><Check state="waiting" label={t("ui.driverRunState")} word={t("ui.checkWordBefore")} /></ul>
                        <RouteCard icon="info" title={t("ui.noNeedToReflash")} detail={t(elevated ? "ui.noNeedToReflashRefresh" : "ui.noNeedToReflashDetail")} />
                </TaskPanel>
        );
};

export const Mismatch = ({ ctx }: { ctx: InstallContext }) => {
        const { t, commands, busy, navigation } = ctx;
        return (
                <TaskPanel
                        label={t("ui.stageLabelInstall")}
                        title={t("ui.mismatchTitle")}
                        lead={t("ui.mismatchLead")}
                        titleRef={ctx.titleRef}
                        bar={
                                <ActionBar
                                        hint={t("ui.mismatchHint")}
                                        secondary={[{ label: t("ui.checkAgain"), onClick: commands.compare, disabled: busy }]}
                                        primary={{ label: t("ui.prepareForThisPc"), icon: "arrow", disabled: busy, onClick: navigation.startNewPreparation }}
                                />
                        }
                >
                        <ActivityNotice ctx={ctx} />
                        <Facts><Fact icon="info" title={t("ui.mismatchFact")} detail={t("ui.mismatchFactDetail")} /></Facts>
                </TaskPanel>
        );
};

const RecommendedSizes = ({ ctx }: { ctx: InstallContext }) => {
        const { t, config, view } = ctx;
        const rules = view.configRecommendation?.value.draft.rules ?? [];
        return (
                <section className="nv-group" aria-labelledby="recommended">
                        <h2 className="nv-section" id="recommended">{t("ui.turnOnSizesTitle")}</h2>
                        {config.rebarStatus.gpus.map((row) => (
                                <GpuRow key={row.gpu.pciBusId} name={row.gpu.productName}><GpuSizes row={row} /></GpuRow>
                        ))}
                        <p className="nv-supporting">{t(rules.length ? "ui.turnOnFallbackRule" : "ui.turnOnRegistryRule")}</p>
                </section>
        );
};

export const TurnOn = ({ ctx }: { ctx: InstallContext }) => {
        const { t, locale, view, commands, busy } = ctx;
        const ready = view.recommendationStatus === "ready" && Boolean(view.configRecommendation);
        return (
                <TaskPanel
                        label={t("ui.stageLabelTurnOn")}
                        title={t("ui.turnOnTitle")}
                        titleRef={ctx.titleRef}
                        bar={
                                <ActionBar
                                        hint={t("ui.turnOnHint")}
                                        primary={{ label: t(view.recommendationStatus === "pending" ? "ui.loadingRecommendation" : "ui.saveTheseSettings"), busy: view.busyAction === "deployment-config" || view.recommendationStatus === "pending", disabled: busy || !ready, onClick: commands.saveRecommendedConfig }}
                                />
                        }
                >
                        {view.recommendationStatus !== "error" && <ActivityNotice ctx={ctx} />}
                        <Result title={t("ui.driverRunConfirmed")} detail={t("ui.driverRunConfirmedDetail")} />
                        {view.recommendationStatus === "error" && view.recommendationError && (
                                <Notice title={t("ui.recommendationFailed")}>{translateMessage(locale, view.recommendationError)}</Notice>
                        )}
                        <RecommendedSizes ctx={ctx} />
                        <p className="nv-body nv-muted">{t("ui.turnOnAppliesAfterRestart")}</p>
                </TaskPanel>
        );
};

export const RestartAfterSave = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view, commands, busy } = ctx;
        return (
                <TaskPanel
                        label={t("ui.stageLabelTurnOn")}
                        title={t("ui.restartTitle")}
                        titleRef={ctx.titleRef}
                        bar={
                                <ActionBar
                                        hint={t("ui.restartAsksFirst")}
                                        secondary={[{ label: t("ui.alreadyRestarted"), onClick: commands.verifyConfigurationBoot, disabled: busy }]}
                                        primary={{ label: t("ui.restartNow"), icon: "restart", busy: view.busyAction === "configuration-reboot-preview", disabled: busy, onClick: commands.openConfigurationReboot }}
                                />
                        }
                >
                        <ActivityNotice ctx={ctx} />
                        <Result title={t("ui.settingsSavedTitle")} detail={t("ui.settingsSavedDetail")} />
                        <Facts>
                                <Fact icon="restart" title={t("ui.restartApplies")} detail={t("ui.restartAppliesDetail")} />
                                <Fact icon="clock" title={t("ui.restartLater")} detail={t("ui.restartLaterDetail")} />
                        </Facts>
                </TaskPanel>
        );
};

export const CheckingResult = ({ ctx }: { ctx: InstallContext }) => {
        const { t, locale, view, commands, busy } = ctx;
        const failed = view.autoCheck?.stepId === "verifyResizableBar" && view.autoCheck.status === "failed";
        return (
                <TaskPanel
                        label={t("ui.stageLabelFinish")}
                        title={t(failed ? "ui.resultCheckFailedTitle" : "ui.resultCheckingTitle")}
                        titleRef={ctx.titleRef}
                        bar={<ActionBar hint={t("ui.resultCheckingHint")} primary={failed ? { label: t("ui.checkAgainNow"), icon: "restart", disabled: busy, onClick: commands.collectBar } : { label: t("ui.checkWordChecking"), busy: true, onClick: () => undefined }} />}
                >
                        <ActivityNotice ctx={ctx} />
                        <ul className="nv-checklist">
                                <Check state="done" label={t("ui.resultRowRestarted")} word={t("ui.checkWordAuto")} />
                                <Check state={failed ? "alert" : "running"} label={t("ui.resultRowBar")} word={t(failed ? "ui.checkWordFailed" : "ui.checkWordChecking")} />
                        </ul>
                        {failed && view.autoCheck?.message && <Notice title={t("ui.resultCheckFailedNotice")}>{translateMessage(locale, view.autoCheck.message)}</Notice>}
                </TaskPanel>
        );
};

export const Done = ({ ctx }: { ctx: InstallContext }) => {
        const { t, view, config, navigation } = ctx;
        const evidence = view.barEvidence?.gpus.find((gpu) => gpu.matchedProfileGpu) ?? view.barEvidence?.gpus[0];
        const observed = config.rebarStatus.gpus.find((row) => row.gpu.state === "expanded")?.gpu;
        const size = evidence?.bar1TotalBytes ?? observed?.bar1TotalBytes ?? null;
        const gpuName = (evidence?.productName ?? observed?.productName ?? "").replace(/^NVIDIA GeForce /, "");
        const driverVersion = view.barEvidence?.driverVersion ?? config.rebarStatus.driverVersion;
        return (
                <TaskPanel
                        label={t("ui.stageLabelFinish")}
                        title={t("ui.doneTitle")}
                        titleRef={ctx.titleRef}
                        bar={<ActionBar hint={t("ui.doneHint")} primary={{ label: t("ui.done"), onClick: () => navigation.go("home") }} />}
                >
                        {size && (
                                <SizeCompare
                                        achieved
                                        fromLabel={t("ui.before")}
                                        from="256 MiB"
                                        toLabel={gpuName ? t("ui.nowWithGpu", { gpu: gpuName }) : t("ui.now")}
                                        to={formatBytes(size)}
                                        label={t("ui.compareBeforeAndNow", { size: formatBytes(size) })}
                                />
                        )}
                        {driverVersion && <p className="nv-supporting">{t("ui.doneSizeSource", { version: driverVersion })}</p>}
                        <hr className="nv-divider" />
                        <section className="nv-group" aria-labelledby="games">
                                <h2 className="nv-section" id="games">{t("ui.doneGamesTitle")}</h2>
                                <p className="nv-body nv-muted">{t("ui.gamesExplanation")}</p>
                                <ul className="nv-rows"><ListRow icon="game" title={t("ui.enablePerGame")} detail={t("ui.doneGamesRowDetail")} onClick={() => navigation.go("games")} /></ul>
                        </section>
                </TaskPanel>
        );
};
