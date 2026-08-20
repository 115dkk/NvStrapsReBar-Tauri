import { expect, test, type Page } from "@playwright/test";

const evidence =
        ".superloopy/evidence/frontend/20260814T055636Z-factual-ui-copy";

const forbiddenEnglish = [
        "EXACT MACHINE / RECOVERABLE ARTIFACT",
        "Exact MSI board recognized",
        "Exact firmware image",
        "NO AUTO-FLASH",
        "Save verified by read-back",
];

const forbiddenKorean = [
        "정확한 컴퓨터 / 복구 가능한 아티팩트",
        "정확한 MSI 보드 확인됨",
        "정확한 펌웨어 이미지",
        "자동 플래시 안 함",
        "다시 읽어 저장 확인 완료",
];

async function expectCopyAbsent(page: Page, copy: readonly string[]) {
        const text = await page.locator("body").innerText();
        for (const phrase of copy) expect(text).not.toContain(phrase);
}

async function expectNoHorizontalOverflow(page: Page) {
        expect(
                await page.evaluate(
                        () =>
                                document.documentElement.scrollWidth <=
                                document.documentElement.clientWidth,
                ),
        ).toBe(true);
}

test("English copy names hardware, selected files, and the next vendor action", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");
        await page.getByRole("button", { name: "Install firmware" }).click();
        await page.getByRole("button", { name: "Choose file" }).click();

        await expect(
                page.getByRole("heading", {
                        name: "Put the NvStraps driver into the motherboard BIOS",
                }),
        ).toBeVisible();
        await expect(
                page
                        .locator(".deployment-content")
                        .getByText("PRO Z690-A DDR4(MS-7D25)"),
        ).toBeVisible();
        await expect(page.getByText("FLASH WITH VENDOR TOOL")).toHaveCount(0);
        await expect(page.getByText("Use the prepared image")).toHaveCount(0);
        await expect(page.getByText("Selected firmware image")).toBeVisible();
        await expect(page.getByText(/E7D25IMS\.1N0 · 32 MiB · SHA-256/)).toBeVisible();
        await expectCopyAbsent(page, forbiddenEnglish);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: `${evidence}/english-deployment-1180x760.png` });

        await page.setViewportSize({ width: 900, height: 760 });
        await page.getByRole("button", { name: "BAR Settings" }).click();
        await expect(page.getByRole("heading", { name: "Firmware behavior" })).toBeVisible();
        await expect(page.getByText(/A rule is a per-GPU exception that overrides the expansion policy/)).toBeVisible();
        await expectCopyAbsent(page, forbiddenEnglish);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: `${evidence}/english-configure-900x760.png` });
});

test("Korean copy states the same facts and actions without accuracy claims", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");
        await page.getByTestId("language-select").selectOption("ko");
        await page.getByRole("button", { name: "펌웨어 설치" }).click();
        await page.getByRole("button", { name: "파일 선택" }).click();

        await expect(
                page.getByRole("heading", { name: "메인보드 BIOS에 NvStraps 드라이버 넣기" }),
        ).toBeVisible();
        await expect(
                page
                        .locator(".deployment-content")
                        .getByText("PRO Z690-A DDR4(MS-7D25)"),
        ).toBeVisible();
        await expect(page.getByText("제조사 도구에서 플래시")).toHaveCount(0);
        await expect(page.getByText("준비된 이미지 사용")).toHaveCount(0);
        await expect(page.getByText("선택한 펌웨어 이미지")).toBeVisible();
        await expect(page.getByText(/E7D25IMS\.1N0 · 32 MiB · SHA-256/)).toBeVisible();
        await expectCopyAbsent(page, forbiddenKorean);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: `${evidence}/korean-deployment-1180x760.png` });

        await page.setViewportSize({ width: 900, height: 760 });
        await page.getByRole("button", { name: "BAR 설정" }).click();
        await expect(page.getByRole("heading", { name: "펌웨어 동작" })).toBeVisible();
        await expect(page.getByText(/규칙은 특정 GPU에만 적용되는 예외로, 위의 확장 정책보다 우선합니다/)).toBeVisible();
        await expectCopyAbsent(page, forbiddenKorean);
        await expectNoHorizontalOverflow(page);
        expect(await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? [])).toEqual([]);
        await page.screenshot({ path: `${evidence}/korean-configure-900x760.png` });
});
