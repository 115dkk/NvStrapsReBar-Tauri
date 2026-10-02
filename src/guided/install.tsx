import { useEffect, useRef, type Ref } from "react";
import { rememberExport } from "./export-memory";
import { useInstallContext } from "./install-context";
import {
        AdminNeeded,
        CheckFailed,
        CheckingDriver,
        CheckingResult,
        Done,
        Guide,
        Making,
        Mismatch,
        Missing,
        RestartAfterSave,
        ReturnRecord,
        SaveToUsb,
        TurnOn,
} from "./install-progress";
import { BoardQuestion, InstallQuestion, LegacyAnalysis, PickFirmware, RecoveryQuestion, Routes } from "./install-source";
import { installScreen, stageFor, type InstallScreen } from "./routing";
import { StageTracker } from "./ui";

const AUTO_CHECK_SCREENS: InstallScreen[] = ["checkingDriver", "restart", "checkingResult"];

export const InstallPage = ({ titleRef, onScreen }: { titleRef: Ref<HTMLHeadingElement>; onScreen: (screen: InstallScreen) => void }) => {
        const ctx = useInstallContext(titleRef);
        const { view, commands, snapshot, navigation, t } = ctx;
        // Legacy rules are reviewed on their own screen before the route questions.
        const legacyHold = view.boardPath === "legacyAbove4g" && !navigation.installUi.legacyAccepted;
        const screen = installScreen(
                { ...view, legacyReady: view.legacyReady && !legacyHold },
                snapshot,
                ctx.routing,
        );
        const stage = stageFor(screen);

        useEffect(() => onScreen(screen), [screen, onScreen]);

        // Keep the USB location for the guide, also after the app restarts.
        useEffect(() => {
                if (view.packageReceipt && view.selectedProfileId) {
                        rememberExport(view.selectedProfileId, view.packageReceipt);
                        navigation.setInstallUi({ savingAgain: false });
                }
        }, [view.packageReceipt]);

        // A created record ends "prepare another file" mode, also when it matches an earlier one.
        useEffect(() => {
                if (navigation.installUi.startNew && view.plan && view.profileCreations > navigation.installUi.startNewCreations)
                        navigation.setInstallUi({ startNew: false, question: 1, legacyAccepted: false, claimedInstalled: false, savingAgain: false, showGuide: false });
        }, [view.profileCreations, view.plan]);

        // "I finished in BIOS setup" only applies to the step it was pressed on.
        const activeId = view.activeStep?.id;
        useEffect(() => {
                if (navigation.installUi.claimedInstalled && activeId !== "flashWithVendorRoute" && activeId !== "configureFirmwareSetup")
                        navigation.setInstallUi({ claimedInstalled: false });
        }, [activeId]);

        // Read-only checks after a restart run on their own, once per plan revision.
        const autoKey = useRef("");
        useEffect(() => {
                if (!AUTO_CHECK_SCREENS.includes(screen) || !view.plan || view.busyAction) return;
                const key = `${view.plan.profileId}:${view.plan.revision}:${activeId}`;
                if (autoKey.current === key) return;
                autoKey.current = key;
                commands.autoCheck();
        }, [screen, view.plan, view.busyAction, activeId, commands]);

        const body = (() => {
                switch (screen) {
                        case "pickFirmware": return <PickFirmware ctx={ctx} />;
                        case "boardQuestion": return <BoardQuestion ctx={ctx} />;
                        case "legacyAnalysis": return <LegacyAnalysis ctx={ctx} />;
                        case "installQuestion": return <InstallQuestion ctx={ctx} />;
                        case "recoveryQuestion": return <RecoveryQuestion ctx={ctx} />;
                        case "routes": return <Routes ctx={ctx} />;
                        case "making": return <Making ctx={ctx} />;
                        case "save": return <SaveToUsb ctx={ctx} />;
                        case "guide": return <Guide ctx={ctx} />;
                        case "returnRecord": return <ReturnRecord ctx={ctx} />;
                        case "checkingDriver": return <CheckingDriver ctx={ctx} />;
                        case "missing": return <Missing ctx={ctx} />;
                        case "admin": return <AdminNeeded ctx={ctx} />;
                        case "checkFailed": return <CheckFailed ctx={ctx} />;
                        case "mismatch": return <Mismatch ctx={ctx} />;
                        case "turnOn": return <TurnOn ctx={ctx} />;
                        case "restart": return <RestartAfterSave ctx={ctx} />;
                        case "checkingResult": return <CheckingResult ctx={ctx} />;
                        case "done": return <Done ctx={ctx} />;
                }
        })();

        return (
                <div className="nv-shell" data-screen={screen}>
                        <StageTracker current={stage} note={stage === 5 ? t("ui.installRecordInMenu") : undefined} />
                        {body}
                </div>
        );
};
