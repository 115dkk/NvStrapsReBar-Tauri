import type { StaticMessageId } from "../i18n-catalog";
import type { LegacyPatchRisk, StepId } from "./contract";
import type { DeploymentStep } from "./contract";

export const stepTitleIds: Record<StepId, StaticMessageId> = {
        verifyProfile: "ui.compareCurrentHardwareBiosTopologyAndSourceImage",
        confirmRecovery: "ui.recordTheFirmwareRecoveryRoute",
        preserveOriginalFirmware: "ui.preserveAndHashTheSourceFirmwareImage",
        prepareRustDriver: "ui.buildAndInspectTheRustDxeDriver",
        applyLegacyBoardPatches: "ui.applyTheProfileSLegacyBoardPatchBundle",
        verifyPatchedArtifact: "ui.injectTheDriverAndInspectTheFirmwareArtifact",
        flashWithVendorRoute: "ui.flashWithTheDocumentedVendorRoute",
        configureFirmwareSetup: "ui.confirmFirmwareSetupValues",
        rebootAfterFirmware: "ui.bootWindowsAfterTheFirmwareHandoff",
        verifyDriverLoaded: "ui.readTheFirmwareDriverStatus",
        writeNvstrapsConfiguration:
                "ui.writeAndReadBackTheNvstrapsrebarConfiguration",
        rebootAfterConfiguration: "ui.restartAfterConfiguration",
        verifyResizableBar: "ui.observeResizableBarThroughNvidiaTelemetry",
        configureNvidiaApplications: "ui.configureNvidiaApplicationProfiles",
};

export const catalogLabelIds = {
        general: "ui.general",
        haswellAbove4g: "ui.haswellAbove4g",
        ivyBridgeUsb3: "ui.ivyBridgeUsb3",
        haswellUsb3: "ui.haswellUsb3",
        broadwellUsb3: "ui.broadwellUsb3",
} as const satisfies Record<string, StaticMessageId>;

export const riskLabelIds: Record<LegacyPatchRisk, StaticMessageId> = {
        dsdtModification: "ui.dsdtModification",
        nvramWhitelist: "ui.nvramWhitelistChange",
        usbControllerBlacklist: "ui.usbControllerBlacklist",
        experimentalX79: "ui.experimentalX79Patch",
};

export const stepStateIds: Record<DeploymentStep["state"], StaticMessageId> = {
        completed: "ui.completed",
        ready: "ui.ready",
        pending: "ui.pending",
};

export const stepKindIds: Record<DeploymentStep["kind"], StaticMessageId> = {
        automated: "ui.automated",
        physicalConfirmation: "ui.physicalConfirmation",
        firmwareManual: "ui.manualFirmwareGate",
        externalTool: "ui.externalTool",
        reboot: "ui.restartGate",
};

export const manualWarningIds = (
        stepId: StepId,
        legacyBoard: boolean,
): StaticMessageId[] => {
        if (stepId === "flashWithVendorRoute")
                return [
                        "ui.selectTheExportedArtifactInTheDocumentedVendorTool",
                        "ui.recordCompletionAfterTheVendorToolReportsSuccess",
                        "ui.keepPowerConnectedDuringFlashingAndKeepTheRecoveryFilesNearby",
                ];
        if (stepId === "configureFirmwareSetup")
                return [
                        legacyBoard
                                ? "ui.enableAbove4gDecodingAndDisableCsmThisLegacyRouteUsesNvstrapsrebarInsteadOfNativeMotherboardRebar"
                                : "ui.enableNativeRebarAndAbove4gDecodingAndDisableCsm",
                        "ui.saveTheseFirmwareSetupValuesThenReturnToRecordTheStep",
                ];
        if (stepId === "configureNvidiaApplications")
                return [
                        "ui.applyAndReviewTheIntendedPerApplicationRebarPolicy",
                        "ui.returnAfterEditingThePolicyAndRecordTheResult",
                ];
        return [];
};

export const firmwareRebootWarningIds: StaticMessageId[] = [
        "ui.saveAndCloseBeforeRestart",
        "ui.windowsOpensTheFirmwareSetupScreenContinueThereWithTheVendorInstructions",
];

export const configurationRebootWarningIds: StaticMessageId[] = [
        "ui.saveAndCloseBeforeRestart",
        "ui.windowsRestartsWithStandardShutdown",
        "ui.returnAfterWindowsBootsSoTheAppCanCompareTheNewBootTime",
];

const legacyRuleDescriptionIds: Record<string, StaticMessageId> = {
        ["4b".repeat(32)]: "ui.above4gDecodingCompatibilityRule",
        ["5c".repeat(32)]: "ui.dsdtResourceWindowCompatibilityPatch",
        ["6d".repeat(32)]: "ui.alreadyAbsentCompatibilityPattern",
        ["7e".repeat(32)]: "ui.compressedVendorSpecificCompatibilityPatch",
};

export const legacyRuleDescriptionId = (ruleId: string): StaticMessageId =>
        legacyRuleDescriptionIds[ruleId] ?? "ui.compatibilityRule";

export const legacyRuleBlockedReasonId = (
        ruleId: string,
): StaticMessageId =>
        ruleId === "7e".repeat(32)
                ? "ui.thisBuildDoesNotSupportTheCompressedSection"
                : "ui.theAnalyzerFoundNoSupportedMatch";
