import type { ConfigDraft } from "../types";
import type {
        ConfigurationRebootAccepted,
        ConfigurationRebootPreview,
        ConfigurationRebootVerificationReceipt,
        CreateProfileRequest,
        DeploymentBundle,
        DeploymentConfigRecommendation,
        DeploymentPackageReceipt,
        DeploymentPlan,
        DriverVerificationReceipt,
        FirmwareFingerprint,
        FirmwarePreparation,
        FirmwareSetupRebootPreview,
        LegacyFirmwareAnalysis,
        ManualDeploymentStepPreview,
        ManualDeploymentStepReceipt,
        MachineProfile,
        NvidiaProfileBackupReceipt,
        NvidiaSmiEvidenceReceipt,
        ProfileComparison,
        ProfileInspectorInstallation,
        ProfileInspectorLaunch,
        SaveDeploymentConfigReceipt,
} from "./contract";

/** Privileged deployment seam. Only the Session consumes this interface. */
export interface DeploymentAdapter {
        selectFirmwareImage(): Promise<string | null>;
        selectDestinationDirectory(): Promise<string | null>;
        inspectFirmwareImage(path: string): Promise<FirmwareFingerprint>;
        analyzeLegacyFirmware(path: string): Promise<LegacyFirmwareAnalysis>;
        createMachineProfile(
                request: CreateProfileRequest,
        ): Promise<DeploymentBundle>;
        listMachineProfiles(): Promise<MachineProfile[]>;
        getDeploymentPlan(profileId: string): Promise<DeploymentPlan>;
        compareMachineProfile(profileId: string): Promise<ProfileComparison>;
        prepareFirmwareArtifact(
                profileId: string,
        ): Promise<FirmwarePreparation>;
        exportDeploymentPackage(
                profileId: string,
                destinationRoot: string,
        ): Promise<DeploymentPackageReceipt>;
        previewFirmwareSetupReboot(
                profileId: string,
        ): Promise<FirmwareSetupRebootPreview>;
        rebootToFirmwareSetup(
                preview: FirmwareSetupRebootPreview,
                unsavedWorkConfirmed: boolean,
        ): Promise<{ profileId: string; accepted: boolean }>;
        previewManualDeploymentStep(
                profileId: string,
        ): Promise<ManualDeploymentStepPreview>;
        confirmManualDeploymentStep(
                preview: ManualDeploymentStepPreview,
        ): Promise<ManualDeploymentStepReceipt>;
        verifyDeploymentDriver(
                profileId: string,
        ): Promise<DriverVerificationReceipt>;
        getRecommendedDeploymentConfig(
                profileId: string,
        ): Promise<DeploymentConfigRecommendation>;
        saveDeploymentConfig(
                profileId: string,
                draft: ConfigDraft,
        ): Promise<SaveDeploymentConfigReceipt>;
        previewConfigurationReboot(
                profileId: string,
        ): Promise<ConfigurationRebootPreview>;
        rebootAfterConfiguration(
                preview: ConfigurationRebootPreview,
                unsavedWorkConfirmed: boolean,
        ): Promise<ConfigurationRebootAccepted>;
        verifyConfigurationReboot(
                profileId: string,
        ): Promise<ConfigurationRebootVerificationReceipt>;
        collectNvidiaSmiEvidence(
                profileId: string,
        ): Promise<NvidiaSmiEvidenceReceipt>;
        installNvidiaProfileInspector(): Promise<ProfileInspectorInstallation>;
        getNvidiaProfileInspectorInstallation(): Promise<ProfileInspectorInstallation | null>;
        backupNvidiaProfiles(
                profileId: string,
        ): Promise<NvidiaProfileBackupReceipt>;
        launchNvidiaProfileInspector(
                profileId: string,
        ): Promise<ProfileInspectorLaunch>;
}
