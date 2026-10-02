import { expect, test, type Page } from "@playwright/test";
import { button, missingMessages, open } from "./support";

/**
 * Screen copy states what the user does next and what the app just did.
 * It never lists what the app does not do, and it never claims safety.
 */
const negativeEnglish = /\b(?:the|this) app\b[^.]*\b(?:does not|doesn't|cannot|can't|won't|never|is not able)\b/i;
const negativeKorean = /앱[은이]\s?[^.]*?(?:않습니다|않는|못합니다|못하|없습니다)/;
const claims = /\bsafe(?:ly)?\b|\bguarantee|\bverified\b|안전|보장|검증된/i;

async function collect(page: Page, locale: "en" | "ko") {
        const ko = locale === "ko";
        const texts: string[] = [];
        const grab = async () => texts.push(await page.locator(".nv-root").innerText());
        await open(page, "not-observed", locale);
        await grab();
        await button(page, ko ? "시작하기" : "Get started").click();
        await grab();
        await button(page, ko ? "파일 고르기" : "Choose file").click();
        await grab();
        await button(page, ko ? "확인 완료 · 파일 만들기" : "Checked · make the file").click();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(ko ? "USB에 저장하세요" : "Save to USB");
        await grab();
        await button(page, ko ? "USB에 저장" : "Save to USB").click();
        await grab();
        await button(page, ko ? "BIOS에서 설치를 마쳤습니다" : "I finished in BIOS setup").click();
        await grab();
        await button(page, ko ? "BIOS 화면으로 다시 시작" : "Restart into BIOS setup").click();
        await grab();
        await page.getByRole("dialog").getByRole("button", { name: ko ? "다시 시작" : "Restart", exact: true }).click();
        await page.reload();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(ko ? "BIOS 화면에서 한 일을 기록하세요" : "Record what you did in BIOS setup");
        await grab();
        await button(page, ko ? "설치·설정 완료 기록" : "Record install and settings").click();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(ko ? "Resizable BAR를 켤 준비가 됐습니다" : "Ready to turn on Resizable BAR");
        await grab();
        await button(page, ko ? "이 설정으로 저장" : "Save these settings").click();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(ko ? "다시 시작하면 켜집니다" : "Restart to turn it on");
        await grab();
        await button(page, ko ? "다시 시작" : "Restart").click();
        await page.getByRole("dialog").getByRole("button", { name: ko ? "다시 시작" : "Restart", exact: true }).click();
        await page.reload();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(ko ? "Resizable BAR가 켜졌습니다" : "Resizable BAR is on");
        await grab();
        await button(page, ko ? "완료" : "Done").click();
        await grab();
        for (const row of ko ? ["게임마다 켜기", "BIOS나 하드웨어를 바꿀 때"] : ["Turn on for each game", "When you change the BIOS or hardware"]) {
                await page.getByRole("button", { name: row }).click();
                await grab();
                await button(page, ko ? "홈" : "Home").click();
        }
        expect(await missingMessages(page)).toEqual([]);
        return texts;
}

test("English screens describe the next action without listing what the app does not do", async ({ page }) => {
        const texts = await collect(page, "en");
        for (const text of texts) {
                expect(text).not.toMatch(negativeEnglish);
                expect(text).not.toMatch(claims);
                expect(text).not.toContain("—");
        }
});

test("Korean screens describe the next action without listing what the app does not do", async ({ page }) => {
        const texts = await collect(page, "ko");
        for (const text of texts) {
                expect(text).not.toMatch(negativeKorean);
                expect(text).not.toMatch(claims);
                expect(text).not.toContain("경로");
                expect(text).not.toContain("—");
                // "드라이버" is reserved for the NVIDIA graphics driver.
                expect(text).not.toMatch(/(?<!NVIDIA )드라이버/);
        }
});

test("headings carry no board, GPU, or file names", async ({ page }) => {
        await open(page, "not-observed");
        await button(page, "Get started").click();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Choose the motherboard BIOS file");
        await button(page, "Choose file").click();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check the install and recovery methods");
        await expect(page.getByRole("heading", { level: 1 })).not.toContainText(/MSI|PRO Z690|M-FLASH|E7D25/);
});
