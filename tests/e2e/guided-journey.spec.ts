import { expect, test } from "@playwright/test";
import { button, evidence, missingMessages, noHorizontalOverflow, open, reachGuide, restartIntoBiosAndReturn, screen } from "./support";

test("the guided install runs from home to the observed size, one task per screen", async ({ page }) => {
        await page.setViewportSize({ width: 1180, height: 760 });
        await open(page, "not-observed");

        // Home: value first, then the user's steps and what is needed.
        await expect(page.getByRole("heading", { name: "You can turn on Resizable BAR" })).toBeVisible();
        await expect(page.getByText("Your PC · RTX 2080 SUPER · this boot")).toBeVisible();
        await expect(page.getByRole("img", { name: "Now 256 MiB, 8 GiB when on" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Your steps" })).toBeVisible();
        await expect(page.getByRole("navigation", { name: "Setup progress" })).toHaveCount(0);
        await page.screenshot({ path: `${evidence}/en-01-home-start-1180.png` });

        await button(page, "Get started").click();
        await expect(screen(page)).toHaveAttribute("data-screen", "pickFirmware");
        await expect(page.getByRole("heading", { name: "Choose the motherboard BIOS file" })).toBeFocused();
        await expect(page.getByText(/This PC's motherboard is .*PRO Z690-A DDR4/)).toBeVisible();
        await expect(page.locator(".nv-stage.current")).toContainText("1 Prepare");

        await button(page, "Choose file").click();
        await expect(page.getByRole("heading", { name: "Check the install and recovery methods" })).toBeVisible();
        await expect(page.getByText("E7D25IMS.1N0", { exact: true })).toBeVisible();
        await expect(page.getByText("M-FLASH", { exact: true })).toBeVisible();
        await expect(page.getByText("Flash BIOS Button", { exact: true })).toBeVisible();
        await page.screenshot({ path: `${evidence}/en-02-routes-1180.png` });

        await button(page, "Checked · make the file").click();
        await expect(page.getByRole("heading", { name: "Save to USB" })).toBeVisible();
        await expect(page.getByText("The install BIOS file is ready")).toBeVisible();
        await expect(page.getByText("MSI.ROM for recovery")).toBeVisible();
        await page.screenshot({ path: `${evidence}/en-03-save-1180.png` });

        await button(page, "Save to USB").click();
        await expect(page.getByRole("heading", { name: "Now install it in BIOS setup" })).toBeVisible();
        await expect(page.locator(".nv-stage.current")).toContainText("2 Install");
        await expect(page.getByText("In M-FLASH, choose E7D25IMS.1N0 in the flash folder.")).toBeVisible();
        await expect(page.getByRole("note")).toContainText("Flash BIOS button");
        await page.screenshot({ path: `${evidence}/en-04-guide-1180.png` });

        // A restart request is not a finished restart: the dialog asks first and the plan stays.
        await button(page, "Restart into BIOS setup").click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText("Save your work in other open programs first.");
        await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
        await page.screenshot({ path: `${evidence}/en-05-restart-dialog-1180.png` });
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(button(page, "Restart into BIOS setup")).toBeFocused();

        await restartIntoBiosAndReturn(page);
        await expect(page.getByText("NvStrapsReBar in the BIOS ran")).toBeVisible();
        await expect(page.getByText("I installed the install BIOS file with M-FLASH and saw it finish")).toBeVisible();
        await page.screenshot({ path: `${evidence}/en-06-return-1180.png` });

        // Recording both facts runs the driver check on its own.
        await button(page, "Record install and settings").click();
        await expect(page.getByRole("heading", { name: "Ready to turn on Resizable BAR" })).toBeVisible();
        await expect(page.locator(".nv-stage.current")).toContainText("3 Turn on");
        await expect(page.getByText("NvStrapsReBar is running")).toBeVisible();
        await page.screenshot({ path: `${evidence}/en-07-turn-on-1180.png` });

        await button(page, "Save these settings").click();
        await expect(page.getByRole("heading", { name: "Restart to turn it on" })).toBeVisible();
        await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
        await page.screenshot({ path: `${evidence}/en-08-restart-1180.png` });

        await button(page, "Restart").click();
        await expect(page.getByRole("dialog")).toContainText("It checks the new size right away.");
        await page.getByRole("dialog").getByRole("button", { name: "Restart", exact: true }).click();
        // Accepting the restart request does not advance the plan.
        await expect(page.getByRole("heading", { name: "Restart to turn it on" })).toBeVisible();

        await page.reload();
        await expect(page.getByRole("heading", { name: "Resizable BAR is on" })).toBeVisible();
        await expect(page.getByRole("img", { name: "Before 256 MiB, now 8 GiB" })).toBeVisible();
        await expect(page.getByText("Size reported by NVIDIA driver 596.36 after the restart.")).toBeVisible();
        await expect(page.locator(".nv-stage.done")).toHaveCount(4);
        await page.screenshot({ path: `${evidence}/en-09-done-1180.png` });

        await button(page, "Done").click();
        await expect(page.getByRole("heading", { name: "Resizable BAR is on" })).toBeVisible();
        await expect(page.getByTestId("home")).toBeVisible();
        expect(await noHorizontalOverflow(page)).toBe(true);
        expect(await missingMessages(page)).toEqual([]);
});

test("closing the app mid-install reopens on the same step", async ({ page }) => {
        await reachGuide(page);
        await page.reload();
        await expect(page.getByRole("heading", { name: "Now install it in BIOS setup" })).toBeVisible();
        await expect(page.getByText("You can close the app. It picks up here next time.")).toBeVisible();
});

test("the restart screen waits for a real restart before checking the size", async ({ page }) => {
        await reachGuide(page);
        await restartIntoBiosAndReturn(page);
        await button(page, "Record install and settings").click();
        await button(page, "Save these settings").click();
        await expect(page.getByRole("heading", { name: "Restart to turn it on" })).toBeVisible();
        await button(page, "I already restarted").click();
        await expect(page.getByRole("alert")).toContainText("Windows has not restarted since the configuration was saved.");
        await expect(page.getByRole("heading", { name: "Restart to turn it on" })).toBeVisible();
});

test("an unconfirmed BIOS install leads to checks, not to a failure", async ({ page }) => {
        await reachGuide(page);
        await button(page, "I finished in BIOS setup").click();
        await expect(page.getByRole("heading", { name: "Check two things in BIOS setup" })).toBeVisible();
        await expect(page.getByText("Check that CSM is off in BIOS setup.")).toBeVisible();
        await button(page, "Back to the steps").click();
        await expect(page.getByRole("heading", { name: "Now install it in BIOS setup" })).toBeVisible();
});

test("Korean install stays readable at the 900 px minimum window", async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 760 });
        await open(page, "not-observed", "ko");
        await expect(page.getByRole("heading", { name: "Resizable BAR를 켤 수 있습니다" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "내가 할 일" })).toBeVisible();
        expect(await noHorizontalOverflow(page)).toBe(true);
        await page.screenshot({ path: `${evidence}/ko-01-home-start-900.png` });
        await button(page, "시작하기").click();
        await button(page, "파일 고르기").click();
        await expect(page.getByRole("heading", { name: "설치와 복구 방법을 확인하세요" })).toBeVisible();
        expect(await noHorizontalOverflow(page)).toBe(true);
        await page.screenshot({ path: `${evidence}/ko-02-routes-900.png` });
        await button(page, "확인 완료 · 파일 만들기").click();
        await button(page, "USB에 저장").click();
        await expect(page.getByRole("heading", { name: "이제 BIOS 화면에서 설치합니다" })).toBeVisible();
        await expect(page.getByText("이 순서를 휴대폰으로 찍어 두세요. USB의 DEPLOYMENT.ko.txt에도 있습니다.")).toBeVisible();
        expect(await noHorizontalOverflow(page)).toBe(true);
        await page.screenshot({ path: `${evidence}/ko-03-guide-900.png` });
        await button(page, "BIOS 화면으로 다시 시작").click();
        await page.getByRole("dialog").getByRole("button", { name: "다시 시작", exact: true }).click();
        await page.reload();
        await expect(page.getByRole("heading", { name: "BIOS 화면에서 한 일을 기록하세요" })).toBeVisible();
        await button(page, "설치·설정 완료 기록").click();
        await expect(page.getByRole("heading", { name: "Resizable BAR를 켤 준비가 됐습니다" })).toBeVisible();
        expect(await noHorizontalOverflow(page)).toBe(true);
        await page.screenshot({ path: `${evidence}/ko-04-turn-on-900.png` });
        expect(await missingMessages(page)).toEqual([]);
});
