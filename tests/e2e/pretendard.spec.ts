import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const evidence =
        ".superloopy/evidence/frontend/20260814T210820Z-cjk-font-fallback-audit";
mkdirSync(evidence, { recursive: true });
const styles = readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");

type PlatformFont = {
        familyName: string;
        postScriptName: string;
        isCustomFont: boolean;
        glyphCount: number;
};

async function platformFontsForSelector(
        page: Page,
        selector: string,
): Promise<PlatformFont[]> {
        const session = await page.context().newCDPSession(page);
        await session.send("DOM.enable");
        await session.send("CSS.enable");
        const { root } = await session.send("DOM.getDocument");
        const { nodeId } = await session.send("DOM.querySelector", {
                nodeId: root.nodeId,
                selector,
        });
        expect(nodeId, `Missing CDP node for ${selector}`).not.toBe(0);
        const { fonts } = await session.send("CSS.getPlatformFontsForNode", {
                nodeId,
        });
        await session.detach();
        return fonts as PlatformFont[];
}

function expectPretendardGlyphs(fonts: PlatformFont[]) {
        const pretendard = fonts.find(
                ({ familyName }) => familyName === "Pretendard Variable",
        );
        expect(pretendard).toBeDefined();
        expect(pretendard?.isCustomFont).toBe(true);
        expect(pretendard?.postScriptName).toContain("PretendardVariable");
        expect(fonts.map(({ familyName }) => familyName)).not.toContain("GulimChe");
        expect(fonts.map(({ familyName }) => familyName)).not.toContain("Malgun Gothic");
}

async function loadPretendard(page: Page, weight: number, text: string) {
        await page.evaluate(
                async ({ fontWeight, sample }) => {
                        await document.fonts.load(
                                `${fontWeight} 16px "Pretendard Variable"`,
                                sample,
                        );
                        await document.fonts.ready;
                },
                { fontWeight: weight, sample: text },
        );
}

async function loadPretendardWeights(page: Page) {
        await Promise.all(
                [400, 450, 550, 650, 680, 700, 720].map((weight) =>
                        loadPretendard(page, weight, "한글 글리프 점검"),
                ),
        );
}

async function auditVisibleHangulText(
        page: Page,
        evidenceName: string,
): Promise<void> {
        const targets = await page.evaluate(() => {
                document
                        .querySelectorAll("[data-cjk-font-audit]")
                        .forEach((element) =>
                                element.removeAttribute("data-cjk-font-audit"),
                        );
                let nextId = 0;
                return [...document.body.querySelectorAll<HTMLElement>("*")]
                        .map((element) => {
                                const directText = [...element.childNodes]
                                        .filter((node) => node.nodeType === Node.TEXT_NODE)
                                        .map((node) => node.textContent ?? "")
                                        .join(" ")
                                        .replace(/\s+/g, " ")
                                        .trim();
                                const controlText =
                                        element instanceof HTMLInputElement ||
                                        element instanceof HTMLTextAreaElement
                                                ? `${element.value} ${element.placeholder}`.trim()
                                                : element instanceof HTMLSelectElement
                                                  ? element.selectedOptions[0]?.text ?? ""
                                                  : "";
                                const sample = `${directText} ${controlText}`.trim();
                                const style = getComputedStyle(element);
                                const visible =
                                        style.display !== "none" &&
                                        style.visibility !== "hidden" &&
                                        element.getClientRects().length > 0;
                                if (!visible || !/[가-힣]/.test(sample)) return null;
                                const id = String(nextId++);
                                element.setAttribute("data-cjk-font-audit", id);
                                return {
                                        selector: `[data-cjk-font-audit="${id}"]`,
                                        sample,
                                        tag: element.tagName.toLowerCase(),
                                        className: element.className,
                                        computedFamily: style.fontFamily,
                                        computedWeight: style.fontWeight,
                                };
                        })
                        .filter((target) => target !== null);
        });

        const session = await page.context().newCDPSession(page);
        await session.send("DOM.enable");
        await session.send("CSS.enable");
        const { root } = await session.send("DOM.getDocument");
        const results = [];
        for (const target of targets) {
                const { nodeId } = await session.send("DOM.querySelector", {
                        nodeId: root.nodeId,
                        selector: target.selector,
                });
                const { fonts } = await session.send("CSS.getPlatformFontsForNode", {
                        nodeId,
                });
                results.push({ ...target, fonts });
        }
        await session.detach();

        const offenders = results.filter(({ fonts }) => {
                const families = fonts.map(({ familyName }) => familyName);
                return (
                        !fonts.some(
                                ({ familyName, isCustomFont }) =>
                                        familyName === "Pretendard Variable" && isCustomFont,
                        ) ||
                        families.includes("GulimChe") ||
                        families.includes("Malgun Gothic")
                );
        });
        writeFileSync(
                `${evidence}/${evidenceName}`,
                `${JSON.stringify({ targetCount: targets.length, offenders, results }, null, 2)}\n`,
        );
        expect(targets.length).toBeGreaterThan(20);
        expect(offenders).toEqual([]);
}

