import { expect, test } from "@playwright/test";

const evidence =
        ".superloopy/evidence/frontend/20260814T121644Z-semantic-i18n-rebar-capability";

test("expanded Resizable BAR hero remains visible across English workspaces", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");

        const hero = page.locator(".rebar-hero");
        const support = page.locator(".motherboard-support-status");
        await expect(support).toHaveAccessibleName(
                "Motherboard native ReBAR: Supported",
        );
        await expect(support).toContainText("Motherboard native ReBAR:");
        await expect(support).toContainText("Supported");
        await expect(support).toContainText("PRO Z690-A DDR4(MS-7D25)");
        await expect(hero).toContainText("Resizable BAR is active");
        await expect(hero).toContainText("NVIDIA GeForce RTX 2080 SUPER");
        await expect(hero).toContainText("BAR1 8 GiB");
        await expect(hero).toContainText("Driver 596.36");
        await expect(hero).toContainText("Expanded aperture");
        await expect(hero).toContainText("Expandable by this app: Not needed");
        await expect(hero.locator(".bar-block.expanded")).toHaveText("8 GiB");
        await expect(page.getByText("Current BAR aperture")).toBeVisible();
        await expect(page.getByText("BAR0", { exact: true })).toHaveCount(0);
        await page.screenshot({
                path: `${evidence}/english-settings-expanded-1180x760.png`,
        });

        await page.getByRole("button", { name: "Install firmware" }).click();
        await expect(hero).toBeVisible();
        await expect(support).toBeVisible();
        await expect(page.getByText("No profile yet")).toBeVisible();
        await expect(page.locator(".deployment-rail .rail-note")).toHaveCount(0);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(50);
        await page.screenshot({
                path: `${evidence}/english-deploy-expanded-1180x760.png`,
        });
});

test("expanded Resizable BAR hero is localized at the minimum window", async ({
        page,
}) => {
        await page.setViewportSize({ width: 900, height: 760 });
        await page.goto("/");
        await page.getByTestId("language-select").selectOption("ko");

        const hero = page.locator(".rebar-hero");
        const support = page.locator(".motherboard-support-status");
        await expect(support).toHaveAccessibleName(
                "메인보드 자체 ReBAR: 지원됨",
        );
        await expect(support).toContainText("메인보드 자체 ReBAR:");
        await expect(support).toContainText("지원됨");
        await expect(support).toContainText("PRO Z690-A DDR4(MS-7D25)");
        await expect(hero).toContainText("Resizable BAR 활성화됨");
        await expect(hero).toContainText("NVIDIA GeForce RTX 2080 SUPER");
        await expect(hero).toContainText("BAR1 8 GiB");
        await expect(hero).toContainText("드라이버 596.36");
        await expect(hero).toContainText("확장 메모리 창");
        await expect(hero).toContainText("이 앱으로 확장: 불필요");
        await expect(page.getByText("현재 BAR 메모리 창")).toBeVisible();
        await page.screenshot({
                path: `${evidence}/korean-settings-expanded-900x760.png`,
        });

        await page.getByRole("button", { name: "펌웨어 설치" }).click();
        await expect(hero).toBeVisible();
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

test("mixed aperture hero keeps every GPU and patch configuration outcome in both locales", async ({
        page,
}) => {
        await page.addInitScript(() =>
                sessionStorage.setItem(
                        "nvstraps-preview-rebar-state",
                        "mixed",
                ),
        );
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");

        const hero = page.locator(".rebar-hero");
        await expect(hero).toContainText("Resizable BAR differs per GPU");
        const rows = hero.locator(".rebar-gpu-row");
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toContainText("RTX 2080 SUPER");
        await expect(rows.nth(0)).toContainText("Expanded aperture");
        await expect(rows.nth(0)).toContainText("Expandable by this app: Not needed");
        await expect(rows.nth(0).locator(".bar-block.expanded")).toHaveText("8 GiB");
        await expect(rows.nth(1)).toContainText("Quadro RTX 4000");
        await expect(rows.nth(1)).toContainText("BAR1 256 MiB");
        await expect(rows.nth(1)).toContainText("256 MiB aperture");
        await expect(rows.nth(1)).toContainText("Expandable by this app: Available");
        await expect(rows.nth(1).locator(".bar-block.small")).toHaveText("256 MiB");
        await expect(rows.nth(1).locator(".bar-block.target")).toHaveText("8 GiB");
        await expect(rows.nth(1).locator(".rebar-patch-state")).toHaveAccessibleName(
                "Expandable by this app: Available",
        );
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect
                .poll(() => page.evaluate(() => window.scrollY))
                .toBe(0);
        await page.screenshot({
                path: `${evidence}/english-settings-mixed-1180x760.png`,
        });

        await page.setViewportSize({ width: 900, height: 760 });
        await page.getByTestId("language-select").selectOption("ko");
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect
                .poll(() => page.evaluate(() => window.scrollY))
                .toBe(0);
        await expect(hero).toContainText("GPU마다 Resizable BAR 상태가 다름");
        const koreanRows = hero.locator(".rebar-gpu-row");
        await expect(koreanRows.nth(0)).toContainText("확장 메모리 창");
        await expect(koreanRows.nth(1)).toContainText("256 MiB 메모리 창");
        await expect(koreanRows.nth(1)).toContainText("이 앱으로 확장: 가능");
        await expect(koreanRows.nth(1).locator(".bar-block.target")).toHaveText("8 GiB");
        await expect(koreanRows.nth(1).locator(".rebar-patch-state")).toHaveAccessibleName(
                "이 앱으로 확장: 가능",
        );
        expect(
                await page.evaluate(
                        () =>
                                document.documentElement.scrollWidth <=
                                document.documentElement.clientWidth,
                ),
        ).toBe(true);
        expect(
                await page.evaluate(
                        () => window.__NVSTRAPS_I18N_MISSING__ ?? [],
                ),
        ).toEqual([]);
        await page.screenshot({
                path: `${evidence}/korean-settings-mixed-900x760.png`,
        });
});
