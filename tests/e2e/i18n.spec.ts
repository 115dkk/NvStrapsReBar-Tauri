import { expect, test } from "@playwright/test";
import { button, chooseLanguage, evidence, missingMessages, noHorizontalOverflow, open } from "./support";

test("the language switch is immediate, persisted, and keeps an unsaved BAR draft", async ({ page }) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await open(page, "expanded");
        await page.getByRole("button", { name: "BAR Settings" }).first().click();
        await page.getByLabel("Built-in list + fallback").check();
        await chooseLanguage(page, "한국어");
        await expect(page.locator("html")).toHaveAttribute("lang", "ko");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("BAR 설정");
        await expect(page.getByLabel("내장 목록 + 대체값")).toBeChecked();
        expect(await missingMessages(page)).toEqual([]);
        await page.screenshot({ path: `${evidence}/ko-bar-settings-draft-1180.png` });
        await page.reload();
        await expect(page.locator("html")).toHaveAttribute("lang", "ko");
        await expect(page.getByRole("heading", { name: "Resizable BAR가 켜져 있습니다" })).toBeVisible();
});

test("the Korean save dialog stays truthful at the minimum width", async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 760 });
        await open(page, "expanded", "ko");
        await page.getByRole("button", { name: "BAR 설정" }).first().click();
        await page.getByLabel("내장 목록 + 대체값").check();
        await button(page, "검토 후 저장").click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText("이 BAR 설정을 저장할까요?");
        await expect(dialog).toContainText("Windows를 다시 시작하면 적용됩니다.");
        expect(await noHorizontalOverflow(page)).toBe(true);
        expect(await missingMessages(page)).toEqual([]);
});

test("English is the fallback and stays selectable", async ({ page }) => {
        await page.goto("/");
        await page.evaluate(() => localStorage.clear());
        await page.reload();
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
        await chooseLanguage(page, "한국어");
        await chooseLanguage(page, "English");
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
        await expect(page.getByRole("heading", { name: "Resizable BAR is on" })).toBeVisible();
});
