import { expect, test, type Page } from "@playwright/test";
import { button, evidence, noHorizontalOverflow, open } from "./support";

/** Chooses the file, then chooses the routes with an older Above 4G board. */
async function reachLegacyAnalysis(page: Page, path?: string) {
        await open(page, "not-observed");
        await button(page, "Get started").click();
        if (path) {
                await page.getByText("Type the file location instead").click();
                await page.getByPlaceholder("Choose a vendor BIOS image or enter an absolute path").fill(path);
                await button(page, "Read file").click();
        } else {
                await button(page, "Choose file").click();
        }
        await page.getByText("Choose other install and recovery methods").click();
        await button(page, "Choose manually").click();
        await expect(page.getByRole("heading", { name: "Choose whether BIOS setup has a Re-Size BAR item" })).toBeVisible();
        await expect(page.getByText("Step 1 · Prepare · Choice 1 of 3")).toBeVisible();
        await page.getByText("Only Above 4G Decoding").click();
        await button(page, "Next").click();
        await expect(page.getByRole("heading", { name: "Choose the extra patches for this BIOS file" })).toBeVisible();
}

test("legacy analysis preselects only the recommended safe rule and keeps the legacy settings", async ({ page }) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await reachLegacyAnalysis(page);
        const safeRule = page.locator("label", { hasText: "Above 4G decoding compatibility rule" });
        await expect(safeRule.getByRole("checkbox")).toBeChecked();
        await expect(page.getByText(/does not support the compressed section/i)).toBeVisible();
        await page.screenshot({ path: `${evidence}/en-legacy-analysis-1180.png` });
        await button(page, "Next").click();

        await expect(page.getByRole("heading", { name: "Choose how to install the BIOS" })).toBeVisible();
        await button(page, "Next").click();
        await expect(page.getByRole("heading", { name: "Choose how to recover if the BIOS install fails" })).toBeVisible();
        await button(page, "Checked · make the file").click();
        await button(page, "Save to USB").click();
        await expect(page.getByText("Turn on Re-Size BAR")).toHaveCount(0);
        await expect(page.getByText("Turn on Above 4G Decoding")).toBeVisible();
        await button(page, "Restart into BIOS setup").click();
        await page.getByRole("dialog").getByRole("button", { name: "Restart", exact: true }).click();
        await page.reload();
        await expect(page.getByText("In BIOS setup I turned on Above 4G Decoding, turned off CSM, and saved")).toBeVisible();
});

test("a risky legacy rule needs its own confirmation", async ({ page }) => {
        await reachLegacyAnalysis(page);
        await page.locator("label", { hasText: "DSDT resource-window compatibility patch" }).getByRole("checkbox").check();
        await expect(button(page, "Next")).toBeDisabled();
        await expect(page.getByText(/Confirm the DSDT modification below to continue/)).toBeVisible();
        await page.getByRole("region", { name: "Confirm the selected changes" }).getByRole("checkbox").check();
        await expect(button(page, "Next")).toBeEnabled();
});

test("a fingerprint change between reading and analysis blocks the legacy patch", async ({ page }) => {
        await reachLegacyAnalysis(page, "C:\\Firmware\\changed-fingerprint.bin");
        await expect(page.getByRole("alert")).toContainText("The firmware fingerprint changed between inspection and analysis.");
        await expect(page.getByRole("button", { name: "Analyze file" })).toBeEnabled();
        await expect(button(page, "Next")).toHaveCount(0);
});

test("legacy analysis fits the 900 px minimum window", async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 620 });
        await reachLegacyAnalysis(page);
        await expect(page.getByText("Above 4G decoding compatibility rule")).toBeVisible();
        expect(await noHorizontalOverflow(page)).toBe(true);
        await page.screenshot({ path: `${evidence}/en-legacy-analysis-900.png` });
});
