import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
const evidence =
        ".superloopy/evidence/frontend/20260813T185901Z-recommended-deployment-config";
const factualCopyEvidence =
        ".superloopy/evidence/frontend/20260814T055636Z-factual-ui-copy";

async function reachRecommendedConfiguration(
        page: Page,
        firmwarePath?: string,
        expectRecommendation = true,
) {
        await page.goto("/");
        await page.getByRole("button", { name: "Deploy" }).click();
        await page.getByRole("button", { name: "Choose file" }).click();
        if (firmwarePath) {
                await page
                        .getByPlaceholder(
                                "Choose a vendor BIOS image or enter an absolute path",
                        )
                        .fill(firmwarePath);
                await page.getByRole("button", { name: "Inspect" }).click();
        }
        await page
                .getByText(
                        "I checked the vendor install and recovery instructions for this board.",
                )
                .click();
        await page
                .getByRole("button", { name: "Create profile for this computer" })
                .click();
        await page
                .getByRole("button", {
                        name: "Prepare and inspect firmware artifact",
                })
                .click();
        for (let gate = 0; gate < 2; gate += 1) {
                await page
                        .getByRole("button", {
                                name: "Review & confirm completed step",
                        })
                        .click();
                const dialog = page.getByRole("dialog");
                await dialog
                        .getByLabel(
                                "I completed this step and reviewed the result.",
                        )
                        .check();
                await dialog
                        .getByRole("button", { name: "Record completed step" })
                        .click();
        }
        await page
                .getByRole("button", {
                        name: "Check current boot + Rust DXE status",
                })
                .click();
        if (expectRecommendation)
                await expect(
                        page.getByText(
                                "Recommended deployment configuration",
                        ),
                ).toBeVisible();
}
test("preview discloses simulation and completes guarded save journey", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");
        await expect(page).toHaveTitle("NvStrapsReBar");
        await expect(page.getByText("PREVIEW DATA")).toBeVisible();
        await expect(
                page.getByRole("heading", { name: "Firmware configuration" }),
        ).toBeVisible();
        await expect(page.getByText("NVIDIA GeForce RTX 2080")).toBeVisible();
        const targetSize = page.getByLabel("Target PCI BAR size");
        await expect(targetSize.locator('option[value="31"]')).toHaveText(
                "2 PiB",
        );
        await expect(targetSize.locator('option[value="32"]')).toHaveText(
                "Any supported size",
        );
        await page.screenshot({
                path: `${evidence}/production-1180-overview.png`,
                fullPage: true,
        });
        await page.getByLabel("Registry + fallback").check();
        await expect(page.getByText("UNSAVED EDITS")).toBeVisible();
        await expect(
                page.getByRole("heading", {
                        name: "Draft is ready for review",
                }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Review & save" }).click();
        await expect(page.getByRole("dialog")).toContainText(
                "Write this draft to UEFI firmware?",
        );
        await page.screenshot({
                path: `${evidence}/production-1180-confirmation.png`,
                fullPage: true,
        });
        await page.getByRole("button", { name: "Write configuration" }).click();
        await expect(
                page.getByText("Configuration written and read back", { exact: true }),
        ).toBeVisible();
        await expect(page.getByText("IN SYNC")).toBeVisible();
});
test("GPU rule exposes scope, size, override, and removal", async ({
        page,
}) => {
        await page.goto("/");
        await page.getByRole("button", { name: "Add explicit rule" }).click();
        await expect(page.getByLabel("Match scope").first()).toHaveValue(
                "location",
        );
        await page.getByLabel("Action / size").first().selectOption("254");
        await page.getByLabel("Size-mask override").selectOption("true");
        await page.getByRole("button", { name: "Remove", exact: true }).click();
        await expect(
                page.getByRole("button", { name: "Add explicit rule" }),
        ).toBeVisible();
});
test("keyboard focus and minimum-width layout remain usable", async ({
        page,
}) => {
        await page.setViewportSize({ width: 900, height: 620 });
        await page.goto("/");
        await page.keyboard.press("Tab");
        await expect(page.locator(":focus")).toBeVisible();
        await page.getByLabel("Off").focus();
        await expect(page.getByLabel("Off").locator("..")).toHaveCSS(
                "outline-style",
                "solid",
        );
        expect(
                await page.evaluate(
                        () =>
                                document.documentElement.scrollWidth <=
                                document.documentElement.clientWidth,
                ),
        ).toBe(true);
        await page.screenshot({
                path: `${evidence}/production-900-minimum.png`,
                fullPage: true,
        });
});

test("durable deployment completes in order and distinguishes requests from receipts", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");
        await page.getByRole("button", { name: "Deploy" }).click();
        await expect(
                page.getByRole("heading", { name: "Deployment workspace" }),
        ).toBeVisible();
        await expect(page.getByText("FLASH WITH VENDOR TOOL")).toBeVisible();
        await expect(
                page.getByText("PRO Z690-A DDR4(MS-7D25)"),
        ).toBeVisible();
        await expect(page.getByText("Profile ID", { exact: true })).toHaveCount(0);
        await expect(page.getByText("Plan revision", { exact: true })).toHaveCount(0);
        await page.screenshot({
                path: `${evidence}/deployment-1180-source.png`,
                fullPage: true,
        });

        await page.getByRole("button", { name: "Choose file" }).click();
        await expect(page.getByText(/E7D25IMS\.1N0 · 32 MiB/)).toBeVisible();
        await page
                .getByText(
                        "I checked the vendor install and recovery instructions for this board.",
                )
                .click();
        await page
                .getByRole("button", { name: "Create profile for this computer" })
                .click();
        await expect(
                page.getByText(
                        "Machine profile created · source image fingerprint recorded.",
                        { exact: true },
                ),
        ).toBeVisible();

        await page
                .getByRole("button", { name: "Prepare and inspect firmware artifact" })
                .click();
        await expect(
                page.getByText("Prepared firmware artifact", { exact: true }),
        ).toBeVisible();
        await expect(page.getByText("Next: export this artifact for the vendor tool.")).toBeVisible();
        await page.getByRole("button", { name: "Choose folder" }).click();
        await page.getByRole("button", { name: "Export package" }).click();
        await expect(
                page.getByText("Package exported — manual handoff next"),
        ).toBeVisible();

        await expect(page.getByRole("heading", { name: "Flash with the documented vendor route" })).toBeVisible();
        await expect(
                page.getByRole("button", { name: "Collect BAR1 data" }),
        ).toHaveCount(0);

        await page.getByRole("button", { name: "Review restart to firmware UI" }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText(
                "Windows opens the firmware setup screen; continue there with the vendor instructions.",
        );
        await expect(
                dialog.getByRole("button", {
                        name: "Restart to firmware UI",
                }),
        ).toBeDisabled();
        await dialog.getByLabel("I saved and closed my work.").check();
        await page.screenshot({
                path: `${evidence}/workflow-1180-firmware-restart.png`,
                fullPage: true,
        });
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Review restart to firmware UI" })).toBeFocused();

        await page.getByRole("button", { name: "Review & confirm completed step" }).click();
        const manual = page.getByRole("dialog");
        await expect(manual).toContainText("Record completion after the vendor tool reports success.");
        await expect(manual).not.toContainText("token is bound");
        await expect(manual).not.toContainText("flashFirmware");
        await expect(manual).not.toContainText("REVISION");
        await manual.getByLabel("I completed this step and reviewed the result.").check();
        await manual.getByRole("button", { name: "Record completed step" }).click();
        await expect(page.getByRole("heading", { name: "Confirm firmware setup values" })).toBeVisible();

        await page.getByRole("button", { name: "Review & confirm completed step" }).click();
        await page.getByRole("dialog").getByLabel("I completed this step and reviewed the result.").check();
        await page.getByRole("dialog").getByRole("button", { name: "Record completed step" }).click();
        await expect(page.getByRole("heading", { name: "Boot Windows after the firmware handoff" })).toBeVisible();

        await page.getByRole("button", { name: "Check current boot + Rust DXE status" }).click();
        await expect(page.getByText("Current boot and Rust DXE status recorded")).toBeVisible();
        await expect(page.getByRole("heading", { name: "Write and read back the NvStrapsReBar configuration" })).toBeVisible();

        const write = page.getByRole("button", { name: "Write configuration and read it back" });
        await expect(write).toBeDisabled();
        await expect(page.getByText("Registry managed")).toBeVisible();
        await expect(page.getByText(/backend/i)).toHaveCount(0);
        await expect(page.getByText("Location-specific fallback rules")).toBeVisible();
        await expect(
                page.getByText("Registry managed").locator("..").getByText("1", { exact: true }),
        ).toBeVisible();
        await expect(
                page.getByText("Location-specific fallback rules").locator("..").getByText("0", { exact: true }),
        ).toBeVisible();
        await expect(page.getByText(/global mode 1 · target selector 0/)).toBeVisible();
        await expect(page.getByText(/no fallback rule is added/i)).toBeVisible();
        await page.screenshot({
                path: `${evidence}/recommendation-1180-known-registry.png`,
                fullPage: true,
        });
        await page.screenshot({
                path: `${factualCopyEvidence}/english-recommendation-1180x760.png`,
        });
        await page.getByLabel("I reviewed this configuration for the selected profile.").check();
        await write.click();
        await expect(page.getByText("Configuration written and read back", { exact: true })).toBeVisible();

        await page.getByRole("button", { name: "Review restart after configuration" }).click();
        const configurationRestart = page.getByRole("dialog");
        await expect(configurationRestart).toContainText("Applications receive the standard shutdown request.");
        await expect(configurationRestart).toContainText("Return after Windows boots so the app can compare the new boot time.");
        await configurationRestart.getByLabel("I saved and closed my work.").check();
        await page.screenshot({
                path: `${evidence}/workflow-1180-configuration-restart.png`,
                fullPage: true,
        });
        await configurationRestart.getByRole("button", { name: "Request restart" }).click();
        await expect(page.getByText("Return after Windows boots, then check the boot time.")).toBeVisible();
        await expect(page.getByRole("heading", { name: "Restart after configuration" })).toBeVisible();

        await page.reload();
        await page.getByRole("button", { name: "Deploy" }).click();
        await expect(page.getByRole("heading", { name: "Restart after configuration" })).toBeVisible();
        await page.getByRole("button", { name: "Check Windows boot time" }).click();
        await expect(page.getByText("Windows boot time recorded")).toBeVisible();

        await page.getByRole("button", { name: "Collect BAR1 data" }).click();
        await expect(page.getByText(/BAR1 8 GiB/)).toBeVisible();
        await expect(page.getByRole("heading", { name: "Configure NVIDIA application profiles" })).toBeVisible();

        await page.getByRole("button", { name: "Install Profile Inspector" }).click();
        await page.getByRole("button", { name: "Back up & launch editor" }).click();
        await expect(page.getByText(/next: edit the policy and record the result/i)).toBeVisible();
        await expect(page.getByRole("heading", { name: "Configure NVIDIA application profiles" })).toBeVisible();
        await page.screenshot({
                path: `${evidence}/workflow-1180-final-policy.png`,
                fullPage: true,
        });
        await page.getByRole("button", { name: "Review & confirm applied NVIDIA policy" }).click();
        await expect(page.getByRole("dialog")).toContainText("Return after editing the policy and record the result.");
        await page.screenshot({
                path: `${evidence}/workflow-1180-policy-confirmation.png`,
                fullPage: true,
        });
        await page.getByRole("dialog").getByLabel("I completed this step and reviewed the result.").check();
        await page.getByRole("dialog").getByRole("button", { name: "Record completed step" }).click();
        await expect(page.getByText("Deployment plan complete", { exact: true })).toBeVisible();
        await expect(page.locator(".deployment-rail .rail-note")).toHaveCount(0);
});

test("deployment remains reachable without horizontal overflow at 900px", async ({
        page,
}) => {
        await page.setViewportSize({ width: 900, height: 620 });
        await page.goto("/");
        await page.getByRole("button", { name: "Deploy" }).click();
        await page.getByRole("button", { name: "Choose file" }).click();
        await expect(page.getByText(/E7D25IMS\.1N0 · 32 MiB/)).toBeVisible();
        await page.getByText("I checked the vendor install and recovery instructions for this board.").click();
        await page.getByRole("button", { name: "Create profile for this computer" }).click();
        await page.getByRole("button", { name: "Prepare and inspect firmware artifact" }).click();
        await expect(page.getByRole("heading", { name: "Flash with the documented vendor route" })).toBeVisible();
        await page.getByRole("button", { name: "Review & confirm completed step" }).focus();
        await expect(page.getByRole("button", { name: "Review & confirm completed step" })).toBeFocused();
        expect(
                await page.evaluate(
                        () =>
                                document.documentElement.scrollWidth <=
                                document.documentElement.clientWidth,
                ),
        ).toBe(true);
        await page.screenshot({
                path: `${evidence}/deployment-900-minimum.png`,
                fullPage: true,
        });
});

test("manual preview suppresses duplicate submit and locks profile selection while busy", async ({
        page,
}) => {
        await page.goto("/");
        await page.getByRole("button", { name: "Deploy" }).click();
        await page.getByRole("button", { name: "Choose file" }).click();
        await page.getByText("I checked the vendor install and recovery instructions for this board.").click();
        await page.getByRole("button", { name: "Create profile for this computer" }).click();
        await page.getByRole("button", { name: "Prepare and inspect firmware artifact" }).click();

        const path = page.getByPlaceholder("Choose a vendor BIOS image or enter an absolute path");
        await path.fill("C:\\Firmware\\changed-fingerprint.bin");
        await page.getByRole("button", { name: "Inspect" }).click();
        await page.getByLabel("Profile name").fill("Second machine profile");
        await page.getByRole("button", { name: "Create profile for this computer" }).click();

        const selector = page.getByLabel("Machine profile");
        await selector.selectOption({ label: "PRO Z690-A DDR4 · RTX 2080 SUPER" });
        const review = page.getByRole("button", { name: "Review & confirm completed step" });
        await review.click();
        await expect(review).toBeDisabled();
        await expect(selector).toBeDisabled();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(selector).toBeEnabled();
        await selector.selectOption({ label: "Second machine profile" });
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.getByRole("heading", { name: "Build and inspect the Rust DXE driver" })).toBeVisible();
});

