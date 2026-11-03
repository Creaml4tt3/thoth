/**
 * Dragging a block by its handle, with a real mouse in Chromium on the real Rust host: the pointer carries a small card
 * (the block's kind icon and the start of its text, or "Image" with a thumbnail), the dragged block fades, a line shows
 * where it lands, and nothing is left behind after a drop or Escape. Pictures of the card in both themes go to
 * tests/.tmp/block-drag/ (the browser's drag picture itself is not in a page screenshot, so the card is shown in place).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "../ports/harness.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";

const SHOTS = join(REPO, "tests", ".tmp", "block-drag");
const LONG = "Birds excrete nitrogen as uric acid, a white paste that saves water, which matters for animals that fly far.";
const PAGE = `# Birds\n\n${LONG}\n\n![Heron](heron.svg)\n\nMiddle line.\n\nLast line.\n`;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><rect width="240" height="120" fill="#7a8f86"/><circle cx="170" cy="45" r="22" fill="#f6d27a"/></svg>`;

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge;

test.use({ viewport: { width: 1200, height: 900 } });

test.beforeAll(async () => {
  built = await buildAll();
  await mkdir(SHOTS, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-block-drag-")));
  vault = join(scratch, "Vault");
  await mkdir(vault, { recursive: true });
  await writeFile(join(vault, "Birds.md"), PAGE);
  await writeFile(join(vault, "heron.svg"), SVG);
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, dataDir: join(scratch, "data") } });
  await page.addInitScript(bridge.initScript);
  // Every card the app makes, as it was when made (it is gone a moment later).
  await page.addInitScript(() => {
    const w = window as unknown as { __cards: string[] };
    w.__cards = [];
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement && n.classList.contains("block-drag-preview")) w.__cards.push(n.outerHTML);
    }).observe(document, { subtree: true, childList: true });
  });
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
});

test.afterEach(async ({ page }) => {
  await page.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

async function openBirds(page: Page) {
  const tree = page.getByRole("tree", { name: "Pages in this Private Space" });
  const start = page.getByRole("button", { name: /start writing/i });
  await expect(tree.or(start)).toBeVisible();
  if (await start.isVisible()) await start.click();
  await settled(page);
  await tree.getByRole("treeitem", { name: "Birds", exact: true }).click();
  const box = page.getByRole("textbox", { name: /page content/i });
  await expect(box).toContainText("Last line.");
  await expect.poll(() => box.getByRole("img", { name: "Heron" }).evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  return box;
}

const cards = (page: Page) => page.evaluate(() => (window as unknown as { __cards: string[] }).__cards.slice());
const order = (box: Locator) => box.locator(":scope > *").evaluateAll((els) => els.map((el) => (el.textContent || (el.querySelector("img")?.getAttribute("alt") ?? "")).slice(0, 12)));

/** Presses on the handle of `block` and moves a little, so the browser starts the drag. */
async function grab(page: Page, block: Locator) {
  await block.hover();
  const handle = page.locator(".block-handle");
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAccessibleName("Drag to move, click for block menu");
  const from = (await handle.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 4, { steps: 4 });
}

/** Shows a recorded card where a person would see it, next to the pointer, for a screenshot. */
async function showCard(page: Page, html: string, dark: boolean) {
  await page.evaluate(
    ({ html, dark }) => {
      document.documentElement.setAttribute("data-theme", dark ? "night" : "light");
      document.querySelector("#shot-card")?.remove();
      const wrap = document.createElement("div");
      wrap.id = "shot-card";
      wrap.innerHTML = html;
      const card = wrap.firstElementChild as HTMLElement;
      card.style.top = "300px";
      card.style.left = "420px";
      document.querySelector(".editor-surface")!.append(card);
      card.id = "shot-card";
    },
    { html, dark },
  );
}

