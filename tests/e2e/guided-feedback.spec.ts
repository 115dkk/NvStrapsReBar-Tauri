import { expect, test, type Page } from "@playwright/test";
import { button, missingMessages, noHorizontalOverflow, open } from "./support";

/**
 * Usability reports from a tester who went through the app on a Linux PC (issue #63).
 * Browser preview only; `?os=linux` makes the preview report Linux.
 */
type Os = "windows" | "linux";
const systems: Os[] = ["windows", "linux"];

const brand = (page: Page) => button(page, "NvStrapsReBar");
const records = (page: Page) => page.getByTestId("profiles-page").getByRole("listitem");
const deleteDialog = (page: Page) => page.getByRole("dialog", { name: "Delete this preparation record?" });

/** From the start screen to the saved-file screen of a new record. */
async function makeRecord(page: Page) {
        await button(page, "Get started").click();
        await button(page, "Choose file").click();
        await button(page, "Checked · make the file").click();
        await expect(page.getByRole("heading", { name: "Save to USB" })).toBeVisible();
}

/** A second record for another BIOS file, made from a typed location. */
async function makeAnotherRecord(page: Page) {
        await page.getByRole("button", { name: "Menu" }).click();
        await page.getByRole("menuitem", { name: "Prepare another BIOS file" }).click();
        await page.getByText("Type the file location instead").click();
        await page.getByPlaceholder("Choose a vendor BIOS image or enter an absolute path").fill("C:\\Firmware\\changed-fingerprint.bin");
        await button(page, "Read file").click();
        await button(page, "Checked · make the file").click();
        await expect(page.getByRole("heading", { name: "Save to USB" })).toBeVisible();
}

async function openRecords(page: Page) {
        await page.getByRole("button", { name: "Menu" }).click();
        await page.getByRole("menuitem", { name: "Open an earlier preparation" }).click();
        await expect(page.getByTestId("profiles-page")).toBeVisible();
}

/** From the start screen to the install-method choice on the MSI preview board. */
async function reachInstallQuestion(page: Page) {
        await button(page, "Get started").click();
        await button(page, "Choose file").click();
        await page.getByText("Choose other install and recovery methods").click();
        await button(page, "Choose manually").click();
        await button(page, "Next").click();
        await expect(page.getByRole("heading", { name: "Choose how to install the BIOS" })).toBeVisible();
}