test("machine preflight mismatch is an error and never claims an exact match", async ({
        page,
}) => {
        await page.goto("/");
        await page.getByRole("button", { name: "Deploy" }).click();
        await page.getByRole("button", { name: "Choose file" }).click();
        await page
                .getByText(
                        "I checked the vendor install and recovery instructions for this board.",
                )
                .click();
        await page
                .getByRole("button", { name: "Create profile for this computer" })
                .click();
        await page.evaluate(() =>
                sessionStorage.setItem(
                        "nvstraps-preview-profile-mismatch",
                        "bios",
                ),
        );
        await page
                .getByRole("button", { name: "Check current hardware and source image" })
                .click();
        await expect(
                page.getByText(
                        "Hardware check found 1 difference; deployment remains blocked until the selected profile matches.",
                        { exact: true },
                ),
        ).toBeVisible();
        await expect(
                page.getByText(
                        "Current machine, GPU topology, BIOS, and preserved source match the profile.",
                        { exact: true },
                ),
        ).toHaveCount(0);
});

test("unknown Turing recommendation pins an exact-location fallback rule", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await reachRecommendedConfiguration(
                page,
                "C:\\Firmware\\changed-fingerprint.bin",
        );
        await expect(
                page.getByText("Registry managed").locator("..").getByText("0", { exact: true }),
        ).toBeVisible();
        await expect(
                page.getByText("Location-specific fallback rules").locator("..").getByText("1", { exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("list", { name: "Location-specific fallback rules" })).toContainText(
                "01:00.0",
        );
        await expect(page.getByRole("list", { name: "Location-specific fallback rules" })).toContainText(
                "PCI location only",
        );
        await expect(page.getByRole("list", { name: "Location-specific fallback rules" })).toContainText(
                "device 1f81",
        );
        await expect(page.getByRole("list", { name: "Location-specific fallback rules" })).toContainText(
                "BAR selector 5",
        );
        await page.screenshot({
                path: `${evidence}/recommendation-1180-exact-fallback.png`,
                fullPage: true,
        });
});

test("malformed plan-changing receipt becomes an error without false success", async ({
        page,
}) => {
        await reachRecommendedConfiguration(page);
        await page.evaluate(() =>
                sessionStorage.setItem(
                        "nvstraps-preview-malformed-receipt",
                        "profile",
                ),
        );
        await page
                .getByLabel(
                        "I reviewed this configuration for the selected profile.",
                )
                .check();
        await page
                .getByRole("button", {
                        name: "Write configuration and read it back",
                })
                .click();
        await expect(
                page.getByText(
                        "The backend returned a deployment receipt for a different profile contract.",
                        { exact: true },
                ),
        ).toBeVisible();
        await expect(
                page.getByText("Configuration written and read back", { exact: true }),
        ).toHaveCount(0);
        await expect(
                page.getByRole("heading", {
                        name: "Write and read back the NvStrapsReBar configuration",
                }),
        ).toBeVisible();
});

test("unexpected receipt revision delta is rejected without advancing the active step", async ({
        page,
}) => {
        await reachRecommendedConfiguration(page);
        await page.evaluate(() =>
                sessionStorage.setItem(
                        "nvstraps-preview-malformed-receipt",
                        "revision",
                ),
        );
        await page
                .getByLabel(
                        "I reviewed this configuration for the selected profile.",
                )
                .check();
        await page
                .getByRole("button", {
                        name: "Write configuration and read it back",
                })
                .click();
        await expect(
                page.getByText(
                        "The backend returned an unexpected deployment plan revision.",
                        { exact: true },
                ),
        ).toBeVisible();
        await expect(
                page.getByText("Configuration written and read back", { exact: true }),
        ).toHaveCount(0);
        await expect(
                page.getByRole("heading", {
                        name: "Write and read back the NvStrapsReBar configuration",
                }),
        ).toBeVisible();
});

test("non-guarded recommendation is rejected before confirmation", async ({
        page,
}) => {
        await page.addInitScript(() =>
                sessionStorage.setItem(
                        "nvstraps-preview-malformed-recommendation",
                        "guarded-fields",
                ),
        );
        await reachRecommendedConfiguration(page, undefined, false);
        await expect(
                page.getByText(
                        "The backend returned an inconsistent deployment configuration recommendation.",
                        { exact: true },
                ),
        ).toBeVisible();
        await expect(
                page.getByLabel(
                        "I reviewed this configuration for the selected profile.",
                ),
        ).toBeDisabled();
        await expect(
                page.getByRole("button", {
                        name: "Write configuration and read it back",
                }),
        ).toBeDisabled();
});

test("legacy analysis selects only the recommended safe rule before profile creation", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");
        await page.getByRole("button", { name: "Deploy" }).click();
        await page.getByLabel("Board path").selectOption("legacyAbove4g");
        await page.getByRole("button", { name: "Choose file" }).click();
        await page
                .getByText(
                        "I checked the vendor install and recovery instructions for this board.",
                )
                .click();

        const create = page.getByRole("button", {
                name: "Create profile for this computer",
        });
        await expect(create).toBeDisabled();
        await expect(
                page.getByText(
                        "Analyze this firmware image before selecting legacy rules.",
                ),
        ).toBeVisible();

        await page.getByRole("button", { name: "Analyze image" }).click();
        await expect(
                page.getByRole("button", { name: "Analyzing image…" }),
        ).toBeDisabled();
        await expect(
                page.getByText(/legacy analysis complete/i),
        ).toBeVisible();
        const safeRule = page.getByText(
                "Above 4G decoding compatibility rule",
        );
        await expect(safeRule).toBeVisible();
        await expect(safeRule.locator("xpath=ancestor::label").getByRole("checkbox")).toBeChecked();
        await expect(
                page.getByText("Compressed vendor-specific compatibility patch"),
        ).toBeVisible();
        await expect(page.getByText(/does not support the compressed section/i)).toBeVisible();
        await expect(create).toBeEnabled();
        await page.screenshot({
                path: `${evidence}/legacy-1180-safe-analysis.png`,
                fullPage: true,
        });
        await create.click();
        await expect(
                page.getByText(/legacy profile created with 1 rule · source fingerprint recorded/i),
        ).toBeVisible();
        await page
                .getByRole("button", {
                        name: "Prepare and inspect firmware artifact",
                })
                .click();
        await page
                .getByRole("button", {
                        name: "Review & confirm completed step",
                })
                .click();
        await page
                .getByRole("dialog")
                .getByLabel(
                        "I completed this step and reviewed the result.",
                )
                .check();
        await page
                .getByRole("dialog")
                .getByRole("button", { name: "Record completed step" })
                .click();
        await page
                .getByRole("button", {
                        name: "Review & confirm completed step",
                })
                .click();
        const setupDialog = page.getByRole("dialog");
        await expect(setupDialog).toContainText(
                "Enable Above 4G decoding and disable CSM. This legacy route uses NvStrapsReBar instead of native motherboard ReBAR.",
        );
        await expect(setupDialog).not.toContainText(
                "Enable native ReBAR and Above 4G decoding",
        );
        await page.keyboard.press("Escape");
});

