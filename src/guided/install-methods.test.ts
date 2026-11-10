import { describe, expect, it } from "vitest";
import { installMethodIds, offeredInstallMethods } from "./install-source";

describe("install method choice by host OS", () => {
        it("offers every method on Windows in catalog order", () => {
                expect(offeredInstallMethods("windows")).toEqual(Object.keys(installMethodIds));
                expect(offeredInstallMethods("windows")).toContain("vendorWindowsUtility");
        });

        it("leaves out the vendor Windows utility on Linux and keeps the others in order", () => {
                expect(offeredInstallMethods("linux")).toEqual(["firmwareSetupUtility", "usbFlashback", "externalSpiProgrammer"]);
        });

        it("keeps the Windows utility labels so an existing plan still renders", () => {
                expect(installMethodIds.vendorWindowsUtility.title).toBe("ui.methodWindowsUtility");
        });
});