for (const os of systems) {
        test(`${os}: the empty file box chooses the file`, async ({ page }) => {
                await page.setViewportSize({ width: 1180, height: 760 });
                await open(page, "not-observed", "en", os);
                await button(page, "Get started").click();
                const box = page.getByRole("button", { name: /^No file chosen yet/ });
                await expect(box).toContainText("Choose the file, or drop it here.");
                expect(await noHorizontalOverflow(page)).toBe(true);
                await box.click();
                await expect(page.getByRole("heading", { name: "Check the install and recovery methods" })).toBeVisible();
                await expect(page.getByText("E7D25IMS.1N0", { exact: true })).toBeVisible();
                expect(await missingMessages(page)).toEqual([]);
        });

        test(`${os}: Next refuses an address that does not start with https:// and says so under the field`, async ({ page }) => {
                await page.setViewportSize({ width: 1180, height: 760 });
                await open(page, "not-observed", "en", os);
                await reachInstallQuestion(page);
                const address = page.getByLabel("Manual address (optional)");
                const next = button(page, "Next");
                const message = page.getByText("The address must start with https://. Correct it or clear the field.");
                await address.fill("http://example.com/manual.pdf");
                // The address is checked when Next is pressed, not while it is typed.
                await expect(message).toHaveCount(0);
                await expect(next).toBeEnabled();
                await next.click();
                await expect(page.getByRole("heading", { name: "Choose how to install the BIOS" })).toBeVisible();
                await expect(message).toBeVisible();
                await expect(address).toBeFocused();
                await expect(address).toHaveAttribute("aria-invalid", "true");
                await expect(address).toHaveAccessibleDescription(/^The address must start with https:\/\/\. Correct it or clear the field\./);
                expect(await noHorizontalOverflow(page)).toBe(true);
                // The message leaves as soon as the address is acceptable.
                await address.fill("https://example.com/manual.pdf");
                await expect(message).toHaveCount(0);
                await expect(address).not.toHaveAttribute("aria-invalid");
                await next.click();
                await expect(page.getByRole("heading", { name: "Choose how to recover if the BIOS install fails" })).toBeVisible();
                expect(await missingMessages(page)).toEqual([]);
        });

        test(`${os}: the manual address may stay empty`, async ({ page }) => {
                await open(page, "not-observed", "en", os);
                await reachInstallQuestion(page);
                await page.getByLabel("Manual address (optional)").fill("");
                await button(page, "Next").click();
                await expect(page.getByText("The address must start with https://. Correct it or clear the field.")).toHaveCount(0);
                await expect(page.getByRole("heading", { name: "Choose how to recover if the BIOS install fails" })).toBeVisible();
                await button(page, "Checked · make the file").click();
                await expect(page.getByRole("heading", { name: "Save to USB" })).toBeVisible();
        });

        test(`${os}: the BIOS-setup method names this board's update tool`, async ({ page }) => {
                await open(page, "not-observed", "en", os);
                await reachInstallQuestion(page);
                const method = page.locator("label", { hasText: "Update tool in BIOS setup" });
                await expect(method).toContainText("M-FLASH, inside BIOS setup");
                await expect(method).not.toContainText("EZ Flash");
        });

        test(`${os}: the install steps say the PC may restart several times`, async ({ page }) => {
                await open(page, "not-observed", "en", os);
                await makeRecord(page);
                await button(page, "Save to USB").click();
                await expect(page.getByRole("heading", { name: "Install it in BIOS setup" })).toBeVisible();
                const afterPower = page.locator(".nv-steps > li", { hasText: "Keep the power on until the installation finishes." }).locator("xpath=following-sibling::li[1]");
                await expect(afterPower).toContainText("The PC may restart several times.");
                await expect(afterPower).toContainText("Some restarts take longer than usual. Wait until it starts normally.");
                expect(await missingMessages(page)).toEqual([]);
        });

        test(`${os}: BAR settings say once why a size can exceed the VRAM`, async ({ page }) => {
                await page.setViewportSize({ width: 900, height: 620 });
                await open(page, "mixed", "en", os);
                await button(page, "Open BAR settings").click();
                await expect(page.getByTestId("bar-page").locator(".nv-gpu")).toHaveCount(2);
                await expect(page.getByText(/^BAR size is an address range, not memory\./)).toHaveCount(1);
                expect(await noHorizontalOverflow(page)).toBe(true);
                expect(await missingMessages(page)).toEqual([]);
        });

        test(`${os}: the only record opens from the menu and is deleted through one dialog`, async ({ page }) => {
                await page.setViewportSize({ width: 1180, height: 760 });
                await open(page, "not-observed", "en", os);
                await makeRecord(page);
                await page.getByRole("button", { name: "Menu" }).click();
                await expect(page.getByRole("menuitem", { name: "Open an earlier preparation" })).toBeEnabled();
                await page.getByRole("menuitem", { name: "Open an earlier preparation" }).click();
                await expect(records(page)).toHaveCount(1);
                const remove = records(page).first().getByRole("button", { name: "Delete this record" });
                await remove.click();
                const dialog = deleteDialog(page);
                await expect(dialog).toContainText("PRO Z690-A DDR4 · RTX 2080 SUPER");
                await expect(dialog).toContainText("E7D25IMS.1N0");
                await expect(dialog).toContainText("The record and the copy of the original BIOS kept on this PC are removed. Files already saved to a USB drive stay.");
                await expect(dialog.getByRole("button")).toHaveCount(2);
                await expect(dialog.getByRole("checkbox")).toHaveCount(0);
                await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
                expect(await noHorizontalOverflow(page)).toBe(true);
                // Closing changes nothing and returns focus to the button that asked.
                await page.keyboard.press("Escape");
                await expect(dialog).toHaveCount(0);
                await expect(records(page)).toHaveCount(1);
                await expect(remove).toBeFocused();

                await remove.click();
                await dialog.getByRole("button", { name: "Delete", exact: true }).click();
                await expect(dialog).toHaveCount(0);
                await expect(records(page)).toHaveCount(0);
                await expect(page.getByText("No preparation records on this PC.")).toBeVisible();
                await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
                await expect(page.getByRole("alert")).toHaveCount(0);
                // Nothing is left to open.
                await page.getByRole("button", { name: "Menu" }).click();
                await expect(page.getByRole("menuitem", { name: "Open an earlier preparation" })).toBeDisabled();
                await expect(page.getByRole("menuitem", { name: "Installation record" })).toBeDisabled();
                await page.keyboard.press("Escape");
                expect(await missingMessages(page)).toEqual([]);
                // The app starts over, also after it is reopened.
                await brand(page).click();
                await expect(page.getByRole("heading", { level: 1 })).toHaveText("You can turn on Resizable BAR");
                await page.reload();
                await expect(page.getByRole("heading", { level: 1 })).toHaveText("You can turn on Resizable BAR");
                await button(page, "Get started").click();
                await expect(page.getByRole("heading", { name: "Choose the motherboard BIOS file" })).toBeVisible();
        });

        test(`${os}: deleting the open record opens the one that is left`, async ({ page }) => {
                await page.setViewportSize({ width: 900, height: 620 });
                await open(page, "not-observed", "en", os);
                await makeRecord(page);
                await makeAnotherRecord(page);
                await openRecords(page);
                await expect(records(page)).toHaveCount(2);
                expect(await noHorizontalOverflow(page)).toBe(true);
                const open2 = records(page).filter({ hasText: "changed-fingerprint.bin" });
                await expect(open2).toContainText("Open now");
                await open2.getByRole("button", { name: "Delete this record" }).click();
                await expect(deleteDialog(page)).toContainText("changed-fingerprint.bin");
                expect(await noHorizontalOverflow(page)).toBe(true);
                await deleteDialog(page).getByRole("button", { name: "Delete", exact: true }).click();
                await expect(records(page)).toHaveCount(1);
                await expect(records(page).first()).toContainText("E7D25IMS.1N0 · Open now");
                // Focus goes to the row that took the removed row's place.
                await expect(records(page).first().getByRole("button", { name: "Delete this record" })).toBeFocused();
                await records(page).first().getByRole("button", { name: /E7D25IMS\.1N0/ }).click();
                await expect(page.getByRole("heading", { name: "Save to USB" })).toBeVisible();
                await expect(page.getByText("with the original name (E7D25IMS.1N0)", { exact: false })).toBeVisible();
        });
}

