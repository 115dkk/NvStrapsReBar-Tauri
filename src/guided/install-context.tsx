import type { Ref } from "react";
import { useConfigurationWorkspaceController } from "../configuration-workspace/context";
import { useDeploymentWorkspaceController } from "../deployment-workspace/context";
import { usesMsiProZ690Route } from "../hardware-support";
import { useI18n } from "../i18n";
import { recallExport } from "./export-memory";
import { useGuidedNavigation } from "./navigation";
import type { InstallUiState } from "./routing";

/** Everything an install screen needs, gathered once by the install page. */
export const useInstallContext = (titleRef: Ref<HTMLHeadingElement>) => {
        const i18n = useI18n();
        const deployment = useDeploymentWorkspaceController();
        const config = useConfigurationWorkspaceController();
        const navigation = useGuidedNavigation();
        const { view, snapshot } = deployment;
        const msi = usesMsiProZ690Route(snapshot);
        const remembered = view.packageReceipt
                ? { packagePath: view.packageReceipt.packagePath, recoveryShortcut: view.packageReceipt.recoveryShortcut }
                : recallExport(view.selectedProfileId);
        const routing: InstallUiState = {
                startNew: navigation.installUi.startNew,
                catalogBoard: msi && !navigation.installUi.customRoutes,
                question: navigation.installUi.question,
                claimedInstalled: navigation.installUi.claimedInstalled,
                savingAgain: navigation.installUi.savingAgain,
                showGuide: navigation.installUi.showGuide,
                exported: Boolean(remembered),
        };
        const profile = view.selectedProfile;
        const artifactName = profile?.firmwareInstall?.artifactFileName ?? view.firmware?.fileName ?? "";
        const boardName = snapshot.machineIdentity ? `${snapshot.machineIdentity.boardManufacturer} ${snapshot.machineIdentity.boardProduct}`.trim() : "";
        return {
                ...i18n,
                ...deployment,
                config,
                navigation,
                msi,
                routing,
                remembered,
                artifactName,
                boardName,
                busy: Boolean(deployment.view.busyAction) || config.busy,
                titleRef,
        };
};

export type InstallContext = ReturnType<typeof useInstallContext>;
