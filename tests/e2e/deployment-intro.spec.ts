import { expect, test, type Page } from "@playwright/test";

const evidence =
        ".superloopy/evidence/frontend/20260815T130951Z-remove-dummy-flash-badge";

const redundantBadge = (page: Page) => page.locator(".truth-badge");
const manualHandoff = (page: Page) =>
        page.locator('section[data-manual-step][aria-labelledby="manual-handoff-title"]');

async function expectNoHorizontalOverflow(page: Page) {
        expect(
                await page.evaluate(
                        () =>
                                document.documentElement.scrollWidth <=
                                document.documentElement.clientWidth,
                ),
        ).toBe(true);
}

test("Deploy omits the redundant flash badge and retains the contextual handoff", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");
        await page.getByRole("button", { name: "Install firmware" }).click();

        await expect(
                page.getByRole("heading", {
                        name: "Put the NvStraps driver into the motherboard BIOS",
                }),
        ).toBeVisible();
        await expect(
                page.getByText(
                        "This screen builds a BIOS image with the driver inside and exports it as a package. Flash that package with the vendor tool, then return here to record the result.",
                ),
        ).toBeVisible();
        await expect(redundantBadge(page)).toHaveCount(0);
        await expect(page.getByText("FLASH WITH VENDOR TOOL")).toHaveCount(0);
        await expect(page.getByText("Use the prepared image")).toHaveCount(0);
        await expect(manualHandoff(page)).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({
                path: `${evidence}/english-intro-without-badge-1180x760.png`,
        });

        await page.getByRole("button", { name: "Choose file" }).click();
        await page
                .getByText(
                        "I checked the vendor install and recovery instructions for this board.",
                )
                .click();
        await page
                .getByRole("button", { name: "Create profile for this computer" })
                .click();
        await page
                .getByRole("button", {
                        name: "Prepare and inspect firmware artifact",
                })
                .click();

        const flashHandoff = manualHandoff(page);
        await expect(flashHandoff).toHaveAttribute(
                "data-manual-step",
                "flashWithVendorRoute",
        );
        await expect(
                flashHandoff.getByRole("heading", {
                        name: "Flash the prepared firmware",
                }),
        ).toBeVisible();
        await expect(flashHandoff).toContainText(
                "return here and record the completed step",
        );
        await expect(redundantBadge(page)).toHaveCount(0);
        await expectNoHorizontalOverflow(page);

        const exportButton = page.getByRole("button", { name: "Export package" });
        await expect(exportButton).toBeVisible();
        await expect(exportButton).toHaveText("Export package");
        await expect(exportButton).toBeDisabled();
        expect(
                await exportButton.evaluate((button) => ({
                        text: button.textContent?.trim(),
                        color: getComputedStyle(button).color,
                        opacity: getComputedStyle(button).opacity,
                })),
        ).toEqual({
                text: "Export package",
                color: "rgb(29, 18, 13)",
                opacity: "0.42",
        });
        await page.evaluate(async () => {
                await document.fonts.ready;
                await new Promise<void>((resolve) =>
                        requestAnimationFrame(() =>
                                requestAnimationFrame(() => resolve()),
                        ),
                );
        });
        await page.mouse.move(0, 0);
        await exportButton.screenshot({
                path: `${evidence}/debug-export-package-button.png`,
        });
        await page
                .getByLabel("Deployment package destination")
                .fill("C:\\Exports");
        await expect(exportButton).toBeEnabled();
        await expect(exportButton).toHaveCSS("opacity", "1");
        await flashHandoff.scrollIntoViewIfNeeded();
        await page.screenshot({
                path: `${evidence}/english-contextual-flash-1180x760.png`,
        });
});

test("Korean Deploy intro remains readable at the 900 px minimum without the badge", async ({
        page,
}) => {
        await page.setViewportSize({ width: 900, height: 760 });
        await page.goto("/");
        await page.getByTestId("language-select").selectOption("ko");
        await page.getByRole("button", { name: "펌웨어 설치" }).click();

        await expect(
                page.getByRole("heading", { name: "메인보드 BIOS에 NvStraps 드라이버 넣기" }),
        ).toBeVisible();
        await expect(
                page.getByText(
                        "여기에서 드라이버를 넣은 BIOS 이미지를 만들어 패키지로 내보냅니다. 플래시는 제조사 도구로 진행하고, 끝나면 돌아와 결과를 기록하세요.",
                ),
        ).toBeVisible();
        await expect(redundantBadge(page)).toHaveCount(0);
        await expect(page.getByText("제조사 도구에서 플래시")).toHaveCount(0);
        await expect(page.getByText("준비된 이미지 사용")).toHaveCount(0);
        await expect(manualHandoff(page)).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({
                path: `${evidence}/korean-intro-without-badge-900x760.png`,
        });
});
