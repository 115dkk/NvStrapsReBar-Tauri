import { describe, expect, it } from "vitest";
import type { ExternalBootStatus, ExternalCandidate, ExternalInstallState, ExternalMediumState, ExternalReport, ExternalUsbDrive } from "./contract";
import { activeRoute, blockReasons, bootMenuKey, defaultSize, externalError, externalScreen, formatSlot, secureBootReady, usableCandidates } from "./model";

const state = (changes: Partial<ExternalMediumState> = {}): ExternalMediumState => ({
        stage: "diagnostic", stageWrittenUnixMs: 100, restartedSinceStage: false,
        report: false, plan: null, receipt: null, lastError: null, ...changes,
});
const install = (changes: Partial<ExternalInstallState> = {}): ExternalInstallState => ({
        ...state(), diagnosticEntry: true, loaderEntry: false, loaderFirst: false,
        nextScheduled: "diagnostic", successorChanged: false, ...changes,
});
const usb = (root: string, mediumState: ExternalMediumState | null): ExternalUsbDrive => ({
        root, label: "NVSTRAPS", fileSystem: "FAT32", totalBytes: 32 * 1024 ** 3, usable: true, problem: null, state: mediumState,
});
const status = (changes: Partial<ExternalBootStatus> = {}): ExternalBootStatus => ({
        uefi: true, elevated: true, secureBoot: false, bitLocker: "off", esp: { found: true, successorSha256: "a1".repeat(32) },
        signing: { imagesSigned: false, certificateEnrolled: null },
        install: null, usbDrives: [], bootTimeUnixMs: 50, ...changes,
});
const receipt = { target: "0000:01:00.0", sizeBytes: 8 * 1024 ** 3, bar1Base: "0x2000000000", measuredBytes: 8 * 1024 ** 3 };

describe("external active route", () => {
        it("returns null without a written stage, including empty owned media", () => {
                expect(activeRoute(status())).toBeNull();
                expect(activeRoute(status({ install: install({ stage: null }), usbDrives: [usb("E:\\", null), usb("F:\\", state({ stage: null }))] }))).toBeNull();
        });

        it("prefers an installed stage over USB stages", () => {
                const installed = install();
                expect(activeRoute(status({ install: installed, usbDrives: [usb("E:\\", state())] }))).toEqual({ mode: "install", medium: { kind: "esp" }, state: installed });
        });

        it("uses the first USB with a stage, skipping an unwritten ESP and USB drives", () => {
                const written = state({ stage: "loader" });
                expect(activeRoute(status({ install: install({ stage: null }), usbDrives: [usb("D:\\", null), usb("E:\\", written), usb("F:\\", state())] })))
                        .toEqual({ mode: "experiment", medium: { kind: "usb", root: "E:\\" }, state: written });
        });
});

describe("external screen", () => {
        it("distinguishes initial loading and a failed inspect", () => {
                expect(externalScreen(null, false)).toBe("loading");
                expect(externalScreen(null, true)).toBe("failed");
                expect(externalScreen(status(), true)).toBe("choose");
        });

        it.each([{ uefi: false }, { elevated: false }])("blocks unavailable platform access even for an installed route: %j", (changes) => {
                expect(externalScreen(status({ ...changes, install: install({ loaderFirst: true }) }), false)).toBe("blocked");
        });

        it("blocks new routes for Secure Boot or a missing ESP", () => {
                expect(externalScreen(status({ secureBoot: true }), false)).toBe("blocked");
                expect(externalScreen(status({ esp: { found: false, reason: "volumeNotFound" } }), false)).toBe("blocked");
                expect(externalScreen(status(), false)).toBe("choose");
                expect(externalScreen(status({ secureBoot: null }), false)).toBe("choose");
        });

        it.each([false, true])("keeps existing routes accessible when Secure Boot is on or the ESP is unavailable (signed: %s)", (imagesSigned) => {
                expect(externalScreen(status({ secureBoot: true, signing: { imagesSigned, certificateEnrolled: false }, esp: { found: false, reason: "unreadable" }, usbDrives: [usb("E:\\", state())] }), false)).toBe("diagnosticReady");
        });

        it.each([false, null])("blocks signed new routes until certificate enrolment is confirmed: %s", (certificateEnrolled) => {
                expect(externalScreen(status({ secureBoot: true, signing: { imagesSigned: true, certificateEnrolled } }), false)).toBe("blocked");
        });

        it("allows signed new routes with an enrolled certificate and Secure Boot on", () => {
                expect(externalScreen(status({ secureBoot: true, signing: { imagesSigned: true, certificateEnrolled: true } }), false)).toBe("choose");
        });

        it("shows installed before considering trial evidence", () => {
                expect(externalScreen(status({ install: install({ stage: "loader", loaderFirst: true, restartedSinceStage: true, receipt, successorChanged: true }) }), false)).toBe("installed");
                expect(externalScreen(status({ install: install({ loaderFirst: true }) }), false)).toBe("installed");
        });

        it.each([
                [state(), "diagnosticReady"],
                [state({ restartedSinceStage: true }), "diagnosticMissing"],
                [state({ report: true }), "pickGpu"],
                [state({ report: true, restartedSinceStage: true }), "pickGpu"],
                [state({ stage: "loader" }), "loaderReady"],
                [state({ stage: "loader", restartedSinceStage: true }), "loaderMissing"],
                [state({ stage: "loader", receipt }), "result"],
                [state({ stage: "loader", receipt, restartedSinceStage: true }), "result"],
        ] as const)("derives %j as %s for both media", (mediumState, expected) => {
                expect(externalScreen(status({ usbDrives: [usb("E:\\", mediumState)] }), false)).toBe(expected);
                expect(externalScreen(status({ install: install(mediumState) }), false)).toBe(expected);
        });
});

