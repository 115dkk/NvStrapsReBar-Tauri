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
        await page.getByRole("button", { name: "Deploy" }).click();
        await page.getByRole("button", { name: "Choose file" }).click();

        await expect(
                page.getByRole("heading", {
                        name: "Firmware preparation and installation",
                }),
        ).toBeVisible();
        await expect(page.getByText("PRO Z690-A DDR4(MS-7D25)")).toBeVisible();
        await expect(page.getByText("FLASH WITH VENDOR TOOL")).toBeVisible();
        await expect(page.getByText("Selected firmware image")).toBeVisible();
        await expect(page.getByText(/E7D25IMS\.1N0 · 32 MiB · SHA-256/)).toBeVisible();
        await expectCopyAbsent(page, forbiddenEnglish);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: `${evidence}/english-deployment-1180x760.png` });

        await page.setViewportSize({ width: 900, height: 760 });
        await page.getByRole("button", { name: "Configure" }).click();
        await expect(page.getByRole("heading", { name: "Firmware behavior" })).toBeVisible();
        await expect(page.getByText("Hardware changes")).toBeVisible();
        await expect(page.getByText("Match rules by PCI location. Maximum eight.")).toBeVisible();
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
        await page.getByRole("button", { name: "배포" }).click();
        await page.getByRole("button", { name: "파일 선택" }).click();

        await expect(
                page.getByRole("heading", { name: "펌웨어 준비 및 적용" }),
        ).toBeVisible();
        await expect(page.getByText("PRO Z690-A DDR4(MS-7D25)")).toBeVisible();
        await expect(page.getByText("제조사 도구에서 플래시")).toBeVisible();
        await expect(page.getByText("선택한 펌웨어 이미지")).toBeVisible();
        await expect(page.getByText(/E7D25IMS\.1N0 · 32 MiB · SHA-256/)).toBeVisible();
        await expectCopyAbsent(page, forbiddenKorean);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: `${evidence}/korean-deployment-1180x760.png` });

        await page.setViewportSize({ width: 900, height: 760 });
        await page.getByRole("button", { name: "구성" }).click();
        await expect(page.getByRole("heading", { name: "펌웨어 동작" })).toBeVisible();
        await expect(page.getByText("하드웨어 변경")).toBeVisible();
        await expect(page.getByText("규칙은 PCI 위치로 연결합니다. 최대 8개까지 만들 수 있습니다.")).toBeVisible();
        await expectCopyAbsent(page, forbiddenKorean);
        await expectNoHorizontalOverflow(page);
        expect(await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? [])).toEqual([]);
        await page.screenshot({ path: `${evidence}/korean-configure-900x760.png` });
});
