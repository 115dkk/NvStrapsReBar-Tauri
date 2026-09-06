import { expect, test, type Page } from "@playwright/test";

const evidence =
        ".superloopy/evidence/frontend/20260814T103841Z-dynamic-next-step";

const nextStepCard = (page: Page) =>
        page.locator(".deployment-rail .rail-note");

async function chooseFirmwareAndCreateProfile(
        page: Page,
        locale: "en" | "ko",
) {
        await page.getByRole("button", { name: locale === "ko" ? "펌웨어 설치" : "Install firmware" }).click();
        await expect(nextStepCard(page)).toHaveCount(0);
        await page
                .getByRole("button", { name: locale === "ko" ? "파일 선택" : "Choose file" })
                .click();
        const notice = page.locator(".deployment-content .notice");
        await expect(notice).toContainText(
                locale === "ko"
                        ? "BIOS 이미지를 불러왔습니다."
                        : "BIOS image loaded.",
        );
        await expect(
                page.getByRole("button", {
                        name:
                                locale === "ko"
                                        ? "작업 상태 닫기"
                                        : "Dismiss operation status",
                }),
        ).toHaveCount(0);
        await page
                .getByText(
                        locale === "ko"
                                ? "이 보드의 제조사 설치 및 복구 지침을 확인했습니다."
                                : "I checked the vendor install and recovery instructions for this board.",
                )
                .click();
        await page
                .getByRole("button", {
                        name:
                                locale === "ko"
                                        ? "이 컴퓨터의 프로필 만들기"
                                        : "Create profile for this computer",
                })
                .click();
}

test("English rail shows the literal next plan step and updates after advance", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");
        await chooseFirmwareAndCreateProfile(page, "en");

        const card = nextStepCard(page);
        await expect(card.getByText("Next step", { exact: true })).toBeVisible();
        await expect(card).toContainText(
                "Add the driver to the BIOS image",
        );
        await expect(card.locator("a, button, input, select, textarea")).toHaveCount(0);
        await expect(card).not.toHaveAttribute("tabindex");
        await page.screenshot({ path: `${evidence}/english-before-advance-1180x760.png` });

        await page
                .getByRole("button", { name: "Prepare BIOS image" })
                .click();
        await expect(card).toContainText("Confirm firmware setup values");
        await expect(card).not.toContainText(
                "Add the driver to the BIOS image",
        );
        await page.screenshot({ path: `${evidence}/english-after-advance-1180x760.png` });
});

test("Korean rail shows the translated next plan step at the 900 px minimum", async ({
        page,
}) => {
        await page.setViewportSize({ width: 900, height: 760 });
        await page.goto("/");
        await page.getByTestId("language-select").selectOption("ko");
        await chooseFirmwareAndCreateProfile(page, "ko");

        const card = nextStepCard(page);
        await expect(card.getByText("다음 단계", { exact: true })).toBeVisible();
        await expect(card).toContainText("BIOS 이미지에 드라이버 추가");
        await page.screenshot({ path: `${evidence}/korean-before-advance-900x760.png` });

        await page
                .getByRole("button", { name: "BIOS 이미지 준비" })
                .click();
        await expect(card).toContainText("펌웨어 설정값 확인");
        await expect(card).not.toContainText("BIOS 이미지에 드라이버 추가");
        expect(
                await page.evaluate(
                        () =>
                                document.documentElement.scrollWidth <=
                                document.documentElement.clientWidth,
                ),
        ).toBe(true);
        await page.screenshot({ path: `${evidence}/korean-after-advance-900x760.png` });
});
