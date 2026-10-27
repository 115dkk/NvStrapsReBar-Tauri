import { useEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { useConfigurationWorkspaceController } from "../configuration-workspace/context";
import { formatBytes } from "../configuration-workspace/model";
import type { ExternalBootStatus, ExternalCandidate, ExternalMedium, ExternalUsbDrive, PciSlot, PlanErrorCode } from "../external-boot/contract";
import { blockReasons, bootMenuKey, defaultSize, formatSlot, secureBootReady, usableCandidates, type ExternalActive, type ExternalError, type ExternalMode } from "../external-boot/model";
import { rememberExternalScreen } from "../external-boot/resume";
import { useExternalBoot, type ExternalBootController } from "../external-boot/use-external-boot";
import { useI18n } from "../i18n";
import type { StaticMessageId } from "../i18n-catalog";
import type { ResizableBarGpuPresentation } from "../resizable-bar-status";
import { Icon } from "./icons";
import { useGuidedNavigation } from "./navigation";
import { ActionBar, Caution, Check, Choices, ConfirmDialog, Crumb, Fact, Facts, GpuRow, Notice, SizeCompare, Step, Steps, TaskHead } from "./ui";

/**
 * The route that leaves the BIOS file alone: a small EFI program runs before Windows and widens
 * the GPU's BAR. Every screen comes from what the backend reads on the USB drive or the EFI system
 * partition, so the page continues where it stopped after each restart.
 */

const bytes = (value: number) => formatBytes(String(value));
const LEGACY_BAR = 256 * 1024 * 1024;

const refusalIds: Record<PlanErrorCode, StaticMessageId> = {
        consoleInUse: "ui.externalRefusalConsole",
        activeDriver: "ui.externalRefusalDriver",
        noAddressSpace: "ui.externalRefusalAddressSpace",
        incompleteReport: "ui.externalRefusalIncomplete",
        unsupportedGpu: "ui.externalRefusalGpu",
        invalidReport: "ui.externalRefusalLayout",
        noTarget: "ui.externalRefusalLayout",
        invalidBar: "ui.externalRefusalLayout",
        invalidSize: "ui.externalRefusalLayout",
        noRoot: "ui.externalRefusalLayout",
        ambiguousTopology: "ui.externalRefusalLayout",
        invalidHandoff: "ui.externalRefusalLayout",
        staleSnapshot: "ui.externalRefusalLayout",
        invalidPlan: "ui.externalRefusalLayout",
};

const errorIds: Record<string, StaticMessageId> = {
        externalSecureBootOn: "ui.externalErrorSecureBoot",
        externalNoEsp: "ui.externalErrorNoEsp",
        externalForeignBootFile: "ui.externalErrorForeignBootFile",
        externalNotFat: "ui.externalErrorNotFat",
        externalNoReport: "ui.externalErrorNoReport",
        externalPlan: "ui.externalErrorPlan",
        externalNotPhysical: "ui.externalErrorNotPhysical",
        externalBitLockerSuspensionRequired: "ui.externalErrorBitLocker",
        externalNoReceipt: "ui.externalErrorNoReceipt",
        externalMediumUnavailable: "ui.externalErrorMediumGone",
        externalCertificateExists: "ui.externalErrorCertificateExists",
};

/** Reasons the EFI programs write to last-error.txt, in the words of the EFI source. */
const lastErrorIds: Record<string, StaticMessageId> = {
        "pinned successor missing or changed": "ui.externalLastErrorSuccessor",
        "fresh diagnostic does not match plan": "ui.externalLastErrorChanged",
        "successor LoadImage/authentication failed": "ui.externalLastErrorSuccessor",
        "MMIO reservation failed": "ui.externalLastErrorAddressSpace",
};

const sameSlot = (pciBusId: string, slot: PciSlot) => {
        const match = /([0-9a-f]+):([0-9a-f]+)\.([0-7])$/i.exec(pciBusId);
        return Boolean(match) && Number.parseInt(match![1]!, 16) === slot.bus && Number.parseInt(match![2]!, 16) === slot.device && Number(match![3]) === slot.function;
};

const gpuAt = (gpus: ResizableBarGpuPresentation[], slot: PciSlot | undefined) => (slot ? gpus.find((row) => sameSlot(row.gpu.pciBusId, slot)) : undefined);

const Frame = ({ label, title, lead, titleRef, children, bar }: { label?: ReactNode; title: ReactNode; lead?: ReactNode; titleRef: Ref<HTMLHeadingElement>; children?: ReactNode; bar?: ReactNode }) => {
        const { t } = useI18n();
        const { go } = useGuidedNavigation();
        return (
                <>
                        <main className="nv-home" data-testid="external-page">
                                <div className="nv-task-body" style={{ paddingTop: 32, gap: 20 }}>
                                        <Crumb here={t("ui.externalCrumb")} onHome={() => go("home")} />
                                        <TaskHead label={label} title={title} lead={lead} titleRef={titleRef} />
                                        {children}
                                </div>
                        </main>
                        {bar}
                </>
        );
};

const ActionError = ({ error }: { error: ExternalError | null }) => {
        const { t } = useI18n();
        if (!error) return null;
        return (
                <Notice title={t("ui.taskDidNotFinish")}>
                        {t(errorIds[error.code] ?? "ui.externalErrorOther")}
                        {error.message && <><br /><span className="nv-mono nv-error-detail">{error.message}</span></>}
                </Notice>
        );
};

const LastError = ({ reason }: { reason: string | null }) => {
        const { t } = useI18n();
        if (!reason) return null;
        return (
                <Notice title={t("ui.externalLastErrorTitle")}>
                        {t(lastErrorIds[reason] ?? "ui.externalLastErrorOther")}
                        <br />
                        <span className="nv-mono nv-error-detail">{reason}</span>
                </Notice>
        );
};

/** The three parts of the route, so the first screen says what the page is for. */
const Journey = ({ install }: { install: boolean }) => {
        const { t } = useI18n();
        return (
                <section className="nv-group" aria-labelledby="external-journey">
                        <h2 className="nv-section" id="external-journey">{t("ui.externalJourneyTitle")}</h2>
                        <Steps>
                                <Step title={t("ui.externalJourneyDiagnose")} detail={t("ui.externalJourneyDiagnoseDetail")} />
                                <Step title={t("ui.externalJourneyTry")} detail={t("ui.externalJourneyTryDetail")} />
                                {install && <Step title={t("ui.externalJourneyKeep")} detail={t("ui.externalJourneyKeepDetail")} />}
                        </Steps>
                </section>
        );
};

const driveTitle = (t: ReturnType<typeof useI18n>["t"], drive: ExternalUsbDrive) => `${drive.root.replace(/\\$/, "")} ${drive.label || t("ui.externalUsbNoLabel")}`;

const driveDetail = (t: ReturnType<typeof useI18n>["t"], drive: ExternalUsbDrive) => {
        const facts = `${drive.fileSystem || "?"} · ${bytes(drive.totalBytes)}`;
        if (drive.problem === "notFat") return `${facts} · ${t("ui.externalUsbNotFat")}`;
        if (drive.problem === "foreignBootFile") return `${facts} · ${t("ui.externalUsbForeign")}`;
        return facts;
};

const UsbPicker = ({ drives, value, onChange, onRefresh, disabled }: { drives: ExternalUsbDrive[]; value: string | null; onChange: (root: string) => void; onRefresh: () => void; disabled: boolean }) => {
        const { t } = useI18n();
        return (
                <section className="nv-group" aria-labelledby="external-usb">
                        <h2 className="nv-section" id="external-usb">{t("ui.externalUsbTitle")}</h2>
                        {drives.length === 0
                                ? <Caution title={t("ui.externalNoUsbTitle")}>{t("ui.externalNoUsbDetail")}</Caution>
                                : <Choices
                                        name="external-usb"
                                        legend={t("ui.externalUsbTitle")}
                                        value={value}
                                        onChange={onChange}
                                        choices={drives.map((drive) => ({ value: drive.root, title: driveTitle(t, drive), detail: driveDetail(t, drive), disabled: !drive.usable }))}
                                />}
                        <div><button type="button" className="nv-btn nv-btn-quiet" disabled={disabled} onClick={onRefresh}><Icon name="restart" />{t("ui.externalLookAgain")}</button></div>
                </section>
        );
};

const Prerequisites = ({ status }: { status: ExternalBootStatus }) => {
        const { t } = useI18n();
        return (
                <section className="nv-group" aria-labelledby="external-checked">
                        <h2 className="nv-label" id="external-checked">{t("ui.externalCheckedTitle")}</h2>
                        <ul className="nv-checklist">
                                <Check
                                        state={status.secureBoot === false || secureBootReady(status) ? "done" : "waiting"}
                                        label={t("ui.externalCheckSecureBoot")}
                                        word={t(status.secureBoot === false ? "ui.externalWordOff" : secureBootReady(status) ? "ui.externalWordOnEnrolled" : "ui.externalWordUnknown")}
                                />
                                <Check state={status.esp.found ? "done" : "alert"} label={t("ui.externalCheckWindowsBoot")} word={t(status.esp.found ? "ui.externalWordFound" : "ui.checkWordNotFound")} />
                                <Check
                                        state={status.bitLocker === "on" ? "alert" : status.bitLocker === "off" ? "done" : "waiting"}
                                        label={t("ui.externalCheckBitLocker")}
                                        word={t(status.bitLocker === "on" ? "ui.externalWordPausedOnRestart" : status.bitLocker === "off" ? "ui.externalWordOff" : "ui.externalWordUnknown")}
                                />
                        </ul>
                </section>
        );
};

const Choose = ({ ext, titleRef }: { ext: ExternalBootController; titleRef: Ref<HTMLHeadingElement> }) => {
        const { t } = useI18n();
        const { rebarStatus } = useConfigurationWorkspaceController();
        const status = ext.status!;
        const [mode, setMode] = useState<ExternalMode>("experiment");
        const firstUsable = status.usbDrives.find((drive) => drive.usable)?.root ?? null;
        const [root, setRoot] = useState<string | null>(firstUsable);
        // A drive that was pulled out or became unusable gives way to the first usable one.
        useEffect(() => {
                if (!status.usbDrives.some((drive) => drive.usable && drive.root === root)) setRoot(firstUsable);
        }, [status.usbDrives, root, firstUsable]);
        const medium: ExternalMedium | null = mode === "install" ? { kind: "esp" } : root ? { kind: "usb", root } : null;
        const target = rebarStatus.gpus.find((row) => row.gpu.state === "legacy256MiB")?.gpu.patchConfiguration.targetSizeBytes ?? null;
        return (
                <Frame
                        label={t("ui.externalExperimental")}
                        title={t("ui.externalTitle")}
                        lead={t("ui.externalLead")}
                        titleRef={titleRef}
                        bar={
                                <ActionBar
                                        hint={t(mode === "install" ? "ui.externalChooseHintInstall" : "ui.externalChooseHintUsb")}
                                        primary={{ label: t("ui.externalPrepareDiagnostic"), icon: "arrow", busy: ext.busy === "prepare", disabled: Boolean(ext.busy) || !medium, onClick: () => medium && void ext.prepareDiagnostic(medium) }}
                                />
                        }
                >
                        <ActionError error={ext.error} />
                        {target && <SizeCompare fromLabel={t("ui.now")} from="256 MiB" toLabel={t("ui.whenOn")} to={formatBytes(target)} label={t("ui.compareNowAndOn", { size: formatBytes(target) })} />}
                        <Journey install={mode === "install"} />
                        <section className="nv-group" aria-labelledby="external-mode">
                                <h2 className="nv-section" id="external-mode">{t("ui.externalModeTitle")}</h2>
                                <Choices
                                        name="external-mode"
                                        legend={t("ui.externalModeTitle")}
                                        value={mode}
                                        onChange={setMode}
                                        choices={[
                                                { value: "experiment", title: t("ui.externalModeUsb"), detail: t("ui.externalModeUsbDetail") },
                                                { value: "install", title: t("ui.externalModeInstall"), detail: t("ui.externalModeInstallDetail") },
                                        ]}
                                />
                        </section>
                        {mode === "experiment" && <UsbPicker drives={status.usbDrives} value={root} onChange={setRoot} onRefresh={() => void ext.reload()} disabled={Boolean(ext.busy)} />}
                        <Prerequisites status={status} />
                        <Caution title={t("ui.externalCautionTitle")}>{t("ui.externalCautionDetail")}</Caution>
                </Frame>
        );
};

const blockedIds = {
        uefi: { title: "ui.externalBlockedUefiTitle", lead: "ui.externalBlockedUefiLead" },
        admin: { title: "ui.externalBlockedAdminTitle", lead: "ui.externalBlockedAdminLead" },
        secureBoot: { title: "ui.externalBlockedSecureBootTitle", lead: "ui.externalBlockedSecureBootLead" },
        noEsp: { title: "ui.externalBlockedEspTitle", lead: "ui.externalBlockedEspLead" },
} as const;

type FirmwareVendor = "msi" | "asus" | "gigabyte" | "other";

const firmwareVendor = (manufacturer: string | null): FirmwareVendor => {
        const name = manufacturer?.toLowerCase() ?? "";
        if (/\bmsi\b|micro[ -]?star/.test(name)) return "msi";
        if (/\basus/.test(name)) return "asus";
        if (/gigabyte/.test(name)) return "gigabyte";
        return "other";
};

const enrollPathIds: Record<FirmwareVendor, StaticMessageId> = {
        msi: "ui.externalEnrollPathMsi",
        asus: "ui.externalEnrollPathAsus",
        gigabyte: "ui.externalEnrollPathGigabyte",
        other: "ui.externalEnrollPathOther",
};

/**
 * Secure Boot is on and the bundled programs carry the project signature, but db does not hold the
 * certificate yet: the user saves it to a USB drive and appends it in BIOS setup once.
 */
const EnrollCertificate = ({ ext, titleRef, onRestart }: { ext: ExternalBootController; titleRef: Ref<HTMLHeadingElement>; onRestart: () => void }) => {
        const { t } = useI18n();
        const { snap } = useConfigurationWorkspaceController();
        const status = ext.status!;
        const usable = status.usbDrives.filter((drive) => drive.usable || drive.problem === "foreignBootFile");
        const [root, setRoot] = useState<string | null>(usable[0]?.root ?? null);
        const [saved, setSaved] = useState<string | null>(null);
        useEffect(() => {
                if (!usable.some((drive) => drive.root === root)) setRoot(usable[0]?.root ?? null);
        }, [usable, root]);
        const busy = Boolean(ext.busy);
        const save = async () => {
                if (!root) return;
                if (await ext.saveCertificate(root)) setSaved(root);
        };
        const vendor = firmwareVendor(snap?.machineIdentity?.boardManufacturer ?? null);
        return (
                <Frame
                        label={t("ui.externalExperimental")}
                        title={t("ui.externalEnrollTitle")}
                        lead={t("ui.externalEnrollLead")}
                        titleRef={titleRef}
                        bar={
                                <ActionBar
                                        hint={t("ui.externalEnrollHint")}
                                        secondary={[{ label: t("ui.retryStatusCheck"), onClick: () => void ext.reload(), disabled: busy }]}
                                        primary={{ label: t("ui.externalEnrollRestart"), icon: "restart", busy: ext.busy === "restart", disabled: busy, onClick: onRestart }}
                                />
                        }
                >
                        <ActionError error={ext.error} />
                        <Steps>
                                <Step title={t("ui.externalEnrollSaveStep")} detail={t("ui.externalEnrollSaveStepDetail")}>
                                        {usable.length === 0
                                                ? <span className="nv-supporting"><br />{t("ui.externalNoUsbDetail")}</span>
                                                : (
                                                        <span className="nv-group" style={{ paddingTop: 8 }}>
                                                                <Choices
                                                                        name="external-certificate-usb"
                                                                        legend={t("ui.externalUsbTitle")}
                                                                        value={root}
                                                                        onChange={setRoot}
                                                                        choices={usable.map((drive) => ({ value: drive.root, title: driveTitle(t, drive), detail: `${drive.fileSystem} · ${bytes(drive.totalBytes)}` }))}
                                                                />
                                                                <span>
                                                                        <button type="button" className="nv-btn nv-btn-quiet" disabled={busy || !root} aria-busy={ext.busy === "certificate" || undefined} onClick={() => void save()}>
                                                                                <Icon name="save" />{t("ui.externalEnrollSave")}
                                                                        </button>
                                                                </span>
                                                                {saved && <span className="nv-supporting" role="status">{t("ui.externalEnrollSaved", { file: `${saved.replace(/\\$/, "")}\\NvStrapsReBar-db.cer` })}</span>}
                                                        </span>
                                                )}
                                </Step>
                                <Step title={t("ui.externalEnrollBiosStep")} detail={t(enrollPathIds[vendor])} />
                                <Step title={t("ui.externalEnrollReturnStep")} detail={t("ui.externalEnrollReturnStepDetail")} />
                        </Steps>
                        <Caution title={t("ui.externalEnrollCautionTitle")}>{t("ui.externalEnrollCautionDetail")}</Caution>
                </Frame>
        );
};

const Blocked = ({ ext, titleRef, onFirmwareRestart }: { ext: ExternalBootController; titleRef: Ref<HTMLHeadingElement>; onFirmwareRestart: () => void }) => {
        const { t } = useI18n();
        const { elevate, busy } = useConfigurationWorkspaceController();
        const status = ext.status!;
        const reasons = blockReasons(status);
        const first = reasons[0] ?? "noEsp";
        if (first === "enrollCertificate") return <EnrollCertificate ext={ext} titleRef={titleRef} onRestart={onFirmwareRestart} />;
        return (
                <Frame
                        label={t("ui.externalExperimental")}
                        title={t(blockedIds[first].title)}
                        lead={t(blockedIds[first].lead)}
                        titleRef={titleRef}
                        bar={
                                <ActionBar
                                        center
                                        primary={first === "admin"
                                                ? { label: t("ui.reopenAsAdministrator"), icon: "key", disabled: busy, onClick: () => void elevate() }
                                                : { label: t("ui.retryStatusCheck"), icon: "restart", busy: ext.busy === "inspect", disabled: Boolean(ext.busy), onClick: () => void ext.reload() }}
                                />
                        }
                >
                        <ul className="nv-checklist">
                                <Check state={status.uefi ? "done" : "alert"} label={t("ui.homeCheckUefi")} word={t(status.uefi ? "ui.checkWordConfirmed" : "ui.checkWordNeeded")} />
                                <Check state={status.elevated ? "done" : "alert"} label={t("ui.pillAdmin")} word={t(status.elevated ? "ui.checkWordConfirmed" : "ui.checkWordNeeded")} />
                                {status.elevated && <Check state={status.secureBoot === true ? "alert" : "done"} label={t("ui.externalCheckSecureBoot")} word={t(status.secureBoot === true ? "ui.externalWordOn" : "ui.externalWordOff")} />}
                                {status.elevated && <Check state={status.esp.found ? "done" : "alert"} label={t("ui.externalCheckWindowsBoot")} word={t(status.esp.found ? "ui.externalWordFound" : "ui.checkWordNotFound")} />}
                        </ul>
                        {first === "secureBoot" && status.bitLocker !== "off" && <Caution title={t("ui.externalSecureBootBitLockerTitle")}>{t("ui.externalSecureBootBitLockerDetail")}</Caution>}
                </Frame>
        );
};

const stepLabel = (t: ReturnType<typeof useI18n>["t"], step: 1 | 2 | 3) => t(step === 1 ? "ui.externalStepDiagnose" : step === 2 ? "ui.externalStepTry" : "ui.externalStepKeep");

type ScreenProps = { ext: ExternalBootController; active: NonNullable<ExternalActive>; titleRef: Ref<HTMLHeadingElement>; onRestart: () => void; onRemove: () => void };

const driveName = (medium: ExternalMedium) => (medium.kind === "usb" ? medium.root.replace(/\\$/, "") : "");

const useBootKey = () => {
        const { snap } = useConfigurationWorkspaceController();
        return bootMenuKey(snap?.machineIdentity?.boardManufacturer ?? null);
};

const DiagnosticReady = ({ ext, active, titleRef, onRestart, onRemove }: ScreenProps) => {
        const { t } = useI18n();
        const key = useBootKey();
        const usb = active.medium.kind === "usb";
        const drive = driveName(active.medium);
        return (
                <Frame
                        label={stepLabel(t, 1)}
                        title={t(usb ? "ui.externalDiagnosticUsbTitle" : "ui.externalDiagnosticEspTitle")}
                        lead={!usb ? t("ui.externalDiagnosticEspLead") : key ? t("ui.externalDiagnosticUsbLead", { key, drive }) : t("ui.externalDiagnosticUsbLeadNoKey", { drive })}
                        titleRef={titleRef}
                        bar={
                                <ActionBar
                                        hint={t("ui.externalReopenHint")}
                                        secondary={[{ label: t("ui.externalStop"), onClick: onRemove, disabled: Boolean(ext.busy) }]}
                                        primary={{ label: t("ui.restart"), icon: "restart", busy: ext.busy === "restart", disabled: Boolean(ext.busy), onClick: onRestart }}
                                />
                        }
                >
                        <ActionError error={ext.error} />
                        <Steps>
                                <Step title={t("ui.externalRestartStep")} />
                                {usb && <Step title={key ? t("ui.externalBootMenuStep", { key, drive }) : t("ui.externalBootMenuStepNoKey", { drive })} detail={t("ui.externalBootMenuStepDetail")} />}
                                <Step title={t("ui.externalDiagnosticRunsStep")} detail={t("ui.externalDiagnosticRunsStepDetail")} />
                        </Steps>
                </Frame>
        );
};

const DiagnosticMissing = ({ ext, active, titleRef, onRemove }: ScreenProps) => {
        const { t } = useI18n();
        const usb = active.medium.kind === "usb";
        return (
                <Frame
                        label={stepLabel(t, 1)}
                        title={t("ui.externalDiagnosticMissingTitle")}
                        lead={t(usb ? "ui.externalDiagnosticMissingUsbLead" : "ui.externalDiagnosticMissingEspLead")}
                        titleRef={titleRef}
                        bar={
                                <ActionBar
                                        secondary={[{ label: t("ui.externalStop"), onClick: onRemove, disabled: Boolean(ext.busy) }]}
                                        primary={{ label: t("ui.externalDiagnoseAgain"), icon: "restart", busy: ext.busy === "prepare", disabled: Boolean(ext.busy), onClick: () => void ext.prepareDiagnostic(active.medium) }}
                                />
                        }
                >
                        <ActionError error={ext.error} />
                        <LastError reason={active.state.lastError} />
                        <section className="nv-group" aria-labelledby="external-causes">
                                <h2 className="nv-section" id="external-causes">{t("ui.externalCausesTitle")}</h2>
                                <Facts>
                                        <Fact icon="key" title={t("ui.externalCauseSecureBoot")} detail={t("ui.externalCauseSecureBootDetail")} />
                                        {usb && <Fact icon="usb" title={t("ui.externalCauseBootMenu")} detail={t("ui.externalCauseBootMenuDetail")} />}
                                        <Fact icon="tool" title={t("ui.externalCauseCsm")} detail={t("ui.externalCauseCsmDetail")} />
                                </Facts>
                        </section>
                </Frame>
        );
};

const CandidateRow = ({ candidate, chosen, size, onChoose, onSize, many }: { candidate: ExternalCandidate; chosen: boolean; size: number | null; onChoose: () => void; onSize: (bytes: number) => void; many: boolean }) => {
        const { t } = useI18n();
        const sizes = candidate.sizes.filter((option) => option.error === null);
        const name = candidate.name ?? t("ui.externalGpuUnknown", { slot: formatSlot(candidate.slot) });
        const refusal = sizes.length === 0 ? candidate.refusal ?? candidate.sizes[0]?.error ?? "invalidReport" : null;
        return (
                <section className="nv-card nv-group" aria-label={name}>
                        <GpuRow name={name} detail={formatSlot(candidate.slot)}>
                                <span className="nv-size legacy">{bytes(candidate.currentBar1Bytes)}</span>
                                {size !== null && chosen && <><span className="nv-muted"><Icon name="arrow" /></span><span className="nv-size target">{bytes(size)}</span></>}
                        </GpuRow>
                        {refusal
                                ? <p className="nv-supporting">{t(refusalIds[refusal])}</p>
                                : (
                                        <>
                                                {many && <div><button type="button" className="nv-btn nv-btn-quiet" aria-pressed={chosen} onClick={onChoose}>{t(chosen ? "ui.externalGpuChosen" : "ui.externalGpuChoose")}</button></div>}
                                                {chosen && (
                                                        <Choices
                                                                name={`external-size-${formatSlot(candidate.slot)}`}
                                                                legend={t("ui.externalSizeTitle")}
                                                                value={size === null ? null : String(size)}
                                                                onChange={(value) => onSize(Number(value))}
                                                                // Largest first: the recommended size is usually the largest that fits.
                                                                choices={[...sizes].sort((a, b) => b.bytes - a.bytes).map((option) => ({
                                                                        value: String(option.bytes),
                                                                        title: bytes(option.bytes),
                                                                        detail: option.bytes === candidate.recommendedBytes ? t("ui.externalSizeRecommended") : "",
                                                                }))}
                                                        />
                                                )}
                                        </>
                                )}
                </section>
        );
};

const PickGpu = ({ ext, active, titleRef, onRemove }: ScreenProps) => {
        const { t } = useI18n();
        const report = ext.report;
        const usable = report ? usableCandidates(report) : [];
        const [chosenSlot, setChosenSlot] = useState<string | null>(null);
        const [sizes, setSizes] = useState<Record<string, number>>({});
        const chosen = usable.find((candidate) => formatSlot(candidate.slot) === chosenSlot) ?? usable[0];
        const chosenKey = chosen ? formatSlot(chosen.slot) : null;
        const chosenSize = chosen ? sizes[chosenKey!] ?? defaultSize(chosen) : null;
        const busy = Boolean(ext.busy);
        return (
                <Frame
                        label={stepLabel(t, 1)}
                        title={t(!report ? "ui.externalReportReading" : usable.length ? "ui.externalPickTitle" : "ui.externalPickNoneTitle")}
                        lead={report ? t(usable.length ? "ui.externalPickLead" : "ui.externalPickNoneLead") : undefined}
                        titleRef={titleRef}
                        bar={
                                <ActionBar
                                        hint={usable.length ? t("ui.externalPickHint") : undefined}
                                        secondary={[
                                                { label: t("ui.externalStop"), onClick: onRemove, disabled: busy },
                                                { label: t("ui.externalDiagnoseAgain"), onClick: () => void ext.prepareDiagnostic(active.medium), disabled: busy },
                                        ]}
                                        primary={usable.length ? { label: t("ui.externalPrepareTrial"), icon: "arrow", busy: ext.busy === "loader", disabled: busy || !chosen || chosenSize === null, onClick: () => chosen && chosenSize !== null && void ext.writeLoader(chosen.slot, chosenSize) } : undefined}
                                />
                        }
                >
                        <ActionError error={ext.error} />
                        {!report && !ext.error && <div className="nv-games-loading" role="status"><span className="nv-spinner" aria-hidden="true" />{t("ui.externalReportReading")}</div>}
                        {report && report.environment !== "physical" && <Notice title={t("ui.externalNotPhysicalTitle")}>{t("ui.externalErrorNotPhysical")}</Notice>}
                        {report && (!report.complete || report.errors.length > 0) && (
                                <Caution title={t("ui.externalReportIncompleteTitle")}>
                                        {t("ui.externalRefusalIncomplete")}
                                        {report.errors.map((error) => <span key={error}><br /><span className="nv-mono">{error}</span></span>)}
                                </Caution>
                        )}
                        {report?.candidates.length === 0 && <Caution title={t("ui.externalNoGpuTitle")}>{t("ui.externalNoGpuDetail")}</Caution>}
                        {report?.candidates.map((candidate) => {
                                const key = formatSlot(candidate.slot);
                                return (
                                        <CandidateRow
                                                key={key}
                                                candidate={candidate}
                                                many={usable.length > 1}
                                                chosen={key === chosenKey}
                                                size={key === chosenKey ? chosenSize : null}
                                                onChoose={() => setChosenSlot(key)}
                                                onSize={(value) => setSizes((current) => ({ ...current, [key]: value }))}
                                        />
                                );
                        })}
                </Frame>
        );
};

const LoaderReady = ({ ext, active, titleRef, onRestart, onRemove }: ScreenProps) => {
        const { t } = useI18n();
        const { rebarStatus } = useConfigurationWorkspaceController();
        const key = useBootKey();
        const usb = active.medium.kind === "usb";
        const drive = driveName(active.medium);
        const plan = active.state.plan;
        const size = plan ? bytes(plan.sizeBytes) : "";
        const now = Number(gpuAt(rebarStatus.gpus, plan?.target)?.gpu.bar1TotalBytes ?? LEGACY_BAR);
        return (
                <Frame
                        label={stepLabel(t, 2)}
                        title={t(usb ? "ui.externalTrialUsbTitle" : "ui.externalTrialEspTitle")}
                        lead={!usb ? t("ui.externalTrialEspLead", { size }) : key ? t("ui.externalTrialUsbLead", { key, drive, size }) : t("ui.externalTrialUsbLeadNoKey", { drive, size })}
                        titleRef={titleRef}
                        bar={
                                <ActionBar
                                        hint={t("ui.externalReopenHint")}
                                        secondary={[{ label: t("ui.externalStop"), onClick: onRemove, disabled: Boolean(ext.busy) }]}
                                        primary={{ label: t("ui.restart"), icon: "restart", busy: ext.busy === "restart", disabled: Boolean(ext.busy), onClick: onRestart }}
                                />
                        }
                >
                        <ActionError error={ext.error} />
                        {plan && <SizeCompare fromLabel={t("ui.now")} from={bytes(now)} toLabel={t("ui.externalAfterTrial")} to={size} label={t("ui.compareNowAndOn", { size })} />}
                        <Caution title={t("ui.externalTrialRecoverTitle")}>{t(usb ? "ui.externalTrialRecoverUsb" : "ui.externalTrialRecoverEsp")}</Caution>
                </Frame>
        );
};

const LoaderMissing = ({ ext, active, titleRef, onRemove }: ScreenProps) => {
        const { t } = useI18n();
        const plan = active.state.plan;
        const usb = active.medium.kind === "usb";
        const busy = Boolean(ext.busy);
        // A changed machine needs a new diagnostic; anything else can try the same plan again.
        const rediagnose = active.state.lastError === "fresh diagnostic does not match plan" || !plan;
        const again = { label: t("ui.externalTryAgain"), icon: "restart" as const, busy: ext.busy === "loader", disabled: busy, onClick: () => plan && void ext.writeLoader(plan.target, plan.sizeBytes) };
        const diagnose = { label: t("ui.externalDiagnoseAgain"), icon: "restart" as const, busy: ext.busy === "prepare", disabled: busy, onClick: () => void ext.prepareDiagnostic(active.medium) };
        return (
                <Frame
                        label={stepLabel(t, 2)}
                        title={t("ui.externalTrialMissingTitle")}
                        lead={t(usb ? "ui.externalTrialMissingUsbLead" : "ui.externalTrialMissingEspLead")}
                        titleRef={titleRef}
                        bar={
                                <ActionBar
                                        secondary={[
                                                { label: t("ui.externalStop"), onClick: onRemove, disabled: busy },
                                                ...(rediagnose ? [] : [{ label: diagnose.label, onClick: diagnose.onClick, disabled: busy }]),
                                        ]}
                                        primary={rediagnose ? diagnose : again}
                                />
                        }
                >
                        <ActionError error={ext.error} />
                        <LastError reason={active.state.lastError} />
                        {!active.state.lastError && <Caution title={t("ui.externalCausesTitle")}>{t(usb ? "ui.externalTrialMissingUsbCauses" : "ui.externalTrialMissingEspCauses")}</Caution>}
                </Frame>
        );
};

const Result = ({ ext, active, titleRef, onRemove }: ScreenProps) => {
        const { t } = useI18n();
        const { rebarStatus } = useConfigurationWorkspaceController();
        const plan = active.state.plan;
        const receipt = active.state.receipt!;
        const gpu = gpuAt(rebarStatus.gpus, plan?.target);
        const widened = gpu ? gpu.gpu.state === "expanded" : rebarStatus.tone === "expanded";
        const seen = gpu?.gpu.bar1TotalBytes ? Number(gpu.gpu.bar1TotalBytes) : receipt.measuredBytes;
        const usb = active.medium.kind === "usb";
        const busy = Boolean(ext.busy);
        const size = bytes(seen);
        const primary = !widened
                ? { label: t("ui.externalDiagnoseAgain"), icon: "restart" as const, busy: ext.busy === "prepare", disabled: busy, onClick: () => void ext.prepareDiagnostic(active.medium) }
                : usb
                        ? { label: t("ui.externalInstallOnPc"), icon: "arrow" as const, busy: ext.busy === "prepare", disabled: busy || (ext.status?.secureBoot === true && !secureBootReady(ext.status)) || !ext.status?.esp.found, onClick: () => void ext.prepareDiagnostic({ kind: "esp" }) }
                        : { label: t("ui.externalMakePermanent"), icon: "check" as const, busy: ext.busy === "permanent", disabled: busy, onClick: () => void ext.makePermanent() };
        return (
                <Frame
                        label={stepLabel(t, 2)}
                        title={widened ? t("ui.externalResultTitle", { size }) : t("ui.externalResultNotWidenedTitle")}
                        lead={widened ? t(usb ? "ui.externalResultUsbLead" : "ui.externalResultEspLead") : t("ui.externalResultNotWidenedLead", { size: bytes(receipt.measuredBytes) })}
                        titleRef={titleRef}
                        bar={<ActionBar hint={widened && !usb ? t("ui.externalMakePermanentHint") : undefined} secondary={[{ label: t(usb ? "ui.externalRemoveFromUsb" : "ui.externalStop"), onClick: onRemove, disabled: busy }]} primary={primary} />}
                >
                        <ActionError error={ext.error} />
                        {widened && <SizeCompare achieved fromLabel={t("ui.externalBefore")} from="256 MiB" toLabel={t("ui.now")} to={size} label={t("ui.compareNowAndOn", { size })} />}
                </Frame>
        );
};

const Installed = ({ ext, active, titleRef, onRemove }: ScreenProps) => {
        const { t } = useI18n();
        const { rebarStatus } = useConfigurationWorkspaceController();
        const install = ext.status?.install;
        const plan = active.state.plan;
        const gpu = gpuAt(rebarStatus.gpus, plan?.target);
        const widened = gpu ? gpu.gpu.state === "expanded" : rebarStatus.tone === "expanded";
        const busy = Boolean(ext.busy);
        const changed = Boolean(install?.successorChanged);
        const size = plan ? bytes(plan.sizeBytes) : "";
        return (
                <Frame
                        label={stepLabel(t, 3)}
                        title={t(widened && !changed ? "ui.externalInstalledTitle" : "ui.externalInstalledNotNowTitle")}
                        lead={t("ui.externalInstalledLead", { size })}
                        titleRef={titleRef}
                        bar={
                                <ActionBar
                                        secondary={[{ label: t("ui.externalRemoveFromPc"), onClick: onRemove, disabled: busy }]}
                                        primary={changed && plan ? { label: t("ui.externalRepin"), icon: "restart", busy: ext.busy === "loader", disabled: busy, onClick: () => void ext.writeLoader(plan.target, plan.sizeBytes) } : undefined}
                                />
                        }
                >
                        <ActionError error={ext.error} />
                        {changed && <Caution title={t("ui.externalSuccessorChangedTitle")}>{t("ui.externalSuccessorChangedDetail")}</Caution>}
                        {!changed && <LastError reason={active.state.lastError} />}
                        <Facts>
                                <Fact icon="gpu" title={gpu?.gpu.productName ?? (plan ? formatSlot(plan.target) : "")} detail={t("ui.externalInstalledGpuDetail", { size })} tone={widened ? "ok" : "warn"} />
                                <Fact icon="power" title={t("ui.externalInstalledOrder")} detail={t("ui.externalInstalledOrderDetail")} />
                        </Facts>
                </Frame>
        );
};

/** One confirmation per restart: save work, and BitLocker pauses for that restart only. */
const RestartDialog = ({ ext, usb, firmwareSetup, onClose }: { ext: ExternalBootController; usb: boolean; firmwareSetup: boolean; onClose: () => void }) => {
        const { t } = useI18n();
        const key = useBootKey();
        const bitLocker = ext.status?.bitLocker === "on";
        return (
                <ConfirmDialog
                        title={t(firmwareSetup ? "ui.restartDialogBiosTitle" : "ui.restartDialogTitle")}
                        confirmLabel={t("ui.restart")}
                        onClose={onClose}
                        onConfirm={() => {
                                onClose();
                                void ext.restart(bitLocker, firmwareSetup);
                        }}
                >
                        {t("ui.restartDialogSaveWork")}
                        {firmwareSetup && <><br />{t("ui.externalEnrollRestartDetail")}</>}
                        {bitLocker && <><br />{t("ui.externalRestartBitLocker")}</>}
                        {usb && !firmwareSetup && key && <><br />{t("ui.externalRestartBootKey", { key })}</>}
                </ConfirmDialog>
        );
};

const RemoveDialog = ({ ext, usb, onClose }: { ext: ExternalBootController; usb: boolean; onClose: () => void }) => {
        const { t } = useI18n();
        return (
                <ConfirmDialog
                        title={t(usb ? "ui.externalRemoveUsbTitle" : "ui.externalRemovePcTitle")}
                        confirmLabel={t("ui.externalRemoveConfirm")}
                        onClose={onClose}
                        onConfirm={() => {
                                onClose();
                                void ext.remove();
                        }}
                >
                        {t(usb ? "ui.externalRemoveUsbDetail" : "ui.externalRemovePcDetail")}
                </ConfirmDialog>
        );
};

export const ExternalBootPage = ({ titleRef }: { titleRef: Ref<HTMLHeadingElement> }) => {
        const { t } = useI18n();
        const ext = useExternalBoot();
        const { load } = useConfigurationWorkspaceController();
        const [dialog, setDialog] = useState<"restart" | "firmware" | "remove" | null>(null);
        // A restart that returns to a mounted page (the browser preview) reads the GPUs again, as
        // the app does when Windows starts it after a real restart.
        const bootTime = ext.status?.bootTimeUnixMs;
        const seenBoot = useRef(bootTime);
        useEffect(() => {
                if (seenBoot.current !== undefined && bootTime !== undefined && bootTime !== seenBoot.current) void load(true);
                seenBoot.current = bootTime;
        }, [bootTime, load]);
        // Each new screen moves focus to its heading, as the install screens do.
        useEffect(() => {
                requestAnimationFrame(() => (titleRef as RefObject<HTMLHeadingElement> | null)?.current?.focus({ preventScroll: true }));
                rememberExternalScreen(ext.screen);
        }, [ext.screen, titleRef]);

        if (ext.screen === "loading")
                return (
                        <Frame title={t("ui.externalTitle")} titleRef={titleRef}>
                                <div className="nv-games-loading" role="status"><span className="nv-spinner" aria-hidden="true" />{t("ui.externalReading")}</div>
                        </Frame>
                );
        if (ext.screen === "failed")
                return (
                        <Frame
                                title={t("ui.externalTitle")}
                                titleRef={titleRef}
                                bar={<ActionBar center primary={{ label: t("ui.retryStatusCheck"), icon: "restart", disabled: Boolean(ext.busy), onClick: () => void ext.reload() }} />}
                        >
                                <ActionError error={ext.loadFailed} />
                        </Frame>
                );
        if (ext.screen === "blocked")
                return (
                        <>
                                <Blocked ext={ext} titleRef={titleRef} onFirmwareRestart={() => setDialog("firmware")} />
                                {dialog === "firmware" && <RestartDialog ext={ext} usb={false} firmwareSetup onClose={() => setDialog(null)} />}
                        </>
                );
        if (ext.screen === "choose" || !ext.active) return <Choose ext={ext} titleRef={titleRef} />;

        const usb = ext.active.medium.kind === "usb";
        const props: ScreenProps = { ext, active: ext.active, titleRef, onRestart: () => setDialog("restart"), onRemove: () => setDialog("remove") };
        const body = (() => {
                switch (ext.screen) {
                        case "diagnosticReady": return <DiagnosticReady {...props} />;
                        case "diagnosticMissing": return <DiagnosticMissing {...props} />;
                        case "pickGpu": return <PickGpu {...props} />;
                        case "loaderReady": return <LoaderReady {...props} />;
                        case "loaderMissing": return <LoaderMissing {...props} />;
                        case "result": return <Result {...props} />;
                        case "installed": return <Installed {...props} />;
                }
        })();
        return (
                <>
                        {body}
                        {dialog === "restart" && <RestartDialog ext={ext} usb={usb} firmwareSetup={false} onClose={() => setDialog(null)} />}
                        {dialog === "remove" && <RemoveDialog ext={ext} usb={usb} onClose={() => setDialog(null)} />}
                </>
        );
};
