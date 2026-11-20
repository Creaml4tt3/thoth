/**
 * Moving through a long page with the keyboard, in Chromium on the real Rust host: the page follows the caret a line
 * at a time and never jumps (the owner's report of 2026-11-03, "it bounces up to the top of current scroll"). Without
 * caret-scroll.ts the browser reveals the caret centred, so the page jumps by half a screen each time the caret passes
 * the edge. Also runs in WebKit: `pnpm e2e editor-scroll --browser=webkit`.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, type Bridge } from "./bridge.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";
import { pickSpace } from "./pick-space.ts";

const line = (i: number) => `Line ${i} of a long page, with enough words to read like a sentence.`;
// A divider half way down: ArrowDown selects it as a block, the next one leaves it.
const PAGE = `# Long\n\n${Array.from({ length: 80 }, (_, i) => (i === 40 ? `---\n\n${line(i + 1)}` : line(i + 1))).join("\n\n")}\n`;

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let bridge: Bridge;

test.use({ viewport: { width: 1200, height: 700 } });

test.beforeAll(async () => {
  built = await buildAll();
});

test.beforeEach(async ({ page }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-scroll-")));
  const vault = join(scratch, "Vault");
  await mkdir(vault, { recursive: true });
  await writeFile(join(vault, "Long.md"), PAGE);
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, dataDir: join(scratch, "data") } });
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
  await pickSpace(page);
});

test.afterEach(async ({ page }) => {
  await page.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

async function openLong(page: Page) {
  const tree = page.getByRole("tree", { name: "Pages in this Private Space" });
  const start = page.getByRole("button", { name: /start writing/i });
  await expect(tree.or(start)).toBeVisible();
  if (await start.isVisible()) await start.click();
  await settled(page);
  await tree.getByRole("treeitem", { name: "Long", exact: true }).click();
  const box = page.getByRole("textbox", { name: /page content/i });
  await expect(box).toContainText("Line 80 of a long page");
  return box;
}

const area = (page: Page) => page.locator(".page-scroll");
const scrollTop = (page: Page) => area(page).evaluate((el) => el.scrollTop);
const frames = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** True when the caret (or the selected block) is fully inside the page area. */
const caretShown = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector(".page-scroll")!.getBoundingClientRect();
    const node = document.querySelector(".ProseMirror-selectednode");
    let r: DOMRect | undefined = node?.getBoundingClientRect();
    if (!r) {
      const sel = getSelection();
      if (!sel?.focusNode) return false;
      const range = document.createRange();
      range.setStart(sel.focusNode, sel.focusOffset);
      const rects = range.getClientRects();
      r = rects.length ? rects[rects.length - 1]! : (sel.focusNode instanceof Element ? sel.focusNode : sel.focusNode.parentElement!).getBoundingClientRect();
    }
    return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
  });

/** Presses `key` `times` times and records scrollTop after each press (two frames later, after any scroll the app makes). */
async function press(page: Page, key: string, times: number): Promise<{ tops: number[]; hidden: number }> {
  const tops: number[] = [];
  let hidden = 0;
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await frames(page);
    tops.push(await scrollTop(page));
    if (!(await caretShown(page))) hidden++;
  }
  return { tops, hidden };
}

const LINE = 60; // a paragraph plus its margin, generously

/** Each step goes the one way (`dir`), by at most two lines. */
function expectSteps(start: number, tops: number[], dir: 1 | -1): void {
  let last = start;
  for (const top of tops) {
    const moved = (top - last) * dir;
    expect(moved, `scrollTop went from ${last} to ${top}: ${start}, ${tops.join(", ")}`).toBeGreaterThanOrEqual(-1);
    expect(moved, `one press scrolled ${moved}px: ${start}, ${tops.join(", ")}`).toBeLessThanOrEqual(LINE * 2);
    last = top;
  }
}

test("ArrowDown from mid-page follows the caret a line at a time, through a selected divider", async ({ page }) => {
  const box = await openLong(page);
  await area(page).evaluate((el) => el.scrollBy(0, 500));
  await box.getByText("Line 24 of a long page").click();
  const start = await scrollTop(page);
  expect(start).toBeGreaterThan(200);
  const { tops, hidden } = await press(page, "ArrowDown", 40);
  expectSteps(start, tops, 1);
  expect(tops.at(-1)!).toBeGreaterThan(start + 400);
  expect(hidden).toBe(0);
  await expect(box).toBeFocused();
});

test("ArrowUp back up the page moves up in small steps and keeps the caret on screen", async ({ page }) => {
  const box = await openLong(page);
  await area(page).evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await box.getByText("Line 78 of a long page").click();
  const start = await scrollTop(page);
  const { tops, hidden } = await press(page, "ArrowUp", 40);
  expectSteps(start, tops, -1);
  expect(hidden).toBe(0);
});

test("a held ArrowDown (presses with no pause) ends with the caret on screen, never back near the top", async ({ page }) => {
  const box = await openLong(page);
  await area(page).evaluate((el) => el.scrollBy(0, 500));
  await box.getByText("Line 24 of a long page").click();
  const start = await scrollTop(page);
  await page.evaluate(() => {
    const w = window as unknown as { __tops: number[] };
    w.__tops = [];
    const el = document.querySelector(".page-scroll")!;
    el.addEventListener("scroll", () => w.__tops.push(el.scrollTop));
  });
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowDown", { delay: 0 });
  await frames(page);
  const tops = await page.evaluate(() => (window as unknown as { __tops: number[] }).__tops);
  expect(Math.min(...tops, start)).toBeGreaterThanOrEqual(start - 1);
  expect(await caretShown(page)).toBe(true);
});

test("Page Down moves the caret a screen down and keeps it on screen", async ({ page }) => {
  const box = await openLong(page);
  await box.getByText("Line 3 of a long page").click();
  const start = await scrollTop(page);
  const { tops, hidden } = await press(page, "PageDown", 3);
  const screen = await area(page).evaluate((el) => el.clientHeight);
  expect(tops[0]! - start).toBeGreaterThan(screen / 2);
  expect(tops[2]! - tops[1]!).toBeGreaterThan(screen / 2);
  expect(hidden).toBe(0);
  // The caret came along: the next arrow moves on from there instead of jumping back up to Line 3.
  const { tops: after, hidden: lost } = await press(page, "ArrowDown", 3);
  expectSteps(tops[2]!, after, 1);
  expect(lost).toBe(0);
  const back = await press(page, "PageUp", 1);
  expect(tops[2]! - back.tops[0]!).toBeGreaterThan(screen / 2);
  expect(back.hidden).toBe(0);
});

test("Plain mode moves a line at a time too", async ({ page }) => {
  await openLong(page);
  await page.getByRole("button", { name: "Plain", exact: true }).click();
  const plain = page.locator(".cm-content");
  await expect(plain).toBeFocused();
  await page.locator(".cm-line", { hasText: "Line 3 of a long page" }).click();
  const scrollerTop = () => page.locator(".page-scroll, .cm-scroller").evaluateAll((els) => els.map((el) => el.scrollTop).reduce((a, b) => a + b, 0));
  const start = await scrollerTop();
  const tops: number[] = [];
  // Blank lines between the paragraphs: two presses a paragraph.
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("ArrowDown");
    await frames(page);
    tops.push(await scrollerTop());
  }
  expectSteps(start, tops, 1);
  expect(tops.at(-1)!).toBeGreaterThan(start);
});
