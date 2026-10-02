import { expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

export const evidence = ".superloopy/evidence/frontend/20261002T183000Z-guided-redesign-app";
mkdirSync(evidence, { recursive: true });

export type PreviewState = "expanded" | "not-observed" | "driver-cleared" | "mixed" | "unavailable" | "expanded-no-access";

/** Opens the preview with a clean session, a chosen system state and language. */
export async function open(page: Page, state: PreviewState = "expanded", locale: "en" | "ko" = "en") {
        await page.goto("/");
        await page.evaluate(
                ([value, language]) => {
                        localStorage.clear();
                        sessionStorage.clear();
                        localStorage.setItem("nvstraps-rebar.ui.language", language);
                        sessionStorage.setItem("nvstraps-preview-rebar-state", value);
                },
                [state, locale] as const,
        );
        await page.reload();
        await expect(page.locator(".nv-root")).toBeVisible();
}

export const noHorizontalOverflow = (page: Page) =>
        page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

export const missingMessages = (page: Page) => page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? []);

export const screen = (page: Page) => page.locator("[data-screen]");

export const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

/** Walks the English install journey up to the screen before the BIOS restart. */
export async function reachGuide(page: Page) {
        await open(page, "not-observed");
        await button(page, "Get started").click();
        await button(page, "Choose file").click();
        await expect(page.getByRole("heading", { name: "Check the install and recovery methods" })).toBeVisible();
        await button(page, "Checked · make the file").click();
        await expect(page.getByRole("heading", { name: "Save to USB" })).toBeVisible();
        await button(page, "Save to USB").click();
        await expect(page.getByRole("heading", { name: "Now install it in BIOS setup" })).toBeVisible();
}

/** Restarts into BIOS setup through the dialog and reopens the app afterwards. */
export async function restartIntoBiosAndReturn(page: Page) {
        await button(page, "Restart into BIOS setup").click();
        await page.getByRole("dialog").getByRole("button", { name: "Restart", exact: true }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await page.reload();
        await expect(page.getByRole("heading", { name: "Record what you did in BIOS setup" })).toBeVisible();
}

/** Continues to the screen that saves the recommended BAR settings. */
export async function reachTurnOn(page: Page) {
        await reachGuide(page);
        await restartIntoBiosAndReturn(page);
        await button(page, "Record install and settings").click();
        await expect(page.getByRole("heading", { name: "Ready to turn on Resizable BAR" })).toBeVisible();
}

export async function chooseLanguage(page: Page, label: "English" | "한국어") {
        await page.getByRole("button", { name: /^(Menu|메뉴)$/ }).click();
        await page.getByRole("menuitemradio", { name: label }).click();
}
