import type { SystemSnapshot } from "./types";
import { DeploymentWorkspaceProvider } from "./deployment-workspace/context";
import { ArtifactJourney } from "./deployment-workspace/artifact-journey";
import { DeploymentDialogs } from "./deployment-workspace/dialogs";
import { DeploymentIntro } from "./deployment-workspace/deployment-intro";
import { DeploymentRail } from "./deployment-workspace/deployment-rail";
import { FirmwareJourney } from "./deployment-workspace/firmware-journey";
import { SourceJourney } from "./deployment-workspace/source-journey";
import { useDeploymentWorkspace } from "./deployment-workspace/use-deployment-workspace";

type Props = { snapshot: SystemSnapshot };

export function DeploymentWorkspace({ snapshot }: Props) {
        const controller = useDeploymentWorkspace(snapshot);
        return (
                <DeploymentWorkspaceProvider value={controller}>
                        <div className="deployment-shell">
                                <DeploymentRail />

                                <main className="deployment-content">
                                        <DeploymentIntro />
                                        <SourceJourney />

                                        <ArtifactJourney />

                                        <FirmwareJourney />
                                </main>

                                <DeploymentDialogs />
                        </div>
                </DeploymentWorkspaceProvider>
        );
}
