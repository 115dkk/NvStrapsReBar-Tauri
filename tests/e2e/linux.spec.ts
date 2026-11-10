import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { button, missingMessages, noHorizontalOverflow, open, type PreviewState } from "./support";

/** Browser preview only: `?os=linux` makes the preview snapshot report Linux; no Rust runs. */
const evidence = ".superloopy/evidence/frontend/20261110T001429Z-linux-host-os";
mkdirSync(evidence, { recursive: true });

type Os = "windows" | "linux";
const systems: Os[] = ["windows", "linux"];

const homeRow = (page: Page, name: string) => page.getByTestId("home").getByRole("button", { name });

async function openMenu(page: Page) {
        await page.getByRole("button", { name: "Menu" }).click();
        await expect(page.getByRole("menu")).toBeVisible();
}

/** From the start screen to the install-method choice on the MSI preview board. */
async function reachInstallQuestion(page: Page) {
        await button(page, "Get started").click();
        await button(page, "Choose file").click();
        await page.getByText("Choose other install and recovery methods").click();
        await button(page, "Choose manually").click();
        await expect(page.getByRole("heading", { name: "Choose whether BIOS setup has a Re-Size BAR item" })).toBeVisible();
        await button(page, "Next").click();
        await expect(page.getByRole("heading", { name: "Choose how to install the BIOS" })).toBeVisible();
}

