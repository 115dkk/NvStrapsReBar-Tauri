import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const evidence =
        ".superloopy/evidence/frontend/20260814T212720Z-jetendard-technical-ui";
mkdirSync(evidence, { recursive: true });
const styles = readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
const assetChecker = readFileSync(
        new URL("../../tools/check-third-party-assets.mjs", import.meta.url),
        "utf8",
);

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

function expectJetendardGlyphs(fonts: PlatformFont[], face?: string) {
        const jetendard = fonts.find(({ familyName }) => familyName === "Jetendard");
        expect(jetendard).toBeDefined();
        expect(jetendard?.isCustomFont).toBe(true);
        expect(jetendard?.postScriptName).toContain("Jetendard");
        if (face) expect(jetendard?.postScriptName).toContain(face);
        const families = fonts.map(({ familyName }) => familyName);
        expect(families).not.toContain("Pretendard Variable");
        expect(families).not.toContain("Pretendard");
        expect(families).not.toContain("GulimChe");
        expect(families).not.toContain("Malgun Gothic");
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

async function loadJetendardWeights(page: Page) {
        await Promise.all(
                [400, 600, 700].map((weight) =>
                        page.evaluate(
                                async ({ fontWeight }) => {
                                        await document.fonts.load(
                                                `${fontWeight} 16px "Jetendard"`,
                                                "A1한글{}[]",
                                        );
                                        await document.fonts.ready;
                                },
                                { fontWeight: weight },
                        ),
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

        const offenders = results.filter(({ computedFamily, fonts }) => {
                const families = fonts.map(({ familyName }) => familyName);
                const technical = computedFamily.includes("Jetendard");
                if (technical) {
                        return (
                                !fonts.some(
                                        ({ familyName, isCustomFont }) =>
                                                familyName === "Jetendard" && isCustomFont,
                                ) ||
                                families.includes("Pretendard Variable") ||
                                families.includes("Pretendard") ||
                                families.includes("GulimChe") ||
                                families.includes("Malgun Gothic")
                        );
                }
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

async function auditVisibleTechnicalText(
        page: Page,
        evidenceName: string,
        minimumTargets = 5,
): Promise<void> {
        const targets = await page.evaluate(() => {
                document
                        .querySelectorAll("[data-technical-font-audit]")
                        .forEach((element) =>
                                element.removeAttribute("data-technical-font-audit"),
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
                                const style = getComputedStyle(element);
                                const visible =
                                        style.display !== "none" &&
                                        style.visibility !== "hidden" &&
                                        element.getClientRects().length > 0;
                                if (
                                        !visible ||
                                        !/[A-Za-z0-9가-힣]/.test(directText) ||
                                        !style.fontFamily.includes("Jetendard")
                                )
                                        return null;
                                const id = String(nextId++);
                                element.setAttribute("data-technical-font-audit", id);
                                return {
                                        selector: `[data-technical-font-audit="${id}"]`,
                                        sample: directText,
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

        const offenders = results.filter(({ computedWeight, fonts }) => {
                const families = fonts.map(({ familyName }) => familyName);
                return (
                        !["400", "600", "700"].includes(computedWeight) ||
                        !fonts.some(
                                ({ familyName, isCustomFont }) =>
                                        familyName === "Jetendard" && isCustomFont,
                        ) ||
                        families.some((familyName) => familyName !== "Jetendard")
                );
        });
        writeFileSync(
                `${evidence}/${evidenceName}`,
                `${JSON.stringify({ targetCount: targets.length, offenders, results }, null, 2)}\n`,
        );
        expect(targets.length).toBeGreaterThanOrEqual(minimumTargets);
        expect(offenders).toEqual([]);
}

async function reachRecommendedConfiguration(page: Page) {
        await page.getByTestId("language-select").selectOption("en");
        await page.getByRole("button", { name: "Install firmware" }).click();
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
                        .getByRole("button", { name: "Record completed step" })
                        .click();
        }
        await page
                .getByRole("button", {
                        name: "Check current boot + Rust DXE status",
                })
                .click();
}

test("every technical declaration routes through the pinned Jetendard faces", () => {
        expect(styles).toMatch(/font-weight:\s*45 920;/);
        for (const [file, weight] of [
                ["Jetendard-Regular.woff2", 400],
                ["Jetendard-SemiBold.woff2", 600],
                ["Jetendard-Bold.woff2", 700],
        ] as const) {
                expect(styles).toMatch(
                        new RegExp(
                                `src: url\\("\\./assets/fonts/Jetendard/${file.replace(".", "\\.")}"\\)[\\s\\S]*?font-weight: ${weight};`,
                        ),
                );
        }
        const technicalStack = styles.match(/--font-technical:\s*([^;]+);/)?.[1];
        expect(technicalStack?.trim()).toBe('"Jetendard", monospace');
        expect(styles.match(/\bmonospace\b/g)).toHaveLength(1);
        expect(styles.match(/var\(--font-technical\)/g)?.length).toBeGreaterThan(17);
        expect(styles).not.toMatch(/font:\s*650[^;]+var\(--font-technical\)/);
        expect(styles).toContain(":where(code, pre, kbd, samp)");
        expect(assetChecker).toContain(
                "42101ca2849d79e6356ebe8841d010fc558365ace1e737d85496dc3061539159",
        );
});

test("Jetendard keeps Korean at two Latin cells in every bundled weight", async ({
        page,
}) => {
        await page.goto("/");
        await loadJetendardWeights(page);
        const metrics = await page.evaluate(() => {
                const host = document.createElement("div");
                host.style.cssText =
                        "position:fixed;left:-10000px;top:0;white-space:pre;visibility:visible";
                document.body.append(host);
                const measure = (weight: number, text: string, id?: string) => {
                        const span = document.createElement("span");
                        if (id) span.id = id;
                        span.style.cssText = `display:inline-block;font: ${weight} 20px/1 Jetendard;letter-spacing:0`;
                        span.textContent = text;
                        host.append(span);
                        return span.getBoundingClientRect().width;
                };
                const result = [400, 600, 700].map((weight) => ({
                        weight,
                        ascii: measure(weight, "A", `jetendard-${weight}`),
                        hangul: measure(weight, "한"),
                        fourLatin: measure(weight, "ABCD"),
                        mixedFourCells: measure(weight, "A한B"),
                }));
                return result;
        });

        for (const metric of metrics) {
                expect(Math.abs(metric.hangul - metric.ascii * 2)).toBeLessThan(0.2);
                expect(
                        Math.abs(metric.mixedFourCells - metric.fourLatin),
                ).toBeLessThan(0.2);
                expect(
                        await page.evaluate(
                                ({ weight }) =>
                                        document.fonts.check(
                                                `${weight} 20px "Jetendard"`,
                                                "A한B",
                                        ),
                                { weight: metric.weight },
                        ),
                ).toBe(true);
        }
        expectJetendardGlyphs(
                await platformFontsForSelector(page, "#jetendard-400"),
                "Regular",
        );
        expectJetendardGlyphs(
                await platformFontsForSelector(page, "#jetendard-600"),
                "SemiBold",
        );
        expectJetendardGlyphs(
                await platformFontsForSelector(page, "#jetendard-700"),
                "Bold",
        );
        writeFileSync(
                `${evidence}/jetendard-cell-metrics.json`,
                `${JSON.stringify({ toleranceCssPx: 0.2, metrics }, null, 2)}\n`,
        );
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
        await loadJetendardWeights(page);
        await page.screenshot({
                path: `${evidence}/english-jetendard-configure-1180x760.png`,
        });

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
        await loadJetendardWeights(page);

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
        expect(typography.monoFamily).toContain("Jetendard");
        expectPretendardGlyphs(await platformFontsForSelector(page, ".intro p"));
        expectJetendardGlyphs(
                await platformFontsForSelector(page, ".kicker"),
                "Bold",
        );
        await auditVisibleHangulText(page, "configure-platform-font-audit.json");
        await auditVisibleTechnicalText(
                page,
                "configure-technical-platform-font-audit.json",
        );

        const fontRequest = requests.find((url) =>
                url.includes("PretendardVariable") && url.endsWith(".woff2"),
        );
        expect(fontRequest).toBeTruthy();
        expect(new URL(fontRequest!).hostname).toBe("127.0.0.1");
        for (const face of ["Regular", "SemiBold", "Bold"]) {
                const jetendardRequest = requests.find(
                        (url) =>
                                url.includes(`Jetendard-${face}`) &&
                                url.endsWith(".woff2"),
                );
                expect(jetendardRequest, `Missing local Jetendard ${face}`).toBeTruthy();
                expect(new URL(jetendardRequest!).hostname).toBe("127.0.0.1");
        }
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
                path: `${evidence}/korean-jetendard-configure-1180x760.png`,
        });
});

test("technical summaries use one Jetendard family for Korean and Latin cells", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");
        await reachRecommendedConfiguration(page);
        await loadJetendardWeights(page);

        const summary = page.locator(".recommended-config > code");
        await expect(summary).toContainText("global mode 1");
        await page.screenshot({
                path: `${evidence}/english-jetendard-technical-summary-1180x760.png`,
        });

        await page.getByTestId("language-select").selectOption("ko");
        await page.setViewportSize({ width: 900, height: 760 });
        await loadPretendardWeights(page);
        await loadJetendardWeights(page);
        await expect(summary).toContainText("전역 모드 1");
        const family = await summary.evaluate(
                (element) => getComputedStyle(element).fontFamily,
        );
        await expect(summary).toHaveCSS("font-weight", "400");
        expect(family).toContain("Jetendard");
        expectJetendardGlyphs(
                await platformFontsForSelector(
                        page,
                        ".recommended-config > code",
                ),
                "Regular",
        );
        await auditVisibleHangulText(page, "deploy-platform-font-audit.json");
        await auditVisibleTechnicalText(
                page,
                "deploy-technical-platform-font-audit.json",
        );
        expect(
                await page.evaluate(() =>
                        document.fonts.check(
                                '400 11px "Jetendard"',
                                "전역 모드 1 · target false",
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
        await summary.scrollIntoViewIfNeeded();
        await page.screenshot({
                path: `${evidence}/korean-jetendard-technical-summary-900x760.png`,
        });
});

test("both bundled OFL texts are readable in a focus-contained dialog", async ({
        page,
}) => {
        const requests: string[] = [];
        page.on("request", (request) => requests.push(request.url()));
        await page.setViewportSize({ width: 900, height: 760 });
        await page.goto("/");
        await page.getByTestId("language-select").selectOption("en");
        await loadJetendardWeights(page);
        const englishOpenButton = page.getByRole("button", { name: "Licenses" });
        await englishOpenButton.click();
        const englishDialog = page.getByRole("dialog", {
                name: "Open-source licenses",
        });
        await expect(englishDialog).toContainText(
                "Jetendard v0.1.0 is bundled for technical information",
        );
        await expect(englishDialog).toContainText("Pretendard v1.3.9");
        await englishDialog.getByRole("button", { name: "Close" }).click();

        await page.getByTestId("language-select").selectOption("ko");
        await loadPretendardWeights(page);
        await loadJetendardWeights(page);

        const openButton = page.getByRole("button", { name: "라이선스" });
        await openButton.click();
        const dialog = page.getByRole("dialog", {
                name: "오픈 소스 라이선스",
        });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("Pretendard v1.3.9");
        await expect(dialog).toContainText("Copyright (c) 2021, Kil Hyung-jin");
        await expect(dialog).toContainText("Reserved Font Name 'Pretendard'");
        await expect(dialog).toContainText("Jetendard v0.1.0");
        await expect(dialog).toContainText("Copyright (c) 2026 Jung Woong Park");
        await expect(dialog).toContainText("Reserved Font Name 'Jetendard'");
        const pretendardFullText = dialog.getByTestId("pretendard-license-text");
        await expect(pretendardFullText).toContainText("SIL OPEN FONT LICENSE");
        await expect(pretendardFullText).toContainText(
                "Version 1.1 - 26 February 2007",
        );
        await expect(pretendardFullText).toContainText("PERMISSION & CONDITIONS");

        const closeButton = dialog.getByRole("button", { name: "닫기" });
        await expect(closeButton).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(pretendardFullText).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(closeButton).toBeFocused();

        const jetendardLicenseButton = dialog.getByRole("button", {
                name: "Jetendard 라이선스",
        });
        await jetendardLicenseButton.click();
        await expect(jetendardLicenseButton).toHaveAttribute("aria-pressed", "true");
        const jetendardFullText = dialog.getByTestId("jetendard-license-text");
        await expect(jetendardFullText).toContainText(
                "Copyright (c) 2026 Jung Woong Park",
        );
        await expect(jetendardFullText).toContainText(
                'with Reserved Font Name "Jetendard"',
        );
        await expect(jetendardFullText).toContainText("PERMISSION & CONDITIONS");
        await auditVisibleHangulText(page, "license-modal-platform-font-audit.json");
        await auditVisibleTechnicalText(
                page,
                "license-modal-technical-platform-font-audit.json",
                1,
        );
        expect(
                await page.evaluate(() =>
                        document.documentElement.scrollWidth <=
                        document.documentElement.clientWidth,
                ),
        ).toBe(true);
        await page.screenshot({
                path: `${evidence}/korean-jetendard-license-900x760.png`,
        });

        for (const licensePath of [
                "/licenses/Pretendard/LICENSE",
                "/licenses/Jetendard/LICENSE",
        ]) {
                const licenseRequest = requests.find((url) =>
                        url.endsWith(licensePath),
                );
                expect(licenseRequest).toBeTruthy();
                expect(new URL(licenseRequest!).hostname).toBe("127.0.0.1");
        }
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(openButton).toBeFocused();
        expect(await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? [])).toEqual([]);
});
