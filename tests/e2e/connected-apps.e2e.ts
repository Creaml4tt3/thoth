/**
 * Connected apps in the real desktop UI (ADR-0021; Chromium, the real Rust host through the dev bridge, and the real
 * `thoth-mcp` started as a child process, as an MCP client starts it). The user switches Connected apps on and shares
 * the Private Space; an app connects and Thoth asks Allow or Deny in the window; once allowed, the app searches (Thai
 * included) and reads a page, and Settings shows the app and its requests. Switched off, the app is told to switch it
 * on again. axe checks the section and the question.
 *
 * It saves pictures of the Settings section and the question, light and dark, under tests/.tmp/mcp/ (git-ignored).
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, buildMcpServer } from "../ports/harness.ts";
import { McpClient } from "../helpers/mcp-client.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { buildAll } from "./setup.ts";

const SHOTS = join(REPO, "tests", ".tmp", "mcp");
const PLAN = "---\nthoth_id: 0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b\n---\n# Plan for 2027\n\nแผนงานปีหน้า: a garden, and a quieter inbox.\n\nSecret line that stays out of the log.\n";

let built: { dist: string; bridgeDir: string; binary: string };
let mcp: string;
let scratch: string;
let vault: string;
let data: string;
let bridge: Bridge;

test.use({ viewport: { width: 1200, height: 900 } });

test.beforeAll(async () => {
  built = await buildAll();
  mcp = await buildMcpServer();
  await mkdir(SHOTS, { recursive: true });
});

test.beforeEach(async ({ page, context }) => {
  // Under /tmp: a Unix socket's path must stay short (104 bytes on macOS).
  scratch = await realpath(await mkdtemp("/tmp/thoth-e2e-mcp-"));
  vault = join(scratch, "Notes");
  data = join(scratch, "data");
  await mkdir(vault);
  await writeFile(join(vault, "Plan.md"), PLAN);
  await writeFile(join(vault, "Inbox.md"), "# Inbox\n\nSee [[Plan]] for next year.\n");
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, dataDir: data } });
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  await expect(page.getByRole("tree", { name: "Pages in this Private Space" })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await page.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

const theme = (page: Page, dark: boolean) => page.evaluate((night) => document.documentElement.setAttribute("data-theme", night ? "night" : "light"), dark);

async function expectAccessible(page: Page, selector: string) {
  const results = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function shoot(page: Page, target: Locator, name: string) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Tall enough that the whole of `target` shows below the tab bar (which stays on top as the page scrolls).
  const before = page.viewportSize()!;
  await page.setViewportSize({ width: before.width, height: 1600 });
  await target.evaluate((el) => el.scrollIntoView({ block: "end" }));
  for (const dark of [false, true]) {
    await theme(page, dark);
    const box = (await target.boundingBox())!;
    await page.screenshot({ path: join(SHOTS, `${name}-${dark ? "dark" : "light"}.png`), clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 } });
  }
  await theme(page, false);
  await page.setViewportSize(before);
}

type ToolResult = { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const result = (message: Record<string, unknown>) => message.result as ToolResult;

test("switch on, allow an app, and it searches and reads through thoth-mcp; the log shows it without page text", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).first().click();
  const section = page.getByTestId("connected-apps-settings");
  await expect(section.getByRole("heading", { name: "Connected apps" })).toBeVisible();
  const toggle = section.getByRole("switch", { name: "Let other apps read my notes" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  const space = section.getByRole("checkbox", { name: /^Notes/ });
  await space.click();
  await expect(space).toBeChecked();
  // The host listens on an owner-only socket in the app data folder.
  const socket = join(data, "mcp", "thoth.sock");
  await expect.poll(async () => (await readdir(join(data, "mcp"))).includes("thoth.sock")).toBe(true);
  await expect(section.getByTestId("mcp-setup")).toContainText(socket);

  const client = new McpClient(mcp, socket);
  try {
    const init = await client.initialize("Claude Desktop");
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe("thoth");
    const searching = client.request(1, "tools/call", { name: "search", arguments: { query: "แผน" } });

    // Thoth asks in its window.
    const dialog = page.getByRole("dialog", { name: "Let “Claude Desktop” read your notes?" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText("Notes");
    await expect(dialog).toContainText("Apps name themselves");
    await expect(dialog.getByRole("button", { name: "Deny" })).toBeFocused();
    await expectAccessible(page, '[role="dialog"]');
    await shoot(page, page.locator(".modal"), "prompt");
    await dialog.getByRole("button", { name: "Allow" }).click();
    await expect(dialog).toBeHidden();

    const search = result(await searching);
    expect(search.isError).toBeFalsy();
    expect(search.structuredContent).toEqual({ results: [expect.objectContaining({ space: "Notes", path: "Plan.md", title: "Plan", id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" })] });

    const read = result(await client.request(2, "tools/call", { name: "read_page", arguments: { path: "Plan.md" } }));
    expect(read.content[0]!.text).toBe(PLAN);
    const back = result(await client.request(3, "tools/call", { name: "backlinks", arguments: { id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" } }));
    expect((back.structuredContent as { backlinks: { path: string }[] }).backlinks.map((b) => b.path)).toEqual(["Inbox.md"]);
    const outside = result(await client.request(4, "tools/call", { name: "read_page", arguments: { path: ".thoth/config.json" } }));
    expect(outside.isError).toBe(true);

    // Settings: the app, allowed, and its requests.
    await expect(section.getByRole("listitem", { name: "Claude Desktop" })).toContainText("Allowed");
    await section.getByRole("button", { name: "Show requests" }).click();
    const log = section.getByRole("table", { name: "Requests from connected apps" });
    await expect(log.getByRole("row")).toHaveCount(5);
    await expect(log.getByRole("row").nth(1)).toContainText("Not found");
    await expect(log.getByRole("row").nth(3)).toContainText("Plan.md");
    await expectAccessible(page, '[data-testid="connected-apps-settings"]');
    await section.scrollIntoViewIfNeeded();
    await shoot(page, section, "settings");
    const logged = (await Promise.all((await readdir(join(data, "mcp", "log"))).map((f) => readFile(join(data, "mcp", "log", f), "utf8")))).join("");
    expect(logged).toContain('"app":"Claude Desktop"');
    expect(logged).not.toContain("Secret line");
    expect(logged).not.toContain("แผน");

    // Switched off: the app is told what to do.
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    const off = result(await client.request(5, "tools/call", { name: "search", arguments: { query: "garden" } }));
    expect(off.isError).toBe(true);
    expect(off.content[0]!.text).toContain("Open Thoth and switch on Connected apps");
  } finally {
    await client.close();
  }
  // The vault holds only what it held: nothing of Connected apps is written there.
  expect((await readdir(vault)).sort()).toEqual([".thoth", "Inbox.md", "Plan.md"]);
});

test("after the identifier change, someone with apps set up is told once to copy the setup again (ADR-0031)", async ({ page, context }) => {
  // The settings a 0.2.0 install left in its data folder, moved over at start: an app was allowed before.
  await bridge.close();
  await mkdir(join(data, "mcp"), { recursive: true, mode: 0o700 });
  await writeFile(join(data, "mcp", "settings.json"), JSON.stringify({ version: 1, enabled: true, spaces: [], apps: [{ name: "Claude Desktop", allowed: true, decidedAt: "2026-10-25T08:00:00Z" }] }));
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, dataDir: data } });
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  await expect(page.getByRole("tree", { name: "Pages in this Private Space" })).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).first().click();
  const section = page.getByTestId("connected-apps-settings");
  const notice = section.getByRole("note", { name: "Copy the setup again" });
  await expect(notice).toContainText("stop connecting");
  await expect(section.getByRole("listitem", { name: "Claude Desktop" })).toContainText("Allowed");
  await expectAccessible(page, '[data-testid="connected-apps-settings"]');
  await shoot(page, notice, "setup-moved");
  // Keyboard: the dismiss button is reachable and works with Enter.
  await notice.getByRole("button", { name: "Got it" }).focus();
  await page.keyboard.press("Enter");
  await expect(notice).toBeHidden();
  // Not again after a reload (the page may come back on the Private Space, or ask for it).
  await page.reload();
  const choose = page.getByRole("button", { name: /choose or create a private space/i });
  const tree = page.getByRole("tree", { name: "Pages in this Private Space" });
  await expect(choose.or(tree)).toBeVisible();
  if (await choose.isVisible()) await choose.click();
  await expect(tree).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).first().click();
  await expect(section.getByRole("listitem", { name: "Claude Desktop" })).toBeVisible();
  await expect(section.getByRole("note")).toHaveCount(0);
});
