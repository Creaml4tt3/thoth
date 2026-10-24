/**
 * The desktop UI's language, fonts and Private Space folder, in Chromium on the real Rust host (the e2e bridge):
 *
 * 1. A Thai system (`locale: th-TH`) gets the Thai UI; Settings → Language switches to English and back to System.
 * 2. The bundled Inter and Noto Sans Thai load from the app itself, with every other request blocked.
 * 3. Settings shows the folder shortened, with the full path as a tooltip, and Show in Finder reaches the host.
 */
import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, type Bridge } from "./bridge.ts";
import { buildAll } from "./setup.ts";

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge;
const revealed: unknown[] = [];
const blocked: string[] = [];

test.use({ locale: "th-TH" });

test.beforeAll(async () => {
  built = await buildAll();
});

test.beforeEach(async ({ page, context }) => {
  revealed.length = 0;
  blocked.length = 0;
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-lang-")));
  vault = join(scratch, "Vault");
  await mkdir(vault);
  bridge = await startBridge({
    dist: built.dist,
    bridgeDir: built.bridgeDir,
    host: { binary: built.binary, pickVault: vault, dataDir: join(scratch, "data"), onHostEvent: (event, payload) => event === "vault.revealed" && revealed.push(payload) },
  });
  // No network: only the bridge origin is reachable, so fonts can only come from the app.
  await context.route(
    (url) => !url.href.startsWith(bridge.url),
    (route) => {
      blocked.push(route.request().url());
      return route.abort();
    },
  );
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
});

test.afterEach(async ({ page }) => {
  await page.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

test("a Thai system gets the Thai UI with the bundled fonts, and Settings changes the language", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("lang", "th");
  await page.getByRole("button", { name: "เลือกหรือสร้าง Private Space" }).click();
  await page.getByRole("button", { name: "เริ่มเขียน" }).click();
  await page.getByRole("button", { name: "หน้าใหม่" }).click();
  const dialog = page.getByRole("dialog", { name: "หน้าใหม่" });
  await dialog.getByRole("textbox").fill("บันทึก");
  await dialog.getByRole("button", { name: "สร้าง" }).click();
  await expect(page.getByRole("group", { name: "โหมดแก้ไข" })).toBeVisible();

  // Both bundled faces are loaded from the app, for Latin and for Thai text, and nothing was fetched elsewhere.
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([document.fonts.load('16px "Inter Variable"', "Thoth"), document.fonts.load('16px "Noto Sans Thai"', "บันทึก")]);
    return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, ""));
  });
  expect(fonts).toEqual(expect.arrayContaining(["Inter Variable", "Noto Sans Thai"]));
  const families = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(families).toMatch(/^"Inter Variable", "Noto Sans Thai"/);
  expect(blocked.filter((u) => /font|woff/i.test(u))).toEqual([]);

  // Settings → Language: English now, remembered after a reload, then back to the system's Thai.
  await page.getByRole("button", { name: "การตั้งค่า" }).click();
  const language = page.getByRole("combobox", { name: "ภาษา" });
  await expect(language).toHaveValue("system");
  await language.selectOption("en");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.reload();
  await page.getByRole("button", { name: "Choose or create a Private Space" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("combobox", { name: "Language" }).selectOption("system");
  await expect(page.getByRole("heading", { level: 1, name: "การตั้งค่า" })).toBeVisible();
});

test("Settings shows the folder shortened with the full path as a tooltip, and Show in reaches the host", async ({ page }) => {
  await page.getByRole("button", { name: "เลือกหรือสร้าง Private Space" }).click();
  await page.getByRole("button", { name: "เริ่มเขียน" }).click();
  await page.getByRole("button", { name: "การตั้งค่า" }).click();
  const location = page.getByTestId("vault-location");
  await expect(location).toHaveAttribute("title", vault);
  const shown = (await location.textContent()) ?? "";
  expect([...shown].length).toBeLessThanOrEqual(48);
  expect(shown.endsWith("Vault")).toBe(true);
  await page.getByRole("button", { name: /^แสดงใน/ }).click();
  await expect.poll(() => revealed).toEqual([{ root: vault }]);
});
