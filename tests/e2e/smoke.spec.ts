import { expect, test } from "@playwright/test";
const evidence =
        ".superloopy/evidence/frontend/20260813T125232Z-nvstraps-rebar-ui";
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