for (const os of systems) {
        const linux = os === "linux";

        test(`${os}: home rows`, async ({ page }) => {
                await page.setViewportSize({ width: 1180, height: 760 });
                await open(page, "expanded", "en", os);
                await expect(page.getByRole("heading", { level: 1 })).toHaveText("Resizable BAR is on");
                await expect(homeRow(page, "BAR Settings")).toBeVisible();
                await expect(homeRow(page, "Settings backup")).toHaveCount(1);
                await expect(homeRow(page, "When you change the BIOS or hardware")).toBeVisible();
                await expect(homeRow(page, "Turn on for each game")).toHaveCount(linux ? 0 : 1);
                await expect(homeRow(page, "Without changing the BIOS")).toHaveCount(linux ? 0 : 1);
                await expect(page.getByTestId("home").locator(".nv-rows > *")).toHaveCount(linux ? 3 : 5);
                expect(await noHorizontalOverflow(page)).toBe(true);
                expect(await missingMessages(page)).toEqual([]);
                await page.screenshot({ path: `${evidence}/${os}-home-expanded-1180.png` });
                await page.setViewportSize({ width: 900, height: 760 });
                expect(await noHorizontalOverflow(page)).toBe(true);
                await page.screenshot({ path: `${evidence}/${os}-home-expanded-900.png` });
        });

        test(`${os}: start screen secondary action`, async ({ page }) => {
                await page.setViewportSize({ width: 1180, height: 760 });
                await open(page, "not-observed", "en", os);
                await expect(page.getByRole("heading", { level: 1 })).toHaveText("You can turn on Resizable BAR");
                await expect(button(page, "Get started")).toBeVisible();
                await expect(button(page, "Without changing the BIOS")).toHaveCount(linux ? 0 : 1);
                expect(await noHorizontalOverflow(page)).toBe(true);
                await page.screenshot({ path: `${evidence}/${os}-home-start-1180.png` });
                await page.setViewportSize({ width: 900, height: 760 });
                expect(await noHorizontalOverflow(page)).toBe(true);
                await page.screenshot({ path: `${evidence}/${os}-home-start-900.png` });
        });

        test(`${os}: app-bar menu`, async ({ page }) => {
                await page.setViewportSize({ width: 1180, height: 760 });
                await open(page, "expanded", "en", os);
                await openMenu(page);
                const menu = page.getByRole("menu");
                await expect(menu.getByRole("menuitem", { name: "Check this PC again" })).toBeVisible();
                await expect(menu.getByRole("menuitem", { name: "Without changing the BIOS" })).toHaveCount(linux ? 0 : 1);
                // Keyboard movement still reaches every enabled item and wraps.
                await expect(menu.getByRole("menuitem").first()).toBeFocused();
                await page.keyboard.press("End");
                await expect(menu.getByRole("menuitem", { name: "Licenses" })).toBeFocused();
                await page.keyboard.press("ArrowDown");
                await expect(menu.getByRole("menuitem").first()).toBeFocused();
                await page.screenshot({ path: `${evidence}/${os}-menu-1180.png` });
                await page.keyboard.press("Escape");
                await expect(page.getByRole("menu")).toHaveCount(0);
                await expect(page.getByRole("button", { name: "Menu" })).toBeFocused();
        });

        test(`${os}: install-method choice`, async ({ page }) => {
                await page.setViewportSize({ width: 1180, height: 760 });
                await open(page, "not-observed", "en", os);
                await reachInstallQuestion(page);
                const choices = page.getByRole("group", { name: "Choose how to install the BIOS" }).getByRole("radio");
                await expect(choices).toHaveCount(linux ? 3 : 4);
                await expect(page.getByRole("radio", { name: /Maker's Windows program/ })).toHaveCount(linux ? 0 : 1);
                await expect(page.getByRole("radio", { name: /Update tool in BIOS setup/ })).toBeChecked();
                expect(await noHorizontalOverflow(page)).toBe(true);
                await page.screenshot({ path: `${evidence}/${os}-install-method-1180.png` });
                await page.setViewportSize({ width: 900, height: 760 });
                expect(await noHorizontalOverflow(page)).toBe(true);
                await page.screenshot({ path: `${evidence}/${os}-install-method-900.png` });
        });
}

for (const os of systems) {
        test(`${os}: the finish screen`, async ({ page }) => {
                await page.setViewportSize({ width: 1180, height: 760 });
                await open(page, "not-observed", "en", os);
                await button(page, "Get started").click();
                await button(page, "Choose file").click();
                await button(page, "Checked · make the file").click();
                await button(page, "Save to USB").click();
                await button(page, "Restart into BIOS setup").click();
                await page.getByRole("dialog").getByRole("button", { name: "Restart", exact: true }).click();
                await page.reload();
                await button(page, "Record install and settings").click();
                await button(page, "Save these settings").click();
                await button(page, "Restart").click();
                await page.getByRole("dialog").getByRole("button", { name: "Restart", exact: true }).click();
                await page.reload();
                await expect(page.getByRole("img", { name: "Before 256 MiB, now 8 GiB" })).toBeVisible();
                const games = page.getByRole("button", { name: "Turn on for each game" });
                await expect(games).toHaveCount(os === "linux" ? 0 : 1);
                await expect(page.locator("[data-screen] hr.nv-divider")).toHaveCount(os === "linux" ? 0 : 1);
                expect(await noHorizontalOverflow(page)).toBe(true);
                await page.screenshot({ path: `${evidence}/${os}-done-1180.png` });
                await page.setViewportSize({ width: 900, height: 760 });
                expect(await noHorizontalOverflow(page)).toBe(true);
                await page.screenshot({ path: `${evidence}/${os}-done-900.png` });
        });
}

test("linux: a remembered external route opens home instead", async ({ page }) => {
        await open(page, "expanded", "en", "linux");
        await page.evaluate(() => localStorage.setItem("nvstraps-external-resume", "1"));
        await page.reload();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Resizable BAR is on");
        await expect(page.locator(".nv-root")).toHaveAttribute("data-page", "home");
});

test("linux: the OS switch survives the preview state and the language", async ({ page }) => {
        const state: PreviewState = "mixed";
        await open(page, state, "ko", "linux");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("일부 GPU만 확장되어 있습니다");
        await expect(page.getByTestId("home").getByRole("button", { name: "게임마다 켜기" })).toHaveCount(0);
        await expect(page.getByTestId("home").getByRole("button", { name: "BIOS 수정 없이" })).toHaveCount(0);
        await page.screenshot({ path: `${evidence}/linux-ko-home-mixed-1180.png` });
});
