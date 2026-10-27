/**
 * The update notice in the real desktop UI (ADR-0022; Chromium, the real Rust host through the dev bridge). A local
 * server stands in for `https://download.thoth.creaml4tt3.me/latest.json`: the harness runs with `--update-url` and the
 * test-only loopback switch (which the app cannot turn on), and the page itself can reach nothing but the bridge, so the
 * one request for `latest.json` is the host's.
 *
 * 1. Start the app: after 10 s a popup says 9.9.9 is out (the app is 0.1.3). It takes no focus. "What's new" and
 *    "Download" go to the host (the harness reports the browser it would open). "Skip this version" is remembered.
 * 2. Restart the app 25 hours later (the harness clock is fixed, so the 24-hour wait is over): the host asks again, and
 *    nothing is shown, because the version was skipped. "Check now" in Settings still shows it.
 * 3. Turned off in Settings: no request at all, and "Check now" is disabled.
 *
 * It saves pictures of the popup and of Settings → General, light and dark, under tests/.tmp/update/ (git-ignored).
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { REPO } from "../ports/harness.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { buildAll } from "./setup.ts";

const SHOTS = join(REPO, "tests", ".tmp", "update");
/** The fixed time the host's update clock starts at (Unix seconds), and a day and an hour later. */
const T0 = 1_900_000_000;
const DOWNLOADS = "https://thoth.creaml4tt3.me/#download";
const NOTES = "https://thoth.creaml4tt3.me/changes#9.9.9";
const LATEST = { version: "9.9.9", date: "2026-11-02", base: "https://download.thoth.creaml4tt3.me/v9.9.9/", files: [], notes: NOTES, extra: { ignored: true } };

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge | undefined;
let latest: Server;
let latestUrl: string;
let asked: string[];
let opened: string[];

test.use({ viewport: { width: 1200, height: 800 } });

test.beforeAll(async () => {
  built = await buildAll();
  await mkdir(SHOTS, { recursive: true });
});

test.beforeEach(async () => {
  asked = [];
  opened = [];
  latest = createServer((req, res) => {
    asked.push(`${req.method} ${req.url} ${req.headers["user-agent"]}`);
    if (req.url === "/latest.json") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(LATEST));
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => latest.listen(0, "127.0.0.1", resolve));
  latestUrl = `http://127.0.0.1:${(latest.address() as AddressInfo).port}/latest.json`;
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-update-")));
  vault = join(scratch, "Vault");
  await mkdir(vault);
  await writeFile(join(vault, "Notes.md"), "# Notes\n\nA page to type in.\n");
});

test.afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
  await new Promise((resolve) => latest.close(resolve));
  await rm(scratch, { recursive: true, force: true });
});

/** The app, started as the desktop shell starts it: a host process on the data folder, then the page. `now`: the host's update clock. */
async function launch(browser: Browser, now: number, port?: number): Promise<{ page: Page; close(): Promise<void> }> {
  bridge = await startBridge({
    dist: built.dist,
    bridgeDir: built.bridgeDir,
    ...(port ? { port } : {}),
    host: {
      binary: built.binary,
      pickVault: vault,
      dataDir: join(scratch, "data"),
      linkPreviewLoopback: true,
      updateUrl: latestUrl,
      updateCurrent: "0.1.3",
      updateNow: now,
      onHostEvent: (event, payload) => void (event === "browser.open" && opened.push((payload as { url: string }).url)),
    },
  });
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  // No network for the page: only the bridge is reachable. `latest.json` is reached by the host alone.
  await context.route((url) => !url.href.startsWith(bridge!.url), (route) => route.abort());
  await context.addInitScript(bridge.initScript);
  const page = await context.newPage();
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  const tree = page.getByRole("tree", { name: "Pages in this Private Space" });
  const start = page.getByRole("button", { name: /start writing/i });
  await expect(tree.or(start)).toBeVisible();
  if (await start.isVisible()) await start.click();
  await expect(tree).toBeVisible();
  return { page, close: () => context.close() };
}

const popup = (page: Page) => page.getByRole("dialog", { name: "Thoth 9.9.9 is out" });
const theme = (page: Page, dark: boolean) => page.evaluate((night) => document.documentElement.setAttribute("data-theme", night ? "night" : "light"), dark);

async function expectAccessible(page: Page, selector: string) {
  const results = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  const toggle = page.getByRole("switch", { name: "Tell me when a new version is out" });
  await expect(toggle).toBeVisible();
  return toggle;
}

