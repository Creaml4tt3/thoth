/**
 * The sidebar and the tab bar on the real desktop UI (Chromium, real Rust host, the e2e bridge): the drag handle on the
 * sidebar's edge, the tooltip for text that is cut off, icon buttons with names, tooltips and shortcuts, the tab width,
 * an accessibility check in both themes, and pictures of the sidebar and tab bar in light and dark.
 *
 * SHOTS=<dir> changes where the pictures go (default tests/.tmp/screens, which git ignores).
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO } from "../ports/harness.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge;
const SHOTS = process.env["SHOTS"] ?? join(REPO, "tests", ".tmp", "screens");
const LONG = "A very long page title that certainly will not fit in the sidebar or in a tab";

test.beforeAll(async () => {
  built = await buildAll();
});

const put = async (path: string, text = `# ${path}\n`) => {
  await mkdir(dirname(join(vault, path)), { recursive: true });
  await writeFile(join(vault, path), text);
};

test.beforeEach(async ({ page, context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-ui-")));
  vault = join(scratch, "Vault");
  await mkdir(vault);
  await put("Alpha.md");
  await put("Beta.md");
  await put("Gamma.md");
  await put(`${LONG}.md`, `# ${LONG}\n`);
  await put("Docs/One.md");
  await put("Docs/Two.md");
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, pickSource: join(scratch, "source"), dataDir: join(scratch, "data") } });
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await page.addInitScript(bridge.initScript);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  await expect(page.getByRole("tree", { name: "Pages in this Private Space" })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await page.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

const isMac = (page: Page) => page.evaluate(() => /Mac OS X|Macintosh/.test(navigator.userAgent));
const handle = (page: Page) => page.getByRole("separator", { name: "Resize sidebar" });
const sidebarWidth = (page: Page) => page.locator(".sidebar").evaluate((el) => Math.round(el.getBoundingClientRect().width));
const tip = (page: Page) => page.getByRole("tooltip");

test("the drag handle resizes the sidebar by pointer and keyboard, is remembered, and resets", async ({ page }) => {
  await expect(handle(page)).toHaveAttribute("aria-orientation", "vertical");
  await expect(handle(page)).toHaveAttribute("aria-valuemin", "200");
  await expect(handle(page)).toHaveAttribute("aria-valuemax", "480"); // 40% of 1200 is exactly 480
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "260");
  expect(await sidebarWidth(page)).toBe(260);

  // A real pointer drag: the width follows, the shell is marked while it runs, and the choice is kept at the end.
  const box = (await handle(page).boundingBox())!;
  const y = box.y + 300;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await expect(page.locator(".shell")).toHaveAttribute("data-resizing", "");
  await page.mouse.move(box.x + box.width / 2 + 50, y, { steps: 5 });
  await page.mouse.move(box.x + box.width / 2 + 100, y, { steps: 5 });
  await expect.poll(() => sidebarWidth(page)).toBe(360);
  await page.mouse.up();
  await expect(page.locator(".shell")).not.toHaveAttribute("data-resizing");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "360");

  // Too far either way stops at the limits.
  const at = (await handle(page).boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(1190, y, { steps: 8 });
  await page.mouse.up();
  expect(await sidebarWidth(page)).toBe(480);
  const wide = (await handle(page).boundingBox())!;
  await page.mouse.move(wide.x + wide.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(5, y, { steps: 8 });
  await page.mouse.up();
  expect(await sidebarWidth(page)).toBe(200);

  // The keyboard: arrows (Shift for more), Home, End.
  await handle(page).focus();
  await page.keyboard.press("ArrowRight");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "216");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "280");
  await page.keyboard.press("ArrowLeft");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "264");
  expect(await sidebarWidth(page)).toBe(264);
  await page.keyboard.press("End");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "480");
  await page.keyboard.press("Home");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "200");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight"); // 232

  // Remembered per Private Space: it is still there after a reload, and only the width is stored.
  await page.reload();
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "232");
  expect(await sidebarWidth(page)).toBe(232);
  const stored = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("thoth.desktop.sidebar.")));
  expect(stored).toHaveLength(1);
  expect(JSON.parse(stored[0]![1])).toEqual({ v: 2, width: 232 }); // the sidebar's layout (ADR-0019 amendment), versioned

  // A double-click brings the default back and forgets the choice.
  const now = (await handle(page).boundingBox())!;
  await page.mouse.dblclick(now.x + now.width / 2, now.y + 300);
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "260");
  expect(await sidebarWidth(page)).toBe(260);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("thoth.desktop.sidebar.")))).toEqual([]);
});

test("a window that gets smaller keeps the sidebar under 40% of it, and gives the width back when it grows", async ({ page }) => {
  await handle(page).focus();
  await page.keyboard.press("End");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "480");
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "320");
  expect(await sidebarWidth(page)).toBe(320);
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "480");
});

test("icon buttons are named, show their name and shortcut in a tooltip, and have a focus ring and a 28 to 32px target", async ({ page }) => {
  const mac = await isMac(page);
  const keys = (mac: boolean, symbol: string, text: string) => (mac ? symbol : text);
  const cases: { name: string; shortcut: string | null }[] = [
    { name: "New page", shortcut: keys(mac, "⌘N", "Ctrl+N") },
    { name: "New folder", shortcut: keys(mac, "⇧⌘N", "Ctrl+Shift+N") },
    { name: "Settings", shortcut: keys(mac, "⌘,", "Ctrl+,") },
    { name: "New tab", shortcut: keys(mac, "⌘T", "Ctrl+T") },
  ];
  for (const c of cases) {
    const button = page.getByRole("button", { name: c.name, exact: true });
    const box = (await button.boundingBox())!;
    expect(box.width, c.name).toBeGreaterThanOrEqual(28);
    expect(box.width, c.name).toBeLessThanOrEqual(32);
    expect(box.height, c.name).toBeGreaterThanOrEqual(28);
    expect(box.height, c.name).toBeLessThanOrEqual(32);
    await button.hover();
    await expect(tip(page)).toBeVisible(); // after the pause
    await expect(tip(page)).toContainText(c.name);
    if (c.shortcut) await expect(tip(page)).toContainText(c.shortcut);
    await page.mouse.move(600, 400);
    await expect(tip(page)).toBeHidden();
  }

  // Keyboard focus shows it at once, with a visible ring; Escape hides it and it stays hidden.
  await page.getByRole("button", { name: "New page", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const newPage = page.getByRole("button", { name: "New page", exact: true });
  await expect(newPage).toBeFocused();
  await expect(tip(page)).toBeVisible();
  await expect(tip(page)).toContainText("New page");
  expect(await newPage.evaluate((el) => `${getComputedStyle(el).outlineStyle} ${getComputedStyle(el).outlineWidth}`)).toBe("solid 2px");
  await expect(newPage).toHaveAttribute("aria-describedby", /.+/);
  await page.keyboard.press("Escape");
  await expect(tip(page)).toBeHidden();
  await expect(newPage).not.toHaveAttribute("aria-describedby");
});

test("text that is cut off shows in full in a tooltip, text that fits shows none", async ({ page }) => {
  const long = page.getByRole("treeitem", { name: LONG, exact: true });
  const short = page.getByRole("treeitem", { name: "Alpha", exact: true });
  await short.hover();
  await page.waitForTimeout(900);
  await expect(tip(page)).toHaveCount(0);
  await long.hover();
  await expect(tip(page)).toBeVisible();
  await expect(tip(page)).toHaveText(LONG);
  // On screen and inside the window.
  const t = (await tip(page).boundingBox())!;
  expect(t.x).toBeGreaterThanOrEqual(0);
  expect(t.x + t.width).toBeLessThanOrEqual(1200);
  await page.mouse.move(700, 500);
  await expect(tip(page)).toBeHidden();

  // The keyboard: focusing the row shows it, and so does the tab.
  await long.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(tip(page)).toHaveText(LONG);
  await page.keyboard.press("Escape");
  await expect(tip(page)).toBeHidden();

  await long.click();
  await expect(page.getByRole("tab", { name: LONG })).toBeVisible();
  await page.getByRole("tab", { name: LONG }).hover();
  await expect(tip(page)).toHaveText(LONG);
  await page.mouse.move(700, 500);
  await expect(tip(page)).toBeHidden();

  // The breadcrumb cuts a long part with an ellipsis and says so in the same way.
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(page.locator(".crumb-current .crumb-text")).toBeVisible();
  await page.locator(".crumb-current .crumb-text").hover();
  await expect(tip(page)).toContainText(LONG);
});

test("a tooltip never gets in the way of a drag", async ({ page }) => {
  const long = page.getByRole("treeitem", { name: LONG, exact: true });
  await long.hover();
  await expect(tip(page)).toBeVisible();
  const box = (await page.getByRole("treeitem", { name: "Gamma", exact: true }).boundingBox())!;
  const docs = (await page.getByRole("treeitem", { name: "Docs", exact: true }).boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 46, box.y + 8, { steps: 4 });
  await page.mouse.move(docs.x + 60, docs.y + docs.height / 2, { steps: 10 });
  await expect(tip(page)).toHaveCount(0);
  await expect(page.locator("[data-drop]")).toHaveCount(1);
  await page.mouse.up();
});

test("tabs open at 202px (three quarters of the old 270px), shrink when there are many, and still close", async ({ page }) => {
  await page.getByRole("treeitem", { name: "Alpha", exact: true }).click();
  const tab = page.getByRole("tab", { name: "Alpha" });
  await settled(page);
  const width = async (name: string | RegExp) => Math.round((await page.getByRole("tab", { name }).locator("xpath=..").boundingBox())!.width);
  expect(await width("Alpha")).toBe(202);
  expect(await tab.evaluate((el) => getComputedStyle(el.parentElement!).maxWidth)).toBe("248px");

  // Many tabs: they give way down to the minimum, then the strip scrolls.
  for (const name of ["Beta", "Gamma", LONG]) await page.getByRole("treeitem", { name, exact: true }).click({ modifiers: ["ControlOrMeta"] });
  await page.getByRole("treeitem", { name: "Docs", exact: true }).click();
  await page.getByRole("treeitem", { name: "One", exact: true }).click({ modifiers: ["ControlOrMeta"] });
  await page.getByRole("treeitem", { name: "Two", exact: true }).click({ modifiers: ["ControlOrMeta"] });
  await settled(page);
  const many = await width("Beta");
  expect(many).toBeLessThan(202);
  expect(many).toBeGreaterThanOrEqual(96);

  // The close button is there on hover and closes the tab.
  const beta = page.getByRole("tab", { name: "Beta" }).locator("xpath=..");
  await beta.hover();
  const close = beta.locator(".tab-close");
  const c = (await close.boundingBox())!;
  expect(c.width).toBeGreaterThanOrEqual(28);
  await close.hover();
  await expect(tip(page)).toContainText("Close tab");
  await close.click();
  await expect(page.getByRole("tab", { name: "Beta" })).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the sidebar and the tab bar pass the accessibility check and are shown in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.getByRole("treeitem", { name: "Alpha", exact: true }).click();
    await page.getByRole("treeitem", { name: "Beta", exact: true }).click({ modifiers: ["ControlOrMeta"] });
    await page.getByRole("treeitem", { name: LONG, exact: true }).click({ modifiers: ["ControlOrMeta"] });
    await page.getByRole("treeitem", { name: "Docs", exact: true }).click();
    await settled(page);
    const bad = (await new AxeBuilder({ page }).include(".sidebar").include(".tabstrip").include(".sidebar-resizer").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ") + " " + JSON.stringify(n.any.map((a) => a.data))).join(", ")}`)).toEqual([]);

    // Pictures for people: the sidebar, the tab bar, and a tooltip.
    await mkdir(SHOTS, { recursive: true });
    await page.mouse.move(700, 600);
    await page.screenshot({ path: join(SHOTS, `sidebar-${scheme}.png`), clip: { x: 0, y: 0, width: 420, height: 800 } });
    await page.screenshot({ path: join(SHOTS, `tabbar-${scheme}.png`), clip: { x: 260, y: 0, width: 940, height: 60 } });
    await page.getByRole("button", { name: "New page", exact: true }).hover();
    await expect(tip(page)).toBeVisible();
    await page.screenshot({ path: join(SHOTS, `tooltip-${scheme}.png`), clip: { x: 0, y: 640, width: 420, height: 160 } });
    await page.mouse.move(700, 600);
  });
}

test("the window never scrolls as a whole, even on the long Settings page: only the page area scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.getByRole("button", { name: "Settings" }).click();
  const scroller = page.locator(".page-scroll").first();
  await expect(scroller).toBeVisible();
  // The settings page is longer than the window, and its own area scrolls to its end.
  expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  // A wheel over the sidebar and a scroll asked of the document (what a focus or scrollIntoView does) move nothing.
  await page.mouse.move(100, 400);
  await page.mouse.wheel(0, 2000);
  await page.evaluate(() => {
    window.scrollTo(0, 10_000);
    document.scrollingElement?.scrollTo(0, 10_000);
    document.querySelector(".shell")?.scrollTo(0, 10_000);
  });
  await settled(page);
  const where = await page.evaluate(() => ({
    scrolled: window.scrollY,
    tall: (document.scrollingElement?.scrollHeight ?? 0) - window.innerHeight,
    shellTop: document.querySelector(".shell")!.getBoundingClientRect().top,
    shellScrolled: document.querySelector(".shell")!.scrollTop,
    mainScrolled: document.querySelector(".main")!.scrollTop,
    sidebarBottom: document.querySelector(".sidebar")!.getBoundingClientRect().bottom,
  }));
  expect(where).toEqual({ scrolled: 0, tall: 0, shellTop: 0, shellScrolled: 0, mainScrolled: 0, sidebarBottom: 600 });
  // The tab bar is still at the top.
  expect(await page.locator(".tabstrip").evaluate((el) => el.getBoundingClientRect().top)).toBe(0);
});

test("a section's drag grip is hidden and takes no room until the pointer is over its header; the name does not move", async ({ page }) => {
  const section = page.locator('.side-section[data-section="private"]');
  const header = section.locator(":scope > .sec");
  const grip = section.getByRole("button", { name: /^Section options: / });
  const name = section.locator(".sec-name");
  const width = () => grip.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  await page.mouse.move(700, 500);
  await settled(page);
  expect(await width()).toBe(0);
  const nameX = (await name.boundingBox())!.x;
  await header.hover();
  await expect.poll(width).toBe(24);
  await expect(grip).toHaveCSS("opacity", "1");
  expect((await name.boundingBox())!.x).toBe(nameX);
  // A mouse click on the name folds the section and leaves the grip hidden once the pointer leaves.
  await section.locator(".sec-toggle").click();
  await page.mouse.move(700, 500);
  await expect.poll(width).toBe(0);
  await section.locator(".sec-toggle").click();
  // The keyboard still reaches it: Tab from the name shows it, and its menu opens.
  await section.locator(".sec-toggle").focus();
  await page.keyboard.press("Tab");
  await expect(grip).toBeFocused();
  await expect.poll(width).toBe(24);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
});
