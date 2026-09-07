import { useDeploymentWorkspaceController } from "./deployment-workspace/context";
import { ArtifactJourney } from "./deployment-workspace/artifact-journey";
import { DeploymentDialogs } from "./deployment-workspace/dialogs";
import { DeploymentIntro } from "./deployment-workspace/deployment-intro";
import { DeploymentRail } from "./deployment-workspace/deployment-rail";
import { SourceJourney } from "./deployment-workspace/source-journey";
import { useI18n } from "./i18n";

export function DeploymentWorkspace() {
        const { t } = useI18n();
        const { view } = useDeploymentWorkspaceController();
        return (
                <>
                        <div className="deployment-shell">
                                <main className="deployment-content">
                                        <DeploymentIntro />
                                        {!view.plan && <SourceJourney />}
                                        <ArtifactJourney />
                                        <DeploymentRail />
                                        {view.plan && <details className="source-disclosure"><summary>{t("ui.sourceAndInstallOptions")}</summary><SourceJourney /></details>}
                                </main>
                                <DeploymentDialogs />
                        </div>
                </>
        );
}
