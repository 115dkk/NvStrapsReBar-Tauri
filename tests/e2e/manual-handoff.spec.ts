import { expect, test, type Page } from "@playwright/test";

const evidence =
        ".superloopy/evidence/frontend/20260815T121150Z-sequential-manual-handoffs";

const manualHandoff = (page: Page) =>
        page.locator('section[data-manual-step][aria-labelledby="manual-handoff-title"]');

async function createProfile(page: Page) {
        await page.goto("/");
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
}

async function recordCurrentManualStep(page: Page) {
        await page
                .getByRole("button", { name: "Review & confirm completed step" })
                .click();
        const dialog = page.getByRole("dialog");
        await dialog
                .getByRole("button", { name: "Record completed step" })
                .click();
}

test("manual handoff reveals only the task owned by the active plan step", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await createProfile(page);

        await expect(manualHandoff(page)).toHaveCount(0);

        await page
                .getByRole("button", { name: "Prepare and inspect firmware artifact" })
                .click();

        const flashTask = manualHandoff(page);
        await expect(flashTask).toHaveAttribute(
                "data-manual-step",
                "flashWithVendorRoute",
        );
        await expect(
                flashTask.getByRole("heading", {
                        name: "Flash the prepared firmware",
                }),
        ).toBeVisible();
        await expect(
                flashTask.getByRole("article", { name: "Current manual task" }),
        ).toHaveCount(1);
        await expect(
                flashTask.getByRole("note", {
                        name: "BEFORE YOU BEGIN",
                }),
        ).toContainText("Prepare the recovery files");
        await expect(flashTask).not.toContainText("Update the UEFI settings");
        await flashTask.scrollIntoViewIfNeeded();
        await page.screenshot({
                path: `${evidence}/english-vendor-flash-1180x760.png`,
        });

        await page.getByTestId("language-select").selectOption("ko");
        await page.setViewportSize({ width: 900, height: 760 });
        await expect(
                flashTask.getByRole("heading", { name: "준비한 펌웨어 플래시" }),
        ).toBeVisible();
        await expect(flashTask.getByRole("note", { name: "시작하기 전에" }))
                .toContainText("복구 파일 준비");
        await expect(flashTask).not.toContainText("UEFI 설정값 변경");
        expect(
                await page.evaluate(
                        () =>
                                document.documentElement.scrollWidth <=
                                document.documentElement.clientWidth,
                ),
        ).toBe(true);
        await flashTask.scrollIntoViewIfNeeded();
        await page.screenshot({
                path: `${evidence}/korean-vendor-flash-900x760.png`,
        });

        await page.getByTestId("language-select").selectOption("en");
        await page.setViewportSize({ width: 1180, height: 760 });

        await recordCurrentManualStep(page);

        const uefiTask = manualHandoff(page);
        await expect(uefiTask).toHaveAttribute(
                "data-manual-step",
                "configureFirmwareSetup",
        );
        await expect(
                uefiTask.getByRole("heading", { name: "Update the UEFI settings" }),
        ).toBeVisible();
        await expect(
                uefiTask.getByRole("article", { name: "Current manual task" }),
        ).toHaveCount(1);
        await expect(uefiTask).not.toContainText("Use the vendor tool");
        await expect(uefiTask).not.toContainText("Prepare the recovery files");
        await uefiTask.scrollIntoViewIfNeeded();
        await page.screenshot({
                path: `${evidence}/english-uefi-settings-1180x760.png`,
        });
});

test("journey headings use available width and remain overflow-free", async ({
        page,
}) => {
        await page.setViewportSize({ width: 1824, height: 900 });
        await page.goto("/");
        await page.getByRole("button", { name: "Install firmware" }).click();

        const sourceHeading = page.locator("#source-title").locator("..").locator("..");
        const sourceCopy = sourceHeading.locator("p");
        const readWideMetrics = () =>
                sourceCopy.evaluate((element) => {
                        const range = document.createRange();
                        range.selectNodeContents(element);
                        const lines = new Set(
                                [...range.getClientRects()].map((rect) =>
                                        Math.round(rect.top),
                                ),
                        );
                        return {
                                lines: lines.size,
                                copyWidth: element.getBoundingClientRect().width,
                                headingWidth:
                                        element.parentElement?.getBoundingClientRect()
                                                .width ?? 0,
                                overflow:
                                        document.documentElement.scrollWidth >
                                        document.documentElement.clientWidth,
                        };
                });
        const wideMetrics = await readWideMetrics();
        expect(wideMetrics.lines).toBe(1);
        expect(wideMetrics.copyWidth).toBeGreaterThan(390);
        expect(wideMetrics.copyWidth).toBeGreaterThan(wideMetrics.headingWidth / 2);
        expect(wideMetrics.overflow).toBe(false);
        await page.screenshot({
                path: `${evidence}/english-heading-wide-1824x900.png`,
        });

        await page.getByTestId("language-select").selectOption("ko");
        await expect(
                page.getByRole("heading", { name: "BIOS 이미지와 복구 수단" }),
        ).toBeVisible();
        const koreanWideMetrics = await readWideMetrics();
        expect(koreanWideMetrics.lines).toBe(1);
        expect(koreanWideMetrics.copyWidth).toBeGreaterThan(390);
        expect(koreanWideMetrics.copyWidth).toBeGreaterThan(
                koreanWideMetrics.headingWidth / 2,
        );
        expect(koreanWideMetrics.overflow).toBe(false);
        await page.screenshot({
                path: `${evidence}/korean-heading-wide-1824x900.png`,
        });

        await page.getByTestId("language-select").selectOption("en");

        for (const viewport of [
                { width: 1180, height: 760 },
                { width: 900, height: 760 },
        ]) {
                await page.setViewportSize(viewport);
                expect(
                        await page.evaluate(
                                () =>
                                        document.documentElement.scrollWidth <=
                                        document.documentElement.clientWidth,
                        ),
                ).toBe(true);
        }

        await page.getByTestId("language-select").selectOption("ko");
        await page.setViewportSize({ width: 900, height: 760 });
        expect(
                await page.evaluate(
                        () =>
                                document.documentElement.scrollWidth <=
                                document.documentElement.clientWidth,
                ),
        ).toBe(true);
        await page.screenshot({
                path: `${evidence}/korean-heading-minimum-900x760.png`,
        });
});
