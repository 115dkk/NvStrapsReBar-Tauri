import { describe, expect, it } from "vitest";
import type { DeploymentWorkspaceView } from "./session-contract";
import { buildMachineProfileRequest, instructionsUrlAcceptable } from "./machine-profile-draft";

const draft = (instructionsUrl: string) => ({
        firmware: { fileName: "bios.bin", byteLength: 10, sha256: "a".repeat(64) },
        firmwarePath: "/home/user/bios.bin",
        displayName: "My PC",
        boardPath: "nativeResizableBar",
        firmwareTargetPolicy: "requireUnique",
        installMethod: "firmwareSetupUtility",
        recoveryMethod: "usbFlashback",
        routeConfirmed: true,
        recoveryNote: "",
        installNote: "",
        instructionsUrl,
} as DeploymentWorkspaceView);

describe("optional manual address", () => {
        it.each([
                ["", true],
                [" \t\n", true],
                ["https://example.test/manual", true],
                ["  https://example.test/manual  ", true],
                ["http://example.test/manual", false],
                ["example.test/manual", false],
                ["HTTPS://example.test/manual", false],
        ])("validates %j as %s", (value, acceptable) => {
                expect(instructionsUrlAcceptable(value)).toBe(acceptable);
        });

        it.each(["", "   ", "https://example.test/manual", " https://example.test/manual "])(
                "builds a request with the trimmed optional address %j",
                (value) => {
                        expect(buildMachineProfileRequest(draft(value)).firmwareInstall.officialInstructionsUrl)
                                .toBe(value.trim());
                },
        );

        it("refuses an insecure non-empty address before sending a request", () => {
                expect(() => buildMachineProfileRequest(draft("http://example.test/manual")))
                        .toThrow("The manual address must start with https://.");
        });
});
