// Captures docs/frontend-gallery from the production build running the browser-preview fixtures.
//
//   npm run build
//   node scripts/capture-frontend-gallery.mjs
//
// The captures show the preview fixtures only: no native WebView2, dialogs, firmware, reboot or
// NVIDIA hardware. Set NVSTRAPS_GALLERY_CHROMIUM to a Chromium binary when the one bundled with
// @playwright/test is not installed.
import { chromium } from "@playwright/test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "docs", "frontend-gallery");
const port = 4174;
const base = `http://127.0.0.1:${port}`;

const WIDE = { width: 1180, height: 760 };
const NARROW = { width: 900, height: 760 };

/** Opens the preview with a clean session, a system state, a language and optional scenarios. */
async function open(page, { state = "expanded", locale = "en", session = {}, local = {} } = {}) {
  await page.goto(base);
  await page.evaluate(
    ([state, locale, session, local]) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("nvstraps-rebar.ui.language", locale);
      sessionStorage.setItem("nvstraps-preview-rebar-state", state);
      for (const [key, value] of Object.entries(session)) sessionStorage.setItem(key, value);
      for (const [key, value] of Object.entries(local)) localStorage.setItem(key, value);
    },
    [state, locale, session, local],
  );
  await page.reload();
  await page.locator(".nv-root").waitFor();
}

const button = (page, name) => page.getByRole("button", { name, exact: true });
const heading = (page, name) => page.getByRole("heading", { name, exact: true }).waitFor();

async function restartDialog(page, opener, confirm) {
  await button(page, opener).click();
  await page.getByRole("dialog").getByRole("button", { name: confirm, exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
}

/** Install journey, English or Korean labels. */
const t = (locale, en, ko) => (locale === "ko" ? ko : en);

async function toFirmwarePicker(page, locale) {
  await open(page, { state: "not-observed", locale });
  await button(page, t(locale, "Get started", "시작하기")).click();
}

async function toRoutes(page, locale) {
  await toFirmwarePicker(page, locale);
  await button(page, t(locale, "Choose file", "파일 고르기")).click();
  await heading(page, t(locale, "Check the install and recovery methods", "설치와 복구 방법을 확인하세요"));
}

async function toSave(page, locale) {
  await toRoutes(page, locale);
  await button(page, t(locale, "Checked · make the file", "확인 완료 · 파일 만들기")).click();
  await heading(page, t(locale, "Save to USB", "USB에 저장하세요"));
}

async function toGuide(page, locale) {
  await toSave(page, locale);
  await button(page, t(locale, "Save to USB", "USB에 저장")).click();
  await heading(page, t(locale, "Install it in BIOS setup", "BIOS 화면에서 설치하세요"));
}

async function toRecord(page, locale) {
  await toGuide(page, locale);
  await restartDialog(page, t(locale, "Restart into BIOS setup", "BIOS 화면으로 다시 시작"), t(locale, "Restart", "다시 시작"));
  await page.reload();
  await heading(page, t(locale, "Record what you did in BIOS setup", "BIOS 화면에서 한 일을 기록하세요"));
}

async function toTurnOn(page, locale) {
  await toRecord(page, locale);
  await button(page, t(locale, "Record install and settings", "설치·설정 완료 기록")).click();
  await heading(page, t(locale, "Ready to turn on Resizable BAR", "Resizable BAR를 켤 준비가 됐습니다"));
}

/** The per-game page after one game was switched on, so the changed list is visible. */
async function toGames(page, locale) {
  await open(page, { locale, session: { "nvstraps-preview-games-state": "ready" } });
  await page.getByRole("button", { name: t(locale, "Turn on for each game", "게임마다 켜기") }).first().click();
  await page.getByTestId("games-page").waitFor();
  const search = page.getByRole("searchbox", { name: t(locale, "Find a game", "게임 찾기") });
  await search.fill("elden");
  const elden = page.getByRole("list", { name: t(locale, "Find a game", "게임 찾기") }).getByRole("switch", { name: "Elden Ring" });
  await elden.click();
  await page.waitForFunction(() => !document.querySelector('[role="switch"][aria-busy="true"]'));
  await search.fill("");
  await search.evaluate((element) => element.blur());
  await page.getByRole("list", { name: t(locale, "Games changed on this PC", "이 PC에서 바꾼 게임") }).waitFor();
}

async function toBarSettings(page, locale) {
  await open(page, { state: "expanded", locale });
  await page.getByRole("button", { name: t(locale, "BAR Settings", "BAR 설정") }).first().click();
  await page.getByText(t(locale, "Advanced", "고급"), { exact: false }).first().click();
}

async function toExternal(page, locale) {
  await open(page, { state: "not-observed", locale, local: { "nvstraps-preview-external-state": "ready" } });
  await button(page, t(locale, "Without changing the BIOS", "BIOS 수정 없이")).click();
  await page.getByTestId("external-page").waitFor();
}

/** One entry per gallery image, in the order the README shows them. */
const SHOTS = [
  ["01-home-on-en", WIDE, (page) => open(page, { state: "expanded", locale: "en" })],
  ["02-home-start-ko", WIDE, (page) => open(page, { state: "not-observed", locale: "ko" })],
  ["03-install-choose-file-en", WIDE, (page) => toFirmwarePicker(page, "en")],
  ["04-install-routes-ko", NARROW, (page) => toRoutes(page, "ko")],
  ["05-install-save-en", NARROW, (page) => toSave(page, "en")],
  ["06-install-guide-ko", WIDE, (page) => toGuide(page, "ko")],
  ["07-install-record-en", NARROW, (page) => toRecord(page, "en")],
  ["08-turn-on-ko", WIDE, (page) => toTurnOn(page, "ko")],
  ["09-home-mixed-en", NARROW, (page) => open(page, { state: "mixed", locale: "en" })],
  ["10-bar-settings-en", WIDE, (page) => toBarSettings(page, "en")],
  ["11-games-en", WIDE, (page) => toGames(page, "en")],
  ["12-external-ko", WIDE, (page) => toExternal(page, "ko")],
];

async function main() {
  const server = await preview({ root, logLevel: "warn", preview: { host: "127.0.0.1", port, strictPort: true } });
  const browser = await chromium.launch({ executablePath: process.env.NVSTRAPS_GALLERY_CHROMIUM || undefined });
  const only = process.argv.slice(2);
  try {
    await mkdir(output, { recursive: true });
    if (only.length === 0) {
      for (const file of await readdir(output)) {
        if (file.endsWith(".png")) await rm(join(output, file));
      }
    }
    for (const [name, viewport, reach] of SHOTS) {
      if (only.length > 0 && !only.some((prefix) => name.startsWith(prefix))) continue;
      const context = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: "reduce" });
      const page = await context.newPage();
      await reach(page);
      await page.evaluate(() => document.fonts.ready);
      const missing = await page.evaluate(() => window.__NVSTRAPS_I18N_MISSING__ ?? []);
      if (missing.length > 0) throw new Error(`${name}: missing messages ${missing.join(", ")}`);
      const file = `${name}-${viewport.width}x${viewport.height}.png`;
      await page.screenshot({ path: join(output, file) });
      console.log(`captured ${file}`);
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
}

await main();
