import { expect, test, type Page } from "@playwright/test";
import { button, missingMessages, noHorizontalOverflow, open } from "./support";

type ExternalState = "ready" | "secureBoot" | "enrollCertificate" | "bitLocker" | "consoleGpu" | "noUsb" | "loaderFails";

/** Opens the "Without changing the BIOS" page on a preview machine from the home start screen. */
async function openExternal(page: Page, external: ExternalState = "ready", locale: "en" | "ko" = "en") {
        await open(page, "not-observed", locale);
        // The preview bridge reads its scenario once, when the page loads.
        await page.evaluate((value) => localStorage.setItem("nvstraps-preview-external-state", value), external);
        await page.reload();
        await button(page, locale === "ko" ? "BIOS 수정 없이" : "Without changing the BIOS").click();
        await expect(page.getByTestId("external-page")).toBeVisible();
}

const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });

async function restart(page: Page, label = "Restart") {
        await button(page, label).click();
        await page.getByRole("dialog").getByRole("button", { name: label, exact: true }).click();
}

test("the USB try reaches the wider BAR and removes only its files", async ({ page }) => {
        await openExternal(page);
        await expect(heading(page, "Turn on Resizable BAR without changing the BIOS")).toBeVisible();
        await expect(page.getByRole("radio", { name: /^E: NVSTRAPS/ })).toBeChecked();
        await expect(page.getByRole("radio", { name: /^F: DATA/ })).toBeDisabled();
        expect(await noHorizontalOverflow(page)).toBe(true);
        await button(page, "Prepare the check").click();
        await expect(heading(page, "Start once from the USB drive")).toBeVisible();
        await restart(page);
        await expect(heading(page, "Increase this GPU's BAR size")).toBeVisible();
        await expect(page.getByRole("radio", { name: /^8 GiB/ })).toBeChecked();
        await button(page, "Prepare the trial").click();
        await expect(heading(page, "Start from the USB drive once more")).toBeVisible();
        await restart(page);
        await expect(heading(page, "The BAR is now 8 GiB")).toBeVisible();
        await button(page, "Remove from USB").click();
        await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
        await expect(heading(page, "Turn on Resizable BAR without changing the BIOS")).toBeVisible();
        expect(await missingMessages(page)).toEqual([]);
});

test("the install mode runs every start in Korean and asks before pausing BitLocker", async ({ page }) => {
        await openExternal(page, "bitLocker", "ko");
        await expect(heading(page, "BIOS를 고치지 않고 Resizable BAR 켜기")).toBeVisible();
        await page.getByRole("radio", { name: /^이 PC에 설치/ }).check();
        await button(page, "진단 준비").click();
        await expect(heading(page, "다음 부팅에서 진단합니다")).toBeVisible();
        await button(page, "다시 시작").click();
        await expect(page.getByRole("dialog")).toContainText("BitLocker 보호를 일시 중단합니다");
        await page.getByRole("dialog").getByRole("button", { name: "다시 시작", exact: true }).click();
        await expect(heading(page, "이 GPU의 BAR 크기 늘리기")).toBeVisible();
        await button(page, "시험 실행 준비").click();
        await expect(heading(page, "다음 부팅에서 시험합니다")).toBeVisible();
        await restart(page, "다시 시작");
        await expect(heading(page, "BAR 크기가 8 GiB로 늘었습니다")).toBeVisible();
        await button(page, "부팅할 때마다 실행").click();
        await expect(heading(page, "부팅할 때마다 BAR 크기를 늘립니다")).toBeVisible();
        expect(await noHorizontalOverflow(page)).toBe(true);
        expect(await missingMessages(page)).toEqual([]);
});

test("Secure Boot on stops the page before anything is written", async ({ page }) => {
        await openExternal(page, "secureBoot");
        await expect(heading(page, "Turn off Secure Boot first")).toBeVisible();
        await expect(button(page, "Prepare the check")).toHaveCount(0);
});

test("a GPU that shows the picture is refused with what to change", async ({ page }) => {
        await openExternal(page, "consoleGpu");
        await button(page, "Prepare the check").click();
        await restart(page);
        await expect(heading(page, "This PC cannot use this method yet")).toBeVisible();
        await expect(page.getByText("This GPU is displaying the screen", { exact: false })).toBeVisible();
        await expect(button(page, "Prepare the trial")).toHaveCount(0);
});

test("a loader that stops shows its reason after the restart", async ({ page }) => {
        await openExternal(page, "loaderFails");
        await button(page, "Prepare the check").click();
        await restart(page);
        await button(page, "Prepare the trial").click();
        await restart(page);
        await expect(heading(page, "The trial did not run")).toBeVisible();
        await expect(page.getByText("pinned successor missing or changed", { exact: true })).toBeVisible();
});

test("Secure Boot on asks for the certificate once and then lets the route start", async ({ page }) => {
        await openExternal(page, "enrollCertificate");
        await expect(heading(page, "Add the certificate to BIOS once")).toBeVisible();
        await button(page, "Save to USB").click();
        await expect(page.getByText("Saved as E:\\NvStrapsReBar-db.cer.", { exact: true })).toBeVisible();
        await button(page, "Restart into BIOS setup").click();
        await expect(page.getByRole("dialog")).toContainText("When BIOS setup opens");
        await page.getByRole("dialog").getByRole("button", { name: "Restart", exact: true }).click();
        await expect(heading(page, "Turn on Resizable BAR without changing the BIOS")).toBeVisible();
        await expect(page.locator(".nv-check").filter({ hasText: "Secure Boot" })).toContainText("On · certificate added");
        expect(await noHorizontalOverflow(page)).toBe(true);
        expect(await missingMessages(page)).toEqual([]);
});
