export type MatchScope = "device" | "subsystem" | "location";
export type GpuRule = {
        matchScope: MatchScope;
        deviceId: number;
        subsystemVendorId: number;
        subsystemDeviceId: number;
        bus: number;
        device: number;
        function: number;
        barSizeSelector: number | null;
        overrideBarSizeMask: boolean | null;
};
export type ConfigDraft = {
        globalMode: 0 | 1 | 2;
        targetPciBarSize: number;
        skipS3Resume: boolean;
        overrideBarSizeMask: boolean;
        guardSetupChanges: boolean;
        rules: GpuRule[];
};
export type GpuDevice = {
        id: string;
        name: string;
        vendorId: number;
        deviceId: number;
        subsystemVendorId: number;
        subsystemDeviceId: number;
        bus: number;
        device: number;
        function: number;
        bar0Base: string;
        bar0Top: string;
        currentBarSize: string;
        dedicatedVideoMemory: string;
        isTuring: boolean;
        recommendedBarSizeSelector: number | null;
        effectiveBarSizeSelector: number | null;
};
export type ApiError = { code: string; message: string; recoverable: boolean };

export type PciLocation = { bus: number; device: number; function: number };
export type GpuFingerprint = {
        vendorId: number;
        deviceId: number;
        subsystemVendorId: number;
        subsystemDeviceId: number;
        location: PciLocation;
        bridgeLocation: PciLocation;
        bar0Base: number;
        bar0Top: number;
};
export type MachineIdentity = {
        boardManufacturer: string;
        boardProduct: string;
        boardVersion: string;
        biosVendor: string;
        biosVersion: string;
        biosReleaseDate: string;
        gpus: GpuFingerprint[];
};
export type SystemSnapshot = {
        schemaVersion: number;
        platform: {
                operatingSystem: string;
                architecture: string;
                supported: boolean;
                uefi: boolean;
                elevated: boolean;
        };
        firmware: {
                accessible: boolean;
                privilegeEnabled: boolean;
                configVariablePresent: boolean | null;
                accessError: ApiError | null;
        };
        driverStatus: {
                raw: string;
                code: number;
                kind: string;
                label: string;
                severity: string;
                pciLocation: string | null;
        } | null;
        config: {
                draft: ConfigDraft;
                rawSize: number;
                setupFingerprintPresent: boolean;
                setupCrc: string;
        } | null;
        devices: GpuDevice[];
        machineIdentity: MachineIdentity | null;
        notices: { kind: string; message: string }[];
};
export type ValidationReport = {
        valid: boolean;
        errors: string[];
        warnings: string[];
        changed: boolean;
        variableWillExist: boolean;
        encodedSize: number;
        affectedGpuIds: string[];
        rebootRequired: boolean;
};
export type SaveReceipt = {
        savedAtUnixMs: string;
        bytesWritten: number;
        variablePresent: boolean;
        rebootRequired: boolean;
        draft: ConfigDraft;
};

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
export type LegacyPatchProfile = {
        upstreamCommit: string;
        catalogs: { catalog: LegacyPatchCatalogFile; sourceSha256: string }[];
        selections: {
                catalog: LegacyPatchCatalogFile;
                ruleId: string;
                expectedMatches: number;
                requiredRisks: LegacyPatchRisk[];
        }[];
        acknowledgements: { risk: LegacyPatchRisk; note: string }[];
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

export const DEFAULT_DRAFT: ConfigDraft = {
        globalMode: 0,
        targetPciBarSize: 0,
        skipS3Resume: false,
        overrideBarSizeMask: false,
        guardSetupChanges: true,
        rules: [],
};