test("in a short window the refused address scrolls into view together with its message", async ({ page }) => {
        // Windows offers four methods, so the address field starts below the fold of the minimum window.
        await page.setViewportSize({ width: 900, height: 620 });
        await open(page, "not-observed");
        await reachInstallQuestion(page);
        const address = page.getByLabel("Manual address (optional)");
        const message = page.getByText("The address must start with https://. Correct it or clear the field.");
        const toTop = () => page.locator(".nv-task-scroll").evaluate((element) => element.scrollTo(0, 0));
        await address.fill("example.com");
        await toTop();
        await expect(address).not.toBeInViewport();
        await button(page, "Next").click();
        await expect(message).toBeInViewport({ ratio: 1 });
        await expect(address).toBeInViewport({ ratio: 1 });
        await expect(address).toBeFocused();
        // A second press after scrolling away brings both back.
        await toTop();
        await expect(message).not.toBeInViewport();
        await button(page, "Next").click();
        await expect(message).toBeInViewport({ ratio: 1 });
        expect(await noHorizontalOverflow(page)).toBe(true);
});

test("after the open record is deleted, the next preparation starts from its first screens", async ({ page }) => {
        await open(page, "not-observed");
        // This record is made through the three choices, which leaves the install screens at the last one.
        await reachInstallQuestion(page);
        await button(page, "Next").click();
        await button(page, "Checked · make the file").click();
        await expect(page.getByRole("heading", { name: "Save to USB" })).toBeVisible();
        await openRecords(page);
        await records(page).first().getByRole("button", { name: "Delete this record" }).click();
        await deleteDialog(page).getByRole("button", { name: "Delete", exact: true }).click();
        await expect(page.getByText("No preparation records on this PC.")).toBeVisible();
        await brand(page).click();
        await button(page, "Get started").click();
        await button(page, "Choose file").click();
        // The choices made for the removed record are not carried over.
        await expect(page.getByRole("heading", { name: "Check the install and recovery methods" })).toBeVisible();
});

