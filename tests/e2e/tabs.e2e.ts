/**
 * Track 5 (ADR-0019) on the real desktop UI in Chromium against the real Rust host: tabs dragged with a real pointer
 * to a new place, kept after a restart, and a tab dragged out into a second window on the same Private Space.
 *
 * The second window: the desktop shell would make a Tauri window; the bridge opens a browser window on the same page
 * with the address the shell builds (`?window=…&root=…&tabs=…`), on the same host process. Both are driven here. What
 * this cannot cover: the native window itself (its position at the drop point, its title bar, the shell's
 * `window_open` and `window_close`, the close event after the red button), which the shell's Rust tests check as far
 * as they can without a display.
 *
 * Pictures of the drag (light and dark) go to tests/.tmp/tabs/; `TABS_CAPTURE=1` also records a short video there.
 */
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "../ports/harness.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { startDrag } from "./drag.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";

const SHOTS = join(REPO, "tests", ".tmp", "tabs");
let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge;

test.beforeAll(async () => {
  built = await buildAll();
  await mkdir(SHOTS, { recursive: true });
});

test.beforeEach(async ({ context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-tabs-")));
  vault = join(scratch, "Vault");
  await mkdir(vault);
  for (const name of ["Alpha", "Beta", "Gamma"]) await writeFile(join(vault, `${name}.md`), `# ${name}\n\nThe ${name.toLowerCase()} page.\n`);
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, pickSource: join(scratch, "source"), dataDir: join(scratch, "data") } });
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  // On the context, so a second window gets the bridge too.
  await context.addInitScript(bridge.initScript);
});

test.afterEach(async ({ context }) => {
  for (const p of context.pages()) await p.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

const tabNames = (page: Page) => page.getByRole("tab").allTextContents();
const current = (page: Page) => page.getByRole("tab", { selected: true });
const tabBox = (page: Page, name: string): Locator => page.getByRole("tab", { name, exact: true }).locator("xpath=..");
const row = (page: Page, name: string) => page.getByRole("tree", { name: "Pages in this Private Space" }).getByRole("treeitem", { name, exact: true });
const editorOf = (page: Page) => page.getByRole("textbox", { name: /page content/i });
const theme = (page: Page, dark: boolean) => page.evaluate((night) => document.documentElement.setAttribute("data-theme", night ? "night" : "light"), dark);

async function open(page: Page) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  // A Private Space opens on Home (ADR-0029); these tests start on Alpha.
  await expect(current(page)).toHaveText("Home");
  await row(page, "Alpha").click();
  await expect(current(page)).toHaveText("Alpha");
}

/** Alpha, Beta and Gamma in three tabs, Gamma current. */
async function threeTabs(page: Page) {
  await open(page);
  for (const name of ["Beta", "Gamma"]) await row(page, name).click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => tabNames(page)).toEqual(["Alpha", "Beta", "Gamma"]);
  await settled(page);
}

/** The middle of a tab, `fraction` along it. */
async function at(tab: Locator, fraction = 0.5): Promise<{ x: number; y: number }> {
  const box = (await tab.boundingBox())!;
  return { x: box.x + box.width * fraction, y: box.y + box.height / 2 };
}

/** Where each tab is shown now (its box includes the drag's transform), left edge rounded, by name. */
const places = (page: Page) =>
  page.locator(".tablist > .tab").evaluateAll((els) => Object.fromEntries(els.map((el) => [el.querySelector(".tab-text")?.textContent ?? "", Math.round(el.getBoundingClientRect().left)])));
/** Within 2px, each: the tabs slide there over a short transition. */
async function expectPlaces(page: Page, expected: Record<string, number>) {
  await expect
    .poll(async () => {
      const now = await places(page);
      return Object.keys(expected).every((name) => Math.abs((now[name] ?? Number.NaN) - expected[name]!) <= 2) ? expected : now;
    })
    .toEqual(expected);
}

