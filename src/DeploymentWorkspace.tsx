import { useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "./bridge";
import type {
        BoardPath,
        DeploymentPackageReceipt,
        DeploymentPlan,
        FirmwareFingerprint,
        FirmwareInstallMethod,
        FirmwarePreparation,
        FirmwareSetupRebootPreview,
        LegacyPatchCatalogView,
        MachineProfile,
        NvidiaProfileBackupReceipt,
        NvidiaSmiEvidence,
        ProfileInspectorInstallation,
        ProfileInspectorLaunch,
        RecoveryMethod,
        SystemSnapshot,
} from "./types";

const MSI_MANUAL =
        "https://download.msi.com/archive/mnu_exe/mb/PROZ690-AWIFIDDR4_PROZ690-ADDR4100x150.pdf";
const exactMsiBoard = (snapshot: SystemSnapshot) => {
        const machine = snapshot.machineIdentity;
        return Boolean(
                machine &&
                        machine.boardManufacturer ===
                                "Micro-Star International Co., Ltd." &&
                        machine.boardProduct === "PRO Z690-A DDR4(MS-7D25)" &&
                        machine.boardVersion === "1.0",
        );
};
const shortHash = (value?: string) =>
        value ? `${value.slice(0, 10)}…${value.slice(-8)}` : "—";
const fileName = (path: string) => path.split(/[\\/]/).at(-1) || "firmware.bin";
const operationError = (error: unknown) =>
        (error as { message?: string }).message || String(error);

type Props = { snapshot: SystemSnapshot };
type Activity = { tone: "success" | "warning" | "error"; text: string } | null;

export function DeploymentWorkspace({ snapshot }: Props) {
        const msi = exactMsiBoard(snapshot);
        const [displayName, setDisplayName] = useState(
                        msi ? "PRO Z690-A DDR4 · RTX 2080 SUPER" : "",
                ),
                [boardPath, setBoardPath] = useState<BoardPath>(
                        msi ? "nativeResizableBar" : "nativeResizableBar",
                ),
                [firmwarePath, setFirmwarePath] = useState(""),
                [firmware, setFirmware] = useState<FirmwareFingerprint | null>(
                        null,
                ),
                [recoveryMethod, setRecoveryMethod] =
                        useState<RecoveryMethod>(
                                msi ? "usbFlashback" : "vendorRecovery",
                        ),
                [installMethod, setInstallMethod] =
                        useState<FirmwareInstallMethod>(
                                msi
                                        ? "firmwareSetupUtility"
                                        : "firmwareSetupUtility",
                        ),
                [instructionsUrl, setInstructionsUrl] = useState(
                        msi ? MSI_MANUAL : "",
                ),
                [recoveryNote, setRecoveryNote] = useState(
                        msi
                                ? "MSI Flash BIOS Button recovery: MSI.ROM at USB root, rear Flash BIOS port, physical button."
                                : "",
                ),
                [installNote, setInstallNote] = useState(
                        msi
                                ? "Use M-FLASH to select the exported vendor-format image. The app does not perform the flash."
                                : "",
                ),
                [routeConfirmed, setRouteConfirmed] = useState(false),
                [catalogs, setCatalogs] = useState<LegacyPatchCatalogView[]>([]),
                [profiles, setProfiles] = useState<MachineProfile[]>([]),
                [selectedProfileId, setSelectedProfileId] = useState(""),
                [plan, setPlan] = useState<DeploymentPlan | null>(null),
                [preflightExact, setPreflightExact] = useState<boolean | null>(
                        null,
                ),
                [preparation, setPreparation] =
                        useState<FirmwarePreparation | null>(null),
                [destination, setDestination] = useState(""),
                [packageReceipt, setPackageReceipt] =
                        useState<DeploymentPackageReceipt | null>(null),
                [rebootPreview, setRebootPreview] =
                        useState<FirmwareSetupRebootPreview | null>(null),
                [showReboot, setShowReboot] = useState(false),
                [savedWork, setSavedWork] = useState(false),
                [barEvidence, setBarEvidence] =
                        useState<NvidiaSmiEvidence | null>(null),
                [installation, setInstallation] =
                        useState<ProfileInspectorInstallation | null>(null),
                [backup, setBackup] =
                        useState<NvidiaProfileBackupReceipt | null>(null),
                [launch, setLaunch] =
                        useState<ProfileInspectorLaunch | null>(null),
                [busyAction, setBusyAction] = useState(""),
                [activity, setActivity] = useState<Activity>(null);
        const sequence = useRef(0),
                rebootDialog = useRef<HTMLDivElement>(null),
                rebootButton = useRef<HTMLButtonElement>(null);

        const selectedProfile = useMemo(
                () =>
                        profiles.find(
                                (profile) =>
                                        profile.profileId === selectedProfileId,
                        ) ?? null,
                [profiles, selectedProfileId],
        );
        const activeStep = plan?.steps.find((step) => step.state === "ready");
        const run = async <T,>(
                action: string,
                work: () => Promise<T>,
                apply: (value: T) => void,
                success: string,
        ) => {
                if (busyAction) return;
                const current = ++sequence.current;
                setBusyAction(action);
                setActivity(null);
                try {
                        const value = await work();
                        if (current !== sequence.current) return;
                        apply(value);
                        setActivity({ tone: "success", text: success });
                } catch (error) {
                        if (current !== sequence.current) return;
                        setActivity({
                                tone: "error",
                                text: operationError(error),
                        });
                } finally {
                        if (current === sequence.current) setBusyAction("");
                }
        };

        useEffect(() => {
                let live = true;
                void Promise.all([
                        bridge.listMachineProfiles(),
                        bridge.listLegacyPatchCatalogs(),
                        bridge.getNvidiaProfileInspectorInstallation(),
                ])
                        .then(([nextProfiles, nextCatalogs, nextInstallation]) => {
                                if (!live) return;
                                setProfiles(nextProfiles);
                                setCatalogs(nextCatalogs);
                                setInstallation(nextInstallation);
                                if (nextProfiles.length)
                                        setSelectedProfileId(
                                                nextProfiles[0].profileId,
                                        );
                        })
                        .catch((error) =>
                                live &&
                                setActivity({
                                        tone: "error",
                                        text: operationError(error),
                                }),
                        );
                return () => {
                        live = false;
                };
        }, []);

        useEffect(() => {
                if (!selectedProfileId) {
                        setPlan(null);
                        return;
                }
                const current = ++sequence.current;
                void bridge
                        .getDeploymentPlan(selectedProfileId)
                        .then((next) => {
                                if (current === sequence.current) setPlan(next);
                        })
                        .catch((error) =>
                                current === sequence.current &&
                                setActivity({
                                        tone: "error",
                                        text: operationError(error),
                                }),
                        );
        }, [selectedProfileId]);

        useEffect(() => {
                if (!showReboot) return;
                const previous = document.activeElement as HTMLElement | null;
                const keydown = (event: KeyboardEvent) => {
                        if (event.key === "Escape") {
                                setShowReboot(false);
                                return;
                        }
                        if (event.key !== "Tab" || !rebootDialog.current)
                                return;
                        const focusable = [
                                ...rebootDialog.current.querySelectorAll<HTMLElement>(
                                        "button:not([disabled]), input:not([disabled])",
                                ),
                        ];
                        const first = focusable[0],
                                last = focusable.at(-1);
                        if (
                                event.shiftKey &&
                                document.activeElement === first &&
                                last
                        ) {
                                event.preventDefault();
                                last.focus();
                        } else if (
                                !event.shiftKey &&
                                document.activeElement === last &&
                                first
                        ) {
                                event.preventDefault();
                                first.focus();
                        }
                };
                addEventListener("keydown", keydown);
                return () => {
                        removeEventListener("keydown", keydown);
                        (rebootButton.current ?? previous)?.focus();
                };
        }, [showReboot]);

        const chooseFirmware = () =>
                void run(
                        "firmware",
                        async () => {
                                const path = await bridge.selectFirmwareImage();
                                if (!path) throw new Error("Firmware selection was cancelled.");
                                const inspected = await bridge.inspectFirmwareImage(path);
                                return { path, inspected };
                        },
                        ({ path, inspected }) => {
                                setFirmwarePath(path);
                                setFirmware(inspected);
                        },
                        "Source firmware read and hashed. No firmware was modified.",
                );
        const inspectManualPath = () =>
                void run(
                        "firmware",
                        () => bridge.inspectFirmwareImage(firmwarePath),
                        setFirmware,
                        "Source firmware read and hashed. No firmware was modified.",
                );
        const createProfile = () =>
                void run(
                        "profile",
                        () =>
                                bridge.createMachineProfile({
                                        displayName,
                                        boardPath,
                                        firmwarePath,
                                        recovery: {
                                                method: recoveryMethod,
                                                testedOrDocumented:
                                                        routeConfirmed,
                                                note: recoveryNote,
                                        },
                                        firmwareInstall: {
                                                method: installMethod,
                                                artifactFileName: fileName(
                                                        firmwarePath,
                                                ),
                                                testedOrDocumented:
                                                        routeConfirmed,
                                                officialInstructionsUrl:
                                                        instructionsUrl,
                                                note: installNote,
                                        },
                                }),
                        (bundle) => {
                                setProfiles((current) => [
                                        bundle.profile,
                                        ...current.filter(
                                                (profile) =>
                                                        profile.profileId !==
                                                        bundle.profile.profileId,
                                        ),
                                ]);
                                setSelectedProfileId(bundle.profile.profileId);
                                setPlan(bundle.plan);
                                setPreflightExact(true);
                        },
                        "Machine-bound profile created; the exact source image was preserved.",
                );
        const compare = () =>
                void run(
                        "preflight",
                        () =>
                                bridge.compareMachineProfile(
                                        selectedProfileId,
                                ),
                        (comparison) =>
                                setPreflightExact(
                                        comparison.result.differences.length ===
                                                0,
                                ),
                        "Current machine, GPU topology, BIOS, and preserved source match the profile.",
                );
        const prepare = () =>
                void run(
                        "prepare",
                        () =>
                                bridge.prepareFirmwareArtifact(
                                        selectedProfileId,
                                ),
                        (result) => {
                                setPreparation(result);
                                setPlan(result.plan);
                        },
                        "Rust driver injected and the patched artifact verified. Nothing was flashed.",
                );
        const chooseDestination = () =>
                void run(
                        "destination",
                        async () => {
                                const path =
                                        await bridge.selectDestinationDirectory();
                                if (!path)
                                        throw new Error(
                                                "Destination selection was cancelled.",
                                        );
                                return path;
                        },
                        setDestination,
                        "Package destination selected.",
                );
        const exportPackage = () =>
                void run(
                        "export",
                        () =>
                                bridge.exportDeploymentPackage(
                                        selectedProfileId,
                                        destination,
                                ),
                        setPackageReceipt,
                        "Verified deployment package exported. Vendor flashing remains manual.",
                );
        const previewReboot = () =>
                void run(
                        "reboot-preview",
                        () =>
                                bridge.previewFirmwareSetupReboot(
                                        selectedProfileId,
                                ),
                        (preview) => {
                                setRebootPreview(preview);
                                setSavedWork(false);
                                setShowReboot(true);
                        },
                        "Restart scope previewed; no restart has occurred.",
                );
        const reboot = () => {
                if (!rebootPreview) return;
                setShowReboot(false);
                void run(
                        "reboot",
                        () =>
                                bridge.rebootToFirmwareSetup(
                                        rebootPreview,
                                        savedWork,
                                ),
                        () => {},
                        "Windows accepted the restart request. This only opens firmware setup.",
                );
        };
        const collectBar = () =>
                void run(
                        "bar1",
                        () =>
                                bridge.collectNvidiaSmiEvidence(
                                        selectedProfileId,
                                ),
                        setBarEvidence,
                        "NVIDIA BAR1 evidence captured and matched to this profile.",
                );
        const installInspector = () =>
                void run(
                        "install-inspector",
                        bridge.installNvidiaProfileInspector,
                        setInstallation,
                        "Pinned NVIDIA Profile Inspector verified and installed.",
                );
        const backupProfiles = () =>
                void run(
                        "backup-profiles",
                        () => bridge.backupNvidiaProfiles(selectedProfileId),
                        setBackup,
                        "Customized NVIDIA profiles exported to an immutable backup.",
                );
        const launchInspector = () =>
                void run(
                        "launch-inspector",
                        () =>
                                bridge.launchNvidiaProfileInspector(
                                        selectedProfileId,
                                ),
                        (result) => {
                                setLaunch(result);
                                setBackup(result.backup);
                        },
                        "Profile Inspector launched after an automatic profile backup. Policy changes remain manual.",
                );

        return (
                <div className="deployment-shell">
                        <aside className="deployment-rail" aria-label="Deployment status">
                                <span className="kicker">PINNED DEPLOYMENT</span>
                                <h2>{selectedProfile?.displayName ?? "No profile yet"}</h2>
                                {selectedProfile ? (
                                        <>
                                                <StatusLine
                                                        label="Machine preflight"
                                                        state={
                                                                preflightExact ===
                                                                true
                                                                        ? "ok"
                                                                        : preflightExact ===
                                                                            false
                                                                          ? "bad"
                                                                          : "idle"
                                                        }
                                                />
                                                <StatusLine
                                                        label="Artifact prepared"
                                                        state={
                                                                preparation
                                                                        ? "ok"
                                                                        : "idle"
                                                        }
                                                />
                                                <StatusLine
                                                        label="Package exported"
                                                        state={
                                                                packageReceipt
                                                                        ? "ok"
                                                                        : "idle"
                                                        }
                                                />
                                                <StatusLine
                                                        label="BAR1 observed"
                                                        state={
                                                                barEvidence
                                                                        ? "ok"
                                                                        : "idle"
                                                        }
                                                />
                                                <hr />
                                                <dl>
                                                        <dt>Profile ID</dt>
                                                        <dd className="mono-wrap">
                                                                {selectedProfile.profileId}
                                                        </dd>
                                                        <dt>Active gate</dt>
                                                        <dd>
                                                                {activeStep?.title ??
                                                                        "No ready step"}
                                                        </dd>
                                                        <dt>Plan revision</dt>
                                                        <dd>
                                                                {plan?.revision ??
                                                                        "—"}
                                                        </dd>
                                                </dl>
                                        </>
                                ) : (
                                        <p className="muted-copy">
                                                Select a source image and pin it
                                                to this exact machine first.
                                        </p>
                                )}
                                <div className="rail-note safety-note">
                                        <strong>Manual boundary</strong>
                                        <p>
                                                This app prepares and verifies a
                                                package. You perform vendor
                                                flashing, setup changes, power
                                                cycles, and hardware work.
                                        </p>
                                </div>
                        </aside>

                        <main className="deployment-content">
                                <section className="deployment-intro">
                                        <div>
                                                <span className="kicker">
                                                        EXACT MACHINE / RECOVERABLE ARTIFACT
                                                </span>
                                                <h2>Prepare, hand off, then verify</h2>
                                                <p>
                                                        Automated steps stop at
                                                        signed evidence. Physical
                                                        and firmware-screen steps
                                                        stay visible as gates.
                                                </p>
                                        </div>
                                        <div className="truth-badge">
                                                <strong>NO AUTO-FLASH</strong>
                                                <span>Manual vendor handoff</span>
                                        </div>
                                </section>

                                {activity && (
                                        <div
                                                className={`notice ${activity.tone}`}
                                                role={
                                                        activity.tone === "error"
                                                                ? "alert"
                                                                : "status"
                                                }
                                        >
                                                <span>{activity.text}</span>
                                                <button
                                                        aria-label="Dismiss operation status"
                                                        onClick={() =>
                                                                setActivity(null)
                                                        }
                                                >
                                                        ×
                                                </button>
                                        </div>
                                )}

                                <section className="journey-panel" aria-labelledby="source-title">
                                        <JourneyHeading
                                                number="01"
                                                title="Pin source & recovery"
                                                id="source-title"
                                                copy="Read and hash the exact vendor image, then document the install and recovery route."
                                        />
                                        {msi && (
                                                <div className="detected-route">
                                                        <strong>Exact MSI board recognized</strong>
                                                        <span>
                                                                Native ReBAR,
                                                                M-FLASH, and Flash
                                                                BIOS Button defaults
                                                                are prefilled from
                                                                the official manual.
                                                                Confirm them below.
                                                        </span>
                                                </div>
                                        )}
                                        <div className="form-grid">
                                                <label className="field span-2">
                                                        <span>Profile name</span>
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
                                                        <span>Exact firmware image</span>
                                                        <div className="path-control">
                                                                <input
                                                                        value={firmwarePath}
                                                                        placeholder="Choose a vendor BIOS image or enter an absolute path"
                                                                        onChange={(event) => {
                                                                                setFirmwarePath(
                                                                                        event.target.value,
                                                                                );
                                                                                setFirmware(null);
                                                                        }}
                                                                />
                                                                <button
                                                                        onClick={chooseFirmware}
                                                                        disabled={Boolean(busyAction)}
                                                                >
                                                                        Choose file
                                                                </button>
                                                                <button
                                                                        className="quiet"
                                                                        onClick={inspectManualPath}
                                                                        disabled={
                                                                                Boolean(busyAction) ||
                                                                                !firmwarePath ||
                                                                                Boolean(firmware)
                                                                        }
                                                                >
                                                                        Inspect
                                                                </button>
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
                                                        <span>Board path</span>
                                                        <select
                                                                value={boardPath}
                                                                onChange={(event) =>
                                                                        setBoardPath(
                                                                                event.target.value as BoardPath,
                                                                        )
                                                                }
                                                        >
                                                                <option value="nativeResizableBar">
                                                                        Native Resizable BAR
                                                                </option>
                                                                <option value="legacyAbove4g">
                                                                        Legacy Above 4G
                                                                </option>
                                                        </select>
                                                </label>
                                                <label className="field">
                                                        <span>Vendor install route</span>
                                                        <select
                                                                value={installMethod}
                                                                onChange={(event) =>
                                                                        setInstallMethod(
                                                                                event.target.value as FirmwareInstallMethod,
                                                                        )
                                                                }
                                                        >
                                                                <option value="firmwareSetupUtility">
                                                                        Firmware setup utility
                                                                </option>
                                                                <option value="usbFlashback">
                                                                        USB flashback
                                                                </option>
                                                                <option value="vendorWindowsUtility">
                                                                        Vendor Windows utility
                                                                </option>
                                                                <option value="externalSpiProgrammer">
                                                                        External SPI programmer
                                                                </option>
                                                        </select>
                                                </label>
                                                <label className="field">
                                                        <span>Recovery route</span>
                                                        <select
                                                                value={recoveryMethod}
                                                                onChange={(event) =>
                                                                        setRecoveryMethod(
                                                                                event.target.value as RecoveryMethod,
                                                                        )
                                                                }
                                                        >
                                                                <option value="usbFlashback">USB flashback</option>
                                                                <option value="dualBios">Dual BIOS</option>
                                                                <option value="vendorRecovery">Vendor recovery</option>
                                                                <option value="externalSpiProgrammer">External SPI programmer</option>
                                                                <option value="none">None — profile will be refused</option>
                                                        </select>
                                                </label>
                                                <label className="field">
                                                        <span>Official instructions URL</span>
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
                                                        <span>Install handoff note</span>
                                                        <input
                                                                value={installNote}
                                                                onChange={(event) =>
                                                                        setInstallNote(
                                                                                event.target.value,
                                                                        )
                                                                }
                                                        />
                                                </label>
                                                <label className="field span-2">
                                                        <span>Recovery note</span>
                                                        <input
                                                                value={recoveryNote}
                                                                onChange={(event) =>
                                                                        setRecoveryNote(
                                                                                event.target.value,
                                                                        )
                                                                }
                                                        />
                                                </label>
                                        </div>
                                        {boardPath === "legacyAbove4g" && (
                                                <div className="notice warning compact-notice">
                                                        <span>
                                                                {catalogs.length} pinned legacy catalogs are available, but this screen cannot safely infer rule match counts. Legacy profile creation remains unavailable until exact selections are supplied by an authoritative workflow.
                                                        </span>
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
                                                        <strong>
                                                                I checked the vendor install and recovery instructions for this board.
                                                        </strong>
                                                        <small>
                                                                This confirmation records a documented route; it does not prove a recovery attempt.
                                                        </small>
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
                                                                boardPath ===
                                                                        "legacyAbove4g"
                                                        }
                                                        onClick={createProfile}
                                                >
                                                        {busyAction === "profile"
                                                                ? "Pinning profile…"
                                                                : "Create machine-bound profile"}
                                                </button>
                                        </div>
                                </section>

                                <section className="journey-panel" aria-labelledby="artifact-title">
                                        <JourneyHeading
                                                number="02"
                                                title="Preflight & export"
                                                id="artifact-title"
                                                copy="Refuse drift, prepare the Rust firmware artifact, and export a read-back verified package."
                                        />
                                        <label className="field profile-select">
                                                <span>Machine profile</span>
                                                <select
                                                        value={selectedProfileId}
                                                        onChange={(event) => {
                                                                setSelectedProfileId(
                                                                        event.target.value,
                                                                );
                                                                setPreflightExact(null);
                                                                setPreparation(null);
                                                                setPackageReceipt(null);
                                                        }}
                                                >
                                                        {!profiles.length && (
                                                                <option value="">No stored profiles</option>
                                                        )}
                                                        {profiles.map((profile) => (
                                                                <option
                                                                        key={profile.profileId}
                                                                        value={profile.profileId}
                                                                >
                                                                        {profile.displayName}
                                                                </option>
                                                        ))}
                                                </select>
                                        </label>
                                        {plan && (
                                                <ol className="plan-list" aria-label="Deployment plan">
                                                        {plan.steps.map((step) => (
                                                                <li
                                                                        key={step.id}
                                                                        className={`plan-step ${step.state}`}
                                                                >
                                                                        <i aria-hidden="true" />
                                                                        <div>
                                                                                <strong>{step.title}</strong>
                                                                                <span>
                                                                                        {step.kind === "automated"
                                                                                                ? "Automated"
                                                                                                : step.kind === "physicalConfirmation"
                                                                                                  ? "Physical confirmation"
                                                                                                  : step.kind === "firmwareManual"
                                                                                                    ? "Manual firmware gate"
                                                                                                    : step.kind === "externalTool"
                                                                                                      ? "Verified external tool"
                                                                                                      : "Restart gate"}
                                                                                </span>
                                                                        </div>
                                                                        <b>{step.state}</b>
                                                                </li>
                                                        ))}
                                                </ol>
                                        )}
                                        <div className="action-row">
                                                <button
                                                        onClick={compare}
                                                        disabled={Boolean(busyAction) || !selectedProfileId}
                                                >
                                                        Run exact-machine preflight
                                                </button>
                                                <button
                                                        className="primary"
                                                        onClick={prepare}
                                                        disabled={
                                                                Boolean(busyAction) ||
                                                                !selectedProfileId ||
                                                                preflightExact !== true ||
                                                                Boolean(preparation)
                                                        }
                                                >
                                                        Prepare verified artifact
                                                </button>
                                        </div>
                                        {preparation?.patchedFirmware && (
                                                <div className="artifact-receipt" role="status">
                                                        <strong>Patched artifact verified</strong>
                                                        <span>
                                                                {preparation.patchedFirmware.byteLength.toLocaleString()} bytes · SHA-256 {shortHash(preparation.patchedFirmware.sha256)}
                                                        </span>
                                                        <small>No BIOS flash has occurred.</small>
                                                </div>
                                        )}
                                        <div className="path-control export-control">
                                                <input
                                                        aria-label="Deployment package destination"
                                                        value={destination}
                                                        placeholder="Choose an empty destination folder"
                                                        onChange={(event) =>
                                                                setDestination(event.target.value)
                                                        }
                                                />
                                                <button
                                                        className="quiet"
                                                        onClick={chooseDestination}
                                                        disabled={Boolean(busyAction)}
                                                >
                                                        Choose folder
                                                </button>
                                                <button
                                                        className="primary"
                                                        onClick={exportPackage}
                                                        disabled={
                                                                Boolean(busyAction) ||
                                                                !preparation ||
                                                                !destination
                                                        }
                                                >
                                                        Export package
                                                </button>
                                        </div>
                                        {packageReceipt && (
                                                <div className="artifact-receipt" role="status">
                                                        <strong>Package exported — manual handoff next</strong>
                                                        <span className="mono-wrap">{packageReceipt.packagePath}</span>
                                                        <small>
                                                                {packageReceipt.manifest.files.length} files verified · manifest {shortHash(packageReceipt.manifestSha256)}
                                                        </small>
                                                </div>
                                        )}
                                </section>

                                <section className="journey-panel" aria-labelledby="firmware-title">
                                        <JourneyHeading
                                                number="03"
                                                title="Enter firmware setup"
                                                id="firmware-title"
                                                copy="Restart directly to the firmware UI when the plan reaches a valid manual gate."
                                        />
                                        <div className="manual-gates">
                                                <div>
                                                        <span>MANUAL</span>
                                                        <strong>Vendor flash</strong>
                                                        <p>Select the exported artifact in the documented vendor utility. Keep power stable.</p>
                                                </div>
                                                <div>
                                                        <span>PHYSICAL</span>
                                                        <strong>Recovery readiness</strong>
                                                        <p>Keep the pinned recovery route and original image available before flashing.</p>
                                                </div>
                                                <div>
                                                        <span>MANUAL</span>
                                                        <strong>UEFI values</strong>
                                                        <p>Confirm Above 4G Decoding and Resizable BAR in firmware. The app does not change them.</p>
                                                </div>
                                        </div>
                                        <button
                                                ref={rebootButton}
                                                className="danger-button"
                                                disabled={Boolean(busyAction) || !selectedProfileId || !preparation}
                                                onClick={previewReboot}
                                        >
                                                Review restart to firmware UI
                                        </button>
                                </section>

                                <section className="journey-panel" aria-labelledby="verify-title">
                                        <JourneyHeading
                                                number="04"
                                                title="Observe & hand off policy"
                                                id="verify-title"
                                                copy="Collect read-only BAR1 evidence, then use a pinned external editor with an automatic backup."
                                        />
                                        <div className="verification-grid">
                                                <div className="tool-card">
                                                        <span className="step">BAR1</span>
                                                        <h4>NVIDIA telemetry</h4>
                                                        <p>Runs the system NVIDIA tool read-only and matches PCI locations to this profile.</p>
                                                        <button
                                                                onClick={collectBar}
                                                                disabled={Boolean(busyAction) || !selectedProfileId}
                                                        >
                                                                Collect BAR1 evidence
                                                        </button>
                                                        {barEvidence && (
                                                                <div className="tool-result" role="status">
                                                                        <strong>{barEvidence.gpus[0]?.productName}</strong>
                                                                        <span>BAR1 {barEvidence.gpus[0]?.bar1TotalBytes ? `${Math.round(Number(barEvidence.gpus[0].bar1TotalBytes) / 1073741824)} GiB` : "unavailable"}</span>
                                                                        <small>Driver {barEvidence.driverVersion} · topology {barEvidence.allProfileGpusObserved ? "matched" : "incomplete"}</small>
                                                                </div>
                                                        )}
                                                </div>
                                                <div className="tool-card">
                                                        <span className="step">NPI</span>
                                                        <h4>NVIDIA Profile Inspector</h4>
                                                        <p>Downloads only the pinned release, verifies every installed file, and backs up customized profiles before launch.</p>
                                                        <div className="tool-actions">
                                                                {!installation ? (
                                                                        <button
                                                                                onClick={installInspector}
                                                                                disabled={Boolean(busyAction)}
                                                                        >
                                                                                Install verified tool
                                                                        </button>
                                                                ) : (
                                                                        <>
                                                                                <button
                                                                                        className="quiet"
                                                                                        onClick={backupProfiles}
                                                                                        disabled={Boolean(busyAction) || !selectedProfileId}
                                                                                >
                                                                                        Back up profiles
                                                                                </button>
                                                                                <button
                                                                                        className="primary"
                                                                                        onClick={launchInspector}
                                                                                        disabled={Boolean(busyAction) || !selectedProfileId}
                                                                                >
                                                                                        Back up & launch
                                                                                </button>
                                                                        </>
                                                                )}
                                                        </div>
                                                        {installation && (
                                                                <div className="tool-result">
                                                                        <strong>Verified {installation.manifest.version}</strong>
                                                                        <span>Manifest {shortHash(installation.manifestSha256)}</span>
                                                                        <small>Application profile changes remain manual.</small>
                                                                </div>
                                                        )}
                                                        {backup && (
                                                                <div className="tool-result" role="status">
                                                                        <strong>Backup preserved</strong>
                                                                        <span>{backup.manifest.profileCount} profiles · {backup.manifest.settingCount} settings</span>
                                                                        <small className="mono-wrap">{backup.backupPath}</small>
                                                                </div>
                                                        )}
                                                        {launch && (
                                                                <small className="verified-line">
                                                                        Process {launch.processId} launched elevated; no policy was imported automatically.
                                                                </small>
                                                        )}
                                                </div>
                                        </div>
                                </section>
                        </main>

                        {showReboot && rebootPreview && (
                                <div className="modal-backdrop" role="presentation">
                                        <div
                                                ref={rebootDialog}
                                                className="modal reboot-modal"
                                                role="dialog"
                                                aria-modal="true"
                                                aria-labelledby="reboot-title"
                                        >
                                                <span className="kicker">IMMEDIATE RESTART</span>
                                                <h2 id="reboot-title">Restart Windows into firmware setup?</h2>
                                                <p>
                                                        This sends <code>{rebootPreview.command} {rebootPreview.arguments.join(" ")}</code>. It does not flash firmware or change setup values.
                                                </p>
                                                <div className="warning-box">
                                                        {rebootPreview.warnings.map((warning) => (
                                                                <span key={warning}>{warning}</span>
                                                        ))}
                                                </div>
                                                <label className="consequence-check">
                                                        <input
                                                                autoFocus
                                                                type="checkbox"
                                                                checked={savedWork}
                                                                onChange={(event) => setSavedWork(event.target.checked)}
                                                        />
                                                        <span>
                                                                <strong>I saved and closed my work.</strong>
                                                                <small>The restart is immediate. Applications are not explicitly force-closed.</small>
                                                        </span>
                                                </label>
                                                <div className="modal-actions">
                                                        <button className="quiet" onClick={() => setShowReboot(false)}>
                                                                Cancel
                                                        </button>
                                                        <button
                                                                className="primary danger-button"
                                                                disabled={!savedWork}
                                                                onClick={reboot}
                                                        >
                                                                Restart to firmware UI
                                                        </button>
                                                </div>
                                        </div>
                                </div>
                        )}
                </div>
        );
}

function StatusLine({
        label,
        state,
}: {
        label: string;
        state: "ok" | "bad" | "idle";
}) {
        return (
                <span className={`status ${state}`}>
                        <i />
                        {label}
                </span>
        );
}

function JourneyHeading({
        number,
        title,
        id,
        copy,
}: {
        number: string;
        title: string;
        id: string;
        copy: string;
}) {
        return (
                <div className="section-head journey-head">
                        <div>
                                <span className="step">{number}</span>
                                <h3 id={id}>{title}</h3>
                        </div>
                        <p>{copy}</p>
                </div>
        );
}
