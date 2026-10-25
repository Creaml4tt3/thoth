/**
 * Notifications in the real desktop UI (ADR-0018; Chromium, the real Rust host through the dev bridge, the FAKE Claude
 * Code CLI). A run ends in review while the window is not focused: the system notification is shown (the notification
 * plugin is stood in for by a spy through `window.__THOTH_NOTIFICATION_PLUGIN__`, the same functions the app calls on
 * Tauri's plugin), the bell shows 1 unread, and its entry opens the review. axe checks the bell's list and Settings →
 * Notifications.
 *
 * It also saves pictures of the bell, its list, the mascot's message and the settings section, light and dark, under
 * tests/.tmp/notifications/ (git-ignored).
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_CLAUDE_DIR } from "../helpers/agent.ts";
import { REPO } from "../ports/harness.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { buildAll } from "./setup.ts";
import { axe, bubble, mascot, openBubble, pickOnly, writeAndStart } from "./assistant.ts";

const SHOTS = join(REPO, "tests", ".tmp", "notifications");
const PLAN = "# Plan\n\nWe have a cat.\n";
let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let data: string;
let bridge: Bridge;

/** Stands in for `@tauri-apps/plugin-notification`, recording each call; the permission is asked for once. */
const PLUGIN_SPY = `
  window.__notifyCalls = [];
  let granted = false;
  window.__THOTH_NOTIFICATION_PLUGIN__ = {
    isPermissionGranted: async () => { window.__notifyCalls.push(["isPermissionGranted"]); return granted; },
    requestPermission: async () => { window.__notifyCalls.push(["requestPermission"]); granted = true; return "granted"; },
    sendNotification: (options) => { window.__notifyCalls.push(["sendNotification", options]); },
  };
`;

type Call = [string, unknown?];
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __notifyCalls: Call[] }).__notifyCalls);

test.use({ viewport: { width: 1200, height: 800 } });

test.beforeAll(async () => {
  built = await buildAll();
  await mkdir(SHOTS, { recursive: true });
});

async function launch(page: Page, context: BrowserContext) {
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await page.addInitScript(PLUGIN_SPY);
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  await expect(page.getByRole("tree", { name: "Pages in this Private Space" })).toBeVisible();
  await expect(mascot(page)).toBeVisible();
}

test.beforeEach(async ({ page, context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-notify-")));
  vault = join(scratch, "Vault");
  data = join(scratch, "data");
  await mkdir(join(vault, "Notes"), { recursive: true });
  await writeFile(join(vault, "Notes/Plan.md"), PLAN);
  await writeFile(join(vault, "Diary.md"), "# Diary\n\nA quiet Sunday.\n");
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, dataDir: data, agentSearchDirs: [FAKE_CLAUDE_DIR] } });
  await launch(page, context);
});

test.afterEach(async ({ context }) => {
  for (const open of context.pages()) await open.close().catch(() => undefined);
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

const bell = (page: Page) => page.getByRole("button", { name: /^Notifications/ });
const list = (page: Page) => page.getByRole("dialog", { name: "Notifications" });
const theme = (page: Page, dark: boolean) => page.evaluate((night) => document.documentElement.setAttribute("data-theme", night ? "night" : "light"), dark);

test("a run ends in review while the window is in the background: a system notification, 1 unread, and the entry opens the review", async ({ page }) => {
  // Nothing is asked of the system at start.
  expect(await calls(page)).toEqual([]);

  await openBubble(page);
  await pickOnly(page, ["Plan"]);
  await writeAndStart(page, "SECRET-TASK make it a dog\n@sleep 600\n@say SECRET-OUTPUT\n@replace Notes/Plan.md :: cat => dog\n");
  await expect(bubble(page).getByRole("button", { name: "Cancel" })).toBeVisible({ timeout: 15_000 });
  await mascot(page).click();
  await expect(bubble(page)).toBeHidden();
  // The window goes to the background (another app in front).
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));

  await expect.poll(() => calls(page), { timeout: 15_000 }).toEqual([["isPermissionGranted"], ["requestPermission"], ["sendNotification", { title: "Changes ready for review", body: "Claude Code · Plan" }]]);
  expect(JSON.stringify(await calls(page))).not.toContain("SECRET");
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread");
  await expect(page.getByTestId("notification-badge")).toHaveText("1");
  await expect(mascot(page)).toHaveAccessibleName("Thoth assistant, changes ready for review");
  const message = page.getByTestId("mascot-message");
  await expect(message).toBeVisible();
  await expect(message).toHaveText("Changes ready for review");

  // Pictures: the bell with its badge and the mascot's message, light and dark (still, for stable pictures).
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await message.hover(); // held while the pointer is on it
  for (const dark of [false, true]) {
    await theme(page, dark);
    await page.screenshot({ path: join(SHOTS, `bell-${dark ? "dark" : "light"}.png`), clip: { x: 0, y: 560, width: 300, height: 240 } });
    await page.screenshot({ path: join(SHOTS, `mascot-message-${dark ? "dark" : "light"}.png`), clip: { x: 700, y: 480, width: 500, height: 320 } });
  }
  await page.mouse.move(0, 0);

  // The bell's list: keyboard reachable, Esc returns focus, then the entry opens the review.
  await bell(page).focus();
  await page.keyboard.press("Enter");
  await expect(list(page)).toBeVisible();
  const entry = list(page).getByRole("button", { name: /Changes ready for review/ });
  await expect(entry).toBeFocused();
  for (const dark of [false, true]) {
    await theme(page, dark);
    await page.screenshot({ path: join(SHOTS, `list-${dark ? "dark" : "light"}.png`), clip: { x: 0, y: 360, width: 560, height: 440 } });
  }
  await theme(page, false);
  await axe(page, ".notif-panel");
  await theme(page, true);
  await axe(page, ".notif-panel");
  await theme(page, false);
  await page.keyboard.press("Escape");
  await expect(list(page)).toBeHidden();
  await expect(bell(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await entry.click();
  const review = page.getByRole("region", { name: "Review the changes" });
  await expect(review).toBeVisible();
  await expect(bell(page)).toHaveAccessibleName("Notifications");
  // Nothing was applied: the notification only opened the review.
  expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe(PLAN);
});

test("Settings → Notifications: switches that are kept, and pass axe in light and dark", async ({ page }) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const section = page.getByTestId("notification-settings");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByRole("switch", { name: "System notifications" })).toBeChecked();
  await section.getByRole("checkbox", { name: "Save conflict" }).uncheck();
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const dark of [false, true]) {
    await theme(page, dark);
    await axe(page, "[data-testid=notification-settings]");
    await section.screenshot({ path: join(SHOTS, `settings-${dark ? "dark" : "light"}.png`) });
  }
  await page.reload();
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("notification-settings").getByRole("checkbox", { name: "Save conflict" })).not.toBeChecked();
  await expect(page.getByTestId("notification-settings").getByRole("checkbox", { name: "Changes ready for review" })).toBeChecked();
});
