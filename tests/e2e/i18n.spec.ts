import { expect, test } from "@playwright/test";
import { chooseLanguage, evidence, missingMessages, noHorizontalOverflow, open } from "./support";

test("the language switch is immediate, persisted, and keeps an unsaved BAR draft", async ({ page }) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await open(page, "expanded");
        await page.getByRole("button", { name: "BAR Settings" }).first().click();
        await page.getByLabel("RTX 2080 SUPER size").selectOption({ label: "4 GiB" });
        await chooseLanguage(page, "한국어");
        await expect(page.locator("html")).toHaveAttribute("lang", "ko");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("BAR 설정");
        await expect(page.getByLabel("RTX 2080 SUPER 다시 시작 후 크기")).toHaveValue("6");
        await expect(page.getByRole("region", { name: "저장하지 않은 변경" })).toContainText("변경 1개 · RTX 2080 SUPER 8 GiB → 4 GiB");
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
        await page.getByRole("switch", { name: "Resizable BAR 확장" }).click();
        await page.getByRole("region", { name: "저장하지 않은 변경" }).getByRole("button", { name: "저장", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Resizable BAR 확장 끄기" });
        await expect(dialog).toContainText("저장된 BAR 설정을 지웁니다. 다시 시작하면 확장이 꺼집니다.");
        await expect(dialog.getByRole("button", { name: "닫기" })).toBeFocused();
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
