import { expect, test } from "@playwright/test";

const evidence = ".superloopy/evidence/frontend/20260814T010925Z-i18n-korean-ui";
const factualCopyEvidence = ".superloopy/evidence/frontend/20260814T055636Z-factual-ui-copy";

test("language switch is accessible, immediate, persisted, and preserves the draft", async ({ page }) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");
        const selector = page.getByTestId("language-select");
        await expect(selector).toHaveAccessibleName("Language");
        await page.getByLabel("Registry + fallback").check();
        await selector.focus();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await expect(page.locator("html")).toHaveAttribute("lang", "ko");
        await expect(selector).toHaveAccessibleName("언어");
        await expect(page.getByRole("heading", { name: "펌웨어 구성" })).toBeVisible();
        await expect(page.getByText("저장하지 않은 변경 사항")).toBeVisible();
        await expect(page.getByLabel("레지스트리 + 대체값")).toBeChecked();
        await expect(page.getByText("감지된 NVIDIA GPU", { exact: true })).toBeVisible();
        await page.screenshot({ path: `${evidence}/korean-configure-1180x760.png`, fullPage: true });
        await page.screenshot({ path: `${evidence}/gallery-korean-configure-1180x760.png` });
        expect(await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? [])).toEqual([]);
        await page.reload();
        await expect(page.locator("html")).toHaveAttribute("lang", "ko");
        await expect(page.getByRole("heading", { name: "펌웨어 구성" })).toBeVisible();
});

test("Korean consequential configuration modal remains truthful at the minimum width", async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 760 });
        await page.goto("/");
        await page.getByTestId("language-select").selectOption("ko");
        await page.getByLabel("레지스트리 + 대체값").check();
        await page.getByRole("button", { name: "검토 후 저장" }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText("이 초안을 UEFI 펌웨어에 기록할까요?");
        await expect(dialog).toContainText("다시 시작해야 합니다");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.screenshot({ path: `${evidence}/korean-save-modal-900x760.png`, fullPage: true });
        expect(await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? [])).toEqual([]);
});

test("Korean deployment and legacy states preserve firmware facts", async ({ page }) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");
        await page.getByTestId("language-select").selectOption("ko");
        await page.getByRole("button", { name: "배포" }).click();
        await expect(page.getByRole("heading", { name: "배포 작업 공간" })).toBeVisible();
        await expect(page.getByText("제조사 도구에서 플래시")).toBeVisible();
        await page.getByLabel("보드 경로").selectOption("legacyAbove4g");
        await page.getByRole("button", { name: "파일 선택" }).click();
        await expect(page.getByText(/E7D25IMS\.1N0 · 32 MiB/)).toBeVisible();
        await page.getByRole("button", { name: "이미지 분석" }).click();
        await expect(page.getByRole("heading", { name: "레거시 패치 분석" })).toBeVisible();
        await expect(page.getByText(/SHA-256/).first()).toBeVisible();
        await page.screenshot({ path: `${evidence}/korean-legacy-analysis-1180x760.png`, fullPage: true });
        await page.setViewportSize({ width: 900, height: 760 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.screenshot({ path: `${evidence}/korean-deployment-900x760.png`, fullPage: true });
        expect(await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? [])).toEqual([]);
});

test("English is the fallback and remains selectable", async ({ page }) => {
        await page.goto("/");
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
        await page.getByTestId("language-select").selectOption("ko");
        await page.getByTestId("language-select").selectOption("en");
        await expect(page.getByRole("heading", { name: "Firmware configuration" })).toBeVisible();
});

test("Korean deployment reaches the recommended configuration without missing catalog entries", async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 760 });
        await page.goto("/");
        await page.getByTestId("language-select").selectOption("ko");
        await page.getByRole("button", { name: "배포" }).click();
        await page.getByRole("button", { name: "파일 선택" }).click();
        await page.getByText("이 보드의 제조사 설치 및 복구 지침을 확인했습니다.").click();
        await page.getByRole("button", { name: "이 컴퓨터의 프로필 만들기" }).click();
        await expect(page.getByText("Rust DXE 드라이버 빌드 및 검사", { exact: true }).first()).toBeVisible();
        await page.getByRole("button", { name: "펌웨어 아티팩트 준비 및 검사" }).click();
        for (let gate = 0; gate < 2; gate += 1) {
                await page.getByRole("button", { name: "완료한 단계 검토 및 확인" }).click();
                const dialog = page.getByRole("dialog");
                await dialog.getByLabel("이 단계를 완료하고 결과를 검토했습니다.").check();
                await dialog.getByRole("button", { name: "완료한 단계 기록" }).click();
        }
        await page.getByRole("button", { name: "현재 부팅 및 Rust DXE 상태 확인" }).click();
        await expect(page.getByText("권장 배포 구성")).toBeVisible();
        await expect(page.getByText(/백엔드/)).toHaveCount(0);
        await expect(page.getByText("프로필 ID", { exact: true })).toHaveCount(0);
        await expect(page.getByText("계획 리비전", { exact: true })).toHaveCount(0);
        await expect(page.getByText(/리비전 \d+/)).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.screenshot({ path: `${evidence}/gallery-korean-recommendation-900x760.png` });
        await page.screenshot({ path: `${factualCopyEvidence}/korean-recommendation-900x760.png` });
        expect(await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? [])).toEqual([]);
});
