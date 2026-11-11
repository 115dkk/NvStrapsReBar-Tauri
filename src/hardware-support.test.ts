import { describe, expect, it } from "vitest";
import { presentMotherboardSupport, setupUtilityName } from "./hardware-support";
import type { SystemSnapshot } from "./types";

const snapshot = (state: "supported" | "unknown"): SystemSnapshot => ({
        schemaVersion: 1,
        platform: {
                operatingSystem: "windows",
                architecture: "x86_64",
                supported: true,
                uefi: true,
                elevated: true,
                bootedAtUnixMs: null,
        },
        firmware: {
                accessible: true,
                privilegeEnabled: true,
                configVariablePresent: null,
                accessError: null,
        },
        driverStatus: null,
        barSettings: {
                currentBootDxeState: "notObservedThisBoot",
                currentBootDxeReasonCode: "statusVariableMissing",
                controlEvidence: "notObserved",
                settingsAvailable: false,
                savedConfigurationState: "disabled",
                topologyToken: "topology",
                configToken: "configuration",
        },
        config: null,
        devices: [],
        machineIdentity: {
                boardManufacturer: "Micro-Star International Co., Ltd.",
                boardProduct: "PRO Z690-A DDR4(MS-7D25)",
                boardVersion: state === "supported" ? "1.0" : "1.1",
                biosVendor: "AMI",
                biosVersion: "1.N0",
                biosReleaseDate: "2026-03-12",
                gpus: [],
        },
        hardwareSupport: {
                motherboardNativeResizableBar: {
                        state,
                        reasonCode:
                                state === "supported"
                                        ? "exactMotherboardCatalogMatch"
                                        : "motherboardNotInCatalog",
                        catalogId:
                                state === "supported"
                                        ? "msi-pro-z690-a-ddr4-ms-7d25"
                                        : null,
                },
                targetGpuFamily: {
                        state: "unknown",
                        reasonCode: "noGpusDetected",
                },
                overallState: state,
        },
        notices: [],
});

describe("motherboard support presenter", () => {
        it("shows a catalog match with the board product as evidence", () => {
                expect(presentMotherboardSupport(snapshot("supported"))).toEqual({
                        statusId: "ui.supported",
                        symbol: "O",
                        tone: "supported",
                        boardProduct: "PRO Z690-A DDR4(MS-7D25)",
                });
        });

        it("keeps a board outside the current catalog unknown", () => {
                const result = presentMotherboardSupport(snapshot("unknown"));
                expect(result).toEqual({
                        statusId: "ui.notInCurrentSupportList",
                        symbol: "?",
                        tone: "unknown",
                        boardProduct: "PRO Z690-A DDR4(MS-7D25)",
                });
                expect(result.statusId).not.toBe("ui.unsupported");
        });
});

describe("BIOS setup utility names", () => {
        it.each([
                ["Micro-Star International Co., Ltd.", "M-FLASH"],
                ["MSI", "M-FLASH"],
                ["msi computer corp.", "M-FLASH"],
                ["ASUSTeK COMPUTER INC.", "EZ Flash"],
                ["ASUS", "EZ Flash"],
                ["Gigabyte Technology Co., Ltd.", "Q-Flash"],
                ["ASRock", "Instant Flash"],
                ["  ASROCK  ", "Instant Flash"],
                ["Dell Inc.", null],
                ["", null],
                [undefined, null],
        ])("maps %s to %s", (manufacturer, name) => {
                expect(setupUtilityName(manufacturer)).toBe(name);
        });
});
