export type PciSlot = { segment: number; bus: number; device: number; function: number };
export type ExternalMedium = { kind: "usb"; root: string } | { kind: "esp" };
export type ExternalStage = "diagnostic" | "loader";
export type PlanErrorCode =
        | "invalidReport" | "incompleteReport" | "noTarget" | "unsupportedGpu" | "activeDriver" | "consoleInUse"
        | "invalidBar" | "invalidSize" | "noRoot" | "ambiguousTopology" | "noAddressSpace" | "invalidHandoff"
        | "staleSnapshot" | "invalidPlan";
export type ExternalReceipt = { target: string | null; sizeBytes: number | null; bar1Base: string; measuredBytes: number };
export type ExternalPlanSummary = { target: PciSlot; sizeBytes: number; destinationStart: string; successorSha256: string };
export type ExternalMediumState = {
        stage: ExternalStage | null;
        stageWrittenUnixMs: number | null;
        /** Windows started after the stage was written. */
        restartedSinceStage: boolean;
        report: boolean;
        plan: ExternalPlanSummary | null;
        /** The newest loader receipt; the app deletes receipts when it writes a stage. */
        receipt: ExternalReceipt | null;
        lastError: string | null;
};
export type ExternalUsbDrive = {
        root: string;
        label: string;
        fileSystem: string;
        totalBytes: number;
        usable: boolean;
        problem: "notFat" | "foreignBootFile" | null;
        /** Null until the app writes to this drive. */
        state: ExternalMediumState | null;
};
export type ExternalInstallState = ExternalMediumState & {
        diagnosticEntry: boolean;
        loaderEntry: boolean;
        /** The loader runs on every start. */
        loaderFirst: boolean;
        nextScheduled: ExternalStage | null;
        /** Windows Boot Manager changed after the plan pinned it; the loader refuses it until the plan is written again. */
        successorChanged: boolean;
};
export type ExternalSigning = { imagesSigned: boolean; certificateEnrolled: boolean | null };
export type ExternalBootStatus = {
        uefi: boolean;
        elevated: boolean;
        secureBoot: boolean | null;
        signing: ExternalSigning;
        bitLocker: "off" | "on" | "unknown";
        esp: { found: true; successorSha256: string } | { found: false; reason: "noWindowsBootManager" | "volumeNotFound" | "unreadable" | "notElevated" };
        /** Null when nothing of ours is on the ESP. */
        install: ExternalInstallState | null;
        usbDrives: ExternalUsbDrive[];
        bootTimeUnixMs: number;
};
export type ExternalCandidate = {
        slot: PciSlot;
        /** Windows' name for the GPU at that location, when Windows knows it. */
        name: string | null;
        product: number;
        currentBar1Bytes: number;
        /** The size the built-in list recommends for this model, when it has one. */
        recommendedBytes: number | null;
        refusal: PlanErrorCode | null;
        sizes: { bytes: number; error: PlanErrorCode | null }[];
};
export type ExternalReport = {
        environment: "physical" | "qemuModel";
        firmware: string;
        secureBoot: boolean | null;
        complete: boolean;
        errors: string[];
        candidates: ExternalCandidate[];
};
export interface ExternalBootBridge {
        inspect(): Promise<ExternalBootStatus>;
        prepareDiagnostic(medium: ExternalMedium): Promise<ExternalBootStatus>;
        readReport(medium: ExternalMedium): Promise<ExternalReport>;
        writeLoader(medium: ExternalMedium, target: PciSlot, sizeBytes: number): Promise<ExternalBootStatus>;
        makePermanent(): Promise<ExternalBootStatus>;
        remove(medium: ExternalMedium): Promise<ExternalBootStatus>;
        saveCertificate(root: string): Promise<ExternalBootStatus>;
        restart(suspendBitLocker: boolean, firmwareSetup?: boolean): Promise<void>;
}
