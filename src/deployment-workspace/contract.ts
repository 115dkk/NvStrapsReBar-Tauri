import type {
        ConfigDraft,
        MachineIdentity,
        SaveReceipt,
        SystemSnapshot,
} from "../types";

export type FirmwareFingerprint = {
        fileName: string;
        byteLength: number;
        sha256: string;
};
export type BoardPath = "nativeResizableBar" | "legacyAbove4g";
export type RecoveryMethod =
        | "dualBios"
        | "usbFlashback"
        | "vendorRecovery"
        | "externalSpiProgrammer"
        | "none";
export type FirmwareInstallMethod =
        | "firmwareSetupUtility"
        | "usbFlashback"
        | "vendorWindowsUtility"
        | "externalSpiProgrammer";
export type RecoveryCapability = {
        method: RecoveryMethod;
        testedOrDocumented: boolean;
        note: string;
};
export type FirmwareInstallRoute = {
        method: FirmwareInstallMethod;
        artifactFileName: string;
        testedOrDocumented: boolean;
        officialInstructionsUrl: string;
        note: string;
};
export type LegacyPatchRisk =
        | "dsdtModification"
        | "nvramWhitelist"
        | "usbControllerBlacklist"
        | "experimentalX79";
export type LegacyPatchCatalogFile =
        | "general"
        | "haswellAbove4g"
        | "ivyBridgeUsb3"
        | "haswellUsb3"
        | "broadwellUsb3";
export type LegacyPatchRuleView = {
        ruleId: string;
        description: string | null;
        sectionType: number;
        requiredRisks: LegacyPatchRisk[];
};
export type LegacyPatchCatalogView = {
        catalog: LegacyPatchCatalogFile;
        upstreamCommit: string;
        sourceSha256: string;
        rules: LegacyPatchRuleView[];
};
export type LegacyFirmwareRuleStatus = "applicable" | "absent" | "blocked";
export type LegacyFirmwareRuleAnalysis = {
        ruleId: string;
        description: string | null;
        sectionType: number;
        requiredRisks: LegacyPatchRisk[];
        status: LegacyFirmwareRuleStatus;
        expectedMatches: number | null;
        blockedReason: string | null;
        recommended: boolean;
};
export type LegacyFirmwareCatalogAnalysis = {
        catalog: LegacyPatchCatalogFile;
        sourceSha256: string;
        rules: LegacyFirmwareRuleAnalysis[];
};
export type LegacyFirmwareAnalysis = {
        firmware: FirmwareFingerprint;
        upstreamCommit: string;
        catalogs: LegacyFirmwareCatalogAnalysis[];
};
export type LegacyRiskAcknowledgement = { risk: LegacyPatchRisk; note: string };
export type LegacyPatchProfile = {
        upstreamCommit: string;
        catalogs: { catalog: LegacyPatchCatalogFile; sourceSha256: string }[];
        selections: {
                catalog: LegacyPatchCatalogFile;
                ruleId: string;
                expectedMatches: number;
                requiredRisks: LegacyPatchRisk[];
        }[];
        acknowledgements: LegacyRiskAcknowledgement[];
};
export type CreateProfileRequest = {
        displayName: string;
        boardPath: BoardPath;
        firmwarePath: string;
        expectedFirmware: FirmwareFingerprint;
        recovery: RecoveryCapability;
        firmwareInstall: FirmwareInstallRoute;
        legacyPatches?: LegacyPatchProfile;
};
export type MachineProfile = {
        schemaVersion: number;
        profileId: string;
        displayName: string;
        boardPath: BoardPath;
        legacyPatches: LegacyPatchProfile | null;
        identity: MachineIdentity;
        originalFirmware: FirmwareFingerprint;
        recovery: RecoveryCapability;
        firmwareInstall: FirmwareInstallRoute | null;
};
export type StepId =
        | "verifyProfile"
        | "confirmRecovery"
        | "preserveOriginalFirmware"
        | "prepareRustDriver"
        | "applyLegacyBoardPatches"
        | "verifyPatchedArtifact"
        | "flashWithVendorRoute"
        | "configureFirmwareSetup"
        | "rebootAfterFirmware"
        | "verifyDriverLoaded"
        | "writeNvstrapsConfiguration"
        | "rebootAfterConfiguration"
        | "verifyResizableBar"
        | "configureNvidiaApplications";
