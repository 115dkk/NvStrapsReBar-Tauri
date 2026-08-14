import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { DeploymentAdapter } from "./adapter";

type Invoke = <T>(
        command: string,
        args?: Record<string, unknown>,
) => Promise<T>;
type Open = typeof open;

export const createTauriDeploymentAdapter = (
        invokeCommand: Invoke = invoke,
        openDialog: Open = open,
): DeploymentAdapter => ({
        selectFirmwareImage: async () => {
                const selection = await openDialog({
                        multiple: false,
                        directory: false,
                        title: "Select the vendor firmware image",
                        filters: [
                                {
                                        name: "Firmware images",
                                        extensions: [
                                                "bin",
                                                "rom",
                                                "cap",
                                                "fd",
                                                "bio",
                                                "1n0",
                                        ],
                                },
                                { name: "All files", extensions: ["*"] },
                        ],
                });
                return typeof selection === "string" ? selection : null;
        },
        selectDestinationDirectory: async () => {
                const selection = await openDialog({
                        multiple: false,
                        directory: true,
                        title: "Select an empty deployment package destination",
                });
                return typeof selection === "string" ? selection : null;
        },
        inspectFirmwareImage: (path) =>
                invokeCommand("inspect_firmware_image", { path }),
        analyzeLegacyFirmware: (path) =>
                invokeCommand("analyze_legacy_firmware", { path }),
        createMachineProfile: (request) =>
                invokeCommand("create_machine_profile", { request }),
        listMachineProfiles: () => invokeCommand("list_machine_profiles"),
        getDeploymentPlan: (profileId) =>
                invokeCommand("get_deployment_plan", { profileId }),
        compareMachineProfile: (profileId) =>
                invokeCommand("compare_machine_profile", {
                        request: { profileId, firmwarePath: null },
                }),
        prepareFirmwareArtifact: (profileId) =>
                invokeCommand("prepare_firmware_artifact", { profileId }),
        exportDeploymentPackage: (profileId, destinationRoot) =>
                invokeCommand("export_deployment_package", {
                        request: { profileId, destinationRoot },
                }),
        previewFirmwareSetupReboot: (profileId) =>
                invokeCommand("preview_firmware_setup_reboot", { profileId }),
        rebootToFirmwareSetup: (preview, unsavedWorkConfirmed) =>
                invokeCommand("reboot_to_firmware_setup", {
                        request: {
                                profileId: preview.profileId,
                                confirmationToken: preview.confirmationToken,
                                unsavedWorkConfirmed,
                        },
                }),
        previewManualDeploymentStep: (profileId) =>
                invokeCommand("preview_manual_deployment_step", { profileId }),
        confirmManualDeploymentStep: (preview) =>
                invokeCommand("confirm_manual_deployment_step", {
                        request: {
                                profileId: preview.profileId,
                                stepId: preview.stepId,
                                confirmationToken: preview.confirmationToken,
                                confirmed: true,
                        },
                }),
        verifyDeploymentDriver: (profileId) =>
                invokeCommand("verify_deployment_driver", { profileId }),
        getRecommendedDeploymentConfig: (profileId) =>
                invokeCommand("get_recommended_deployment_config", {
                        profileId,
                }),
        saveDeploymentConfig: (profileId, draft) =>
                invokeCommand("save_deployment_config", {
                        request: { profileId, draft },
                }),
        previewConfigurationReboot: (profileId) =>
                invokeCommand("preview_configuration_reboot", { profileId }),
        rebootAfterConfiguration: (preview, unsavedWorkConfirmed) =>
                invokeCommand("reboot_after_configuration", {
                        request: {
                                profileId: preview.profileId,
                                confirmationToken: preview.confirmationToken,
                                unsavedWorkConfirmed,
                        },
                }),
        verifyConfigurationReboot: (profileId) =>
                invokeCommand("verify_configuration_reboot", { profileId }),
        collectNvidiaSmiEvidence: (profileId) =>
                invokeCommand("collect_nvidia_smi_evidence", { profileId }),
        installNvidiaProfileInspector: () =>
                invokeCommand("install_nvidia_profile_inspector"),
        getNvidiaProfileInspectorInstallation: () =>
                invokeCommand("get_nvidia_profile_inspector_installation"),
        backupNvidiaProfiles: (profileId) =>
                invokeCommand("backup_nvidia_profiles", { profileId }),
        launchNvidiaProfileInspector: (profileId) =>
                invokeCommand("launch_nvidia_profile_inspector", {
                        request: { profileId },
                }),
});

export const tauriDeploymentAdapter = createTauriDeploymentAdapter();
