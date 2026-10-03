import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { button, missingMessages, noHorizontalOverflow, open, type PreviewState } from "./support";

const evidence = ".superloopy/evidence/frontend/20261003T023011Z-games-driver-switches";
mkdirSync(evidence, { recursive: true });

type GamesState = "ready" | "unavailable" | "write-fails" | "readback-fails";

/** Opens the per-game page on a preview driver database. */
async function openGames(page: Page, { system = "expanded", games = "ready", locale = "en" }: { system?: PreviewState; games?: GamesState; locale?: "en" | "ko" } = {}) {
        await open(page, system, locale);
        await page.evaluate((value) => sessionStorage.setItem("nvstraps-preview-games-state", value), games);
        await page.reload();
        await page.getByRole("button", { name: locale === "ko" ? "게임마다 켜기" : "Turn on for each game" }).click();
        await expect(page.getByTestId("games-page")).toBeVisible();
}

const search = (page: Page) => page.getByRole("searchbox", { name: "Find a game" });
const results = (page: Page) => page.getByRole("list", { name: "Find a game" });
const allGames = (page: Page) => page.getByRole("switch", { name: "All games" });

test("a game switch turns it on, reads the state back, and lists it as changed", async ({ page }) => {
        await openGames(page);
        await expect(page.getByText("30 games in driver 616.64")).toBeVisible();
        await search(page).fill("elden");
        await expect(page.getByText("1 found")).toBeVisible();
        const elden = results(page).getByRole("switch", { name: "Elden Ring" });
        await expect(elden).toHaveAttribute("aria-checked", "false");
        await elden.click();
        // The switch shows the request while the driver write runs.
        await expect(elden).toHaveAttribute("aria-busy", "true");
        await expect(elden).toHaveAttribute("aria-checked", "true");
        await expect(elden).not.toHaveAttribute("aria-busy", "true");
        await expect(page.getByRole("status").filter({ hasText: "Elden Ring: on" })).toBeAttached();
        const changed = page.getByRole("list", { name: "Games changed on this PC" });
        await expect(changed.getByRole("switch", { name: "Elden Ring" })).toHaveAttribute("aria-checked", "true");
        await expect(changed.getByText("eldenring.exe and 1 more · Changed on this PC")).toBeVisible();
        // The first change saved a backup.
        await page.getByTestId("games-backup").locator("summary").click();
        await expect(page.getByText("Full copy of the NVIDIA driver settings")).toBeVisible();
        await expect(page.getByText("Profiles changed on this PC: 1")).toBeVisible();
        await page.screenshot({ path: `${evidence}/e2e-en-game-on-1180.png`, fullPage: true });
        // Turning it off returns to the driver default; the row stays for this visit.
        await changed.getByRole("switch", { name: "Elden Ring" }).click();
        await expect(changed.getByRole("switch", { name: "Elden Ring" })).toHaveAttribute("aria-checked", "false");
        await expect(changed.getByText("eldenring.exe and 1 more", { exact: true })).toBeVisible();
        expect(await missingMessages(page)).toEqual([]);
});

test("a game NVIDIA turns on can be turned off", async ({ page }) => {
        await openGames(page);
        await search(page).fill("rdr2");
        const red = page.getByRole("switch", { name: "Red Dead Redemption 2" });
        await expect(red).toHaveAttribute("aria-checked", "true");
        await expect(page.getByText("RDR2.exe · NVIDIA default")).toBeVisible();
        await red.click();
        await expect(red).toHaveAttribute("aria-checked", "false");
        await expect(page.getByRole("list", { name: "Games changed on this PC" }).getByText("RDR2.exe · Changed on this PC")).toBeVisible();
});

