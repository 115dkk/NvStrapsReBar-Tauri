import { expect, test } from "@playwright/test";
import { button, evidence, open, reachGuide } from "./support";

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
        await expect(page.getByText("GPUs the app does not list are set at their current slot with the size above.", { exact: false })).toBeVisible();
        // The size comes from the draft rule that the save button writes (selector 5 is 2 GiB).
        await expect(page.locator(".nv-gpu .nv-size.target")).toHaveText("2 GiB");
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

test("an NvStrapsReBar left by an earlier install does not skip the BIOS steps for a new file", async ({ page }) => {
        // Expansion is already on from an earlier install, so NvStrapsReBar runs in this boot.
        await open(page, "expanded");
        await page.getByRole("button", { name: "Menu" }).click();
        await page.getByRole("menuitem", { name: "Prepare another BIOS file" }).click();
        await button(page, "Choose file").click();
        await button(page, "Checked · make the file").click();
        await button(page, "Save to USB").click();
        await expect(page.getByRole("heading", { name: "Install it in BIOS setup" })).toBeVisible();
        // Reopening the app in the same boot keeps the steps: nothing was restarted since the save.
        await page.reload();
        await expect(page.getByRole("heading", { name: "Install it in BIOS setup" })).toBeVisible();
        await expect(button(page, "Record install and settings")).toHaveCount(0);
        // The user says the BIOS work is done and records it on the next screen.
        await button(page, "Done in BIOS setup").click();
        await expect(page.getByRole("heading", { name: "Record what you did in BIOS setup" })).toBeVisible();
});
