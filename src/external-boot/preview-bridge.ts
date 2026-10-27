import { PREVIEW_REBAR_STATE_KEY } from "../bridge";
import type { ExternalBootBridge, ExternalBootStatus, ExternalMedium, ExternalMediumState, ExternalReport, ExternalStage } from "./contract";
import { activeRoute, formatSlot, secureBootReady } from "./model";

/** Select a machine before loading the browser preview. */
export const PREVIEW_EXTERNAL_STATE_KEY = "nvstraps-preview-external-state";
export type PreviewExternalState = "ready" | "secureBoot" | "enrollCertificate" | "bitLocker" | "consoleGpu" | "noUsb" | "loaderFails";

const previewState = (): PreviewExternalState => {
        try {
                const value = localStorage.getItem(PREVIEW_EXTERNAL_STATE_KEY);
                if (value === "secureBoot" || value === "enrollCertificate" || value === "bitLocker" || value === "consoleGpu" || value === "noUsb" || value === "loaderFails") return value;
        } catch {
                // Storage can be unavailable; the fixture stays ready.
        }
        return "ready";
};

const scenario = previewState();
const GiB = 1024 ** 3;
const successorSha256 = "a1".repeat(32);
let clock = Date.now();
const machine: ExternalBootStatus = {
        uefi: true,
        elevated: true,
        secureBoot: scenario === "secureBoot" || scenario === "enrollCertificate",
        signing: { imagesSigned: scenario === "enrollCertificate", certificateEnrolled: scenario === "enrollCertificate" ? false : null },
        bitLocker: scenario === "bitLocker" ? "on" : "off",
        esp: { found: true, successorSha256 },
        install: null,
        usbDrives: scenario === "noUsb" ? [] : [
                { root: "E:\\", label: "NVSTRAPS", fileSystem: "FAT32", totalBytes: 32 * GiB, usable: true, problem: null, state: null },
                { root: "F:\\", label: "DATA", fileSystem: "NTFS", totalBytes: 64 * GiB, usable: false, problem: "notFat", state: null },
        ],
        bootTimeUnixMs: clock,
};
const reports = new Map<string, ExternalReport>();
const mediumKey = (medium: ExternalMedium) => medium.kind === "esp" ? "esp" : medium.root;
const failure = (code: string, message: string) => ({ code, message, recoverable: true });
const inspect = () => structuredClone(machine);
const tick = () => (clock = Math.max(Date.now(), clock + 1));

const usbDrive = (root: string) => {
        const drive = machine.usbDrives.find((drive) => drive.root === root);
        if (!drive) throw failure("externalMediumUnavailable", "The USB drive is unavailable");
        return drive;
};

const mediumState = (medium: ExternalMedium): ExternalMediumState | null => {
        if (medium.kind === "usb") return usbDrive(medium.root).state;
        if (!machine.esp.found) throw failure("externalNoEsp", "Windows Boot Manager is unavailable");
        return machine.install;
};

const writable = (medium: ExternalMedium) => {
        if (machine.secureBoot === true && !secureBootReady(machine)) throw failure("externalSecureBootOn", "Secure Boot is on");
        mediumState(medium);
        if (medium.kind === "usb") {
                const drive = usbDrive(medium.root);
                if (drive.problem === "foreignBootFile") throw failure("externalForeignBootFile", "The USB boot file belongs to another program");
                if (!drive.usable) throw failure("externalNotFat", "The USB drive is not FAT32 or FAT");
        }
};

const setStage = (medium: ExternalMedium, state: ExternalMediumState, stage: ExternalStage) => {
        if (medium.kind === "usb") usbDrive(medium.root).state = state;
        else machine.install = {
                ...state,
                diagnosticEntry: stage === "diagnostic" || (machine.install?.diagnosticEntry ?? false),
                loaderEntry: stage === "loader" || (machine.install?.loaderEntry ?? false),
                loaderFirst: machine.install?.loaderFirst ?? false,
                nextScheduled: stage,
                successorChanged: false,
        };
};

const diagnosticReport = (): ExternalReport => ({
        environment: "physical",
        firmware: "American Megatrends International, LLC. 1.N0",
        secureBoot: machine.secureBoot,
        complete: true,
        errors: [],
        candidates: [{
                slot: { segment: 0, bus: 1, device: 0, function: 0 },
                name: "NVIDIA GeForce RTX 2080 SUPER",
                product: 0x1e81,
                currentBar1Bytes: 256 * 1024 ** 2,
                recommendedBytes: 8 * GiB,
                refusal: scenario === "consoleGpu" ? "consoleInUse" : null,
                sizes: [0.5, 1, 2, 4, 8, 16, 32].map((gib) => ({
                        bytes: gib * GiB,
                        error: scenario === "consoleGpu" ? "consoleInUse" : gib >= 16 ? "noAddressSpace" : null,
                })),
        }],
});

