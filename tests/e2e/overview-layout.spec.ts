import { expect, test } from "@playwright/test";

const evidence = ".superloopy/evidence/frontend/20260907T011423Z-purpose-first-workspace";

test("an operation error remains visible when returning to Overview", async ({ page }) => {
        await page.addInitScript(() => sessionStorage.setItem("nvstraps-preview-bar-settings-error", "stale_configuration"));
        await page.goto("/");
        await page.getByRole("button", { name: "Open BAR settings" }).click();
        await page.getByLabel("Built-in list + fallback").check();
        await page.getByRole("button", { name: "Review & save" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Save BAR Settings" }).click();
        await expect(page.getByRole("alert")).toContainText("saved BAR configuration changed");
        await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
        await expect(page.getByRole("alert")).toContainText("saved BAR configuration changed");
        await page.getByRole("button", { name: "Dismiss error" }).click();
        await expect(page.getByRole("alert")).toHaveCount(0);
});

test("blue actions and readable text are independent of success color", async ({ page }) => {
        await page.goto("/");
        const action = page.getByRole("button", { name: "Open BAR settings" });
        await expect(action).toBeVisible();
        await expect(action).toHaveCSS("background-color", "rgb(138, 185, 248)");
        const colors = await action.evaluate((element) => {
                const style = getComputedStyle(element);
                const root = getComputedStyle(document.documentElement);
                return { foreground: style.color, background: style.backgroundColor, success: root.getPropertyValue("--ok").trim(), accent: root.getPropertyValue("--accent").trim() };
        });
        const luminance = (rgb: string) => {
                const channels = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => {
                        const value = Number(part) / 255;
                        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                });
                return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const values = [luminance(colors.foreground), luminance(colors.background)].sort((a, b) => b - a);
        expect((values[0] + 0.05) / (values[1] + 0.05)).toBeGreaterThanOrEqual(4.5);
        expect(colors.accent).not.toBe(colors.success);
        const summary = page.locator(".environment-details > summary");
        await summary.focus();
        await page.keyboard.press("Enter");
        await expect(page.locator(".environment-details")).toHaveAttribute("open");
        await expect(page.locator(".environment-details .status")).toHaveCount(4);
        await page.keyboard.press("Enter");
        await expect(page.locator(".environment-details")).not.toHaveAttribute("open");
});
for (const locale of ["en", "ko"] as const) {
        for (const width of [1180, 900]) {
                test(`${locale} purpose-first overview and workspaces at ${width}`, async ({ page }) => {
                        await page.setViewportSize({ width, height: 760 });
                        await page.goto("/");
                        const ko = locale === "ko";
                        await page.getByTestId("language-select").selectOption(locale);
                        const nav = page.getByRole("navigation", { name: ko ? "진행 단계" : "Setup steps" });
                        const overview = nav.getByRole("button", { name: ko ? "개요" : "Overview" });
                        await expect(overview).toHaveAttribute("aria-current", "page");
                        await expect(page.getByRole("heading", { name: ko ? "NVIDIA Turing에서 Resizable BAR 사용하기" : "Resizable BAR for NVIDIA Turing." })).toBeVisible();
                        const next = page.getByRole("button", { name: ko ? "BAR 설정 열기" : "Open BAR settings" });
                        await expect(next).toBeInViewport();
                        await expect(page.locator("main")).toHaveCount(1);
                        await expect(page.locator(".rebar-gpu-row")).toHaveCount(1);
                        await page.screenshot({ path: `${evidence}/${locale}-overview-${width}.png` });
                        await next.click();
                        await page.getByLabel(ko ? "내장 목록 + 대체값" : "Built-in list + fallback").check();
                        await expect(page.getByRole("button", { name: ko ? "검토 후 저장" : "Review & save" })).toBeEnabled();
                        await page.screenshot({ path: `${evidence}/${locale}-settings-${width}.png` });
                        await overview.click();
                        await nav.getByRole("button", { name: ko ? "BAR 설정" : "BAR Settings", exact: true }).click();
                        await expect(page.getByLabel(ko ? "내장 목록 + 대체값" : "Built-in list + fallback")).toBeChecked();
                        await page.getByText(ko ? "펌웨어 고급 설정" : "Advanced firmware settings", { exact: true }).click();
                        await expect(page.getByLabel(ko ? "BIOS 설정이 바뀌면 확장 끄기" : "Turn off expansion if BIOS settings change")).toBeVisible();
                        await nav.getByRole("button", { name: ko ? "펌웨어 설치" : "Install firmware" }).click();
                        await page.getByRole("button", { name: ko ? "파일 선택" : "Choose file" }).click();
                        await page.screenshot({ path: `${evidence}/${locale}-source-${width}.png` });
                        await overview.click();
                        await nav.getByRole("button", { name: ko ? "펌웨어 설치" : "Install firmware" }).click();
                        await expect(page.getByPlaceholder(ko ? "제조사 BIOS 이미지를 선택하거나 절대 경로를 입력하세요" : "Choose a vendor BIOS image or enter an absolute path")).toHaveValue(/E7D25IMS/);
                        await page.getByText(ko ? "이 보드의 제조사 설치 및 복구 지침을 확인했습니다." : "I checked the vendor install and recovery instructions for this board.").click();
                        await page.getByRole("button", { name: ko ? "이 컴퓨터의 프로필 만들기" : "Create profile for this computer" }).click();
                        await expect(page.locator(".source-disclosure")).not.toHaveAttribute("open");
                        await page.getByRole("button", { name: ko ? "BIOS 이미지 준비" : "Prepare BIOS image" }).click();
                        await expect(page.locator(".active-workflow [data-manual-step]")).toHaveAttribute("data-manual-step", "flashWithVendorRoute");
                        await page.locator(".active-workflow").scrollIntoViewIfNeeded();
                        await page.screenshot({ path: `${evidence}/${locale}-active-install-${width}.png` });
                        await page.getByText(ko ? "전체 설치 단계" : "All installation steps", { exact: true }).click();
                        await expect(page.getByRole("list", { name: ko ? "배포 계획" : "Deployment plan" })).toBeVisible();
                        await page.getByText(ko ? "BIOS 원본과 설치 방법" : "BIOS source and installation options", { exact: true }).click();
                        await expect(page.getByRole("button", { name: ko ? "파일 선택" : "Choose file" })).toBeVisible();
                        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
                        expect(await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? [])).toEqual([]);
                });
        }
}

for (const scenario of ["not-observed", "mixed", "unavailable", "expanded-no-access"] as const) {
        test(`overview preserves state truth: ${scenario}`, async ({ page }) => {
                await page.addInitScript((value) => sessionStorage.setItem("nvstraps-preview-rebar-state", value), scenario);
                await page.goto("/");
                await expect(page.getByRole("button", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
                if (scenario === "not-observed") await expect(page.getByRole("button", { name: "Start installation" })).toBeVisible();
                if (scenario === "mixed") await expect(page.locator(".rebar-gpu-row")).toHaveCount(2);
                if (scenario === "expanded-no-access") {
                        await page.getByRole("button", { name: "Open BAR settings" }).click();
                        await expect(page.getByRole("button", { name: "Restart as administrator" })).toBeVisible();
                        await expect(page.getByRole("button", { name: "Review & save" })).toHaveCount(0);
                }
                if (scenario === "unavailable") {
                        await expect(page.getByRole("button", { name: "Check status again" })).toBeVisible();
                        await expect(page.getByRole("button", { name: "Start installation" })).toHaveCount(0);
                }
                await page.screenshot({ path: `${evidence}/overview-${scenario}.png` });
        });
}