test("risky legacy rule requires a fingerprint-specific acknowledgement", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");
        await page.getByRole("button", { name: "Deploy" }).click();
        await page.getByLabel("Board path").selectOption("legacyAbove4g");
        await page.getByRole("button", { name: "Choose file" }).click();
        await page
                .getByText(
                        "I checked the vendor install and recovery instructions for this board.",
                )
                .click();
        await page.getByRole("button", { name: "Analyze image" }).click();

        const riskyRule = page.getByText(
                "DSDT resource-window compatibility patch",
        );
        await riskyRule.locator("xpath=ancestor::label").getByRole("checkbox").check();
        const create = page.getByRole("button", {
                name: "Create profile for this computer",
        });
        await expect(create).toBeDisabled();
        await expect(
                page.getByText(/Add an image-specific note and confirmation for DSDT modification/),
        ).toBeVisible();

        await page
                .getByLabel("Image-specific acknowledgement note")
                .fill(
                        "For firmware 71717171 this DSDT change may alter resource windows and recovery behavior on this board.",
                );
        await page
                .getByLabel(
                        "I reviewed this risk for the analyzed firmware.",
                )
                .check();
        await expect(create).toBeEnabled();
        await page.screenshot({
                path: `${evidence}/legacy-1180-risk-acknowledged.png`,
                fullPage: true,
        });
        await create.click();
        await expect(
                page.getByText(/legacy profile created with 2 rules · source fingerprint recorded/i),
        ).toBeVisible();
        await expect(page.getByText(/source fingerprint recorded/i)).toBeVisible();
});

