import { expect, test } from "@playwright/test";
import { button, evidence, open, reachGuide, reachTurnOn } from "./support";

test("a malformed plan-changing receipt becomes an error without false success", async ({ page }) => {
        await reachTurnOn(page);
        await page.evaluate(() => sessionStorage.setItem("nvstraps-preview-malformed-receipt", "profile"));
        await button(page, "Save these settings").click();
        await expect(page.getByRole("alert")).toContainText("The backend returned a deployment receipt for a different profile contract.");
        await expect(page.getByText("Settings saved", { exact: true })).toHaveCount(0);
        await expect(page.getByRole("heading", { name: "Ready to turn on Resizable BAR" })).toBeVisible();
});

test("an unexpected receipt revision is rejected without advancing the step", async ({ page }) => {
        await reachTurnOn(page);
        await page.evaluate(() => sessionStorage.setItem("nvstraps-preview-malformed-receipt", "revision"));
        await button(page, "Save these settings").click();
        await expect(page.getByRole("alert")).toContainText("The backend returned an unexpected deployment plan revision.");
        await expect(page.getByRole("heading", { name: "Ready to turn on Resizable BAR" })).toBeVisible();
});

test("a recommendation without the guard fields cannot be saved", async ({ page }) => {
        await page.addInitScript(() => sessionStorage.setItem("nvstraps-preview-malformed-recommendation", "guarded-fields"));
        await reachTurnOn(page);
        await expect(page.getByRole("alert")).toContainText("inconsistent deployment configuration recommendation");
        await expect(button(page, "Save these settings")).toBeDisabled();
});

test("an unregistered Turing GPU gets a fallback rule at its exact slot", async ({ page }) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await open(page, "not-observed");
        await button(page, "Get started").click();
        await page.getByText("Type the file location instead").click();
        await page.getByPlaceholder("Choose a vendor BIOS image or enter an absolute path").fill("C:\\Firmware\\changed-fingerprint.bin");
        await button(page, "Read file").click();
        await expect(page.getByText("changed-fingerprint.bin", { exact: true })).toBeVisible();
        await button(page, "Checked · make the file").click();
        await button(page, "Save to USB").click();
        await button(page, "Restart into BIOS setup").click();
        await page.getByRole("dialog").getByRole("button", { name: "Restart", exact: true }).click();
        await page.reload();
        await button(page, "Record install and settings").click();
        await expect(page.getByText("GPUs the app does not list get 2 GiB at their current slot.", { exact: false })).toBeVisible();
        await page.screenshot({ path: `${evidence}/en-turn-on-fallback-1180.png` });
});

test("a hardware mismatch stops the install and offers to prepare again", async ({ page }) => {
        await reachGuide(page);
        await page.evaluate(() => sessionStorage.setItem("nvstraps-preview-profile-mismatch", "bios"));
        await page.getByRole("button", { name: "Menu" }).click();
        await page.getByRole("menuitem", { name: "Installation record" }).click();
        await button(page, "Compare with this PC").click();
        await expect(page.getByRole("alert")).toContainText("Hardware check found 1 difference");
        await expect(page.getByText("Current machine, GPU topology, BIOS, and preserved source match the profile.")).toHaveCount(0);
        await button(page, "Home").click();
        await button(page, "Continue setup").click();
        await expect(page.getByRole("heading", { name: "This PC differs from the first check" })).toBeVisible();
        await expect(button(page, "Restart into BIOS setup")).toHaveCount(0);
        await button(page, "Prepare for this PC").click();
        await expect(page.getByRole("heading", { name: "Choose the motherboard BIOS file" })).toBeVisible();
});

test("an open restart dialog locks the menu, and a record in flight cannot be sent twice", async ({ page }) => {
        await reachGuide(page);
        await button(page, "Restart into BIOS setup").click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await expect(page.getByRole("button", { name: "Menu" })).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("button", { name: "Menu" })).toBeEnabled();
        await button(page, "Restart into BIOS setup").click();
        await page.getByRole("dialog").getByRole("button", { name: "Restart", exact: true }).click();
        await page.reload();
        const record = button(page, "Record install and settings");
        await record.click();
        await expect(record).toBeDisabled();
        await expect(page.getByRole("button", { name: "Record install only" })).toBeDisabled();
        await expect(page.getByRole("heading", { name: "Ready to turn on Resizable BAR" })).toBeVisible();
});
