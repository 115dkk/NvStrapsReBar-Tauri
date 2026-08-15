import { expect, test } from "@playwright/test";

const evidence =
        ".superloopy/evidence/frontend/20260814T121644Z-semantic-i18n-rebar-capability";

test("expanded Resizable BAR status remains visible across English workspaces", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");

        const strip = page.getByRole("status", {
                name: /Resizable BAR active/,
        });
        const support = page.locator(".motherboard-support-status");
        await expect(support).toHaveAccessibleName(
                "Motherboard Resizable BAR: Supported",
        );
        await expect(support).toContainText("Motherboard Resizable BAR support:");
        await expect(support).toContainText("O");
        await expect(support).toContainText("PRO Z690-A DDR4(MS-7D25)");
        await expect(strip).toContainText("NVIDIA GeForce RTX 2080 SUPER");
        await expect(strip).toContainText("BAR1 8 GiB");
        await expect(strip).toContainText("Driver 596.36");
        await expect(strip).toContainText("Expanded aperture");
        await expect(strip).toContainText("Expandable by this app: Not needed");
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
        await expect(support).toHaveAccessibleName(
                "메인보드 Resizable BAR: 지원됨",
        );
        await expect(support).toContainText("메인보드 Resizable BAR 지원:");
        await expect(support).toContainText("O");
        await expect(support).toContainText("PRO Z690-A DDR4(MS-7D25)");
        await expect(strip).toContainText("NVIDIA GeForce RTX 2080 SUPER");
        await expect(strip).toContainText("BAR1 8 GiB");
        await expect(strip).toContainText("드라이버 596.36");
        await expect(strip).toContainText("확장 메모리 창");
        await expect(strip).toContainText("이 앱으로 확장: 불필요");
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

test("mixed aperture status keeps every GPU and patch configuration outcome in both locales", async ({
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

        const strip = page.getByRole("status", {
                name: "Mixed Resizable BAR apertures",
        });
        await expect(strip).toContainText("MIX");
        const rows = strip.locator(".rebar-gpu-row");
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toContainText("RTX 2080 SUPER");
        await expect(rows.nth(0)).toContainText("Expanded aperture");
        await expect(rows.nth(0)).toContainText("Expandable by this app: Not needed");
        await expect(rows.nth(1)).toContainText("Quadro RTX 4000");
        await expect(rows.nth(1)).toContainText("BAR1 256 MiB");
        await expect(rows.nth(1)).toContainText("256 MiB aperture");
        await expect(rows.nth(1)).toContainText("Expandable by this app: Available");
        await expect(rows.nth(1)).toContainText("Target 8 GiB");
        await expect(rows.nth(1).locator(".rebar-patch-state")).toHaveAccessibleName(
                "Expandable by this app: Available",
        );
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect
                .poll(() => page.evaluate(() => window.scrollY))
                .toBe(0);
        await page.screenshot({
                path: `${evidence}/english-configure-mixed-1180x760.png`,
        });

        await page.setViewportSize({ width: 900, height: 760 });
        await page.getByTestId("language-select").selectOption("ko");
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect
                .poll(() => page.evaluate(() => window.scrollY))
                .toBe(0);
        const koreanStrip = page.getByRole("status", {
                name: "Resizable BAR 메모리 창 혼재",
        });
        const koreanRows = koreanStrip.locator(".rebar-gpu-row");
        await expect(koreanRows.nth(0)).toContainText("확장 메모리 창");
        await expect(koreanRows.nth(1)).toContainText("256 MiB 메모리 창");
        await expect(koreanRows.nth(1)).toContainText("이 앱으로 확장: 가능");
        await expect(koreanRows.nth(1)).toContainText("목표 8 GiB");
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
                path: `${evidence}/korean-configure-mixed-900x760.png`,
        });
});