async function reachRecommendedConfiguration(page: Page) {
        await page.getByTestId("language-select").selectOption("en");
        await page.getByRole("button", { name: "Deploy" }).click();
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
        for (let gate = 0; gate < 2; gate += 1) {
                await page
                        .getByRole("button", {
                                name: "Review & confirm completed step",
                        })
                        .click();
                const dialog = page.getByRole("dialog");
                await dialog
                        .getByLabel("I completed this step and reviewed the result.")
                        .check();
                await dialog
                        .getByRole("button", { name: "Record completed step" })
                        .click();
        }
        await page
                .getByRole("button", {
                        name: "Check current boot + Rust DXE status",
                })
                .click();
        await page.getByTestId("language-select").selectOption("ko");
}

test("every monospace declaration routes through the audited CJK stack", () => {
        expect(styles).toMatch(/font-weight:\s*45 920;/);
        const monoStack = styles.match(/--font-mono-cjk:\s*([^;]+);/)?.[1];
        expect(monoStack).toBeDefined();
        expect(monoStack).toContain('"Pretendard Variable"');
        expect(monoStack!.indexOf('"Pretendard Variable"')).toBeLessThan(
                monoStack!.indexOf('"Malgun Gothic"'),
        );

        expect(styles.match(/ui-monospace/g)).toHaveLength(1);
        expect(styles.match(/\bmonospace\b/g)).toHaveLength(2);
        expect(styles.match(/var\(--font-mono-cjk\)/g)?.length).toBeGreaterThan(17);
        expect(styles).toContain(":where(code, pre, kbd, samp)");
});

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
        await loadPretendard(page, 700, "가동 중인 시스템 편집 가능한 초안");
        await loadPretendardWeights(page);

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
        expect(typography.monoFamily).toContain("Pretendard Variable");
        expectPretendardGlyphs(await platformFontsForSelector(page, ".kicker"));
        await auditVisibleHangulText(page, "configure-platform-font-audit.json");

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

test("Korean glyphs in technical summaries use Pretendard after the Latin mono face", async ({
        page,
}) => {
        await page.setViewportSize({ width: 900, height: 760 });
        await page.goto("/");
        await reachRecommendedConfiguration(page);
        await loadPretendard(page, 400, "전역 모드 대상 선택값 설정 보호");
        await loadPretendardWeights(page);

        const summary = page.locator(".recommended-config > code");
        await expect(summary).toContainText("전역 모드 1");
        const family = await summary.evaluate(
                (element) => getComputedStyle(element).fontFamily,
        );
        await expect(summary).toHaveCSS("font-weight", "400");
        expect(family).toContain("Consolas");
        expect(family).toContain("Pretendard Variable");
        expectPretendardGlyphs(
                await platformFontsForSelector(page, ".recommended-config > code"),
        );
        await auditVisibleHangulText(page, "deploy-platform-font-audit.json");
        expect(
                await page.evaluate(() =>
                        document.fonts.check(
                                '400 11px "Pretendard Variable"',
                                "전역 모드 대상 선택값 설정 보호",
                        ),
                ),
        ).toBe(true);
        expect(
                await page.evaluate(
                        () =>
                                document.documentElement.scrollWidth <=
                                document.documentElement.clientWidth,
                ),
        ).toBe(true);
        await page.screenshot({
                path: `${evidence}/korean-technical-summary-900x760.png`,
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
        await loadPretendardWeights(page);

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
        await auditVisibleHangulText(page, "license-modal-platform-font-audit.json");

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
