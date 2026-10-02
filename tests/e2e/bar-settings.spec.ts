import { expect, test, type Page } from "@playwright/test";
import { button, chooseLanguage, evidence, missingMessages, noHorizontalOverflow, open, type PreviewState } from "./support";

async function openBarSettings(page: Page, state: PreviewState = "expanded", locale: "en" | "ko" = "en") {
        await open(page, state, locale);
        await page.getByRole("button", { name: locale === "ko" ? "BAR 설정" : "BAR Settings" }).first().click();
        await expect(page.getByTestId("bar-page")).toBeVisible();
}

test("an installed driver opens BAR settings from home and saves through its own dialog", async ({ page }) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await openBarSettings(page);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("BAR Settings");
        await expect(page.getByTestId("bar-settings-workspace")).toBeVisible();
        expect(await noHorizontalOverflow(page)).toBe(true);
        await page.screenshot({ path: `${evidence}/en-bar-settings-1180.png` });

        await page.getByLabel("Target PCI BAR size").selectOption("10");
        await expect(page.getByRole("heading", { name: "Changes ready to save" })).toBeVisible();
        await button(page, "Review & save").click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText("Save these BAR Settings?");
        await dialog.getByRole("button", { name: "Save BAR Settings" }).click();
        await expect(page.getByText("BAR Settings saved", { exact: true })).toBeVisible();
        await expect(page.getByText(/UEFI variable/)).toHaveCount(0);
        await button(page, "Home").click();
        await expect(page.getByRole("heading", { name: "Resizable BAR is on" })).toBeVisible();
});

test("mixed apertures lead to BAR settings and stay usable at the minimum window in Korean", async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 760 });
        await open(page, "mixed", "ko");
        await expect(page.getByRole("heading", { name: "일부 GPU만 확장되어 있습니다" })).toBeVisible();
        await button(page, "BAR 설정 열기").click();
        await expect(page.getByTestId("bar-page")).toBeVisible();
        await page.getByLabel("대상 PCI BAR 크기").selectOption("10");
        await expect(page.getByRole("heading", { name: "변경 사항 저장 가능" })).toBeVisible();
        await button(page, "검토 후 저장").click();
        await expect(page.getByRole("dialog")).toContainText("이 BAR 설정을 저장할까요?");
        await page.getByRole("button", { name: "BAR 설정 저장" }).click();
        await expect(page.getByText("BAR 설정 저장됨", { exact: true })).toBeVisible();
        expect(await noHorizontalOverflow(page)).toBe(true);
        expect(await missingMessages(page)).toEqual([]);
        await page.screenshot({ path: `${evidence}/ko-bar-settings-mixed-900.png` });
});

test("expanded Turing evidence without UEFI read access asks for administrator rights instead of inventing a draft", async ({ page }) => {
        await openBarSettings(page, "expanded-no-access");
        await expect(page.getByRole("heading", { name: "Load the saved configuration to edit" })).toBeVisible();
        await expect(page.getByTestId("bar-page").getByRole("button", { name: "Restart as administrator" })).toBeVisible();
        await expect(page.getByText("Resizable BAR expansion", { exact: true })).toHaveCount(0);
        await expect(button(page, "Review & save")).toHaveCount(0);
});

test("settings round-trip through a file: export confirms, import fills a reviewable draft", async ({ page }) => {
        await openBarSettings(page);
        const fileSection = page.locator(".settings-file");
        await fileSection.getByRole("button", { name: "Save to file" }).click();
        await expect(page.getByText("Settings saved to file", { exact: true })).toBeVisible();
        await fileSection.getByRole("button", { name: "Load from file" }).click();
        await expect(page.getByText("Settings loaded from file", { exact: true })).toBeVisible();
        await expect(page.getByLabel("Target PCI BAR size")).toHaveValue("10");
        await expect(button(page, "Review & save")).toBeEnabled();
        await chooseLanguage(page, "한국어");
        await expect(fileSection).toContainText("설정 파일");
        await expect(page.getByLabel("대상 PCI BAR 크기")).toHaveValue("10");
        expect(await missingMessages(page)).toEqual([]);
});

test("expansion turned off after a BIOS change explains what to do next", async ({ page }) => {
        await open(page, "driver-cleared");
        await expect(page.getByRole("heading", { name: "NvStrapsReBar is running, but expansion is off" })).toBeVisible();
        await expect(page.getByText(/Changing BIOS settings or resetting CMOS turns expansion off/)).toBeVisible();
        await button(page, "Open BAR settings").click();
        await expect(page.getByText("NvStrapsReBar turned expansion off after a BIOS setup change or CMOS reset. Check your BIOS settings, then turn expansion back on and save.")).toBeVisible();
});

test("a stale configuration is a typed failure without false success", async ({ page }) => {
        await page.addInitScript(() => sessionStorage.setItem("nvstraps-preview-bar-settings-error", "stale_configuration"));
        await openBarSettings(page);
        await page.getByLabel("Target PCI BAR size").selectOption("10");
        await button(page, "Review & save").click();
        await page.getByRole("button", { name: "Save BAR Settings" }).click();
        await expect(page.getByRole("alert")).toContainText("The saved BAR configuration changed. Refresh the system before applying this draft.");
        await expect(page.getByText("BAR Settings saved", { exact: true })).toHaveCount(0);
});
