import { FirmwareDeploymentActions } from "./firmware-deployment-actions";
import { ProfileSourceActions } from "./profile-source-actions";
import type { DeploymentSessionRuntime } from "./session-action-runtime";
import type { DeploymentWorkspaceIntent } from "./session-contract";
import { VerificationActions } from "./verification-actions";

/** Routes non-local intents to the domain protocol that owns their receipts. */
export class DeploymentSessionActions {
        private profileSource: ProfileSourceActions;
        private firmwareDeployment: FirmwareDeploymentActions;
        private verification: VerificationActions;

        constructor(private runtime: DeploymentSessionRuntime) {
                this.profileSource = new ProfileSourceActions(runtime);
                this.firmwareDeployment = new FirmwareDeploymentActions(
                        runtime,
                );
                this.verification = new VerificationActions(runtime);
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
                        case "saveToUsb":
                                return this.firmwareDeployment.saveToDestination();
                        case "previewFirmwareReboot":
                                return this.firmwareDeployment.previewFirmwareReboot();
                        case "requestFirmwareReboot":
                                return this.firmwareDeployment.requestFirmwareReboot();
                        case "openManual":
                                return this.verification.openManual();
                        case "confirmManual":
                                return this.verification.confirmManual();
                        case "recordFirmwareHandoff":
                                return this.verification.recordFirmwareHandoff(
                                        intent.includeSetup,
                                        intent.planRevision,
                                );
                        case "autoCheck":
                                return this.verification.autoCheck();
                        case "retryRecommendation":
                                return this.runtime.loadRecommendation();
                        case "saveRecommendedConfig":
                                return this.verification.saveRecommendedConfig();
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
                        default:
                                return;
                }
        };
}