const readReport = (medium: ExternalMedium): ExternalReport => {
        const state = mediumState(medium);
        const report = reports.get(mediumKey(medium));
        if (!state?.report || !report) throw failure("externalNoReport", "No diagnostic report is present");
        return structuredClone(report);
};

export const previewExternalBootBridge: ExternalBootBridge = {
        inspect: async () => inspect(),
        prepareDiagnostic: async (medium) => {
                writable(medium);
                reports.delete(mediumKey(medium));
                setStage(medium, {
                        stage: "diagnostic",
                        stageWrittenUnixMs: tick(),
                        restartedSinceStage: false,
                        report: false,
                        plan: null,
                        receipt: null,
                        lastError: null,
                }, "diagnostic");
                return inspect();
        },
        readReport: async (medium) => readReport(medium),
        writeLoader: async (medium, target, sizeBytes) => {
                writable(medium);
                const report = readReport(medium);
                if (report.environment !== "physical") throw failure("externalNotPhysical", "The report is not from a physical machine");
                const candidate = report.candidates.find((candidate) => formatSlot(candidate.slot) === formatSlot(target));
                if (!candidate) throw failure("externalPlan", "noTarget");
                const size = candidate.sizes.find((size) => size.bytes === sizeBytes);
                if (candidate.refusal || !size || size.error) throw failure("externalPlan", candidate.refusal ?? size?.error ?? "invalidSize");
                setStage(medium, {
                        stage: "loader",
                        stageWrittenUnixMs: tick(),
                        restartedSinceStage: false,
                        report: true,
                        plan: { target: { ...target }, sizeBytes, destinationStart: "0x2000000000", successorSha256 },
                        receipt: null,
                        lastError: null,
                }, "loader");
                return inspect();
        },
        makePermanent: async () => {
                const install = machine.install;
                if (install?.stage !== "loader" || !install.receipt) throw failure("externalNoReceipt", "No successful installed loader trial is present");
                install.loaderFirst = true;
                install.diagnosticEntry = false;
                return inspect();
        },
        remove: async (medium) => {
                mediumState(medium);
                reports.delete(mediumKey(medium));
                if (medium.kind === "usb") usbDrive(medium.root).state = null;
                else machine.install = null;
                return inspect();
        },
        saveCertificate: async (root) => {
                const drive = usbDrive(root);
                if (drive.fileSystem !== "FAT32" && drive.fileSystem !== "FAT") throw failure("externalNotFat", "The USB drive is not FAT32 or FAT");
                return inspect();
        },
        restart: async (suspendBitLocker, firmwareSetup = false) => {
                if (machine.bitLocker === "on" && !suspendBitLocker) {
                        throw failure("externalBitLockerSuspensionRequired", "BitLocker must be suspended for this restart");
                }
                machine.bootTimeUnixMs = tick();
                const active = activeRoute(machine);
                // All media observe a Windows restart; only the active route is booted.
                for (const state of [machine.install, ...machine.usbDrives.map((drive) => drive.state)]) {
                        if (state?.stageWrittenUnixMs != null) state.restartedSinceStage = machine.bootTimeUnixMs > state.stageWrittenUnixMs;
                }
                if (firmwareSetup) {
                        // The preview user appends the certificate in BIOS setup instead of running a stage.
                        machine.signing.certificateEnrolled = true;
                        return;
                }
                if (machine.install) machine.install.nextScheduled = null;
                if (!active) return;
                if (active.state.stage === "diagnostic") {
                        reports.set(mediumKey(active.medium), diagnosticReport());
                        active.state.report = true;
                        active.state.lastError = null;
                } else if (active.state.plan) {
                        if (scenario === "loaderFails") {
                                active.state.receipt = null;
                                active.state.lastError = "pinned successor missing or changed";
                        } else {
                                const plan = active.state.plan;
                                active.state.receipt = {
                                        target: formatSlot(plan.target),
                                        sizeBytes: plan.sizeBytes,
                                        bar1Base: plan.destinationStart,
                                        measuredBytes: plan.sizeBytes,
                                };
                                active.state.lastError = null;
                                // The preview system snapshot then reports the wider BAR, as Windows would.
                                try {
                                        sessionStorage.setItem(PREVIEW_REBAR_STATE_KEY, "expanded");
                                } catch {
                                        // Without storage the preview keeps showing the old size.
                                }
                        }
                }
        },
};
