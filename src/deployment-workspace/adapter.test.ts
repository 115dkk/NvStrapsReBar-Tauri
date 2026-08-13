import { describe, expect, it } from "vitest";
import { previewDeploymentAdapter } from "./preview-adapter";
import { createTauriDeploymentAdapter } from "./tauri-adapter";

const deploymentSeam = [
        "selectFirmwareImage",
        "selectDestinationDirectory",
        "inspectFirmwareImage",
        "analyzeLegacyFirmware",
        "createMachineProfile",
        "listMachineProfiles",
        "getDeploymentPlan",
        "compareMachineProfile",
        "prepareFirmwareArtifact",
        "exportDeploymentPackage",
        "previewFirmwareSetupReboot",
        "rebootToFirmwareSetup",
        "previewManualDeploymentStep",
        "confirmManualDeploymentStep",
        "verifyDeploymentDriver",
        "getRecommendedDeploymentConfig",
        "saveDeploymentConfig",
        "previewConfigurationReboot",
        "rebootAfterConfiguration",
        "verifyConfigurationReboot",
        "collectNvidiaSmiEvidence",
        "installNvidiaProfileInspector",
        "getNvidiaProfileInspectorInstallation",
        "backupNvidiaProfiles",
        "launchNvidiaProfileInspector",
] as const;

describe("DeploymentAdapter contract", () => {
        it.each([
                ["preview", previewDeploymentAdapter],
                [
                        "tauri",
                        createTauriDeploymentAdapter(
                                (() => Promise.resolve()) as never,
                                (() => Promise.resolve(null)) as never,
                        ),
                ],
        ])(
                "%s implementation exposes the complete callable seam",
                (_name, value) => {
                        expect(Object.keys(value).sort()).toEqual(
                                [...deploymentSeam].sort(),
                        );
                        for (const method of deploymentSeam) {
                                expect(typeof value[method]).toBe("function");
                        }
                },
        );
});
