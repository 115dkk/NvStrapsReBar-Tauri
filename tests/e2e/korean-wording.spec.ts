import { expect, test } from "@playwright/test";

const evidence = ".superloopy/evidence/frontend/20260907T023259Z-korean-route-wording";
for (const width of [1180, 900]) {
        test(`Korean installation uses methods, not metaphorical routes, at ${width}px`, async ({ page }) => {
                await page.setViewportSize({ width, height: 760 });
                await page.goto("/");
                await page.getByTestId("language-select").selectOption("ko");
                await page.getByRole("button", { name: "펌웨어 설치", exact: true }).click();
                await page.getByRole("button", { name: "파일 선택" }).click();
                await page.getByText("이 보드의 제조사 설치 및 복구 지침을 확인했습니다.").click();
                await page.getByRole("button", { name: "이 컴퓨터의 프로필 만들기" }).click();
                await page.getByRole("button", { name: "BIOS 이미지 준비" }).click();
                await expect(page.getByRole("heading", { name: "제조사 안내에 따라 플래시", exact: true })).toBeVisible();
                await expect(page.getByRole("note", { name: "시작하기 전에" })).toContainText("선택한 복구 방법");
                await expect(page.getByRole("textbox", { name: "패키지 저장 폴더" })).toBeVisible();
                await page.getByText("전체 설치 단계", { exact: true }).click();
                await expect(page.getByRole("list", { name: "배포 계획" })).toContainText("펌웨어 복구 방법 기록");
                expect(await page.locator("main").innerText()).not.toContain("경로");
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
                await page.locator(".active-workflow").scrollIntoViewIfNeeded();
                await page.screenshot({ path: `${evidence}/korean-install-${width}.png` });
                expect(await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? [])).toEqual([]);
        });
}