test("a popup right after the app opens for a newer version; Skip is remembered across a restart, and Check now still shows it", async ({ browser }) => {
  const first = await launch(browser, T0);
  const page = first.page;
  await expect(popup(page)).toBeVisible({ timeout: 25_000 });
  expect(asked).toEqual(["GET /latest.json Thoth/0.1.3 (update check)"]);

  // A small dialog in the corner that takes no focus: typing in the page goes on.
  await expect(popup(page)).toContainText("Released 2026-11-02.");
  expect(await page.evaluate(() => document.activeElement?.closest("[data-testid=update-notice]") ?? null)).toBeNull();
  await page.getByRole("treeitem", { name: "Notes" }).click();
  const box = page.getByRole("textbox", { name: /page content/i });
  await box.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" More.");
  await expect(box).toContainText("More.");
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup(page)).toBeVisible(); // Esc while typing belongs to the editor
  await expectAccessible(page, "[data-testid=update-notice]");

  // Pictures, light and dark, still.
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const dark of [false, true]) {
    await theme(page, dark);
    await popup(page).screenshot({ path: join(SHOTS, `popup-${dark ? "dark" : "light"}.png`) });
    await page.screenshot({ path: join(SHOTS, `popup-in-window-${dark ? "dark" : "light"}.png`) });
  }
  await theme(page, false);

  // The notification list has an entry for it, and no system notification was asked for (nothing was set up for one).
  await expect(page.getByRole("button", { name: "Notifications, 1 unread" })).toBeVisible();

  // "What's new" opens the release notes through the host and leaves the popup; "Download" opens the downloads page.
  await popup(page).getByRole("button", { name: "What's new" }).click();
  await expect.poll(() => opened).toEqual([NOTES]);
  await expect(popup(page)).toBeVisible();
  await popup(page).getByRole("button", { name: "Later" }).click();
  await expect(popup(page)).toBeHidden();
  // The list's entry brings it back; then it is skipped.
  await page.getByRole("button", { name: "Notifications, 1 unread" }).click();
  await page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: /Thoth 9\.9\.9 is out/ }).click();
  await expect(popup(page)).toBeVisible();
  await popup(page).getByRole("button", { name: "Download" }).click();
  await expect.poll(() => opened).toEqual([NOTES, DOWNLOADS]);
  await expect(popup(page)).toBeHidden();
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: /Thoth 9\.9\.9 is out/ }).click();
  await popup(page).getByRole("button", { name: "Skip this version" }).click();
  await expect(popup(page)).toBeHidden();
  // The popup closes before the host has written the choice down: wait for the file, not for the popup.
  const kept = () => readFile(join(scratch, "data", "update.json"), "utf8").then((text) => JSON.parse(text) as { notify: boolean; lastCheck: number; skipped: string }, () => null);
  await expect.poll(kept).toMatchObject({ notify: true, lastCheck: T0, skipped: "9.9.9" });
  expect(asked).toHaveLength(1);

  // Restart an hour later: every start of the app asks again, but the version was skipped.
  const port = Number(new URL(bridge!.url).port);
  await first.close();
  await bridge!.close();
  const second = await launch(browser, T0 + 3600, port);
  await expect.poll(() => asked.length, { timeout: 25_000 }).toBe(2);
  await second.page.waitForTimeout(500);
  await expect(popup(second.page)).toBeHidden();
  await expect(second.page.getByRole("button", { name: "Notifications" })).toBeVisible();

  // "Check now" is the person asking: it shows a skipped version, and says what it found.
  const toggle = await openSettings(second.page);
  await expect(toggle).toBeChecked();
  await expect(second.page.getByText("You have Thoth 0.1.3.")).toBeVisible();
  await second.page.getByRole("button", { name: "Check now" }).click();
  await expect(popup(second.page)).toBeVisible();
  await expect(second.page.getByTestId("update-check-status")).toHaveText("Thoth 9.9.9 is out.");
  expect(asked).toHaveLength(3);
  await popup(second.page).getByRole("button", { name: "Later" }).click();

  // Settings → General, light and dark.
  await second.page.emulateMedia({ reducedMotion: "reduce" });
  const general = second.page.getByRole("region", { name: "General" });
  await expectAccessible(second.page, "section.update-settings");
  for (const dark of [false, true]) {
    await theme(second.page, dark);
    await general.screenshot({ path: join(SHOTS, `settings-general-${dark ? "dark" : "light"}.png`) });
  }
  await second.close();
});

test("turned off in Settings: no request at all, not even Check now", async ({ browser }) => {
  const app = await launch(browser, T0);
  const toggle = await openSettings(app.page);
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(app.page.getByRole("button", { name: "Check now" })).toBeDisabled();
  expect(JSON.parse(await readFile(join(scratch, "data", "update.json"), "utf8"))).toMatchObject({ notify: false });
  // Well past the first check's 2 seconds.
  await app.page.waitForTimeout(5_000);
  await expect(popup(app.page)).toBeHidden();
  expect(asked).toEqual([]);

  // It stays off after a restart.
  const port = Number(new URL(bridge!.url).port);
  await app.close();
  await bridge!.close();
  const again = await launch(browser, T0 + 25 * 3600, port);
  await again.page.waitForTimeout(5_000);
  await expect(popup(again.page)).toBeHidden();
  expect(asked).toEqual([]);
  await expect(await openSettings(again.page)).not.toBeChecked();
  await again.close();
});