test("the drag carries a small card with the block's icon and text; the block fades; the line shows where it lands", async ({ page }) => {
  const box = await openBirds(page);
  const long = box.locator("p", { hasText: "Birds excrete" });
  const before = await order(box);
  await grab(page, long);
  const target = (await box.locator("p", { hasText: "Last line." }).boundingBox())!;
  await page.mouse.move(target.x + 80, target.y + 2, { steps: 10 });
  // dragover fires on a timer in Chromium: one more small move so the last one is seen.
  await page.mouse.move(target.x + 81, target.y + 2, { steps: 2 });

  const indicator = page.locator(".block-drop-indicator");
  await expect(indicator).toBeVisible();
  // The line sits between "Middle line." and "Last line.", as wide as the blocks.
  const middle = (await box.locator("p", { hasText: "Middle line." }).boundingBox())!;
  await expect.poll(async () => (await indicator.boundingBox())!.y).toBeGreaterThan(middle.y + middle.height - 2);
  const line = (await indicator.boundingBox())!;
  expect(line.y).toBeLessThan(target.y + 2);
  expect(Math.abs(line.x - target.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(line.width - target.width)).toBeLessThanOrEqual(1);
  await expect(long).toHaveCSS("opacity", "0.45");

  // One card, made for this drag: the text icon and the start of the paragraph, cut with an ellipsis.
  const made = await cards(page);
  expect(made).toHaveLength(1);
  expect(made[0]).toContain(">T<");
  expect(made[0]).toContain("Birds excrete nitrogen as uric acid, a white paste that sav");
  expect(made[0]).toContain("…");
  await expect(page.locator(".block-drag-preview")).toHaveCount(0);

  await page.mouse.up();
  await expect(indicator).toBeHidden();
  await expect(long).toHaveCSS("opacity", "1");
  await expect(page.locator(".block-drag-preview")).toHaveCount(0);
  const after = await order(box);
  expect(after).not.toEqual(before);
  expect(after.indexOf(after.find((t) => t.startsWith("Birds excr"))!)).toBe(after.length - 2);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(join(vault, "Birds.md"), "utf8")).toBe(`# Birds\n\n![Heron](heron.svg)\n\nMiddle line.\n\n${LONG}\n\nLast line.\n`);

  // Pictures of the card, light and dark.
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const dark of [false, true]) {
    await showCard(page, made[0]!, dark);
    await settled(page);
    await page.locator("#shot-card").screenshot({ path: join(SHOTS, `card-text-${dark ? "dark" : "light"}.png`) });
  }
});

test("an image's card says Image with its picture; Escape cancels and leaves nothing behind", async ({ page }) => {
  const box = await openBirds(page);
  const before = await order(box);
  const image = box.locator(".page-image").first();
  await grab(page, image);
  const target = (await box.locator("p", { hasText: "Last line." }).boundingBox())!;
  await page.mouse.move(target.x + 80, target.y + target.height - 2, { steps: 10 });
  await expect(page.locator(".block-drop-indicator")).toBeVisible();
  const made = await cards(page);
  expect(made).toHaveLength(1);
  expect(made[0]).toContain(">▣<");
  expect(made[0]).toContain(">Image<");
  expect(made[0]).toContain("<canvas");

  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".block-drop-indicator")).toBeHidden();
  await expect(page.locator(".block-drag-preview")).toHaveCount(0);
  await expect(page.locator(".is-block-dragging")).toHaveCount(0);
  expect(await order(box)).toEqual(before);

  // The picture is drawn on a canvas, which `outerHTML` does not keep: take this one from a fresh card.
  await page.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>(".page-image img")!;
    const c = document.createElement("canvas");
    c.width = c.height = 24 * devicePixelRatio;
    const s = Math.max(c.width / img.naturalWidth, c.height / img.naturalHeight);
    c.getContext("2d")!.drawImage(img, (c.width - img.naturalWidth * s) / 2, (c.height - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
    (window as unknown as { __thumb: string }).__thumb = c.toDataURL();
  });
  for (const dark of [false, true]) {
    await showCard(page, made[0]!, dark);
    await page.evaluate(() => {
      const old = document.querySelector("#shot-card canvas, #shot-card .block-drag-thumb");
      const img = document.createElement("img");
      img.className = "block-drag-thumb";
      img.src = (window as unknown as { __thumb: string }).__thumb;
      old?.replaceWith(img);
    });
    await settled(page);
    await page.locator("#shot-card").screenshot({ path: join(SHOTS, `card-image-${dark ? "dark" : "light"}.png`) });
  }
});

test("keyboard moves are unchanged: Alt+Shift+ArrowDown moves the block down", async ({ page }) => {
  const box = await openBirds(page);
  await box.getByText("Middle line.").click();
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(join(vault, "Birds.md"), "utf8")).toBe(`# Birds\n\n${LONG}\n\n![Heron](heron.svg)\n\nLast line.\n\nMiddle line.\n`);
});
