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

export type SettingsSnapshotExportReceipt = {
        path: string;
        bytesWritten: number;
};
export type SettingsSnapshotInspection = {
        draft: ConfigDraft;
        savedAtUnixMs: number;
        validation: ValidationReport;
};

export type CurrentBootDxeState =
        | "observedThisBoot"
        | "notObservedThisBoot"
        | "indeterminate";
export type CurrentBootDxeReasonCode =
        | "currentBootStatusObserved"
        | "statusVariableMissing"
        | "statusVariableMalformed"
        | "statusVariableUnavailable"
        | "statusValueUnrecognized";
export type BarSettingsStatus = {
        currentBootDxeState: CurrentBootDxeState;
        currentBootDxeReasonCode: CurrentBootDxeReasonCode;
        controlEvidence:
                | "currentBootDxe"
                | "expandedTuringAperture"
                | "notObserved"
                | "indeterminate";
        settingsAvailable: boolean;
        savedConfigurationState: "enabled" | "disabled" | "invalid" | "unreadable";
        topologyToken: string;
        configToken: string | null;
};

export type ResizableBarApertureState =
        | "expanded"
        | "legacy256MiB"
        | "indeterminate";
export type ResizableBarInspectionState =
        | ResizableBarApertureState
        | "mixed";
export type ResizableBarPatchConfiguration = {
        state: "notNeeded" | "available" | "unavailable" | "indeterminate";
        reasonCode:
                | "alreadyExpanded"
                | "automaticTargetAvailable"
                | "registryExcluded"
                | "unusableBar0"
                | "apertureIndeterminate";
        targetSelector: number | null;
        targetSizeBytes: string | null;
};
export type ResizableBarInspection = {
        driverVersion: string;
        capturedAt: string;
        state: ResizableBarInspectionState;
        gpus: {
                pciBusId: string;
                productName: string;
                bar1TotalBytes: string | null;
                windowsBarSizeBytes: string;
                state: ResizableBarApertureState;
                reason: string;
                patchConfiguration: ResizableBarPatchConfiguration;
        }[];
        warnings: string[];
};

export type HardwareSupportState = "supported" | "unsupported" | "unknown";
export type HardwareSupportAssessment = {
        motherboardNativeResizableBar: {
                state: HardwareSupportState;
                reasonCode:
                        | "exactMotherboardCatalogMatch"
                        | "motherboardNotInCatalog"
                        | "machineIdentityUnavailable";
                catalogId: string | null;
        };
        targetGpuFamily: {
                state: HardwareSupportState;
                reasonCode:
                        | "allDetectedGpusTuring"
                        | "detectedGpuOutsideTuringFamily"
                        | "mixedTuringAndNonTuringGpus"
                        | "noGpusDetected";
        };
        overallState: HardwareSupportState;
};

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
        barSettings: BarSettingsStatus;
        config: {
                draft: ConfigDraft;
                rawSize: number;
                setupFingerprintPresent: boolean;
                setupCrc: string;
        } | null;
        devices: GpuDevice[];
        machineIdentity: MachineIdentity | null;
        hardwareSupport: HardwareSupportAssessment;
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
export type SaveBarSettingsRequest = {
        draft: ConfigDraft;
        expectedTopologyToken: string;
        expectedConfigToken: string;
};
export type SaveBarSettingsReceipt = {
        save: SaveReceipt;
        topologyToken: string;
        configToken: string;
};

export const DEFAULT_DRAFT: ConfigDraft = {
        globalMode: 0,
        targetPciBarSize: 0,
        skipS3Resume: false,
        overrideBarSizeMask: false,
        guardSetupChanges: true,
        rules: [],
};
