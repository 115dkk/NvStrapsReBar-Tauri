import { FirmwareDeploymentActions } from "./firmware-deployment-actions";
import { ProfileInspectorActions } from "./profile-inspector-actions";
import { ProfileSourceActions } from "./profile-source-actions";
import type { DeploymentSessionRuntime } from "./session-action-runtime";
import type { DeploymentWorkspaceIntent } from "./session-contract";
import { VerificationActions } from "./verification-actions";

/** Routes non-local intents to the domain protocol that owns their receipts. */
export class DeploymentSessionActions {
        private profileSource: ProfileSourceActions;
        private firmwareDeployment: FirmwareDeploymentActions;
        private verification: VerificationActions;
        private profileInspector: ProfileInspectorActions;

        constructor(private runtime: DeploymentSessionRuntime) {
                this.profileSource = new ProfileSourceActions(runtime);
                this.firmwareDeployment = new FirmwareDeploymentActions(
                        runtime,
                );
                this.verification = new VerificationActions(runtime);
                this.profileInspector = new ProfileInspectorActions(runtime);
        }

        dispatch = async (intent: DeploymentWorkspaceIntent): Promise<void> => {
                switch (intent.type) {
                        case "setSelectedProfile":
                                this.firmwareDeployment.resetProfileBinding();
                                return this.runtime.selectProfile(intent.value);
                        case "chooseFirmware":
                                return this.profileSource.chooseFirmware();
                        case "inspectFirmware":
                                return this.profileSource.inspectFirmware();
                        case "analyzeLegacy":
                                return this.profileSource.analyzeLegacy();
                        case "createProfile":
                                return this.profileSource.createProfile();
                        case "compare":
                                return this.profileSource.compareMachine();
                        case "prepare":
                                return this.firmwareDeployment.prepare();
                        case "chooseDestination":
                                return this.firmwareDeployment.chooseDestination();
                        case "exportPackage":
                                return this.firmwareDeployment.exportPackage();
                        case "previewFirmwareReboot":
                                return this.firmwareDeployment.previewFirmwareReboot();
                        case "requestFirmwareReboot":
                                return this.firmwareDeployment.requestFirmwareReboot();
                        case "openManual":
                                return this.verification.openManual();
                        case "confirmManual":
                                return this.verification.confirmManual();
                        case "verifyDriver":
                                return this.verification.verifyDriver();
                        case "saveGuardedConfig":
                                return this.verification.saveGuardedConfig();
                        case "openConfigurationReboot":
                                return this.verification.openConfigurationReboot();
                        case "requestConfigurationReboot":
                                return this.verification.requestConfigurationReboot();
                        case "verifyConfigurationBoot":
                                return this.verification.verifyConfigurationBoot();
                        case "collectBar":
                                return this.verification.collectBar();
                        case "installInspector":
                                return this.profileInspector.install();
                        case "backupProfiles":
                                return this.profileInspector.backup();
                        case "launchInspector":
                                return this.profileInspector.launch();
                        default:
                                return;
                }
        };
}
