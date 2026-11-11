import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview, type Webview } from "@tauri-apps/api/webview";
import { messages } from "../i18n-catalog";
import { choosePath } from "../native-dialogs";
import type { DeploymentAdapter } from "./adapter";

type Invoke = <T>(
        command: string,
        args?: Record<string, unknown>,
) => Promise<T>;
type ChoosePath = typeof choosePath;

export const createTauriDeploymentAdapter = (
        invokeCommand: Invoke = invoke,
        choose: ChoosePath = choosePath,
        watchDragDrop: Webview["onDragDropEvent"] = (listener) =>
                getCurrentWebview().onDragDropEvent(listener),
): DeploymentAdapter => ({
        watchFileDrops: (listener) => {
                let stopped = false;
                let unlisten: (() => void) | undefined;
                void watchDragDrop(({ payload }) => {
                        if (stopped) return;
                        switch (payload.type) {
                                case "enter":
                                case "over":
                                        listener({ kind: "over" });
                                        break;
                                case "leave":
                                        listener({ kind: "leave" });
                                        break;
                                case "drop":
                                        listener({ kind: "drop", paths: payload.paths });
                                        break;
                        }
                }).then((stop) => {
                        if (stopped) stop();
                        else unlisten = stop;
                }).catch(() => {
                        // The file picker remains available if native events are unavailable.
                        if (!stopped) listener({ kind: "leave" });
                });
                return () => {
                        if (stopped) return;
                        stopped = true;
                        unlisten?.();
                };
        },
        deleteMachineProfile: (profileId) =>
                invokeCommand("delete_machine_profile", { profileId }),
        // No file type filter: makers name BIOS files after the version (E7B98IMS.1F0,
        // Z690AORUS.F20), so a list of extensions hides valid files.
        selectFirmwareImage: (title = messages["ui.dialogChooseBiosFile"].en) =>
                choose({ kind: "file", title }),
        selectDestinationDirectory: (title = messages["ui.dialogChooseUsbFolder"].en) =>
                choose({ kind: "folder", title }),
        inspectFirmwareImage: (path) =>
                invokeCommand("inspect_firmware_image", { path }),
        inspectSignedFirmwareUpdate: (path) =>
                invokeCommand("inspect_signed_firmware_update", { path }),
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
});

export const tauriDeploymentAdapter = createTauriDeploymentAdapter();
