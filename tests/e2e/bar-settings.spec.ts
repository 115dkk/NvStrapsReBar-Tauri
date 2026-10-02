import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { button, chooseLanguage, missingMessages, noHorizontalOverflow, open, type PreviewState } from "./support";

const evidence = ".superloopy/evidence/frontend/20261002T200500Z-bar-settings-switch";
mkdirSync(evidence, { recursive: true });

async function openBarSettings(page: Page, state: PreviewState = "expanded", locale: "en" | "ko" = "en") {
        await open(page, state, locale);
        await page.getByRole("button", { name: locale === "ko" ? "BAR 설정" : "BAR Settings" }).first().click();
        await expect(page.getByTestId("bar-page")).toBeVisible();
}

const saveBar = (page: Page) => page.getByRole("region", { name: /^(Unsaved changes|저장하지 않은 변경)$/ });

test("a size change shows the save bar, saves through one confirmation, and returns focus", async ({ page }) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await openBarSettings(page);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("BAR Settings");
        await expect(page.getByRole("switch", { name: "Resizable BAR expansion" })).toHaveAttribute("aria-checked", "true");
        const size = page.getByLabel("RTX 2080 SUPER size");
        await expect(size).toHaveValue("auto");
        await expect(size.locator("option:checked")).toHaveText("Automatic (8 GiB)");
        await expect(saveBar(page)).toHaveCount(0);
        expect(await noHorizontalOverflow(page)).toBe(true);
        await page.screenshot({ path: `${evidence}/en-bar-settings-1180.png` });

        await size.selectOption({ label: "4 GiB" });
        await expect(saveBar(page)).toContainText("1 change · RTX 2080 SUPER 8 GiB → 4 GiB");
        const save = saveBar(page).getByRole("button", { name: "Save", exact: true });
        await expect(save).toBeEnabled();
        await page.screenshot({ path: `${evidence}/en-bar-settings-changed-1180.png` });

        await save.click();
        const dialog = page.getByRole("dialog", { name: "Save BAR settings" });
        await expect(dialog).toContainText("The settings are saved and read back. They apply after a restart.");
        await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(save).toBeFocused();

        await save.click();
        await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByText("BAR Settings saved", { exact: true })).toBeVisible();
        await expect(saveBar(page)).toHaveCount(0);
        await expect(size).toHaveValue("6"); // 4 GiB is selector 6 (64 MiB << 6)
        await expect(page.getByText(/UEFI variable/)).toHaveCount(0);
        await page.getByRole("navigation", { name: "Location" }).getByRole("button", { name: "Home" }).click();
        await expect(page.getByRole("heading", { name: "Resizable BAR is on" })).toBeVisible();
});

test("revert restores the saved settings and turning expansion back on restores the sizes", async ({ page }) => {
        await openBarSettings(page);
        const size = page.getByLabel("RTX 2080 SUPER size");
        await size.selectOption({ label: "Do not expand" });
        await expect(saveBar(page)).toContainText("RTX 2080 SUPER 8 GiB → Do not expand");
        await saveBar(page).getByRole("button", { name: "Revert" }).click();
        await expect(saveBar(page)).toHaveCount(0);
        await expect(size).toHaveValue("auto");

        const expansion = page.getByRole("switch", { name: "Resizable BAR expansion" });
        await expansion.click();
        await expect(expansion).toHaveAttribute("aria-checked", "false");
        // Sizes only matter while expansion is on.
        await expect(page.getByRole("heading", { name: "Size for each GPU" })).toHaveCount(0);
        await expect(saveBar(page)).toContainText("1 change · Expansion off");
        await expansion.click();
        await expect(saveBar(page)).toHaveCount(0);
        await expect(size).toHaveValue("auto");
});

test("turning expansion off is confirmed as turning it off", async ({ page }) => {
        await openBarSettings(page);
        await page.getByRole("switch", { name: "Resizable BAR expansion" }).click();
        await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Turn off Resizable BAR expansion" });
        await expect(dialog).toContainText("Expansion turns off after a restart.");
        await dialog.getByRole("button", { name: "Turn off" }).click();
        await expect(page.getByText("BAR Settings saved", { exact: true })).toBeVisible();
        await expect(page.getByRole("switch", { name: "Resizable BAR expansion" })).toHaveAttribute("aria-checked", "false");
});

