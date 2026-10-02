import { expect, test } from "@playwright/test";
import { button, evidence, missingMessages, noHorizontalOverflow, open, type PreviewState } from "./support";

const cases: { state: PreviewState; title: string; chip: string; action?: string }[] = [
        { state: "expanded", title: "Resizable BAR is on", chip: "Resizable BAR on · 8 GiB" },
        { state: "not-observed", title: "You can turn on Resizable BAR", chip: "Resizable BAR off · 256 MiB", action: "Get started" },
        { state: "driver-cleared", title: "NvStrapsReBar is running, but expansion is off", chip: "Resizable BAR off · 256 MiB", action: "Open BAR settings" },
        { state: "mixed", title: "Only some GPUs are expanded", chip: "Resizable BAR partly on", action: "Open BAR settings" },
        { state: "unavailable", title: "Check the Resizable BAR status again", chip: "Needs a check", action: "Check status again" },
];

for (const { state, title, chip, action } of cases) {
        test(`home opens on the state of this PC: ${state}`, async ({ page }) => {
                await page.setViewportSize({ width: 1180, height: 760 });
                await open(page, state);
                await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
                await expect(page.getByRole("banner").getByRole("status")).toHaveText(chip);
                if (action) await expect(button(page, action)).toBeVisible();
                await expect(page.getByRole("complementary", { name: "Setup progress" })).toHaveCount(0);
                expect(await noHorizontalOverflow(page)).toBe(true);
                await page.screenshot({ path: `${evidence}/en-home-${state}-1180.png` });
        });
}

test("mixed apertures name the GPU that is still at 256 MiB", async ({ page }) => {
        await open(page, "mixed");
        await expect(page.getByText("NVIDIA Quadro RTX 4000 is still at 256 MiB. Check its size in BAR settings.")).toBeVisible();
        await expect(page.locator(".nv-gpu")).toHaveCount(2);
});

test("home rows reach every page and each page returns home", async ({ page }) => {
        await open(page, "expanded");
        for (const [row, heading] of [
                ["BAR Settings", "BAR Settings"],
                ["Turn on for each game", "Turn on Resizable BAR for the games you play"],
                ["When you change the BIOS or hardware", "What to do when you change the BIOS or hardware"],
        ] as const) {
                await page.getByRole("button", { name: row }).first().click();
                await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
                await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
                await button(page, "Home").click();
                await expect(page.getByRole("heading", { name: "Resizable BAR is on" })).toBeVisible();
        }
});

test("the per-game page opens Profile Inspector after a backup and keeps the step optional", async ({ page }) => {
        await open(page, "expanded");
        await page.getByRole("button", { name: "Turn on for each game" }).click();
        await expect(page.getByText("Under 5 - Common, set rBAR - Feature to Enabled.")).toBeVisible();
        await expect(page.getByText("Install NVIDIA Profile Inspector from its GitHub page and follow the same steps.")).toBeVisible();
        await expect(button(page, "Open Profile Inspector")).toHaveCount(0);
        await page.screenshot({ path: `${evidence}/en-games-without-record-1180.png` });
});

test("the menu is keyboard-operable and switches language in place", async ({ page }) => {
        await open(page, "expanded");
        const menuButton = page.getByRole("button", { name: "Menu" });
        await menuButton.focus();
        await page.keyboard.press("Enter");
        const menu = page.getByRole("menu", { name: "Menu" });
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: "Check this PC again" })).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(menu.getByRole("menuitem", { name: "Installation record" })).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
        await expect(menuButton).toBeFocused();
        await menuButton.click();
        await page.getByRole("menuitemradio", { name: "한국어" }).click();
        await expect(page.locator("html")).toHaveAttribute("lang", "ko");
        await expect(page.getByRole("heading", { name: "Resizable BAR가 켜져 있습니다" })).toBeVisible();
        await page.reload();
        await expect(page.getByRole("heading", { name: "Resizable BAR가 켜져 있습니다" })).toBeVisible();
        await page.getByRole("button", { name: "메뉴" }).click();
        await expect(page.getByRole("menuitemradio", { name: "한국어" })).toHaveAttribute("aria-checked", "true");
        expect(await missingMessages(page)).toEqual([]);
});

test("Korean home fits the 900 px minimum window", async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 620 });
        await open(page, "expanded", "ko");
        await expect(page.getByRole("heading", { name: "Resizable BAR가 켜져 있습니다" })).toBeVisible();
        expect(await noHorizontalOverflow(page)).toBe(true);
        await page.screenshot({ path: `${evidence}/ko-home-on-900x620.png` });
});
