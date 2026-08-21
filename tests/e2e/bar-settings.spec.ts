import { expect, test, type Page } from "@playwright/test";

const evidence =
        ".superloopy/evidence/frontend/20260815T161821Z-bar-settings-workspace";

const noHorizontalOverflow = async (page: Page) =>
        page.evaluate(
                () =>
                        document.documentElement.scrollWidth <=
                        document.documentElement.clientWidth,
        );

const captureFromDocumentTop = async (page: Page, path: string) => {
        await page.evaluate(async () => {
                window.scrollTo(0, 0);
                await document.fonts.ready;
                await new Promise<void>((resolve) =>
                        requestAnimationFrame(() =>
                                requestAnimationFrame(() => resolve()),
                        ),
                );
                window.scrollTo(0, 0);
        });
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        await page.screenshot({ path });
};

test("an installed driver opens BAR Settings, saves through its own path, and refresh preserves a user step choice", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");

        const settings = page.getByRole("button", { name: "BAR Settings" });
        const install = page.getByRole("button", { name: "Install firmware" });
        await expect(settings).toHaveAttribute("aria-current", "page");
        await expect(install).toBeEnabled();
        await expect(page.getByTestId("bar-settings-workspace")).toBeVisible();
        await expect(
                page.getByRole("heading", { name: "Edit saved BAR Settings" }),
        ).toBeVisible();
        await expect(
                page.locator(".rebar-gpu-row", {
                        hasText: "NVIDIA GeForce RTX 2080 SUPER",
                }),
        ).toContainText("BAR1 8 GiB");
        expect(await noHorizontalOverflow(page)).toBe(true);
        await captureFromDocumentTop(
                page,
                `${evidence}/english-settings-expanded-1180x760.png`,
        );

        await page.getByLabel("Target PCI BAR size").selectOption("10");
        await expect(
                page.getByRole("heading", { name: "Draft is ready for review" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Review & save" }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText("Save these BAR Settings to UEFI?");
        await dialog.getByRole("button", { name: "Save BAR Settings" }).click();
        await expect(
                page.getByText("BAR Settings saved and read back", {
                        exact: true,
                }),
        ).toBeVisible();
        await expect(page.getByText(/UEFI variable Present/)).toBeVisible();
        await page.getByText("BAR Settings saved and read back", { exact: true }).scrollIntoViewIfNeeded();
        expect(await noHorizontalOverflow(page)).toBe(true);
        await page.screenshot({
                path: `${evidence}/english-settings-save-receipt-1180x760.png`,
        });

        await install.click();
        await page.getByRole("button", { name: "Refresh system" }).click();
        await expect(install).toHaveAttribute("aria-current", "page");
        await expect(page.getByTestId("bar-settings-workspace")).toHaveCount(0);
});

test("mixed apertures open BAR Settings and stay usable at the minimum window in Korean", async ({
        page,
}) => {
        await page.addInitScript(() =>
                sessionStorage.setItem("nvstraps-preview-rebar-state", "mixed"),
        );
        await page.setViewportSize({ width: 900, height: 760 });
        await page.goto("/");
        await page.getByTestId("language-select").selectOption("ko");

        const settings = page.getByRole("button", { name: "BAR 설정" });
        await expect(settings).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("heading", { name: "저장된 BAR 설정 편집" })).toBeVisible();
        await expect(page.locator(".rebar-gpu-row")).toHaveCount(2);
        await expect(page.getByText("GPU마다 Resizable BAR 상태가 다름")).toBeVisible();
        await captureFromDocumentTop(
                page,
                `${evidence}/korean-settings-mixed-top-900x760.png`,
        );
        await page.getByLabel("대상 PCI BAR 크기").selectOption("10");
        await expect(
                page.getByRole("heading", { name: "초안을 검토할 수 있음" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "검토 후 저장" }).click();
        await expect(page.getByRole("dialog")).toContainText(
                "이 BAR 설정을 UEFI에 저장할까요?",
        );
        await page.getByRole("button", { name: "BAR 설정 저장" }).click();
        await expect(
                page.getByText("BAR 설정 저장 및 다시 읽기 완료", {
                        exact: true,
                }),
        ).toBeVisible();
        await page
                .getByText("BAR 설정 저장 및 다시 읽기 완료", { exact: true })
                .scrollIntoViewIfNeeded();
        expect(await noHorizontalOverflow(page)).toBe(true);
        expect(await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? [])).toEqual([]);
        await page.screenshot({
                path: `${evidence}/korean-settings-mixed-900x760.png`,
        });
});

test("a DXE driver not observed this boot opens Install firmware and keeps configuration editable", async ({
        page,
}) => {
        await page.addInitScript(() =>
                sessionStorage.setItem(
                        "nvstraps-preview-rebar-state",
                        "not-observed",
                ),
        );
        await page.setViewportSize({ width: 900, height: 760 });
        await page.goto("/");
        await page.getByTestId("language-select").selectOption("ko");

        await expect(
                page.getByRole("button", { name: "펌웨어 설치" }),
        ).toHaveAttribute("aria-current", "page");
        await expect(
                page.getByRole("heading", {
                        name: "메인보드 BIOS에 NvStraps 드라이버 넣기",
                }),
        ).toBeVisible();
        await expect(page.getByText("1단계 — 펌웨어 설치에서 드라이버를 BIOS에 넣으세요.")).toBeVisible();

        const settings = page.getByRole("button", { name: "BAR 설정" });
        await expect(settings).toBeEnabled();
        await settings.click();
        await expect(settings).toHaveAttribute("aria-current", "page");
        await expect(page.getByTestId("bar-settings-workspace")).toHaveCount(0);
        await expect(
                page.getByRole("heading", {
                        name: "다음 부팅 때 적용할 펌웨어 설정",
                }),
        ).toBeVisible();
        expect(await noHorizontalOverflow(page)).toBe(true);
        expect(await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? [])).toEqual([]);
        await captureFromDocumentTop(
                page,
                `${evidence}/korean-settings-preinstall-900x760.png`,
        );
});

