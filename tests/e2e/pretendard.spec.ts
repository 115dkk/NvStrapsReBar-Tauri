import { expect, test } from "@playwright/test";

const evidence =
        ".superloopy/evidence/frontend/20260814T021235Z-pretendard-korean-typography";

test("Korean uses the bundled Pretendard variable font without external requests", async ({
        page,
}) => {
        const requests: string[] = [];
        page.on("request", (request) => requests.push(request.url()));
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");

        const englishFamily = await page.locator("html").evaluate(
                (element) => getComputedStyle(element).fontFamily,
        );
        expect(englishFamily).toContain("Segoe UI Variable Text");
        expect(englishFamily).not.toContain("Pretendard Variable");

        await page.getByTestId("language-select").selectOption("ko");
        await expect(page.locator("html")).toHaveAttribute("lang", "ko");
        await expect
                .poll(() =>
                        page.evaluate(() =>
                                document.fonts.check(
                                        '400 16px "Pretendard Variable"',
                                        "한글 타이포그래피",
                                ),
                        ),
                )
                .toBe(true);

        const typography = await page.evaluate(() => {
                const style = (selector: string) => {
                        const element = document.querySelector(selector);
                        if (!element) throw new Error(`Missing ${selector}`);
                        return getComputedStyle(element);
                };
                return {
                        rootFamily: style("html").fontFamily,
                        bodyWeight: style("body").fontWeight,
                        supportingWeight: style(".intro p").fontWeight,
                        labelWeight: style(".mode-grid label").fontWeight,
                        buttonWeight: style("button").fontWeight,
                        sectionWeight: style(".section-head h3").fontWeight,
                        pageWeight: style("h1").fontWeight,
                        monoFamily: style(".product").fontFamily,
                };
        });
        expect(typography).toMatchObject({
                bodyWeight: "400",
                supportingWeight: "450",
                labelWeight: "550",
                buttonWeight: "650",
                sectionWeight: "680",
                pageWeight: "720",
        });
        expect(typography.rootFamily).toContain("Pretendard Variable");
        expect(typography.monoFamily).not.toContain("Pretendard Variable");

        const fontRequest = requests.find((url) =>
                url.includes("PretendardVariable") && url.endsWith(".woff2"),
        );
        expect(fontRequest).toBeTruthy();
        expect(new URL(fontRequest!).hostname).toBe("127.0.0.1");
        expect(
                requests.every((url) => {
                        const parsed = new URL(url);
                        return (
                                parsed.hostname === "127.0.0.1" ||
                                parsed.protocol === "data:"
                        );
                }),
        ).toBe(true);
        expect(
                await page.evaluate(() =>
                        document.documentElement.scrollWidth <=
                        document.documentElement.clientWidth,
                ),
        ).toBe(true);
        await page.screenshot({
                path: `${evidence}/korean-pretendard-configure-1180x760.png`,
        });
});

test("the bundled Pretendard OFL is readable in a focus-contained dialog", async ({
        page,
}) => {
        const requests: string[] = [];
        page.on("request", (request) => requests.push(request.url()));
        await page.setViewportSize({ width: 900, height: 760 });
        await page.goto("/");
        await page.getByTestId("language-select").selectOption("ko");

        const openButton = page.getByRole("button", { name: "라이선스" });
        await openButton.click();
        const dialog = page.getByRole("dialog", {
                name: "오픈 소스 라이선스",
        });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("Pretendard v1.3.9");
        await expect(dialog).toContainText("Copyright (c) 2021, Kil Hyung-jin");
        await expect(dialog).toContainText("Reserved Font Name 'Pretendard'");
        const fullText = dialog.getByTestId("pretendard-license-text");
        await expect(fullText).toContainText("SIL OPEN FONT LICENSE");
        await expect(fullText).toContainText("Version 1.1 - 26 February 2007");
        await expect(fullText).toContainText("PERMISSION & CONDITIONS");

        const closeButton = dialog.getByRole("button", { name: "닫기" });
        await expect(closeButton).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(fullText).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(closeButton).toBeFocused();
        expect(
                await page.evaluate(() =>
                        document.documentElement.scrollWidth <=
                        document.documentElement.clientWidth,
                ),
        ).toBe(true);
        await page.screenshot({
                path: `${evidence}/korean-pretendard-license-900x760.png`,
        });

        const licenseRequest = requests.find((url) =>
                url.endsWith("/licenses/Pretendard/LICENSE"),
        );
        expect(licenseRequest).toBeTruthy();
        expect(new URL(licenseRequest!).hostname).toBe("127.0.0.1");
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(openButton).toBeFocused();
        expect(await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? [])).toEqual([]);
});
