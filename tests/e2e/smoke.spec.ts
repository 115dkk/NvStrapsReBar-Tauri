import { expect, test } from "@playwright/test";
const evidence =
        ".superloopy/evidence/frontend/20260813T172117Z-deployment-journeys";
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
                page.getByText("Save verified by read-back"),
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

test("deployment journey pins, prepares, exports, and scopes restart truthfully", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");
        await page.getByRole("button", { name: "Deploy" }).click();
        await expect(
                page.getByRole("heading", { name: "Deployment workspace" }),
        ).toBeVisible();
        await expect(page.getByText("NO AUTO-FLASH")).toBeVisible();
        await expect(
                page.getByText("Exact MSI board recognized"),
        ).toBeVisible();
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
                .getByRole("button", { name: "Create machine-bound profile" })
                .click();
        await expect(
                page.getByText(/Machine-bound profile created/),
        ).toBeVisible();

        await page
                .getByRole("button", { name: "Prepare verified artifact" })
                .click();
        await expect(
                page.getByText("Patched artifact verified", { exact: true }),
        ).toBeVisible();
        await expect(page.getByText("No BIOS flash has occurred.")).toBeVisible();
        await page.getByRole("button", { name: "Choose folder" }).click();
        await page.getByRole("button", { name: "Export package" }).click();
        await expect(
                page.getByText("Package exported — manual handoff next"),
        ).toBeVisible();

        await page
                .getByRole("button", {
                        name: "Review restart to firmware UI",
                })
                .click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText(
                "It does not flash firmware or change setup values.",
        );
        await expect(
                dialog.getByRole("button", {
                        name: "Restart to firmware UI",
                }),
        ).toBeDisabled();
        await dialog.getByLabel("I saved and closed my work.").check();
        await page.screenshot({
                path: `${evidence}/deployment-1180-reboot-confirmation.png`,
                fullPage: true,
        });
        await dialog
                .getByRole("button", { name: "Restart to firmware UI" })
                .click();
        await expect(
                page.getByText(/only opens firmware setup/i),
        ).toBeVisible();
});

test("deployment verification reaches BAR1 and guarded external-tool handoff", async ({
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
                .getByRole("button", { name: "Create machine-bound profile" })
                .click();
        await page.getByRole("button", { name: "Collect BAR1 evidence" }).click();
        await expect(page.getByText("BAR1 8 GiB")).toBeVisible();
        await page
                .getByRole("button", { name: "Install verified tool" })
                .click();
        await expect(page.getByText("Verified v3.0.2.1")).toBeVisible();
        await page.getByRole("button", { name: "Back up & launch" }).click();
        await expect(page.getByText("Backup preserved")).toBeVisible();
        await expect(
                page.getByText(/no policy was imported automatically/i),
        ).toBeVisible();
});

test("deployment remains reachable without horizontal overflow at 900px", async ({
        page,
}) => {
        await page.setViewportSize({ width: 900, height: 620 });
        await page.goto("/");
        await page.getByRole("button", { name: "Deploy" }).click();
        await page.getByRole("button", { name: "Choose file" }).click();
        await expect(page.getByText(/E7D25IMS\.1N0 · 32 MiB/)).toBeVisible();
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
