import { useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "./bridge";
import type {
        BoardPath,
        DeploymentPackageReceipt,
        DeploymentPlan,
        DeploymentConfigRecommendation,
        ConfigurationRebootPreview,
        FirmwareFingerprint,
        FirmwareInstallMethod,
        FirmwarePreparation,
        FirmwareSetupRebootPreview,
        LegacyFirmwareAnalysis,
        LegacyPatchRisk,
        ManualDeploymentStepPreview,
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
const sameFirmware = (
        left: FirmwareFingerprint | null,
        right: FirmwareFingerprint | null,
) =>
        Boolean(
                left &&
                        right &&
                        left.fileName === right.fileName &&
                        left.byteLength === right.byteLength &&
                        left.sha256 === right.sha256,
        );
const legacyRuleKey = (catalog: string, ruleId: string) =>
        `${catalog}:${ruleId}`;
const catalogLabels = {
        general: "General",
        haswellAbove4g: "Haswell Above 4G",
        ivyBridgeUsb3: "Ivy Bridge USB 3",
        haswellUsb3: "Haswell USB 3",
        broadwellUsb3: "Broadwell USB 3",
} as const;
const riskLabels: Record<LegacyPatchRisk, string> = {
        dsdtModification: "DSDT modification",
        nvramWhitelist: "NVRAM whitelist change",
        usbControllerBlacklist: "USB controller blacklist",
        experimentalX79: "Experimental X79 patch",
};
const validAcknowledgementNote = (note: string, fingerprintPrefix: string) => {
        const normalized = note.trim();
        return (
                normalized.length >= 40 &&
                normalized.split(/\s+/).length >= 8 &&
                normalized
                        .toLowerCase()
                        .includes(fingerprintPrefix.toLowerCase())
        );
};
const assertPlanAdvance = (
        before: DeploymentPlan,
        after: DeploymentPlan,
        completedStepIds: DeploymentPlan["steps"][number]["id"][],
) => {
        if (
                after.profileId !== before.profileId ||
                after.schemaVersion !== before.schemaVersion ||
                after.originalFirmwareSha256 !== before.originalFirmwareSha256 ||
                after.recoveryMethod !== before.recoveryMethod
        )
                throw new Error(
                        "The backend returned a deployment receipt for a different profile contract.",
                );
        if (after.revision !== before.revision + completedStepIds.length)
                throw new Error(
                        "The backend returned an unexpected deployment plan revision.",
                );
        if (
                after.steps.length !== before.steps.length ||
                after.steps.some(
                        (step, index) => step.id !== before.steps[index]?.id,
                )
        )
                throw new Error(
                        "The backend returned a malformed deployment step sequence.",
                );
        const readyBefore = before.steps
                .map((step, index) => ({ step, index }))
                .filter(({ step }) => step.state === "ready");
        if (readyBefore.length !== 1)
                throw new Error(
                        "The current deployment plan does not have exactly one active step.",
                );
        const activeIndex = readyBefore[0]!.index;
        const expectedCompleted = before.steps.slice(
                activeIndex,
                activeIndex + completedStepIds.length,
        );
        if (
                expectedCompleted.length !== completedStepIds.length ||
                expectedCompleted.some(
                        (step, index) =>
                                step.id !== completedStepIds[index] ||
                                (index === 0
                                        ? step.state !== "ready"
                                        : step.state !== "pending"),
                ) ||
                completedStepIds.some((_, index) => {
                        const step = after.steps[activeIndex + index];
                        return step?.state !== "completed" || !step.evidence;
                }) ||
                after.steps.some(
                        (step, index) =>
                                (index < activeIndex ||
                                        index >
                                                activeIndex +
                                                        completedStepIds.length) &&
                                (step.state !== before.steps[index]?.state ||
                                        JSON.stringify(step.evidence) !==
                                                JSON.stringify(
                                                        before.steps[index]?.evidence,
                                                )),
                )
        )
                throw new Error(
                        "The backend receipt advanced unexpected deployment steps.",
                );
        const nextIndex = activeIndex + completedStepIds.length;
        const next = after.steps[nextIndex];
        if (
                (next &&
                        (next.state !== "ready" ||
                                before.steps[nextIndex]?.state !== "pending" ||
                                JSON.stringify(next.evidence) !==
                                        JSON.stringify(
                                                before.steps[nextIndex]?.evidence,
                                        ))) ||
                (!next && after.steps.some((step) => step.state === "ready"))
        )
                throw new Error(
                        "The backend receipt did not activate exactly the next deployment step.",
                );
        const ready = after.steps.filter((step) => step.state === "ready");
        if (ready.length !== (next ? 1 : 0))
                throw new Error(
                        "The backend returned an invalid active deployment step count.",
                );
        return after;
};
const assertRecommendation = (value: DeploymentConfigRecommendation) => {
        const ruleIdentities = value.draft.rules.map((rule) =>
                [
                        rule.deviceId,
                        rule.subsystemVendorId,
                        rule.subsystemDeviceId,
                        rule.bus,
                        rule.device,
                        rule.function,
                ].join(":"),
        );
        if (
                value.draft.globalMode !== 1 ||
                value.draft.targetPciBarSize !== 0 ||
                value.draft.skipS3Resume !== false ||
                value.draft.overrideBarSizeMask !== false ||
                value.draft.guardSetupChanges !== true ||
                value.turingGpuCount <= 0 ||
                value.registryManagedGpuCount < 0 ||
                value.exactFallbackRuleCount < 0 ||
                value.registryManagedGpuCount + value.exactFallbackRuleCount !==
                        value.turingGpuCount ||
                value.exactFallbackRuleCount !== value.draft.rules.length ||
                new Set(ruleIdentities).size !== ruleIdentities.length ||
                value.draft.rules.some(
                        (rule) =>
                                rule.matchScope !== "location" ||
                                rule.barSizeSelector !== 5 ||
                                rule.overrideBarSizeMask !== null,
                )
        )
                throw new Error(
                        "The backend returned an inconsistent deployment configuration recommendation.",
                );
        return value;
};
const assertFreshProfilePlan = (
        profile: MachineProfile,
        nextPlan: DeploymentPlan,
) => {
        if (
                nextPlan.profileId !== profile.profileId ||
                nextPlan.originalFirmwareSha256 !==
                        profile.originalFirmware.sha256 ||
                nextPlan.steps.filter((step) => step.state === "ready").length !==
                        1
        )
                throw new Error(
                        "The backend returned a malformed deployment plan for the new profile.",
                );
        return nextPlan;
};

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
                [legacyAnalysis, setLegacyAnalysis] = useState<{
                        path: string;
                        value: LegacyFirmwareAnalysis;
                } | null>(null),
                [legacyAnalysisStatus, setLegacyAnalysisStatus] = useState<
                        "idle" | "pending" | "ready" | "error"
                >("idle"),
                [legacyAnalysisError, setLegacyAnalysisError] = useState(""),
                [selectedLegacyRules, setSelectedLegacyRules] = useState<
                        string[]
                >([]),
                [legacyAcknowledgements, setLegacyAcknowledgements] = useState<
                        Partial<
                                Record<
                                        LegacyPatchRisk,
                                        { note: string; confirmed: boolean }
                                >
                        >
                >({}),
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
                [manualPreview, setManualPreview] =
                        useState<ManualDeploymentStepPreview | null>(null),
                [showManual, setShowManual] = useState(false),
                [manualConfirmed, setManualConfirmed] = useState(false),
                [configurationRebootPreview, setConfigurationRebootPreview] =
                        useState<ConfigurationRebootPreview | null>(null),
                [showConfigurationReboot, setShowConfigurationReboot] =
                        useState(false),
                [guardedConfigConfirmed, setGuardedConfigConfirmed] =
                        useState(false),
                [configRecommendation, setConfigRecommendation] = useState<{
                        profileId: string;
                        planRevision: number;
                        value: DeploymentConfigRecommendation;
                } | null>(null),
                [recommendationStatus, setRecommendationStatus] = useState<
                        "idle" | "pending" | "ready" | "error"
                >("idle"),
                [recommendationError, setRecommendationError] = useState(""),
                [workflowReceipt, setWorkflowReceipt] = useState<{
                        title: string;
                        detail: string;
                } | null>(null),
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
                busyActionRef = useRef(""),
                legacyAnalysisRequest = useRef(0),
                recommendationRequest = useRef(0),
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
        const legacyAnalysisValid = Boolean(
                legacyAnalysis &&
                        legacyAnalysis.path === firmwarePath &&
                        sameFirmware(legacyAnalysis.value.firmware, firmware),
        );
        const selectedLegacyEntries = useMemo(() => {
                if (!legacyAnalysis || !legacyAnalysisValid) return [];
                return legacyAnalysis.value.catalogs.flatMap((catalog) =>
                        catalog.rules
                                .filter(
                                        (rule) =>
                                                rule.status === "applicable" &&
                                                selectedLegacyRules.includes(
                                                        legacyRuleKey(
                                                                catalog.catalog,
                                                                rule.ruleId,
                                                        ),
                                                ),
                                )
                                .map((rule) => ({ catalog, rule })),
                );
        }, [legacyAnalysis, legacyAnalysisValid, selectedLegacyRules]);
        const selectedLegacyRisks = useMemo(
                () => [
                        ...new Set(
                                selectedLegacyEntries.flatMap(
                                        ({ rule }) => rule.requiredRisks,
                                ),
                        ),
                ],
                [selectedLegacyEntries],
        );
        const acknowledgementHash = firmware?.sha256.slice(0, 8) ?? "";
        const missingLegacyRisk = selectedLegacyRisks.find((risk) => {
                const acknowledgement = legacyAcknowledgements[risk];
                const note = acknowledgement?.note.trim() ?? "";
                return !(
                        acknowledgement?.confirmed &&
                        validAcknowledgementNote(note, acknowledgementHash)
                );
        });
        const legacyReady =
                boardPath !== "legacyAbove4g" ||
                (legacyAnalysisStatus === "ready" &&
                        legacyAnalysisValid &&
                        selectedLegacyEntries.length > 0 &&
                        !missingLegacyRisk);
        const legacyNextAction = (() => {
                if (boardPath !== "legacyAbove4g") return "";
                if (!firmware)
                        return "Choose and inspect the exact firmware image first.";
                if (legacyAnalysisStatus === "pending")
                        return "Wait for the exact-image analysis to finish.";
                if (legacyAnalysisStatus === "error")
                        return `Analysis failed: ${legacyAnalysisError} Retry the exact image.`;
                if (!legacyAnalysis || !legacyAnalysisValid)
                        return "Analyze this exact firmware image before selecting legacy rules.";
                if (!selectedLegacyEntries.length)
                        return "Select at least one applicable rule. Only proven matches can be selected.";
                if (missingLegacyRisk)
                        return `Add an image-specific note and confirmation for ${riskLabels[missingLegacyRisk]}.`;
                return "Legacy selections are pinned to this firmware fingerprint and ready for profile creation.";
        })();
        const activeStep = plan?.steps.find((step) => step.state === "ready");
        const stepCompleted = (stepId: DeploymentPlan["steps"][number]["id"]) =>
                plan?.steps.find((step) => step.id === stepId)?.state ===
                "completed";
        const invalidateLegacyAnalysis = () => {
                legacyAnalysisRequest.current += 1;
                setLegacyAnalysis(null);
                setLegacyAnalysisStatus("idle");
                setLegacyAnalysisError("");
                setSelectedLegacyRules([]);
                setLegacyAcknowledgements({});
                if (busyActionRef.current === "legacy-analysis")
                        busyActionRef.current = "";
                setBusyAction((current) =>
                        current === "legacy-analysis" ? "" : current,
                );
        };
        const run = async <T,>(
                action: string,
                work: () => Promise<T>,
                apply: (value: T) => void,
                success: string,
        ) => {
                if (busyActionRef.current) return;
                const current = ++sequence.current;
                busyActionRef.current = action;
                setBusyAction(action);
                setActivity(null);
                try {
                        const value = await work();
                        if (current !== sequence.current)
                                throw new Error(
                                        "A stale operation response was rejected because the selected profile or deployment plan changed.",
                                );
                        apply(value);
                        setActivity({ tone: "success", text: success });
                } catch (error) {
                        setActivity({
                                tone: "error",
                                text: operationError(error),
                        });
                } finally {
                        if (busyActionRef.current === action) {
                                busyActionRef.current = "";
                                setBusyAction("");
                        }
                }
        };

        useEffect(() => {
                let live = true;
                void Promise.all([
                        bridge.listMachineProfiles(),
                        bridge.getNvidiaProfileInspectorInstallation(),
                ])
                        .then(([nextProfiles, nextInstallation]) => {
                                if (!live) return;
                                setProfiles(nextProfiles);
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
                const request = ++recommendationRequest.current;
                setGuardedConfigConfirmed(false);
                setConfigRecommendation(null);
                setRecommendationError("");
                if (
                        !plan ||
                        activeStep?.id !== "writeNvstrapsConfiguration"
                ) {
                        setRecommendationStatus("idle");
                        return;
                }
                const profileId = plan.profileId;
                const planRevision = plan.revision;
                setRecommendationStatus("pending");
                void bridge
                        .getRecommendedDeploymentConfig(profileId)
                        .then((value) => {
                                if (request !== recommendationRequest.current)
                                        throw new Error(
                                                "A stale deployment configuration recommendation was discarded.",
                                        );
                                const recommendation =
                                        assertRecommendation(value);
                                setConfigRecommendation({
                                        profileId,
                                        planRevision,
                                        value: recommendation,
                                });
                                setRecommendationStatus("ready");
                        })
                        .catch((error) => {
                                if (request !== recommendationRequest.current)
                                        return;
                                const message = operationError(error);
                                setRecommendationStatus("error");
                                setRecommendationError(message);
                                setActivity({ tone: "error", text: message });
                        });
        }, [activeStep?.id, plan?.profileId, plan?.revision]);

        useEffect(() => {
                if (!(showReboot || showManual || showConfigurationReboot)) return;
                const previous = document.activeElement as HTMLElement | null;
                const keydown = (event: KeyboardEvent) => {
                        if (event.key === "Escape") {
                                setShowReboot(false);
                                setShowManual(false);
                                setShowConfigurationReboot(false);
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
        }, [showReboot, showManual, showConfigurationReboot]);

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
                                invalidateLegacyAnalysis();
                                setFirmwarePath(path);
                                setFirmware(inspected);
                        },
                        "Source firmware read and hashed. No firmware was modified.",
                );
        const inspectManualPath = () =>
                void run(
                        "firmware",
                        () => bridge.inspectFirmwareImage(firmwarePath),
                        (inspected) => {
                                invalidateLegacyAnalysis();
                                setFirmware(inspected);
                        },
                        "Source firmware read and hashed. No firmware was modified.",
                );
        const analyzeLegacy = async () => {
                if (busyActionRef.current || !firmware || !firmwarePath) return;
                const request = ++legacyAnalysisRequest.current;
                const requestedPath = firmwarePath;
                const requestedFirmware = structuredClone(firmware);
                busyActionRef.current = "legacy-analysis";
                setBusyAction("legacy-analysis");
                setLegacyAnalysisStatus("pending");
                setLegacyAnalysisError("");
                setLegacyAnalysis(null);
                setSelectedLegacyRules([]);
                setLegacyAcknowledgements({});
                setActivity(null);
                try {
                        const value = await bridge.analyzeLegacyFirmware(requestedPath);
                        if (request !== legacyAnalysisRequest.current) return;
                        if (!sameFirmware(value.firmware, requestedFirmware)) {
                                throw new Error(
                                        "The firmware fingerprint changed between inspection and analysis.",
                                );
                        }
                        setLegacyAnalysis({ path: requestedPath, value });
                        setSelectedLegacyRules(
                                value.catalogs.flatMap((catalog) =>
                                        catalog.rules
                                                .filter(
                                                        (rule) =>
                                                                rule.status ===
                                                                        "applicable" &&
                                                                rule.recommended,
                                                )
                                                .map((rule) =>
                                                        legacyRuleKey(
                                                                catalog.catalog,
                                                                rule.ruleId,
                                                        ),
                                                ),
                                ),
                        );
                        setLegacyAnalysisStatus("ready");
                        setActivity({
                                tone: "success",
                                text: "Exact-image legacy analysis completed read-only. No firmware was modified.",
                        });
                } catch (error) {
                        if (request !== legacyAnalysisRequest.current) return;
                        const message = operationError(error);
                        setLegacyAnalysisStatus("error");
                        setLegacyAnalysisError(message);
                        setActivity({ tone: "error", text: message });
                } finally {
                        if (request === legacyAnalysisRequest.current) {
                                if (busyActionRef.current === "legacy-analysis")
                                        busyActionRef.current = "";
                                setBusyAction("");
                        }
                }
        };
        const toggleLegacyRule = (key: string, checked: boolean) =>
                setSelectedLegacyRules((current) =>
                        checked
                                ? [...new Set([...current, key])]
                                : current.filter((value) => value !== key),
                );
        const setLegacyRiskNote = (risk: LegacyPatchRisk, note: string) =>
                setLegacyAcknowledgements((current) => ({
                        ...current,
                        [risk]: {
                                note,
                                confirmed: current[risk]?.confirmed ?? false,
                        },
                }));
        const setLegacyRiskConfirmed = (
                risk: LegacyPatchRisk,
                confirmed: boolean,
        ) =>
                setLegacyAcknowledgements((current) => ({
                        ...current,
                        [risk]: {
                                note: current[risk]?.note ?? "",
                                confirmed,
                        },
                }));
        const createProfile = () => {
                if (!firmware) return;
                const expectedFirmware = structuredClone(firmware);
                void run(
                        "profile",
                        () =>
                                bridge.createMachineProfile({
                                        displayName,
                                        boardPath,
                                        firmwarePath,
                                        expectedFirmware,
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
                                        legacyPatches:
                                                boardPath === "legacyAbove4g" &&
                                                legacyAnalysis &&
                                                legacyAnalysisValid
                                                        ? {
                                                                  upstreamCommit:
                                                                          legacyAnalysis
                                                                                  .value
                                                                                  .upstreamCommit,
                                                                  catalogs:
                                                                          legacyAnalysis.value.catalogs
                                                                                  .filter(
                                                                                          (catalog) =>
                                                                                                  selectedLegacyEntries.some(
                                                                                                          (entry) =>
                                                                                                                  entry.catalog.catalog ===
                                                                                                                  catalog.catalog,
                                                                                                  ),
                                                                                  )
                                                                                  .map(
                                                                                          (catalog) => ({
                                                                                                  catalog: catalog.catalog,
                                                                                                  sourceSha256:
                                                                                                          catalog.sourceSha256,
                                                                                          }),
                                                                                  ),
                                                                  selections:
                                                                          selectedLegacyEntries.map(
                                                                                  ({ catalog, rule }) => ({
                                                                                          catalog: catalog.catalog,
                                                                                          ruleId: rule.ruleId,
                                                                                          expectedMatches:
                                                                                                  rule.expectedMatches!,
                                                                                          requiredRisks:
                                                                                                  rule.requiredRisks,
                                                                                  }),
                                                                          ),
                                                                  acknowledgements:
                                                                          selectedLegacyRisks.map(
                                                                                  (risk) => ({
                                                                                          risk,
                                                                                          note: legacyAcknowledgements[
                                                                                                  risk
                                                                                          ]!.note.trim(),
                                                                                  }),
                                                                          ),
                                                          }
                                                        : undefined,
                                }),
                        (bundle) => {
                                assertFreshProfilePlan(
                                        bundle.profile,
                                        bundle.plan,
                                );
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
                        boardPath === "legacyAbove4g"
                                ? `Machine-bound legacy profile created with ${selectedLegacyEntries.length} authoritative rule ${selectedLegacyEntries.length === 1 ? "selection" : "selections"}; no firmware was modified or flashed.`
                                : "Machine-bound profile created; the exact source image was preserved.",
                );
        };
        const compare = () =>
                void run(
                        "preflight",
                        () =>
                                bridge.compareMachineProfile(
                                        selectedProfileId,
                                ),
                        (comparison) => {
                                const exact =
                                        comparison.result.differences.length ===
                                        0;
                                setPreflightExact(exact);
                                if (!exact)
                                        throw new Error(
                                                `Pinned machine preflight found ${comparison.result.differences.length} difference${comparison.result.differences.length === 1 ? "" : "s"}; deployment remains blocked until the selected profile matches.`,
                                        );
                        },
                        "Current machine, GPU topology, BIOS, and preserved source match the profile.",
                );
        const prepare = () => {
                if (!plan || !activeStep) return;
                const before = plan;
                const start = before.steps.findIndex(
                        (step) => step.id === activeStep.id,
                );
                const end = before.steps.findIndex(
                        (step) => step.id === "verifyPatchedArtifact",
                );
                const expected = before.steps
                        .slice(start, end + 1)
                        .map((step) => step.id);
                void run(
                        "prepare",
                        () =>
                                bridge.prepareFirmwareArtifact(
                                        selectedProfileId,
                                ),
                        (result) => {
                                assertPlanAdvance(
                                        before,
                                        result.plan,
                                        expected,
                                );
                                setPreparation(result);
                                setPlan(result.plan);
                        },
                        "Rust driver injected and the patched artifact verified. Nothing was flashed.",
                );
        };
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
                        (receipt) => {
                                if (
                                        receipt.profileId !==
                                                rebootPreview.profileId ||
                                        receipt.accepted !== true
                                )
                                        throw new Error(
                                                "The firmware restart request returned an invalid acceptance receipt.",
                                        );
                        },
                        "Windows accepted the restart request. This only opens firmware setup.",
                );
        };
        const openManualConfirmation = () => {
                if (!plan || !activeStep) return;
                const expectedProfile = plan.profileId;
                const expectedRevision = plan.revision;
                const expectedStep = activeStep.id;
                void run(
                        "manual-preview",
                        async () => {
                                const preview =
                                        await bridge.previewManualDeploymentStep(
                                                selectedProfileId,
                                        );
                                if (
                                        preview.profileId !== expectedProfile ||
                                        preview.planRevision !== expectedRevision ||
                                        preview.stepId !== expectedStep
                                )
                                        throw new Error(
                                                "The deployment plan changed while the consequence preview was loading. Review the current step again.",
                                        );
                                return preview;
                        },
                        (preview) => {
                                setManualPreview(preview);
                                setManualConfirmed(false);
                                setShowManual(true);
                        },
                        "Current manual consequence preview loaded; nothing was completed.",
                );
        };
        const confirmManual = () => {
                if (!manualPreview || !manualConfirmed || !plan) return;
                const expectedRevision = manualPreview.planRevision;
                const expectedStep = manualPreview.stepId;
                const before = plan;
                setShowManual(false);
                void run(
                        "manual-confirm",
                        () => bridge.confirmManualDeploymentStep(manualPreview),
                        (receipt) => {
                                if (
                                        receipt.plan.profileId !== before.profileId ||
                                        before.revision !== expectedRevision ||
                                        receipt.stepId !== expectedStep
                                )
                                        throw new Error(
                                                "The backend returned a stale manual-step receipt.",
                                        );
                                assertPlanAdvance(before, receipt.plan, [
                                        expectedStep,
                                ]);
                                setPlan(receipt.plan);
                                setWorkflowReceipt({
                                        title: `${manualPreview.title} recorded`,
                                        detail: `Operator attestation persisted at ${receipt.recordedAtUnixMs}.`,
                                });
                        },
                        "Manual gate recorded in the durable deployment plan.",
                );
        };
        const verifyDriver = () => {
                if (!plan || !activeStep) return;
                const before = plan;
                const expected =
                        activeStep.id === "rebootAfterFirmware"
                                ? ([
                                          "rebootAfterFirmware",
                                          "verifyDriverLoaded",
                                  ] as const)
                                : (["verifyDriverLoaded"] as const);
                void run(
                        "driver-verify",
                        () => bridge.verifyDeploymentDriver(selectedProfileId),
                        (receipt) => {
                                assertPlanAdvance(before, receipt.plan, [
                                        ...expected,
                                ]);
                                setPlan(receipt.plan);
                                setWorkflowReceipt({
                                        title: "Current boot and Rust DXE verified",
                                        detail: `${receipt.status.label} · ${receipt.status.raw}. The volatile status proved this boot and advanced both boot and driver gates.`,
                                });
                        },
                        "Current Windows boot and Rust DXE status were durably verified.",
                );
        };
        const saveGuardedConfig = () => {
                if (
                        !guardedConfigConfirmed ||
                        !plan ||
                        !configRecommendation ||
                        configRecommendation.profileId !== plan.profileId ||
                        configRecommendation.planRevision !== plan.revision
                )
                        return;
                const before = plan;
                const submittedDraft = structuredClone(
                        configRecommendation.value.draft,
                );
                void run(
                        "deployment-config",
                        () =>
                                bridge.saveDeploymentConfig(
                                        selectedProfileId,
                                        submittedDraft,
                                ),
                        (receipt) => {
                                assertPlanAdvance(before, receipt.plan, [
                                        "writeNvstrapsConfiguration",
                                ]);
                                if (
                                        JSON.stringify(receipt.save.draft) !==
                                        JSON.stringify(submittedDraft)
                                )
                                        throw new Error(
                                                "The configuration read-back receipt does not match the recommended draft that was submitted.",
                                        );
                                setPlan(receipt.plan);
                                setWorkflowReceipt({
                                        title: "Configuration write verified by read-back",
                                        detail: `${receipt.save.bytesWritten} bytes · saved ${receipt.save.savedAtUnixMs}. A Windows restart is still required.`,
                                });
                                setGuardedConfigConfirmed(false);
                        },
                        "Guarded deployment configuration was written and verified by read-back.",
                );
        };
        const openConfigurationReboot = () => {
                if (!plan) return;
                const expectedProfile = plan.profileId;
                const expectedRevision = plan.revision;
                void run(
                        "configuration-reboot-preview",
                        async () => {
                                const preview =
                                        await bridge.previewConfigurationReboot(
                                                selectedProfileId,
                                        );
                                if (
                                        preview.profileId !== expectedProfile ||
                                        preview.planRevision !== expectedRevision
                                )
                                        throw new Error(
                                                "The deployment plan changed while the restart preview was loading.",
                                        );
                                return preview;
                        },
                        (preview) => {
                                setConfigurationRebootPreview(preview);
                                setSavedWork(false);
                                setShowConfigurationReboot(true);
                        },
                        "Configuration restart previewed; the plan did not advance.",
                );
        };
        const requestConfigurationReboot = () => {
                if (!configurationRebootPreview) return;
                setShowConfigurationReboot(false);
                void run(
                        "configuration-reboot",
                        () =>
                                bridge.rebootAfterConfiguration(
                                        configurationRebootPreview,
                                        savedWork,
                                ),
                        (receipt) => {
                                if (
                                        receipt.profileId !== selectedProfileId ||
                                        receipt.accepted !== true ||
                                        receipt.planAdvanced !== false
                                )
                                        throw new Error(
                                                "The restart request returned an invalid plan-advancement receipt.",
                                        );
                                setWorkflowReceipt({
                                        title: "Configuration restart request accepted",
                                        detail: "Plan advanced: false. Return after Windows boots, then verify the later boot separately.",
                                });
                        },
                        "Windows accepted the restart request; this did not complete the reboot gate.",
                );
        };
        const verifyConfigurationBoot = () => {
                if (!plan) return;
                const before = plan;
                void run(
                        "configuration-boot-verify",
                        () =>
                                bridge.verifyConfigurationReboot(
                                        selectedProfileId,
                                ),
                        (receipt) => {
                                assertPlanAdvance(before, receipt.plan, [
                                        "rebootAfterConfiguration",
                                ]);
                                setPlan(receipt.plan);
                                setWorkflowReceipt({
                                        title: "Returned Windows boot verified",
                                        detail: `Boot ${receipt.bootedAtUnixMs} is later than configuration read-back ${receipt.configurationSavedAtUnixMs}.`,
                                });
                        },
                        "A Windows boot after the configuration read-back was durably verified.",
                );
        };
        const collectBar = () => {
                if (!plan) return;
                const before = plan;
                void run(
                        "bar1",
                        () =>
                                bridge.collectNvidiaSmiEvidence(
                                        selectedProfileId,
                                ),
                        (receipt) => {
                                if (
                                        receipt.evidence.profileId !==
                                                selectedProfileId ||
                                        receipt.evidence.allProfileGpusObserved !==
                                                true
                                )
                                        throw new Error(
                                                "NVIDIA telemetry did not prove every GPU in the selected profile.",
                                        );
                                assertPlanAdvance(before, receipt.plan, [
                                        "verifyResizableBar",
                                ]);
                                setPlan(receipt.plan);
                                setBarEvidence(receipt.evidence);
                                setWorkflowReceipt({
                                        title: "Resizable BAR independently verified",
                                        detail: `All profile GPUs observed · XML ${shortHash(receipt.evidence.rawXmlSha256)}.`,
                                });
                        },
                        "NVIDIA BAR1 evidence captured and matched to this profile.",
                );
        };
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

        const activeAction = () => {
                if (!activeStep)
                        return (
                                <div className="workflow-complete" role="status">
                                        <strong>Deployment plan complete</strong>
                                        <span>Every durable gate has a persisted receipt.</span>
                                </div>
                        );
                switch (activeStep.id) {
                        case "prepareRustDriver":
                        case "applyLegacyBoardPatches":
                        case "verifyPatchedArtifact":
                                return (
                                        <button
                                                className="primary"
                                                onClick={prepare}
                                                disabled={Boolean(busyAction)}
                                        >
                                                Prepare and verify firmware artifact
                                        </button>
                                );
                        case "flashWithVendorRoute":
                        case "configureFirmwareSetup":
                                return (
                                        <div className="workflow-actions">
                                                <button
                                                        ref={rebootButton}
                                                        className="quiet"
                                                        onClick={previewReboot}
                                                        disabled={Boolean(busyAction)}
                                                >
                                                        Review restart to firmware UI
                                                </button>
                                                <button
                                                        className="primary danger-button"
                                                        onClick={openManualConfirmation}
                                                        disabled={Boolean(busyAction)}
                                                >
                                                        Review & confirm completed step
                                                </button>
                                        </div>
                                );
                        case "rebootAfterFirmware":
                        case "verifyDriverLoaded":
                                return (
                                        <button
                                                className="primary"
                                                onClick={verifyDriver}
                                                disabled={Boolean(busyAction)}
                                        >
                                                Verify current boot + Rust DXE
                                        </button>
                                );
                        case "writeNvstrapsConfiguration":
                                return (
                                        <div className="guarded-config">
                                                {recommendationStatus === "pending" && (
                                                        <p role="status">Loading the backend-owned recommendation for this exact profile…</p>
                                                )}
                                                {recommendationStatus === "error" && (
                                                        <p className="blocked-copy" role="alert">
                                                                {recommendationError} Use Configure or retry after reloading the exact profile.
                                                        </p>
                                                )}
                                                {configRecommendation && recommendationStatus === "ready" && (
                                                        <div className="recommended-config">
                                                                <strong>Backend-recommended deployment configuration</strong>
                                                                <dl className="recommendation-facts">
                                                                        <div><dt>Turing GPUs</dt><dd>{configRecommendation.value.turingGpuCount}</dd></div>
                                                                        <div><dt>Registry managed</dt><dd>{configRecommendation.value.registryManagedGpuCount}</dd></div>
                                                                        <div><dt>Exact fallback rules</dt><dd>{configRecommendation.value.exactFallbackRuleCount}</dd></div>
                                                                </dl>
                                                                <code>
                                                                        global mode {configRecommendation.value.draft.globalMode} · target selector {configRecommendation.value.draft.targetPciBarSize} · skip S3 {String(configRecommendation.value.draft.skipS3Resume)} · mask override {String(configRecommendation.value.draft.overrideBarSizeMask)} · setup guard {String(configRecommendation.value.draft.guardSetupChanges)}
                                                                </code>
                                                                {configRecommendation.value.draft.rules.length > 0 ? (
                                                                        <ul className="recommendation-rules" aria-label="Exact fallback rules">
                                                                                {configRecommendation.value.draft.rules.map((rule) => (
                                                                                        <li key={`${rule.bus}-${rule.device}-${rule.function}`}>
                                                                                                <strong>{rule.bus.toString(16).padStart(2, "0")}:{rule.device.toString(16).padStart(2, "0")}.{rule.function}</strong>
                                                                                                <span>device {rule.deviceId.toString(16).padStart(4, "0")} · BAR selector {rule.barSizeSelector} · exact location only</span>
                                                                                        </li>
                                                                                ))}
                                                                        </ul>
                                                                ) : (
                                                                        <p>Every detected Turing GPU is covered by the built-in registry; no fallback rule is added.</p>
                                                                )}
                                                                <p>
                                                                        This draft was generated and prevalidated by the backend for the current topology. To choose another policy or size, switch to Configure instead of confirming here.
                                                                </p>
                                                        </div>
                                                )}
                                                <label className="consequence-check compact-check">
                                                        <input
                                                                type="checkbox"
                                                                checked={guardedConfigConfirmed}
                                                                disabled={recommendationStatus !== "ready"}
                                                                onChange={(event) =>
                                                                        setGuardedConfigConfirmed(
                                                                                event.target.checked,
                                                                        )
                                                                }
                                                        />
                                                        <span>
                                                                <strong>
                                                                        I reviewed this exact backend recommendation for the selected profile.
                                                                </strong>
                                                        </span>
                                                </label>
                                                <button
                                                        className="primary"
                                                        onClick={saveGuardedConfig}
                                                        disabled={
                                                                Boolean(busyAction) ||
                                                                !guardedConfigConfirmed ||
                                                                recommendationStatus !== "ready" ||
                                                                !configRecommendation
                                                        }
                                                >
                                                        Write and verify guarded configuration
                                                </button>
                                        </div>
                                );
                        case "rebootAfterConfiguration":
                                return (
                                        <div className="workflow-actions">
                                                <button
                                                        className="quiet"
                                                        onClick={openConfigurationReboot}
                                                        disabled={Boolean(busyAction)}
                                                >
                                                        Review restart after configuration
                                                </button>
                                                <button
                                                        className="primary"
                                                        onClick={verifyConfigurationBoot}
                                                        disabled={Boolean(busyAction)}
                                                >
                                                        Verify returned Windows boot
                                                </button>
                                        </div>
                                );
                        case "verifyResizableBar":
                                return (
                                        <button
                                                className="primary"
                                                onClick={collectBar}
                                                disabled={Boolean(busyAction)}
                                        >
                                                Collect and verify BAR1 evidence
                                        </button>
                                );
                        case "configureNvidiaApplications":
                                return (
                                        <div className="policy-step">
                                                <div className="tool-actions">
                                                        {!installation ? (
                                                                <button
                                                                        className="quiet"
                                                                        onClick={installInspector}
                                                                        disabled={Boolean(busyAction)}
                                                                >
                                                                        Install verified Profile Inspector
                                                                </button>
                                                        ) : (
                                                                <>
                                                                        <button
                                                                                className="quiet"
                                                                                onClick={backupProfiles}
                                                                                disabled={Boolean(busyAction)}
                                                                        >
                                                                                Back up profiles
                                                                        </button>
                                                                        <button
                                                                                className="quiet"
                                                                                onClick={launchInspector}
                                                                                disabled={Boolean(busyAction)}
                                                                        >
                                                                                Back up & launch editor
                                                                        </button>
                                                                </>
                                                        )}
                                                </div>
                                                <p>
                                                        Installing, backing up, or launching the editor does not complete policy application.
                                                </p>
                                                <button
                                                        className="primary danger-button"
                                                        onClick={openManualConfirmation}
                                                        disabled={Boolean(busyAction)}
                                                >
                                                        Review & confirm applied NVIDIA policy
                                                </button>
                                        </div>
                                );
                        default:
                                return (
                                        <p className="blocked-copy" role="alert">
                                                This durable step has no frontend action. Reload the plan or use Configure for configuration changes.
                                        </p>
                                );
                }
        };

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
                                                                preflightExact === false
                                                                        ? "bad"
                                                                        : stepCompleted("verifyProfile") ||
                                                                            preflightExact === true
                                                                          ? "ok"
                                                                          : "idle"
                                                        }
                                                />
                                                <StatusLine
                                                        label="Artifact prepared"
                                                        state={
                                                                stepCompleted("verifyPatchedArtifact")
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
                                                                stepCompleted("verifyResizableBar")
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
                                                                                invalidateLegacyAnalysis();
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
                                                                onChange={(event) => {
                                                                        invalidateLegacyAnalysis();
                                                                        setBoardPath(
                                                                                event.target.value as BoardPath,
                                                                        );
                                                                }}
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
                                                <div
                                                        className="legacy-analysis"
                                                        aria-labelledby="legacy-analysis-title"
                                                >
                                                        <div className="legacy-analysis-head">
                                                                <div>
                                                                        <span className="step">READ-ONLY</span>
                                                                        <h4 id="legacy-analysis-title">
                                                                                Exact legacy patch analysis
                                                                        </h4>
                                                                        <p>
                                                                                Match counts come only from the pinned Rust analyzer. Analysis does not mutate or flash the image.
                                                                        </p>
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
                                                                                ? "Analyzing exact image…"
                                                                                : legacyAnalysisValid
                                                                                  ? "Analyze again"
                                                                                  : "Analyze exact image"}
                                                                </button>
                                                        </div>
                                                        <p
                                                                className={`legacy-next-action ${legacyReady ? "ready" : "blocked"}`}
                                                                role="status"
                                                                aria-live="polite"
                                                        >
                                                                {legacyNextAction}
                                                        </p>
                                                        {legacyAnalysis &&
                                                                legacyAnalysisValid && (
                                                                        <div className="legacy-results">
                                                                                <div className="legacy-fingerprint">
                                                                                        <span>Analyzed source</span>
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
                                                                                                                                        {catalogLabels[catalog.catalog]}
                                                                                                                                </h5>
                                                                                                                                <small>
                                                                                                                                        {applicable.length} applicable · {absent.length} absent · {blocked.length} blocked
                                                                                                                                </small>
                                                                                                                        </div>
                                                                                                                        <span className="mono-wrap">
                                                                                                                                source {shortHash(catalog.sourceSha256)}
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
                                                                                                                                                                                {rule.description ??
                                                                                                                                                                                        "Pinned compatibility rule"}
                                                                                                                                                                        </strong>
                                                                                                                                                                        <small>
                                                                                                                                                                                {rule.expectedMatches} exact {rule.expectedMatches === 1 ? "match" : "matches"} · section 0x{rule.sectionType.toString(16).padStart(2, "0")}
                                                                                                                                                                        </small>
                                                                                                                                                                        {rule.requiredRisks.length >
                                                                                                                                                                                0 && (
                                                                                                                                                                                <em>
                                                                                                                                                                                        Requires {rule.requiredRisks.map((risk) => riskLabels[risk]).join(", ")}
                                                                                                                                                                                </em>
                                                                                                                                                                        )}
                                                                                                                                                                </span>
                                                                                                                                                                {rule.recommended && (
                                                                                                                                                                        <b>RECOMMENDED</b>
                                                                                                                                                                )}
                                                                                                                                                        </label>
                                                                                                                                                );
                                                                                                                                        },
                                                                                                                                )}
                                                                                                                        </div>
                                                                                                                ) : (
                                                                                                                        <p className="legacy-empty">
                                                                                                                                No applicable rules in this catalog.
                                                                                                                        </p>
                                                                                                                )}
                                                                                                                {absent.length > 0 && (
                                                                                                                        <p className="legacy-absent">
                                                                                                                                {absent.length} rule{absent.length === 1 ? " is" : "s are"} absent from this image and cannot be selected.
                                                                                                                        </p>
                                                                                                                )}
                                                                                                                {blocked.map(
                                                                                                                        (rule) => (
                                                                                                                                <div
                                                                                                                                        className="legacy-blocked-rule"
                                                                                                                                        key={rule.ruleId}
                                                                                                                                >
                                                                                                                                        <strong>
                                                                                                                                                Blocked · {rule.description ?? "Pinned compatibility rule"}
                                                                                                                                        </strong>
                                                                                                                                        <span>
                                                                                                                                                {rule.blockedReason ?? "The analyzer could not prove a safe match."}
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
                                                                                                <h5 id="legacy-risk-title">
                                                                                                        Explicit risk acknowledgements
                                                                                                </h5>
                                                                                                <p>
                                                                                                        For each selected risk, describe this exact image and include fingerprint <code>{acknowledgementHash}</code>. A generic confirmation is refused.
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
                                                                                                                                                {riskLabels[risk]}
                                                                                                                                        </strong>
                                                                                                                                        <span>
                                                                                                                                                Image-specific acknowledgement note
                                                                                                                                        </span>
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
                                                                                                                                                <strong>
                                                                                                                                                        I reviewed this risk for the exact analyzed firmware.
                                                                                                                                                </strong>
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
                                                                !legacyReady
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
                                                        disabled={Boolean(busyAction)}
                                                        onChange={(event) => {
                                                                if (busyActionRef.current)
                                                                        return;
                                                                sequence.current += 1;
                                                                setShowManual(false);
                                                                setShowReboot(false);
                                                                setShowConfigurationReboot(false);
                                                                setSelectedProfileId(
                                                                        event.target.value,
                                                                );
                                                                setPreflightExact(null);
                                                                setPreparation(null);
                                                                setPackageReceipt(null);
                                                                setWorkflowReceipt(null);
                                                                setBarEvidence(null);
                                                                setGuardedConfigConfirmed(false);
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
                                                <div className="active-workflow" aria-live="polite">
                                                        <div className="active-workflow-head">
                                                                <div>
                                                                        <span className="step">ACTIVE STEP · REVISION {plan.revision}</span>
                                                                        <h4>
                                                                                {activeStep?.title ?? "Deployment complete"}
                                                                        </h4>
                                                                        <p>
                                                                                {activeStep
                                                                                        ? "Only this step can advance the durable plan. Completed receipts survive reload."
                                                                                        : "No remaining step is ready; every gate has durable evidence."}
                                                                        </p>
                                                                </div>
                                                                <strong>
                                                                        {plan.steps.filter((step) => step.state === "completed").length}/{plan.steps.length}
                                                                </strong>
                                                        </div>
                                                        <div className="active-workflow-action">
                                                                {activeAction()}
                                                        </div>
                                                        {workflowReceipt && (
                                                                <div className="workflow-receipt" role="status">
                                                                        <strong>{workflowReceipt.title}</strong>
                                                                        <span>{workflowReceipt.detail}</span>
                                                                </div>
                                                        )}
                                                        {barEvidence && (
                                                                <div className="workflow-receipt" role="status">
                                                                        <strong>{barEvidence.gpus[0]?.productName}</strong>
                                                                        <span>
                                                                                BAR1 {barEvidence.gpus[0]?.bar1TotalBytes ? `${Math.round(Number(barEvidence.gpus[0].bar1TotalBytes) / 1073741824)} GiB` : "unavailable"} · Driver {barEvidence.driverVersion}
                                                                        </span>
                                                                </div>
                                                        )}
                                                        {installation && activeStep?.id === "configureNvidiaApplications" && (
                                                                <div className="workflow-receipt">
                                                                        <strong>Profile Inspector {installation.manifest.version} verified</strong>
                                                                        <span>Tool launch is a handoff only; policy remains incomplete until manual confirmation.</span>
                                                                </div>
                                                        )}
                                                        {backup && activeStep?.id === "configureNvidiaApplications" && (
                                                                <small className="verified-line mono-wrap">
                                                                        Backup preserved: {backup.backupPath}
                                                                </small>
                                                        )}
                                                        {launch && activeStep?.id === "configureNvidiaApplications" && (
                                                                <small className="verified-line">
                                                                        Editor process {launch.processId} launched; the plan did not advance.
                                                                </small>
                                                        )}
                                                </div>
                                        )}
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
                                                                plan?.steps.find((step) => step.id === "verifyPatchedArtifact")?.state !== "completed" ||
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
                                                title="Manual boundaries remain explicit"
                                                id="firmware-title"
                                                copy="Vendor flash, setup values, returned boot, and NVIDIA policy are never inferred from a local click."
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
                        {showManual && manualPreview && (
                                <div className="modal-backdrop" role="presentation">
                                        <div
                                                ref={rebootDialog}
                                                className="modal reboot-modal"
                                                role="dialog"
                                                aria-modal="true"
                                                aria-labelledby="manual-confirm-title"
                                        >
                                                <span className="kicker">OPERATOR ATTESTATION · REVISION {manualPreview.planRevision}</span>
                                                <h2 id="manual-confirm-title">{manualPreview.title}</h2>
                                                <p>
                                                        This records a durable attestation for only <code>{manualPreview.stepId}</code>. It cannot prove the external operation automatically.
                                                </p>
                                                <div className="warning-box">
                                                        {manualPreview.warnings.map((warning) => (
                                                                <span key={warning}>{warning}</span>
                                                        ))}
                                                </div>
                                                <label className="consequence-check">
                                                        <input
                                                                autoFocus
                                                                type="checkbox"
                                                                checked={manualConfirmed}
                                                                onChange={(event) =>
                                                                        setManualConfirmed(
                                                                                event.target.checked,
                                                                        )
                                                                }
                                                        />
                                                        <span>
                                                                <strong>I completed and independently reviewed this exact step.</strong>
                                                                <small>The token is bound to this profile, active step, and plan revision.</small>
                                                        </span>
                                                </label>
                                                <div className="modal-actions">
                                                        <button className="quiet" onClick={() => setShowManual(false)}>
                                                                Cancel
                                                        </button>
                                                        <button
                                                                className="primary danger-button"
                                                                disabled={!manualConfirmed || Boolean(busyAction)}
                                                                onClick={confirmManual}
                                                        >
                                                                Record completed step
                                                        </button>
                                                </div>
                                        </div>
                                </div>
                        )}
                        {showConfigurationReboot && configurationRebootPreview && (
                                <div className="modal-backdrop" role="presentation">
                                        <div
                                                ref={rebootDialog}
                                                className="modal reboot-modal"
                                                role="dialog"
                                                aria-modal="true"
                                                aria-labelledby="configuration-reboot-title"
                                        >
                                                <span className="kicker">RESTART REQUEST · PLAN DOES NOT ADVANCE</span>
                                                <h2 id="configuration-reboot-title">Restart Windows after configuration?</h2>
                                                <p>
                                                        This sends <code>{configurationRebootPreview.command} {configurationRebootPreview.arguments.join(" ")}</code>. A later Windows boot must be verified separately.
                                                </p>
                                                <div className="warning-box">
                                                        {configurationRebootPreview.warnings.map((warning) => (
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
                                                                <small>The command omits /f and the restart request itself does not complete this step.</small>
                                                        </span>
                                                </label>
                                                <div className="modal-actions">
                                                        <button className="quiet" onClick={() => setShowConfigurationReboot(false)}>
                                                                Cancel
                                                        </button>
                                                        <button
                                                                className="primary danger-button"
                                                                disabled={!savedWork || Boolean(busyAction)}
                                                                onClick={requestConfigurationReboot}
                                                        >
                                                                Request restart
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
