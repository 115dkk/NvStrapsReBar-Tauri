import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { usesMsiProZ690Route } from "../hardware-support";
import type { SystemSnapshot } from "../types";
import type {
        BoardPath,
        FirmwareInstallMethod,
        FirmwareTargetPolicy,
        LegacyPatchRisk,
        RecoveryMethod,
} from "./contract";
import {
        recallSelectedProfile,
        rememberSelectedProfile,
} from "./profile-memory";
import {
        createDeploymentWorkspaceSession,
        type DeploymentWorkspaceIntent,
} from "./session";

export const useDeploymentWorkspace = (snapshot: SystemSnapshot) => {
        const session = useMemo(
                () =>
                        createDeploymentWorkspaceSession(
                                snapshot,
                                undefined,
                                recallSelectedProfile(),
                        ),
                [snapshot],
        );
        useEffect(() => () => session.dispose(), [session]);
        const view = useSyncExternalStore(
                session.subscribe,
                session.view,
                session.view,
        );
        useEffect(() => {
                rememberSelectedProfile(view.selectedProfileId);
        }, [view.selectedProfileId]);
        const rebootDialog = useRef<HTMLDivElement>(null);
        const rebootButton = useRef<HTMLButtonElement>(null);
        // The control that opened a dialog; the dialog's own autofocus runs before the effect below.
        const opener = useRef<HTMLElement | null>(null);
        const rememberOpener = () => {
                opener.current = document.activeElement as HTMLElement | null;
        };

        useEffect(() => {
                if (
                        !(
                                view.showReboot ||
                                view.showManual ||
                                view.showConfigurationReboot
                        )
                )
                        return;
                const previous = document.activeElement as HTMLElement | null;
                const keydown = (event: KeyboardEvent) => {
                        if (event.key === "Escape") {
                                void session.dispatch({ type: "closeModals" });
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
                        const target = [
                                opener.current,
                                rebootButton.current,
                                previous,
                        ].find((element) => element?.isConnected);
                        opener.current = null;
                        target?.focus();
                };
        }, [
                session,
                view.showReboot,
                view.showManual,
                view.showConfigurationReboot,
        ]);

        const send = (intent: DeploymentWorkspaceIntent) =>
                void session.dispatch(intent);
        const closeModal = (value: boolean) => {
                if (!value) send({ type: "closeModals" });
        };
        const commands = {
                setDisplayName: (value: string) =>
                        send({ type: "setDisplayName", value }),
                setBoardPath: (value: BoardPath) =>
                        send({ type: "setBoardPath", value }),
                setFirmwarePath: (value: string) =>
                        send({ type: "setFirmwarePath", value }),
                setRecoveryMethod: (value: RecoveryMethod) =>
                        send({ type: "setRecoveryMethod", value }),
                setFirmwareTargetPolicy: (value: FirmwareTargetPolicy) =>
                        send({ type: "setFirmwareTargetPolicy", value }),
                setInstallMethod: (value: FirmwareInstallMethod) =>
                        send({ type: "setInstallMethod", value }),
                setInstructionsUrl: (value: string) =>
                        send({ type: "setInstructionsUrl", value }),
                setRecoveryNote: (value: string) =>
                        send({ type: "setRecoveryNote", value }),
                setInstallNote: (value: string) =>
                        send({ type: "setInstallNote", value }),
                setRouteConfirmed: (value: boolean) =>
                        send({ type: "setRouteConfirmed", value }),
                setDestination: (value: string) =>
                        send({ type: "setDestination", value }),
                setGuardedConfigConfirmed: (value: boolean) =>
                        send({ type: "setGuardedConfigConfirmed", value }),
                setSelectedProfileId: (value: string) =>
                        send({ type: "setSelectedProfile", value }),
                toggleLegacyRule: (key: string, checked: boolean) =>
                        send({ type: "toggleLegacyRule", key, checked }),
                setLegacyRiskConfirmed: (
                        risk: LegacyPatchRisk,
                        confirmed: boolean,
                ) => send({ type: "setLegacyRiskConfirmed", risk, confirmed }),
                setShowReboot: closeModal,
                setShowManual: closeModal,
                setShowConfigurationReboot: closeModal,
                chooseFirmware: () => send({ type: "chooseFirmware" }),
                inspectManualPath: () => send({ type: "inspectFirmware" }),
                analyzeLegacy: () => send({ type: "analyzeLegacy" }),
                createProfile: () => send({ type: "createProfile" }),
                compare: () => send({ type: "compare" }),
                prepare: () => send({ type: "prepare" }),
                chooseDestination: () => send({ type: "chooseDestination" }),
                exportPackage: () => send({ type: "exportPackage" }),
                previewReboot: () => {
                        rememberOpener();
                        send({ type: "previewFirmwareReboot" });
                },
                reboot: () => send({ type: "requestFirmwareReboot" }),
                openManualConfirmation: () => {
                        rememberOpener();
                        send({ type: "openManual" });
                },
                confirmManual: () => send({ type: "confirmManual" }),
                recordFirmwareHandoff: (
                        includeSetup: boolean,
                        planRevision: number,
                ) =>
                        send({
                                type: "recordFirmwareHandoff",
                                includeSetup,
                                planRevision,
                        }),
                autoCheck: () => send({ type: "autoCheck" }),
                retryRecommendation: () => send({ type: "retryRecommendation" }),
                saveToUsb: () => send({ type: "saveToUsb" }),
                openInspector: () => send({ type: "openInspector" }),
                saveRecommendedConfig: () =>
                        send({ type: "saveRecommendedConfig" }),
                verifyDriver: () => send({ type: "verifyDriver" }),
                saveGuardedConfig: () => send({ type: "saveGuardedConfig" }),
                openConfigurationReboot: () => {
                        rememberOpener();
                        send({ type: "openConfigurationReboot" });
                },
                requestConfigurationReboot: () =>
                        send({ type: "requestConfigurationReboot" }),
                verifyConfigurationBoot: () =>
                        send({ type: "verifyConfigurationBoot" }),
                collectBar: () => send({ type: "collectBar" }),
                installInspector: () => send({ type: "installInspector" }),
                backupProfiles: () => send({ type: "backupProfiles" }),
                launchInspector: () => send({ type: "launchInspector" }),
        };
        const stepCompleted = (stepId: string) =>
                view.plan?.steps.find((step) => step.id === stepId)?.state ===
                "completed";

        return {
                view,
                commands,
                snapshot,
                msi: usesMsiProZ690Route(snapshot),
                stepCompleted,
                rebootDialog,
                rebootButton,
        };
};

export type DeploymentWorkspaceController = ReturnType<
        typeof useDeploymentWorkspace
>;
