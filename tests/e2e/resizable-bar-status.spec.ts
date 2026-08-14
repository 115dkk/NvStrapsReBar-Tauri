import { expect, test } from "@playwright/test";

const evidence =
        ".superloopy/evidence/frontend/20260814T105058Z-resizable-bar-status";

test("expanded Resizable BAR status remains visible across English workspaces", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");

        const strip = page.getByRole("status", {
                name: /Resizable BAR active/,
        });
        const support = page.locator(".motherboard-support-status");
        await expect(support).toContainText("Motherboard support");
        await expect(support).toContainText("Supported");
        await expect(support).toContainText("PRO Z690-A DDR4(MS-7D25)");
        await expect(strip).toContainText("NVIDIA GeForce RTX 2080 SUPER");
        await expect(strip).toContainText("BAR1 8 GiB");
        await expect(strip).toContainText("Driver 596.36");
        await expect(page.getByText("Current BAR aperture")).toBeVisible();
        await expect(page.getByText("BAR0", { exact: true })).toHaveCount(0);
        await page.screenshot({
                path: `${evidence}/english-configure-expanded-1180x760.png`,
        });

        await page.getByRole("button", { name: "Deploy" }).click();
        await expect(strip).toBeVisible();
        await expect(support).toBeVisible();
        await expect(page.getByText("No profile yet")).toBeVisible();
        await expect(page.locator(".deployment-rail .rail-note")).toHaveCount(0);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(50);
        await page.screenshot({
                path: `${evidence}/english-deploy-expanded-1180x760.png`,
        });
});

test("expanded Resizable BAR status is localized at the minimum window", async ({
        page,
}) => {
        await page.setViewportSize({ width: 900, height: 760 });
        await page.goto("/");
        await page.getByTestId("language-select").selectOption("ko");

        const strip = page.getByRole("status", {
                name: /Resizable BAR 활성/,
        });
        const support = page.locator(".motherboard-support-status");
        await expect(support).toContainText("메인보드 지원");
        await expect(support).toContainText("지원됨");
        await expect(support).toContainText("PRO Z690-A DDR4(MS-7D25)");
        await expect(strip).toContainText("NVIDIA GeForce RTX 2080 SUPER");
        await expect(strip).toContainText("BAR1 8 GiB");
        await expect(strip).toContainText("드라이버 596.36");
        await expect(page.getByText("현재 BAR 메모리 창")).toBeVisible();
        await page.screenshot({
                path: `${evidence}/korean-configure-expanded-900x760.png`,
        });

        await page.getByRole("button", { name: "배포" }).click();
        await expect(strip).toBeVisible();
        await expect(support).toBeVisible();
        await expect(page.getByText("아직 프로필 없음")).toBeVisible();
        expect(
                await page.evaluate(
                        () =>
                                document.documentElement.scrollWidth <=
                                document.documentElement.clientWidth,
                ),
        ).toBe(true);
        expect(await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? [])).toEqual([]);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(50);
        await page.screenshot({
                path: `${evidence}/korean-deploy-expanded-900x760.png`,
        });
});
