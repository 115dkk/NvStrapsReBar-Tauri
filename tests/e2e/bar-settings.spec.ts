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

test("expanded and observed opens Settings once, saves through its own path, and refresh preserves a user tab choice", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto("/");

        const settings = page.getByRole("button", { name: "Settings" });
        const configure = page.getByRole("button", { name: "Configure" });
        await expect(settings).toHaveAttribute("aria-current", "page");
        await expect(settings).toBeEnabled();
        await expect(page.getByTestId("bar-settings-workspace")).toBeVisible();
        await expect(page.getByText("POST-INSTALL / SAVED CONFIGURATION")).toBeVisible();
        await expect(page.getByText("Current-boot DXE")).toBeVisible();
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

        await configure.click();
        await page.getByRole("button", { name: "Refresh system" }).click();
        await expect(configure).toHaveAttribute("aria-current", "page");
        await expect(page.getByTestId("bar-settings-workspace")).toHaveCount(0);
});

test("mixed aperture opens Configure but keeps Settings usable at the minimum window in Korean", async ({
        page,
}) => {
        await page.addInitScript(() =>
                sessionStorage.setItem("nvstraps-preview-rebar-state", "mixed"),
        );
        await page.setViewportSize({ width: 900, height: 760 });
        await page.goto("/");
        await page.getByTestId("language-select").selectOption("ko");

        const configure = page.getByRole("button", { name: "구성" });
        const settings = page.getByRole("button", { name: "설정" });
        await expect(configure).toHaveAttribute("aria-current", "page");
        await expect(settings).toBeEnabled();
        await settings.click();
        await expect(settings).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("heading", { name: "저장된 BAR 설정 편집" })).toBeVisible();
        await expect(page.locator(".rebar-gpu-row")).toHaveCount(2);
        await expect(page.getByText("Resizable BAR 메모리 창 혼재")).toBeVisible();
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

test("a DXE driver not observed this boot keeps Configure selected and exposes a semantic Settings lock", async ({
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

        await expect(page.getByRole("button", { name: "구성" })).toHaveAttribute(
                "aria-current",
                "page",
        );
        const settings = page.getByRole("button", { name: "설정" });
        await expect(settings).toBeDisabled();
        await expect(settings).toHaveAttribute(
                "aria-describedby",
                "settings-lock-reason",
        );
        await expect(page.locator("#settings-lock-reason")).toContainText(
                "이번 부팅에서 DXE 드라이버 실행이 확인되거나 Turing GPU의 Windows 메모리 창이 확장된 경우 설정을 열 수 있습니다.",
        );
        await expect(page.getByTestId("bar-settings-workspace")).toHaveCount(0);
        expect(await noHorizontalOverflow(page)).toBe(true);
        expect(await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? [])).toEqual([]);
        await captureFromDocumentTop(
                page,
                `${evidence}/korean-settings-locked-900x760.png`,
        );
});

test("expanded Turing evidence opens Settings without inventing an editable draft when UEFI read access is missing", async ({
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

        const settings = page.getByRole("button", { name: "Settings" });
        await expect(settings).toBeEnabled();
        await expect(settings).toHaveAttribute("aria-current", "page");
        await expect(page.getByText("Expanded Turing aperture")).toBeVisible();
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
        await expect(page.getByText("Automatic policy", { exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Review & save" })).toHaveCount(0);
        expect(await noHorizontalOverflow(page)).toBe(true);
        await captureFromDocumentTop(
                page,
                `${evidence}/english-settings-expanded-no-access-1180x760.png`,
        );
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