test("all games needs consent, Escape keeps it off, and turning it off asks nothing", async ({ page }) => {
        await openGames(page);
        await allGames(page).click();
        const dialog = page.getByRole("dialog", { name: "Turn on Resizable BAR for all games" });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(dialog.getByRole("button", { name: "Turn on for all" })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
        await page.screenshot({ path: `${evidence}/e2e-en-all-games-consent-1180.png` });
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(allGames(page)).toHaveAttribute("aria-checked", "false");
        await expect(allGames(page)).toBeFocused();

        await allGames(page).click();
        await dialog.getByRole("button", { name: "Turn on for all" }).click();
        await expect(allGames(page)).toHaveAttribute("aria-checked", "true");
        await expect(allGames(page)).not.toHaveAttribute("aria-busy", "true");
        await search(page).fill("counter");
        await expect(page.getByText("cs2.exe · All games setting")).toBeVisible();
        await expect(page.getByRole("switch", { name: "Counter-Strike 2" })).toHaveAttribute("aria-checked", "true");

        await allGames(page).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(allGames(page)).toHaveAttribute("aria-checked", "false");
        await expect(page.getByRole("switch", { name: "Counter-Strike 2" })).toHaveAttribute("aria-checked", "false");
});

test("the undo returns the changed profiles to their earlier values", async ({ page }) => {
        await openGames(page);
        await page.getByTestId("games-backup").locator("summary").click();
        await expect(page.getByText("The first change saves the earlier values and a full copy of the NVIDIA driver settings first.")).toBeVisible();
        await search(page).fill("elden");
        await results(page).getByRole("switch", { name: "Elden Ring" }).click();
        await search(page).fill("rdr2");
        await results(page).getByRole("switch", { name: "Red Dead Redemption 2" }).click();
        await expect(page.getByText("Profiles changed on this PC: 2")).toBeVisible();
        await expect(page.getByText("Full copy of the NVIDIA driver settings")).toBeVisible();
        await button(page, "Restore the earlier values").click();
        const dialog = page.getByRole("dialog", { name: "Restore the earlier values" });
        await expect(dialog).toContainText("The Resizable BAR values of the profiles changed on this PC (2) return to what they were before the app first changed them.");
        await page.screenshot({ path: `${evidence}/e2e-en-undo-dialog-1180.png` });
        await dialog.getByRole("button", { name: "Restore" }).click();
        await expect(page.getByRole("status").filter({ hasText: "Earlier values restored" })).toBeAttached();
        const changed = page.getByRole("list", { name: "Games changed on this PC" });
        await expect(changed.getByRole("switch", { name: "Elden Ring" })).toHaveAttribute("aria-checked", "false");
        await expect(changed.getByRole("switch", { name: "Red Dead Redemption 2" })).toHaveAttribute("aria-checked", "true");
        await expect(changed.getByText("RDR2.exe · NVIDIA default")).toBeVisible();
});

test("without administrator rights the switches wait for a reopen", async ({ page }) => {
        await openGames(page, { system: "expanded-no-access" });
        await expect(page.getByRole("heading", { name: "Reopen as administrator" })).toBeVisible();
        await expect(allGames(page)).toBeDisabled();
        await search(page).fill("elden");
        await expect(page.getByRole("switch", { name: "Elden Ring" })).toBeDisabled();
});

test("failures keep the old state and name the next action", async ({ page }) => {
        await openGames(page, { games: "unavailable", locale: "ko" });
        await expect(page.getByRole("alert")).toContainText("NVIDIA 드라이버 설정을 읽지 못했습니다");
        await expect(page.getByRole("alert")).toContainText("NVIDIA 그래픽 드라이버를 설치한 뒤 다시 읽으세요.");
        // The backend message and the log path stay on screen for the test report.
        await expect(page.getByRole("alert")).toContainText("nvapi64.dll returned NvAPI status -2 (log: C:\\Users\\Preview\\AppData\\Local\\io.github.nvstrapsrebar.desktop\\logs\\driver-settings.log)");
        await page.screenshot({ path: `${evidence}/e2e-ko-driver-unavailable-1180.png` });
        await page.evaluate(() => sessionStorage.setItem("nvstraps-preview-games-state", "ready"));
        await button(page, "다시 읽기").click();
        await expect(page.getByRole("switch", { name: "모든 게임" })).toBeVisible();

        await page.evaluate(() => sessionStorage.setItem("nvstraps-preview-games-state", "readback-fails"));
        await page.getByRole("searchbox", { name: "게임 찾기" }).fill("elden");
        const elden = page.getByRole("switch", { name: "Elden Ring" });
        await elden.click();
        await expect(page.getByRole("alert")).toContainText("바꾼 값이 드라이버에 남지 않았습니다.");
        await expect(page.getByRole("alert")).toContainText("the NVIDIA driver did not keep the requested Resizable BAR value (log: ");
        await expect(elden).toHaveAttribute("aria-checked", "false");
        await expect(page.getByRole("list", { name: "이 PC에서 바꾼 게임" })).toHaveCount(0);
});

test("skipped profiles are counted and the log is one click away", async ({ page }) => {
        await openGames(page, { games: "partial" });
        await expect(page.getByRole("note")).toContainText("Profiles that could not be read: 3");
        await expect(page.getByRole("note")).toContainText("driver-settings.log");
        await page.getByTestId("games-backup").locator("summary").click();
        await expect(page.getByText("Diagnostic log", { exact: true })).toBeVisible();
        await page.screenshot({ path: `${evidence}/e2e-en-skipped-and-log-1180.png`, fullPage: true });
});

test("the page fits the minimum window in both languages", async ({ page }) => {
        for (const locale of ["en", "ko"] as const) {
                await page.setViewportSize({ width: 900, height: 620 });
                await openGames(page, { locale });
                await page.getByRole("searchbox").fill("e");
                await expect(page.getByRole("switch").nth(1)).toBeVisible();
                expect(await noHorizontalOverflow(page)).toBe(true);
                await page.screenshot({ path: `${evidence}/e2e-${locale}-games-900x620.png` });
        }
});
