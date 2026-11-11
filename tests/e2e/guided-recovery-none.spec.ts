import { expect, test, type Page } from "@playwright/test";
import { button, missingMessages, noHorizontalOverflow, open } from "./support";

/**
 * A board with no way to put its BIOS back (issue #63). The answer used to stop the record, so a
 * tester chose a method the board does not have. It goes on now, after one confirmation that
 * lists what can go wrong. Browser preview only; `?os=linux` makes the preview report Linux.
 */
const systems = ["windows", "linux"] as const;

const dialog = (page: Page) => page.getByRole("dialog", { name: "Go on without a way to recover" });

/** From the start screen to the recovery question, answering the install question as offered. */
async function reachRecoveryQuestion(page: Page) {
        await button(page, "Get started").click();
        await button(page, "Choose file").click();
        await page.getByText("Choose other install and recovery methods").click();
        await button(page, "Choose manually").click();
        await button(page, "Next").click();
        await button(page, "Next").click();
        await expect(page.getByRole("heading", { name: "Choose how to recover if the BIOS install fails" })).toBeVisible();
}

for (const os of systems) {
        test(`${os}: no way to recover goes on after one confirmation that lists what can go wrong`, async ({ page }) => {
                await page.setViewportSize({ width: 1180, height: 760 });
                await open(page, "not-observed", "en", os);
                await reachRecoveryQuestion(page);

                await page.getByRole("radio", { name: /No way to recover/ }).check();
                await expect(page.getByText("The board has none of the above")).toBeVisible();
                await expect(page.getByText("A confirmation opens before the file is made.")).toBeVisible();
                const make = button(page, "Checked · make the file");
                await expect(make).toBeEnabled();

                // The first press only opens the confirmation; closing it leaves the question as it was.
                await make.click();
                await expect(dialog(page)).toBeVisible();
                // Three things that can go wrong, then, below a line, what there is to do when one has.
                await expect(dialog(page).getByRole("listitem")).toHaveCount(3);
                await expect(dialog(page).getByRole("listitem").first()).toContainText("the PC no longer starts");
                await expect(dialog(page).getByRole("listitem").last()).toHaveText("A board with a changed BIOS may be refused warranty service.");
                const remedy = dialog(page).locator(".nv-dialog-remedy");
                await expect(remedy).toContainText("What to do then");
                await expect(remedy).toContainText("takes a repair shop or an SPI programmer");
                await button(page, "Close").click();
                await expect(dialog(page)).toBeHidden();
                await expect(page.getByRole("heading", { name: "Choose how to recover if the BIOS install fails" })).toBeVisible();
                await expect(make).toBeFocused();

                await make.click();
                await button(page, "Make the file anyway").click();
                await expect(page.getByRole("heading", { name: "Save to USB" })).toBeVisible();
                expect(await missingMessages(page)).toEqual([]);
        });
}

test("a recovery method the board has still makes the file without the confirmation", async ({ page }) => {
        await open(page, "not-observed", "en");
        await reachRecoveryQuestion(page);
        await page.getByRole("radio", { name: /External SPI programmer/ }).check();
        await button(page, "Checked · make the file").click();
        await expect(page.getByRole("heading", { name: "Save to USB" })).toBeVisible();
        await expect(dialog(page)).toHaveCount(0);
});

test("Korean: the confirmation fits the 900 px minimum window", async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 620 });
        await open(page, "not-observed", "ko");
        await button(page, "시작하기").click();
        await button(page, "파일 고르기").click();
        await page.getByText("다른 설치·복구 방법 고르기").click();
        await button(page, "직접 고르기").click();
        await button(page, "다음").click();
        await button(page, "다음").click();
        await page.getByRole("radio", { name: /복구 수단 없음/ }).check();
        await button(page, "확인 완료 · 파일 만들기").click();
        const korean = page.getByRole("dialog", { name: "복구 수단 없이 진행" });
        await expect(korean).toBeVisible();
        await expect(korean.getByRole("listitem")).toHaveCount(3);
        await expect(korean.getByRole("listitem").last()).toHaveText("BIOS를 바꾼 보드는 보증 수리를 거절당할 수 있습니다.");
        await expect(korean.locator(".nv-dialog-remedy")).toContainText("대응법");
        await expect(korean.locator(".nv-dialog-remedy")).toContainText("그때 원본 BIOS를 되돌리려면");
        await expect(button(page, "그래도 만들기")).toBeVisible();
        expect(await noHorizontalOverflow(page)).toBe(true);
        expect(await missingMessages(page)).toEqual([]);
});