test("advanced settings keep every firmware option, each described by its on state", async ({ page }) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await openBarSettings(page);
        await page.getByText("Advanced · motherboard-side size limit, BIOS change detection, sleep resume").click();
        const unlisted = page.getByRole("switch", { name: "Also expand unlisted RTX 20 and GTX 16 GPUs to 2 GiB" });
        await expect(unlisted).toHaveAttribute("aria-checked", "false");
        await unlisted.click();
        await expect(page.getByLabel("RTX 2080 SUPER size").locator("option:checked")).toHaveText("Automatic (8 GiB)");
        await expect(page.getByRole("switch", { name: "Turn off expansion if BIOS settings change" })).toHaveAttribute("aria-checked", "true");
        await expect(page.getByRole("switch", { name: "Allow sizes not listed by the GPU" })).toHaveAttribute("aria-checked", "false");
        const sleep = page.getByRole("switch", { name: "Reapply settings after sleep (S3)" });
        await expect(sleep).toHaveAttribute("aria-checked", "true");
        await sleep.click();
        await expect(page.getByText("Check that graphics work after waking from sleep (S3).")).toBeVisible();
        await page.getByLabel("Motherboard-side size limit").selectOption("10");
        await expect(saveBar(page)).toContainText("1 change · Advanced settings");
        expect(await noHorizontalOverflow(page)).toBe(true);
        await page.screenshot({ path: `${evidence}/en-bar-settings-advanced-1180.png` });
});

test("mixed apertures lead to BAR settings and stay usable at the minimum window in Korean", async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 620 });
        await open(page, "mixed", "ko");
        await expect(page.getByRole("heading", { name: "일부 GPU만 확장되어 있습니다" })).toBeVisible();
        await button(page, "BAR 설정 열기").click();
        await expect(page.getByTestId("bar-page")).toBeVisible();
        await expect(page.getByLabel("Quadro RTX 4000 크기")).toBeVisible();
        await page.getByLabel("Quadro RTX 4000 크기").selectOption({ label: "4 GiB" });
        await expect(saveBar(page)).toContainText("변경 1개 · Quadro RTX 4000 8 GiB → 4 GiB");
        expect(await noHorizontalOverflow(page)).toBe(true);
        await page.screenshot({ path: `${evidence}/ko-bar-settings-mixed-900x620.png` });
        await saveBar(page).getByRole("button", { name: "저장", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "BAR 설정 저장" });
        await expect(dialog).toContainText("저장한 뒤 다시 읽어 확인합니다. 다시 시작하면 적용됩니다.");
        await dialog.getByRole("button", { name: "저장", exact: true }).click();
        await expect(page.getByText("BAR 설정 저장됨", { exact: true })).toBeVisible();
        expect(await missingMessages(page)).toEqual([]);
});

test("expanded Turing evidence without UEFI read access asks to reopen as administrator instead of inventing a draft", async ({ page }) => {
        await openBarSettings(page, "expanded-no-access");
        await expect(page.getByRole("heading", { name: "Load the saved settings" })).toBeVisible();
        await expect(page.getByTestId("bar-page").getByRole("button", { name: "Reopen as administrator" })).toBeVisible();
        await expect(page.getByRole("switch")).toHaveCount(0);
        await expect(saveBar(page)).toHaveCount(0);
});

test("settings backup from home opens the file section; a loaded file becomes a reviewable draft", async ({ page }) => {
        await open(page, "expanded");
        await page.getByRole("button", { name: "Settings backup" }).click();
        const file = page.getByTestId("settings-file");
        await expect(file).toHaveAttribute("open", "");
        await file.getByRole("button", { name: "Save to file" }).click();
        await expect(page.getByText("Settings saved to file", { exact: true })).toBeVisible();
        await file.getByRole("button", { name: "Load from file" }).click();
        await expect(page.getByText("Settings loaded from file", { exact: true })).toBeVisible();
        await expect(page.getByLabel("Motherboard-side size limit")).toHaveValue("10");
        await expect(saveBar(page)).toContainText("1 change · Advanced settings");
        await chooseLanguage(page, "한국어");
        await expect(file).toContainText("설정 파일");
        await expect(page.getByLabel("메인보드 쪽 크기 상한")).toHaveValue("10");
        await expect(saveBar(page)).toContainText("변경 1개 · 고급 설정");
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
        await page.getByLabel("RTX 2080 SUPER size").selectOption({ label: "4 GiB" });
        await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByRole("alert")).toContainText("The saved BAR configuration changed. Refresh the system before applying this draft.");
        await expect(page.getByText("BAR Settings saved", { exact: true })).toHaveCount(0);
        await expect(saveBar(page)).toBeVisible();
});