test("a delete that fails keeps the record and says so on the page", async ({ page }) => {
        await open(page, "not-observed");
        await makeRecord(page);
        await openRecords(page);
        // The preview keeps its records in session storage; refusing that write makes the delete fail.
        await page.evaluate(() => {
                const setItem = Storage.prototype.setItem;
                Storage.prototype.setItem = function (key: string, value: string) {
                        if (key === "nvstraps-preview-profiles") throw new Error("The record could not be removed.");
                        setItem.call(this, key, value);
                };
        });
        const remove = records(page).first().getByRole("button", { name: "Delete this record" });
        await remove.click();
        await deleteDialog(page).getByRole("button", { name: "Delete", exact: true }).click();
        await expect(page.getByRole("alert")).toContainText("This step did not finish");
        await expect(page.getByRole("alert")).toContainText("The record could not be removed.");
        await expect(records(page)).toHaveCount(1);
        await expect(page.getByText("No preparation records on this PC.")).toHaveCount(0);
        await expect(remove).toBeFocused();
        await expect(remove).toBeEnabled();
});

test("the brand opens home and is locked together with the menu", async ({ page }) => {
        await open(page, "not-observed");
        await expect(brand(page)).toHaveAttribute("title", "Home");
        await makeRecord(page);
        await button(page, "Save to USB").click();
        await button(page, "Restart into BIOS setup").click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await expect(brand(page)).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(brand(page)).toBeEnabled();
        await brand(page).click();
        await expect(page.locator(".nv-root")).toHaveAttribute("data-page", "home");
        await expect(button(page, "Continue setup")).toBeVisible();
        // The crumb's Home is still the only button named Home.
        await page.getByRole("button", { name: "Menu" }).click();
        await page.getByRole("menuitem", { name: "Installation record" }).click();
        await expect(button(page, "Home")).toHaveCount(1);
});

test("Korean: the changed screens carry their text and fit the 900 px minimum window", async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 620 });
        await open(page, "not-observed", "ko", "linux");
        await button(page, "시작하기").click();
        await expect(page.getByRole("button", { name: /^아직 고른 파일이 없습니다/ })).toContainText("파일을 고르거나 여기에 끌어다 놓으세요.");
        await page.getByRole("button", { name: /^아직 고른 파일이 없습니다/ }).click();
        await page.getByText("다른 설치·복구 방법 고르기").click();
        await button(page, "직접 고르기").click();
        await button(page, "다음").click();
        await expect(page.locator("label", { hasText: "BIOS 화면의 업데이트 도구" })).toContainText("BIOS 화면 안에 있는 M-FLASH");
        await page.getByLabel("안내서 주소 (선택)").fill("example.com");
        await button(page, "다음").click();
        await expect(page.getByText("주소는 https://로 시작해야 합니다. 고치거나 칸을 비우세요.")).toBeVisible();
        await expect(page.getByLabel("안내서 주소 (선택)")).toBeFocused();
        expect(await noHorizontalOverflow(page)).toBe(true);
        await page.getByLabel("안내서 주소 (선택)").fill("");
        await button(page, "다음").click();
        await button(page, "확인 완료 · 파일 만들기").click();
        await button(page, "USB에 저장").click();
        await expect(page.getByText("PC가 여러 번 다시 시작되기도 합니다.")).toBeVisible();
        expect(await noHorizontalOverflow(page)).toBe(true);
        await page.getByRole("button", { name: "메뉴" }).click();
        await page.getByRole("menuitem", { name: "이전 준비 기록 열기" }).click();
        await records(page).first().getByRole("button", { name: "이 기록 지우기" }).click();
        const dialog = page.getByRole("dialog", { name: "이 준비 기록을 지울까요?" });
        await expect(dialog).toContainText("기록과 이 PC에 보관한 원본 BIOS 사본이 지워집니다. USB에 이미 저장한 파일은 그대로 남습니다.");
        expect(await noHorizontalOverflow(page)).toBe(true);
        await dialog.getByRole("button", { name: "지우기", exact: true }).click();
        await expect(page.getByText("이 PC에 준비 기록이 없습니다.")).toBeVisible();
        expect(await missingMessages(page)).toEqual([]);
});