describe("external helpers", () => {
        it("lists every blocker in a stable order and does not treat unknown Secure Boot as on", () => {
                expect(blockReasons(status())).toEqual([]);
                expect(blockReasons(status({ secureBoot: null }))).toEqual([]);
                expect(blockReasons(status({ uefi: false, elevated: false, secureBoot: true, esp: { found: false, reason: "notElevated" } })))
                        .toEqual(["uefi", "admin", "secureBoot", "noEsp"]);
        });

        it.each([false, null])("asks to enrol signed images when certificate enrolment is %s", (certificateEnrolled) => {
                expect(blockReasons(status({ secureBoot: true, signing: { imagesSigned: true, certificateEnrolled } }))).toEqual(["enrollCertificate"]);
                expect(blockReasons(status({ uefi: false, elevated: false, secureBoot: true, signing: { imagesSigned: true, certificateEnrolled }, esp: { found: false, reason: "notElevated" } })))
                        .toEqual(["uefi", "admin", "enrollCertificate", "noEsp"]);
        });

        it("requires signed images even when the certificate is enrolled", () => {
                expect(blockReasons(status({ secureBoot: true, signing: { imagesSigned: false, certificateEnrolled: true } }))).toEqual(["secureBoot"]);
        });

        it("has no Secure Boot blocker once the signed images are trusted", () => {
                expect(blockReasons(status({ secureBoot: true, signing: { imagesSigned: true, certificateEnrolled: true } }))).toEqual([]);
        });

        it.each([true, false, null])("is Secure Boot ready only with signed images and a confirmed certificate (Secure Boot: %s)", (secureBoot) => {
                for (const imagesSigned of [false, true]) {
                        for (const certificateEnrolled of [false, true, null]) {
                                expect(secureBootReady(status({ secureBoot, signing: { imagesSigned, certificateEnrolled } })))
                                        .toBe(secureBoot === true && imagesSigned && certificateEnrolled === true);
                        }
                }
        });

        it.each([
                ["MSI", "F11"], ["Micro-Star International Co., Ltd.", "F11"], ["micro star", "F11"],
                ["ASUS", "F8"], ["ASUSTeK COMPUTER INC.", "F8"], ["Gigabyte Technology Co., Ltd.", "F12"],
                ["ASRock", "F11"], ["Dell Inc.", null], ["", null], [null, null],
        ])("maps the motherboard manufacturer %s to %s", (name, key) => {
                expect(bootMenuKey(name)).toBe(key);
        });

        it("formats every PCI field in padded lowercase hexadecimal", () => {
                expect(formatSlot({ segment: 0, bus: 1, device: 0, function: 0 })).toBe("0000:01:00.0");
                expect(formatSlot({ segment: 0xabcd, bus: 0xef, device: 0x1a, function: 7 })).toBe("abcd:ef:1a.7");
                expect(formatSlot({ segment: 0xa, bus: 0xb, device: 0xc, function: 1 })).toBe("000a:0b:0c.1");
        });

        it("normalizes API errors, Error instances, strings and unknown values", () => {
                expect(externalError({ code: "externalPlan", message: " noAddressSpace ", recoverable: true })).toEqual({ code: "externalPlan", message: "noAddressSpace" });
                expect(externalError({ code: "externalNoReceipt" })).toEqual({ code: "externalNoReceipt", message: "" });
                expect(externalError(new Error("worker stopped"))).toEqual({ code: "externalWrite", message: "worker stopped" });
                expect(externalError(" plain text ")).toEqual({ code: "externalWrite", message: "plain text" });
                for (const cause of [null, undefined, 3, { code: 5, message: {} }, { code: " ", message: " " }]) {
                        expect(externalError(cause)).toEqual({ code: "externalWrite", message: "" });
                }
        });
});

const candidate = (changes: Partial<ExternalCandidate> = {}): ExternalCandidate => ({
        slot: { segment: 0, bus: 1, device: 0, function: 0 }, name: "NVIDIA GeForce RTX 2080 SUPER", product: 0x1e81,
        currentBar1Bytes: 256 * 1024 ** 2, recommendedBytes: 8 * 1024 ** 3, refusal: null,
        sizes: [16, 8, 2, 4].map((gib) => ({ bytes: gib * 1024 ** 3, error: gib === 16 ? "noAddressSpace" : null })), ...changes,
});

describe("external sizes", () => {
        it("prefers a valid recommendation even when a larger size is usable", () => {
                expect(defaultSize(candidate({ recommendedBytes: 2 * 1024 ** 3 }))).toBe(2 * 1024 ** 3);
        });

        it("uses the largest valid size for a missing, absent, or refused recommendation", () => {
                for (const recommendedBytes of [null, 32 * 1024 ** 3, 16 * 1024 ** 3]) {
                        expect(defaultSize(candidate({ recommendedBytes }))).toBe(8 * 1024 ** 3);
                }
        });

        it("returns null when no size works or no sizes exist", () => {
                expect(defaultSize(candidate({ sizes: [] }))).toBeNull();
                expect(defaultSize(candidate({ sizes: [{ bytes: 8 * 1024 ** 3, error: "consoleInUse" }] }))).toBeNull();
        });

        it("keeps only candidates with a valid size without mutating the report", () => {
                const usable = candidate();
                const report: ExternalReport = {
                        environment: "physical", firmware: "fixture", secureBoot: false, complete: true, errors: [],
                        candidates: [candidate({ sizes: [] }), usable, candidate({ refusal: "consoleInUse", sizes: [{ bytes: 8 * 1024 ** 3, error: "consoleInUse" }] })],
                };
                expect(usableCandidates(report)).toEqual([usable]);
                expect(report.candidates).toHaveLength(3);
        });
});