export type DeploymentStep = {
        id: StepId;
        kind:
                | "automated"
                | "externalTool"
                | "firmwareManual"
                | "reboot"
                | "physicalConfirmation";
        title: string;
        state: "ready" | "pending" | "completed";
        evidence: { kind: string; value: string } | null;
};
export type DeploymentPlan = {
        schemaVersion: number;
        profileId: string;
        originalFirmwareSha256: string;
        recoveryMethod: RecoveryMethod;
        revision: number;
        steps: DeploymentStep[];
};
export type DriverStatus = NonNullable<SystemSnapshot["driverStatus"]>;
export type ManualDeploymentStepPreview = {
        profileId: string;
        planRevision: number;
        stepId: StepId;
        title: string;
        confirmationToken: string;
        warnings: string[];
};
export type ManualDeploymentStepReceipt = {
        plan: DeploymentPlan;
        stepId: StepId;
        recordedAtUnixMs: string;
};
export type DriverVerificationReceipt = {
        plan: DeploymentPlan;
        status: DriverStatus;
};
export type SaveDeploymentConfigReceipt = {
        plan: DeploymentPlan;
        save: SaveReceipt;
};
export type DeploymentConfigRecommendation = {
        draft: ConfigDraft;
        turingGpuCount: number;
        registryManagedGpuCount: number;
        exactFallbackRuleCount: number;
};
export type ConfigurationRebootPreview = {
        profileId: string;
        planRevision: number;
        confirmationToken: string;
        command: string;
        arguments: string[];
        immediate: boolean;
        forceCloseApplications: boolean;
        warnings: string[];
};
export type ConfigurationRebootAccepted = {
        profileId: string;
        accepted: boolean;
        planAdvanced: boolean;
};
export type ConfigurationRebootVerificationReceipt = {
        plan: DeploymentPlan;
        configurationSavedAtUnixMs: string;
        bootedAtUnixMs: string;
};
export type DeploymentBundle = {
        profile: MachineProfile;
        plan: DeploymentPlan;
        originalFirmwarePath: string;
};
export type ProfileComparison = {
        profile: MachineProfile;
        currentIdentity: MachineIdentity;
        firmware: FirmwareFingerprint | null;
        result: { differences: ({ kind: string } & Record<string, unknown>)[] };
};
export type StoredArtifact = {
        kind: string;
        path: string;
        byteLength: number;
        sha256: string;
};
export type FirmwarePreparation = {
        plan: DeploymentPlan;
        driver: StoredArtifact;
        legacyPatchedFirmware: StoredArtifact | null;
        legacyPatchReceipt: StoredArtifact | null;
        legacyPatch: unknown | null;
        patchedFirmware: StoredArtifact | null;
        injection: {
                firmwareVolumeOffset: number;
                fileOffset: number;
                replacedPadFile: boolean;
                erasePolarity: boolean;
                encapsulatedVolumeImage: boolean;
                recompressedGuidedSection: boolean;
        } | null;
};
export type DeploymentPackageReceipt = {
        packagePath: string;
        manifest: {
                profileId: string;
                files: {
                        relativePath: string;
                        purpose: string;
                        byteLength: number;
                        sha256: string;
                }[];
                manualGates: string[];
        };
        manifestSha256: string;
        checksumsSha256: string;
};
export type FirmwareSetupRebootPreview = {
        profileId: string;
        activeStep: StepId;
        confirmationToken: string;
        command: string;
        arguments: string[];
        immediate: boolean;
        forceCloseApplications: boolean;
        warnings: string[];
};
export type NvidiaSmiEvidence = {
        profileId: string;
        toolPath: string;
        tool: FirmwareFingerprint;
        rawXmlSha256: string;
        driverVersion: string;
        capturedAt: string;
        gpus: {
                pciBusId: string;
                productName: string;
                bus: number;
                device: number;
                function: number;
                framebufferTotalBytes: string | null;
                bar1TotalBytes: string | null;
                bar1UsedBytes: string | null;
                bar1FreeBytes: string | null;
                matchedProfileGpu: boolean;
                matchesWindowsBarSize: boolean | null;
        }[];
        allProfileGpusObserved: boolean;
        warnings: string[];
};
export type NvidiaSmiEvidenceReceipt = {
        plan: DeploymentPlan;
        evidence: NvidiaSmiEvidence;
};
export type ProfileInspectorInstallation = {
        installPath: string;
        executablePath: string;
        manifest: {
                version: string;
                sourceCommit: string;
                releaseUrl: string;
                assetSha256: string;
        };
        manifestSha256: string;
        installedNow: boolean;
};
export type NvidiaProfileBackupReceipt = {
        backupPath: string;
        manifestPath: string;
        manifest: {
                profileId: string;
                toolVersion: string;
                nipSha256: string;
                nipByteLength: number;
                profileCount: number;
                executableCount: number;
                settingCount: number;
        };
        manifestSha256: string;
};
export type ProfileInspectorLaunch = {
        profileId: string;
        processId: number;
        executablePath: string;
        executableSha256: string;
        elevated: boolean;
        backup: NvidiaProfileBackupReceipt;
        warnings: string[];
};
