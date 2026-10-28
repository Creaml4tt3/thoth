/**
 * In-app updates in the real desktop UI (ADR-0034; Chromium, the real Rust host through the dev bridge). The host runs
 * with a scripted updater (`--update-installer`) in place of the Tauri plugin, which the desktop shell has and the
 * harness does not: the popup's states, the host's progress events and the restart are real; the download is not.
 * `latest.json` comes from a local server, as in update-notice.e2e.ts; the page reaches nothing but the bridge.
 *
 * 1. Update → progress → "Restart now" or "Later"; Restart now writes the page's edits and asks the host to restart.
 * 2. A slow download: Cancel, then Try again.
 * 3. An update whose signature does not check out: said plainly, with the Download button.
 * 4. The switch in Settings → Updates: off, the popup keeps Download; a host that cannot update has no switch.
 *
 * Pictures of each state, light and dark, go under tests/.tmp/in-app-updates/ (git-ignored).
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { StdioTransportOptions } from "@thoth/platform/stdio";
import { REPO } from "../ports/harness.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { buildAll } from "./setup.ts";

const SHOTS = join(REPO, "tests", ".tmp", "in-app-updates");
const DOWNLOADS = "https://thothnotes.com/#download";
const LATEST = { version: "9.9.9", date: "2026-11-02", base: "https://download.thothnotes.com/v9.9.9/", files: [], notes: "https://thothnotes.com/changelog/#v9-9-9", platforms: {} };

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge | undefined;
let latest: Server;
let latestUrl: string;
let events: string[];
let opened: string[];

test.use({ viewport: { width: 1200, height: 800 } });

test.beforeAll(async () => {
  built = await buildAll();
  await mkdir(SHOTS, { recursive: true });
});

test.beforeEach(async () => {
  events = [];
  opened = [];
  latest = createServer((req, res) => {
    if (req.url === "/latest.json") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(LATEST));
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => latest.listen(0, "127.0.0.1", resolve));
  latestUrl = `http://127.0.0.1:${(latest.address() as AddressInfo).port}/latest.json`;
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-in-app-")));
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

async function launch(browser: Browser, installer: StdioTransportOptions["updateInstaller"]): Promise<Page> {
  bridge = await startBridge({
    dist: built.dist,
    bridgeDir: built.bridgeDir,
    host: {
      binary: built.binary,
      pickVault: vault,
      dataDir: join(scratch, "data"),
      linkPreviewLoopback: true,
      updateUrl: latestUrl,
      updateCurrent: "0.2.3",
      ...(installer ? { updateInstaller: installer } : {}),
      onHostEvent: (event, payload) => {
        if (event === "browser.open") opened.push((payload as { url: string }).url);
        else if (event === "update.restarted") events.push(event);
      },
    },
  });
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
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
  return page;
}

const popup = (page: Page, name: string | RegExp = "Thoth 9.9.9 is out") => page.getByRole("dialog", { name });
const theme = (page: Page, dark: boolean) => page.evaluate((night) => document.documentElement.setAttribute("data-theme", night ? "night" : "light"), dark);

async function expectAccessible(page: Page, selector: string) {
  // Off the buttons: a button just clicked may be replaced by another under the pointer, measured in its hover colour.
  await page.mouse.move(1, 790);
  const results = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function shoot(page: Page, name: string) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const dark of [false, true]) {
    await theme(page, dark);
    await page.getByTestId("update-notice").screenshot({ path: join(SHOTS, `${name}-${dark ? "dark" : "light"}.png`) });
  }
  await theme(page, false);
}

test("Update downloads with progress, then Restart now writes the edits and restarts; Later waits", async ({ browser }) => {
  const page = await launch(browser, "ok");
  const offer = popup(page);
  await expect(offer).toBeVisible({ timeout: 25_000 });
  await expect(offer.getByRole("button", { name: "Download" })).toHaveCount(0);
  await expectAccessible(page, "[data-testid=update-notice]");
  await shoot(page, "1-offer");

  // An edit not yet written when Restart now is clicked.
  await page.getByRole("treeitem", { name: "Notes" }).click();
  const box = page.getByRole("textbox", { name: /page content/i });
  await box.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Typed before the restart.");

  // Keyboard only: the popup takes no focus, so Tab to its Update button.
  await offer.getByRole("button", { name: "Update" }).focus();
  await page.keyboard.press("Enter");
  const updating = popup(page, "Updating to Thoth 9.9.9");
  await expect(updating.getByRole("progressbar", { name: "Download progress" })).toBeVisible();
  await expect(page.getByTestId("update-live")).toHaveText(/Downloading Thoth 9\.9\.9: \d+%/);
  const ready = popup(page, "Thoth 9.9.9 is ready");
  await expect(ready).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("update-live")).toHaveText("Thoth 9.9.9 is ready. Restart to use it.");
  await expectAccessible(page, "[data-testid=update-notice]");
  await shoot(page, "3-ready");

  // Later: nothing restarts; the list under the bell brings it back as it was.
  await ready.getByRole("button", { name: "Later" }).click();
  await expect(ready).toBeHidden();
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: /Thoth 9\.9\.9 is out/ }).click();
  await expect(ready).toBeVisible();
  expect(events).toEqual([]);

  await ready.getByRole("button", { name: "Restart now" }).click();
  await expect.poll(() => events).toEqual(["update.restarted"]);
  await expect(popup(page, "Thoth 9.9.9 is ready").getByText("Restarting…")).toBeVisible();
  // The edit was written before the host was asked.
  expect(await readFile(join(vault, "Notes.md"), "utf8")).toContain("Typed before the restart.");
});

test("a slow download can be cancelled, and tried again", async ({ browser }) => {
  const page = await launch(browser, "slow");
  await expect(popup(page)).toBeVisible({ timeout: 25_000 });
  await popup(page).getByRole("button", { name: "Update" }).click();
  const updating = popup(page, "Updating to Thoth 9.9.9");
  await expect(updating.getByText(/^\d+% \(\d+\.\d MB of 13\.4 MB\)$/)).toBeVisible();
  await expectAccessible(page, "[data-testid=update-notice]");
  await shoot(page, "2-downloading");
  await updating.getByRole("button", { name: "Cancel" }).click();
  const failed = popup(page, "Thoth 9.9.9 was not installed");
  await expect(failed.getByText("The update was cancelled. Nothing was installed.")).toBeVisible();
  await shoot(page, "4-cancelled");
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(updating.getByRole("progressbar", { name: "Download progress" })).toBeVisible();
  await updating.getByRole("button", { name: "Cancel" }).click();
  await expect(failed).toBeVisible();
});

test("an update that is not signed by Thoth is not installed, and Download is offered", async ({ browser }) => {
  const page = await launch(browser, "verify");
  await expect(popup(page)).toBeVisible({ timeout: 25_000 });
  await popup(page).getByRole("button", { name: "Update" }).click();
  const failed = popup(page, "Thoth 9.9.9 was not installed");
  await expect(failed.getByText(/could not be verified as signed by Thoth, so nothing was installed/)).toBeVisible();
  await expect(failed.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(page.getByTestId("update-live")).toHaveText(/Thoth 9\.9\.9 was not installed\./);
  await expectAccessible(page, "[data-testid=update-notice]");
  await shoot(page, "5-not-verified");
  await failed.getByRole("button", { name: "Download" }).click();
  await expect.poll(() => opened).toEqual([DOWNLOADS]);
  expect(events).toEqual([]);
});

test("the switch: off keeps Download; a host that cannot update has none", async ({ browser }) => {
  const page = await launch(browser, "ok");
  await expect(popup(page)).toBeVisible({ timeout: 25_000 });
  await popup(page).getByRole("button", { name: "Later" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  const section = page.getByRole("region", { name: "Updates" });
  const toggle = section.getByRole("switch", { name: "Download and install updates in the app" });
  await expect(toggle).toBeChecked();
  await expectAccessible(page, "section.update-settings");
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const dark of [false, true]) {
    await theme(page, dark);
    await section.screenshot({ path: join(SHOTS, `6-settings-${dark ? "dark" : "light"}.png`) });
  }
  await theme(page, false);
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(JSON.parse(await readFile(join(scratch, "data", "update.json"), "utf8"))).toMatchObject({ install: false });
  await section.getByRole("button", { name: "Check now" }).click();
  await expect(popup(page).getByRole("button", { name: "Download" })).toBeVisible();
  await expect(popup(page).getByRole("button", { name: "Update" })).toHaveCount(0);
  await bridge!.close();
  bridge = undefined;

  // No scripted updater: the host cannot update this copy (as a .deb install), so no switch and the old popup.
  const plain = await launch(browser, undefined);
  await expect(popup(plain).getByRole("button", { name: "Download" })).toBeVisible({ timeout: 25_000 });
  await plain.getByRole("button", { name: "Settings" }).click();
  await expect(plain.getByRole("switch", { name: "Tell me when a new version is out" })).toBeVisible();
  await expect(plain.getByRole("switch", { name: "Download and install updates in the app" })).toHaveCount(0);
});