test("legacy selections are invalidated by path and fingerprint drift", async ({
        page,
}) => {
        await page.goto("/");
        await page.getByRole("button", { name: "Deploy" }).click();
        await page.getByLabel("Board path").selectOption("legacyAbove4g");
        await page.getByRole("button", { name: "Choose file" }).click();
        const firmwarePath = page.getByPlaceholder(
                "Choose a vendor BIOS image or enter an absolute path",
        );
        await page.getByRole("button", { name: "Analyze image" }).click();
        await firmwarePath.fill("C:\\Firmware\\reply-race.bin");
        await page.waitForTimeout(80);
        await expect(page.getByText("Analyzed source")).toHaveCount(0);

        await firmwarePath.fill("C:\\Firmware\\E7D25IMS.1N0");
        await page.getByRole("button", { name: "Inspect" }).click();
        await page.getByRole("button", { name: "Analyze image" }).click();
        await expect(page.getByText("Analyzed source")).toBeVisible();

        await firmwarePath.fill("C:\\Firmware\\changed-fingerprint.bin");
        await expect(page.getByText("Analyzed source")).toHaveCount(0);
        await expect(
                page.getByRole("button", { name: "Create profile for this computer" }),
        ).toBeDisabled();

        await page.getByRole("button", { name: "Inspect" }).click();
        await expect(page.getByText(/changed-fingerprint\.bin/)).toBeVisible();
        await page.getByRole("button", { name: "Analyze image" }).click();
        await expect(
                page.getByText(
                        "The firmware fingerprint changed between inspection and analysis.",
                        { exact: true },
                ),
        ).toBeVisible();
        await expect(
                page.getByRole("button", { name: "Create profile for this computer" }),
        ).toBeDisabled();
});

test("legacy analysis remains reachable at the supported minimum window", async ({
        page,
}) => {
        await page.setViewportSize({ width: 900, height: 620 });
        await page.goto("/");
        await page.getByRole("button", { name: "Deploy" }).click();
        await page.getByLabel("Board path").selectOption("legacyAbove4g");
        await page.getByRole("button", { name: "Choose file" }).click();
        await page.getByRole("button", { name: "Analyze image" }).click();
        await expect(
                page.getByRole("button", { name: "Create profile for this computer" }),
        ).toBeVisible();
        await expect(page.getByText("Analyzed source")).toBeVisible();
        expect(
                await page.evaluate(
                        () =>
                                document.documentElement.scrollWidth <=
                                document.documentElement.clientWidth,
                ),
        ).toBe(true);
        await page.screenshot({
                path: `${evidence}/legacy-900-minimum.png`,
                fullPage: true,
        });
});