test("expanded Turing evidence opens BAR Settings without inventing an editable draft when UEFI read access is missing", async ({
        page,
}) => {
        await page.addInitScript(() =>
                sessionStorage.setItem(
                        "nvstraps-preview-rebar-state",
                        "expanded-no-access",
                ),
        );
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");

        const settings = page.getByRole("button", { name: "BAR Settings" });
        await expect(settings).toHaveAttribute("aria-current", "page");
        await expect(
                page.getByRole("heading", {
                        name: "Load the saved configuration to edit",
                }),
        ).toBeVisible();
        await expect(
                page
                        .getByTestId("bar-settings-workspace")
                        .getByRole("main")
                        .getByRole("button", {
                                name: "Restart as administrator",
                        }),
        ).toBeVisible();
        await expect(
                page.getByText("Resizable BAR expansion", { exact: true }),
        ).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Review & save" })).toHaveCount(0);
        expect(await noHorizontalOverflow(page)).toBe(true);
        await captureFromDocumentTop(
                page,
                `${evidence}/english-settings-expanded-no-access-1180x760.png`,
        );
});

test("a safety-cleared driver explains why it is off and what to do next", async ({
        page,
}) => {
        await page.addInitScript(() =>
                sessionStorage.setItem(
                        "nvstraps-preview-rebar-state",
                        "driver-cleared",
                ),
        );
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");

        await expect(
                page.getByText(
                        "The driver switched itself off after a BIOS setup change or CMOS reset. Check your BIOS settings, then turn expansion back on and save.",
                ),
        ).toBeVisible();

        await page.getByTestId("language-select").selectOption("ko");
        await expect(
                page.getByText(
                        "BIOS 설정 변경이나 CMOS 리셋 때문에 드라이버가 스스로 꺼졌습니다. BIOS 설정을 확인한 뒤 확장을 다시 켜고 저장하세요.",
                ),
        ).toBeVisible();
        expect(
                await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? []),
        ).toEqual([]);
});

test("Settings presents a typed stale-configuration failure without false success", async ({
        page,
}) => {
        await page.addInitScript(() =>
                sessionStorage.setItem(
                        "nvstraps-preview-bar-settings-error",
                        "stale_configuration",
                ),
        );
        await page.goto("/");
        await page.getByLabel("Target PCI BAR size").selectOption("10");
        await page.getByRole("button", { name: "Review & save" }).click();
        await page.getByRole("button", { name: "Save BAR Settings" }).click();

        await expect(page.getByRole("alert")).toContainText(
                "The saved BAR configuration changed. Refresh the system before applying this draft.",
        );
        await expect(
                page.getByText("BAR Settings saved and read back", {
                        exact: true,
                }),
        ).toHaveCount(0);
});
