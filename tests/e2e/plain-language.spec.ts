import { expect, test } from "@playwright/test";

const evidence = ".superloopy/evidence/frontend/20260906T225510Z-plain-language-i18n";
for (const locale of ["en", "ko"] as const) {
  for (const width of [1180, 900]) {
    test(`${locale} plain-language settings and installation at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 760 });
      await page.goto("/");
      await page.getByTestId("language-select").selectOption(locale);
      const ko = locale === "ko";
      await page.getByRole("button", { name: ko ? "BAR 설정" : "BAR Settings", exact: true }).click();
      await page.getByLabel(ko ? "내장 목록 + 대체값" : "Built-in list + fallback").check();
      await expect(page.getByText(ko ? "목록에 없는 Turing GPU도 2 GiB로 확장합니다." : "Also expand Turing GPUs missing from the list to 2 GiB.")).toBeVisible();
      await expect(page.locator(".danger-check")).toHaveCount(0);
      await page.screenshot({ path: `${evidence}/${locale}-settings-${width}.png` });
      await page.getByRole("button", { name: ko ? "검토 후 저장" : "Review & save" }).click();
      const modal = page.getByRole("dialog");
      await expect(modal).toContainText(ko ? "Windows를 다시 시작하면 적용됩니다." : "after you restart Windows");
      await expect(modal).not.toContainText(/read back|UEFI|다시 읽|변수/);
      await expect(modal.getByRole("button", { name: ko ? "취소" : "Cancel", exact: true })).toBeFocused();
      await page.screenshot({ path: `${evidence}/${locale}-save-${width}.png` });
      await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0);
      await expect(page.getByRole("button", { name: ko ? "검토 후 저장" : "Review & save" })).toBeFocused();
      await page.getByRole("button", { name: ko ? "펌웨어 설치" : "Install firmware" }).click();
      await page.getByRole("button", { name: ko ? "파일 선택" : "Choose file" }).click();
      await expect(page.locator(".detected-route")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(page.locator(".detected-route")).toHaveCSS("border-left-width", "0px");
      await expect(page.locator(".deployment-content")).not.toContainText(/SHA-256|READ-ONLY|읽기 전용/);
      await page.screenshot({ path: `${evidence}/${locale}-install-${width}.png` });
      await page.getByText(ko ? "이 보드의 제조사 설치 및 복구 지침을 확인했습니다." : "I checked the vendor install and recovery instructions for this board.").click();
      await page.getByRole("button", { name: ko ? "이 컴퓨터의 프로필 만들기" : "Create profile for this computer" }).click();
      await page.getByRole("button", { name: ko ? "BIOS 이미지 준비" : "Prepare BIOS image" }).click();
      for (let step = 0; step < 2; step++) {
        await page.getByRole("button", { name: ko ? "완료한 단계 검토 및 확인" : "Review & confirm completed step" }).click();
        await page.getByRole("dialog").getByRole("button", { name: ko ? "완료한 단계 기록" : "Record completed step" }).click();
      }
      await page.getByRole("button", { name: ko ? "다시 시작한 뒤 드라이버 확인" : "Check driver after restart" }).click();
      const recommendation = page.locator(".recommended-config");
      await expect(recommendation).toContainText(ko ? "권장 BAR 설정" : "Recommended BAR settings");
      await expect(recommendation.locator("code, .recommendation-facts")).toHaveCount(0);
      await expect(recommendation).not.toContainText(/true|false|selector|PCI|전역 모드|설정 보호/);
      await recommendation.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${evidence}/${locale}-recommendation-${width}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? [])).toEqual([]);
    });
  }
}