test("tabs are dragged to a new place with a real pointer, and come back in that order after a restart", async ({ page }) => {
  await threeTabs(page);
  const start0 = await places(page);

  // Alpha past Gamma: Alpha lifts and follows the pointer, Beta and Gamma slide back to open the gap at the end.
  let drag = await startDrag(page, tabBox(page, "Alpha"));
  const end = await at(tabBox(page, "Gamma"), 0.9);
  await drag.moveTo(end.x, end.y);
  await expect(tabBox(page, "Alpha")).toHaveAttribute("data-dragging", "");
  await expectPlaces(page, { Beta: start0["Alpha"]!, Gamma: start0["Beta"]! });
  expect((await places(page))["Alpha"]).toBeGreaterThan(start0["Beta"]!); // under the pointer, over where Gamma was
  await expect(page.locator(".tab[data-drop]")).toHaveCount(0); // no line: the gap is the preview
  await expect(page.locator(".tab-drag-image")).toHaveCount(0);
  for (const dark of [false, true]) {
    await theme(page, dark);
    await settled(page); // the colours change with a short transition
    await page.screenshot({ path: join(SHOTS, `reorder-drag-${dark ? "dark" : "light"}.png`), clip: { x: 260, y: 0, width: 940, height: 120 } });
  }
  await theme(page, false);
  await drag.drop();
  await expect.poll(() => tabNames(page)).toEqual(["Beta", "Gamma", "Alpha"]);
  await expect(current(page)).toHaveText("Gamma"); // the same tab stays current
  // It lands in the gap it was shown: where Gamma was, and the others stay where they had slid to.
  await expectPlaces(page, { Beta: start0["Alpha"]!, Gamma: start0["Beta"]!, Alpha: start0["Gamma"]! });
  await settled(page);
  expect(await tabBox(page, "Beta").evaluate((el) => getComputedStyle(el).transform)).toBe("none");

  // Gamma to the start; Escape on a second drag puts everything back.
  drag = await startDrag(page, tabBox(page, "Gamma"));
  const begin = await at(tabBox(page, "Beta"), 0.1);
  await drag.moveTo(begin.x, begin.y);
  await expectPlaces(page, { Beta: start0["Beta"]! });
  await drag.drop();
  await expect.poll(() => tabNames(page)).toEqual(["Gamma", "Beta", "Alpha"]);
  await settled(page);
  drag = await startDrag(page, tabBox(page, "Beta"));
  const far = await at(tabBox(page, "Alpha"), 0.9);
  await drag.moveTo(far.x, far.y);
  await expectPlaces(page, { Gamma: start0["Alpha"]!, Alpha: start0["Beta"]! });
  await drag.cancel();
  await expect.poll(() => tabNames(page)).toEqual(["Gamma", "Beta", "Alpha"]);
  await expectPlaces(page, { Gamma: start0["Alpha"]!, Beta: start0["Beta"]!, Alpha: start0["Gamma"]! });

  // The keyboard way: Option/Alt+Shift+Right on the focused tab.
  await page.getByRole("tab", { name: "Gamma" }).focus();
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expect.poll(() => tabNames(page)).toEqual(["Beta", "Gamma", "Alpha"]);
  await expect(page.getByRole("tab", { name: "Gamma" })).toBeFocused();

  // Restart: the order comes back, and the same tab is current.
  await page.reload();
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  await expect.poll(() => tabNames(page)).toEqual(["Beta", "Gamma", "Alpha"]);
  await expect(current(page)).toHaveText("Gamma");
});

