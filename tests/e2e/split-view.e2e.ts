/**
 * Split view (ADR-0030) on the real desktop UI in Chromium against the real Rust host: a tab dragged to the right part of
 * the page area and split from its menu, one page open in both panes and typed in (shown in both, saved once, no
 * conflict), the separator moved from the keyboard, the same layout after a restart, a tab of the right pane moved to a
 * new window, and axe in light and dark.
 *
 * Pictures (light and dark) go to `.tmp/split-shots/` in the main checkout (THOTH_SPLIT_SHOTS overrides it).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { axe } from "./assistant.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";

const SHOTS = process.env["THOTH_SPLIT_SHOTS"] ?? "/Users/user/Desktop/Creaml4tt3/thoth/.tmp/split-shots";
let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge;

test.beforeAll(async () => {
  built = await buildAll();
  await mkdir(SHOTS, { recursive: true });
});

test.beforeEach(async ({ context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-split-")));
  vault = join(scratch, "Vault");
  await mkdir(vault);
  for (const name of ["Alpha", "Beta", "Gamma"]) await writeFile(join(vault, `${name}.md`), `# ${name}\n\nThe ${name.toLowerCase()} page.\n`);
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, pickSource: join(scratch, "source"), dataDir: join(scratch, "data") } });
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await context.addInitScript(bridge.initScript);
});

test.afterEach(async ({ context }) => {
  for (const p of context.pages()) await p.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

const list = (page: Page, name: string) => page.getByRole("tablist", { name, exact: true });
const names = (page: Page, name: string) => list(page, name).getByRole("tab").allTextContents();
const row = (page: Page, name: string) => page.getByRole("tree", { name: "Pages in this Private Space" }).getByRole("treeitem", { name, exact: true });
const editors = (page: Page) => page.getByRole("textbox", { name: /page content/i });
const theme = (page: Page, dark: boolean) => page.evaluate((night) => document.documentElement.setAttribute("data-theme", night ? "night" : "light"), dark);
const tabIn = (page: Page, bar: string, name: string): Locator => list(page, bar).getByRole("tab", { name, exact: true });

async function shots(page: Page, name: string) {
  for (const dark of [false, true]) {
    await theme(page, dark);
    await settled(page);
    await page.screenshot({ path: join(SHOTS, `${name}-${dark ? "dark" : "light"}.png`) });
  }
  await theme(page, false);
}

/** Alpha and Beta open, Beta current. */
async function open(page: Page) {
  await page.setViewportSize({ width: 1400, height: 820 });
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  await expect(page.getByRole("tab", { selected: true })).toHaveText("Alpha"); // nothing was open: the first page
  await row(page, "Alpha").click();
  await row(page, "Beta").click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => names(page, "Open pages")).toEqual(["Alpha", "Beta"]);
  await settled(page);
}

test("a tab dragged to the right edge splits; one page in both panes is typed in, shown in both and saved once", async ({ page }) => {
  await open(page);

  // Drag Beta over the right part of the page area: the zone appears, then says what letting go does.
  const tab = (await tabIn(page, "Open pages", "Beta").boundingBox())!;
  const panel = (await page.locator(".tab-panel").first().boundingBox())!;
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
  await page.mouse.down();
  await page.mouse.move(tab.x + tab.width / 2 + 12, tab.y + tab.height / 2 + 4, { steps: 3 });
  await expect(page.locator(".pane-drop-split")).toBeVisible();
  await page.mouse.move(panel.x + panel.width * 0.85, panel.y + panel.height * 0.5, { steps: 16 });
  await expect(page.locator(".pane-drop-split[data-over]")).toBeVisible();
  await expect(page.locator(".tab-drag-hint")).toHaveText("Release to split right");
  await shots(page, "drag-to-split");
  await page.mouse.up();
  await expect.poll(() => names(page, "Open pages, right")).toEqual(["Beta"]);
  expect(await names(page, "Open pages, left")).toEqual(["Alpha"]);

  // Beta in the left pane too: two editors on one page.
  await tabIn(page, "Open pages, left", "Alpha").click();
  await row(page, "Beta").click();
  await expect.poll(() => names(page, "Open pages, left")).toEqual(["Beta"]);
  await expect(editors(page)).toHaveCount(2);
  const [one, two] = [editors(page).nth(0), editors(page).nth(1)];
  await one.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Typed on the left.");
  await expect(two).toContainText("The beta page. Typed on the left.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(join(vault, "Beta.md"), "utf8")).toContain("Typed on the left.");
  // Then on the right, after the left's save: no conflict.
  await two.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" And on the right.");
  await expect(one).toContainText("Typed on the left. And on the right.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(join(vault, "Beta.md"), "utf8")).toContain("Typed on the left. And on the right.");
  await page.waitForTimeout(600); // the watcher's reconcile comes back: still no conflict
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await readdir(vault)).filter((f) => f.includes("conflict"))).toEqual([]);
  expect(await readFile(join(vault, "Beta.md"), "utf8")).toBe("# Beta\n\nThe beta page. Typed on the left. And on the right.\n");
  await shots(page, "same-page-both-panes");
  // What the split view adds: both tab bars and the separator. (The page's own muted text, the save status and the
  // backlinks, is below 4.5:1 in one pane on main too: a separate finding.)
  const added = [".tabstrip", ".pane-resizer"];
  await axe(page, added);
  await theme(page, true);
  await axe(page, added);
  await theme(page, false);
});