test("a tab dragged out opens in a second window on the same Private Space; edits show in both; both come back", async ({ page, context, browser }) => {
  await threeTabs(page);

  // Along the bar first: the gap opens. Out of the bar, well below it, every tab goes back to its place and the label
  // says what letting go will do; back in the bar the gap comes back.
  const home = await places(page);
  const drag = await startDrag(page, tabBox(page, "Beta"));
  const gamma = await at(tabBox(page, "Gamma"), 0.9);
  await drag.moveTo(gamma.x, gamma.y);
  await expectPlaces(page, { Alpha: home["Alpha"]!, Gamma: home["Beta"]! });
  await drag.moveTo(500, 420);
  await expect(page.getByText("Release to open in a new window")).toBeVisible();
  await expectPlaces(page, home);
  await expect(tabBox(page, "Beta")).toHaveAttribute("data-detach", "");
  await drag.moveTo(gamma.x, gamma.y);
  await expectPlaces(page, { Gamma: home["Beta"]! });
  await expect(page.getByText("Release to open in a new window")).toHaveCount(0);
  await drag.moveTo(500, 420);
  await expect(page.getByText("Release to open in a new window")).toBeVisible();
  for (const dark of [false, true]) {
    await theme(page, dark);
    await settled(page); // the colours change with a short transition
    await page.screenshot({ path: join(SHOTS, `detach-drag-${dark ? "dark" : "light"}.png`), clip: { x: 260, y: 0, width: 940, height: 520 } });
  }
  await theme(page, false);
  const opened = context.waitForEvent("page");
  await drag.drop();
  const second = await opened;
  await second.setViewportSize({ width: 1200, height: 800 });

  // The first window lost the tab; the second has it, with the whole shell, on the same folder (no start screen).
  await expect.poll(() => tabNames(page)).toEqual(["Alpha", "Gamma"]);
  await expect(current(second)).toHaveText("Beta");
  expect(await tabNames(second)).toEqual(["Beta"]);
  await expect(row(second, "Gamma")).toBeVisible();
  await expect(second.getByRole("button", { name: /choose or create a private space/i })).toHaveCount(0);
  const url = new URL(second.url());
  expect(url.searchParams.get("window")).toMatch(/^space-[a-z0-9]{16}$/);
  expect(url.searchParams.get("root")).toBe(vault);

  // An edit in the second window shows in the first (its watcher reconciles; the page reloads from disk).
  await row(page, "Beta").click();
  await expect(editorOf(page)).toContainText("The beta page.");
  const box = editorOf(second);
  await box.click();
  await second.keyboard.press("ControlOrMeta+End");
  await second.keyboard.type(" Written in the second window.");
  await second.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(join(vault, "Beta.md"), "utf8")).toContain("Written in the second window.");
  await expect(editorOf(page)).toContainText("Written in the second window.", { timeout: 10_000 });

  // Quit and start again: the same browser storage and data folder, a new host process, and no window "closed" on the
  // way (quitting forgets nothing). Opening the Private Space in the main window brings the second window back.
  const state = await context.storageState();
  const port = Number(new URL(bridge.url).port);
  await bridge.close();
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, port, host: { binary: built.binary, pickVault: vault, pickSource: join(scratch, "source"), dataDir: join(scratch, "data") } });
  const again = await browser.newContext({ storageState: state, viewport: { width: 1200, height: 800 } });
  try {
    await again.route((u) => !u.href.startsWith(bridge.url), (route) => route.abort());
    await again.addInitScript(bridge.initScript);
    const main = await again.newPage();
    await main.goto(bridge.url);
    const reopened = again.waitForEvent("page");
    await main.getByRole("button", { name: /choose or create a private space/i }).click();
    await expect.poll(() => tabNames(main)).toEqual(["Alpha", "Beta"]);
    const back = await reopened;
    await expect.poll(() => tabNames(back)).toEqual(["Beta"]);
    await expect(editorOf(back)).toContainText("Written in the second window.");
    expect(new URL(back.url()).searchParams.get("window")).toBe(url.searchParams.get("window"));
  } finally {
    await again.close();
  }
});

test("the tab's menu moves a tab to a new window from the keyboard, and focus stays in the tab bar", async ({ page, context }) => {
  await threeTabs(page);
  await page.getByRole("tab", { name: "Alpha" }).focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Tab: Alpha" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^Move tab left/ })).toBeDisabled();
  const opened = context.waitForEvent("page");
  await menu.getByRole("menuitem", { name: "Move tab to new window" }).click();
  const second = await opened;
  await expect(current(second)).toHaveText("Alpha");
  await expect.poll(() => tabNames(page)).toEqual(["Beta", "Gamma"]);
  await expect(page.getByRole("tab", { name: "Gamma" })).toBeFocused();
});

test("records the drag", async ({ browser }) => {
  test.skip(process.env["TABS_CAPTURE"] !== "1", "set TABS_CAPTURE=1 to record a video of the drag");
  const videos = join(scratch, "video");
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1200, height: 800 }, recordVideo: { dir: videos, size: { width: 1200, height: 800 } } });
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await context.addInitScript(bridge.initScript);
  const page = await context.newPage();
  await threeTabs(page);
  await page.waitForTimeout(600);
  const from = await at(tabBox(page, "Alpha"));
  const to = await at(tabBox(page, "Gamma"), 0.9);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 40 });
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(700);
  const back = await at(tabBox(page, "Beta"), 0.1);
  const gamma = await at(tabBox(page, "Gamma"));
  await page.mouse.move(gamma.x, gamma.y);
  await page.mouse.down();
  await page.mouse.move(back.x, back.y, { steps: 30 });
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.waitForTimeout(700);
  const video = page.video();
  await context.close();
  if (video) await copyFile(await video.path(), join(SHOTS, "reorder.webm"));
});