test("split from the menu, resize from the keyboard, the same layout after a restart, and a right-pane tab to a new window", async ({ page, context, browser }) => {
  await open(page);
  await page.getByRole("tab", { name: "Beta" }).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menu", { name: "Tab: Beta" }).getByRole("menuitem", { name: "Split right" }).click();
  await expect.poll(() => names(page, "Open pages, right")).toEqual(["Beta"]);
  await expect(tabIn(page, "Open pages, right", "Beta")).toBeFocused();

  // F6 goes to the other pane.
  await page.keyboard.press("F6");
  await expect(tabIn(page, "Open pages, left", "Alpha")).toBeFocused();

  // The separator, from the keyboard: wider by 64px with Shift+Right, End and Home to the limits, Enter back to half.
  const sep = page.getByRole("separator", { name: "Resize panes" });
  await sep.focus();
  await expect(sep).toHaveAttribute("aria-valuenow", "50");
  const leftWidth = async () => (await page.locator('[data-pane="0"]').boundingBox())!.width;
  const before = await leftWidth();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(leftWidth).toBeGreaterThan(before + 50);
  await page.keyboard.press("End");
  const max = Number(await sep.getAttribute("aria-valuemax"));
  await expect(sep).toHaveAttribute("aria-valuenow", String(max));
  await expect.poll(async () => (await page.locator('[data-pane="1"]').boundingBox())!.width).toBeGreaterThanOrEqual(319);
  await page.keyboard.press("Enter");
  await expect(sep).toHaveAttribute("aria-valuenow", "50");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  const chosen = await sep.getAttribute("aria-valuenow");
  expect(Number(chosen)).toBeLessThan(50);
  await shots(page, "two-panes");

  // Restart: same storage, a new host process. The layout comes back with its ratio.
  const state = await context.storageState();
  const port = Number(new URL(bridge.url).port);
  await bridge.close();
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, port, host: { binary: built.binary, pickVault: vault, pickSource: join(scratch, "source"), dataDir: join(scratch, "data") } });
  const again = await browser.newContext({ storageState: state, viewport: { width: 1400, height: 820 } });
  try {
    await again.route((u) => !u.href.startsWith(bridge.url), (route) => route.abort());
    await again.addInitScript(bridge.initScript);
    const main = await again.newPage();
    await main.goto(bridge.url);
    await main.getByRole("button", { name: /choose or create a private space/i }).click();
    await expect.poll(() => names(main, "Open pages, right")).toEqual(["Beta"]);
    expect(await names(main, "Open pages, left")).toEqual(["Alpha"]);
    await expect(main.getByRole("separator", { name: "Resize panes" })).toHaveAttribute("aria-valuenow", chosen!);

    // A tab of the right pane to a new window: the pane closes, the window is one pane again.
    await main.getByRole("tab", { name: "Beta" }).focus();
    await main.keyboard.press("Shift+F10");
    const opened = again.waitForEvent("page");
    await main.getByRole("menu", { name: "Tab: Beta" }).getByRole("menuitem", { name: "Move tab to new window" }).click();
    const second = await opened;
    await expect(second.getByRole("tab", { selected: true })).toHaveText("Beta");
    await expect.poll(() => names(main, "Open pages")).toEqual(["Alpha"]);
    await expect(main.getByRole("separator", { name: "Resize panes" })).toHaveCount(0);
  } finally {
    await again.close();
  }
});
