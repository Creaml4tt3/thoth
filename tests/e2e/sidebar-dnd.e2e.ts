/**
 * Drag and drop in the Private Space tree with a real pointer (`page.mouse` down, move in steps, up; and
 * `locator.dragTo`), on the real desktop UI in Chromium and the real Rust host through the e2e bridge. Checks what the
 * person sees (the drop indicator on the row they point at), where the drop lands (files, `.thoth/order.json`) and
 * that the tree shows the new order without a reload.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { settled } from "./settled.ts";
import { expectIndicator, indicators, recordIndicators, recorded, rowByName, rowNames, startDrag } from "./drag.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { buildAll } from "./setup.ts";

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge;

test.beforeAll(async () => {
  built = await buildAll();
});

const put = async (path: string, text = `# ${path}\n`) => {
  await mkdir(dirname(join(vault, path)), { recursive: true });
  await writeFile(join(vault, path), text);
};
const exists = (path: string) => stat(join(vault, path)).then(() => true, () => false);
const order = async (): Promise<Record<string, string[]>> => {
  try {
    return (JSON.parse(await readFile(join(vault, ".thoth/order.json"), "utf8")) as { folders: Record<string, string[]> }).folders;
  } catch {
    return {};
  }
};

test.beforeEach(async ({ page, context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-dnd-")));
  vault = join(scratch, "Vault");
  await mkdir(vault);
  await put("Alpha.md");
  await put("Beta.md");
  await put("Gamma.md");
  await put("Docs/One.md");
  await put("Docs/Two.md");
  await put("Docs/Three.md");
  await put("Docs/Deep/Inner.md");
  await mkdir(join(vault, "Empty"));
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

const tree = (page: Page) => page.getByRole("tree", { name: "Pages in this Private Space" });
const row = rowByName;
const open = async (page: Page, folder: string) => {
  const r = row(page, folder);
  if ((await r.getAttribute("aria-expanded")) !== "true") await r.click();
  await expect(r).toHaveAttribute("aria-expanded", "true");
  await settled(page); // the folder slides open; positions are read after that
};

test("reorder at the top level: the indicator shows on the row pointed at, the page lands there, the order is saved", async ({ page }) => {
  await expect.poll(() => rowNames(tree(page))).toEqual(["Docs", "Empty", "Alpha", "Beta", "Gamma"]);

  // Gamma above Alpha.
  const drag = await startDrag(page, row(page, "Gamma"));
  await drag.over(row(page, "Alpha"), 0.15);
  await expectIndicator(page, ["Alpha: before"]);
  // Sweeping across the row's own children (caret, icon, label) does not make the indicator blink off and on.
  await recordIndicators(page);
  const box = (await row(page, "Alpha").boundingBox())!;
  for (const dx of [4, 20, 44, 120, 60, 12]) await drag.moveTo(box.x + dx, box.y + 3, 6);
  await expectIndicator(page, ["Alpha: before"]);
  expect(await recorded(page)).toEqual([]);
  await drag.drop();
  await expect.poll(() => rowNames(tree(page))).toEqual(["Docs", "Empty", "Gamma", "Alpha", "Beta"]);
  await expect.poll(async () => (await order())[""]).toEqual(["Docs", "Empty", "Gamma.md", "Alpha.md", "Beta.md"]);
  expect(await indicators(page)).toEqual([]);

  // Gamma below Beta.
  const second = await startDrag(page, row(page, "Gamma"));
  await second.over(row(page, "Beta"), 0.85);
  await expectIndicator(page, ["Beta: after"]);
  await second.drop();
  await expect.poll(() => rowNames(tree(page))).toEqual(["Docs", "Empty", "Alpha", "Beta", "Gamma"]);
  expect(await indicators(page)).toEqual([]);
});

test("reorder inside an open folder, before and after, writes that folder's order and nothing else moves", async ({ page }) => {
  await open(page, "Docs");
  await expect.poll(() => rowNames(tree(page))).toEqual(["Docs", "Deep", "One", "Three", "Two", "Empty", "Alpha", "Beta", "Gamma"]);

  const drag = await startDrag(page, row(page, "Two"));
  await drag.over(row(page, "One"), 0.8); // a page row is two halves: the lower half of One is "after One"
  await expectIndicator(page, ["One: after"]);
  await drag.over(row(page, "One"), 0.2);
  await expectIndicator(page, ["One: before"]);
  await drag.drop();
  await expect.poll(() => rowNames(tree(page))).toEqual(["Docs", "Deep", "Two", "One", "Three", "Empty", "Alpha", "Beta", "Gamma"]);
  await expect.poll(async () => (await order())["Docs"]).toEqual(["Deep", "Two.md", "One.md", "Three.md"]);
  expect(await exists("Docs/Two.md")).toBe(true); // reordering renames nothing

  const again = await startDrag(page, row(page, "Two"));
  await again.over(row(page, "Three"), 0.9);
  await expectIndicator(page, ["Three: after"]);
  await again.drop();
  await expect.poll(() => rowNames(tree(page))).toEqual(["Docs", "Deep", "One", "Three", "Two", "Empty", "Alpha", "Beta", "Gamma"]);
  await expect.poll(async () => (await order())["Docs"]).toEqual(["Deep", "One.md", "Three.md", "Two.md"]);
  expect(await indicators(page)).toEqual([]);
  // The top level was not touched.
  expect((await order())[""]).toBeUndefined();
});

test("drop into a folder: the folder row is outlined, the page moves into it and the folder opens", async ({ page }) => {
  const drag = await startDrag(page, row(page, "Alpha"));
  await drag.over(row(page, "Docs"), 0.5);
  await expectIndicator(page, ["Docs: inside"]);
  await drag.drop();
  await expect.poll(() => exists("Docs/Alpha.md")).toBe(true);
  expect(await exists("Alpha.md")).toBe(false);
  await expect.poll(() => rowNames(tree(page))).toEqual(["Docs", "Deep", "One", "Three", "Two", "Alpha", "Empty", "Beta", "Gamma"]);
  await expect.poll(async () => (await order())["Docs"]).toEqual(["Deep", "One.md", "Three.md", "Two.md", "Alpha.md"]);
  expect(await indicators(page)).toEqual([]);
});

test("a drop on the row's text lands like a drop on the row, and so does a drop on its empty end", async ({ page }) => {
  const label = row(page, "Docs").locator(".tree-label");
  const drag = await startDrag(page, row(page, "Beta"));
  const text = (await label.boundingBox())!;
  await drag.moveTo(text.x + text.width / 2, text.y + text.height / 2);
  await expectIndicator(page, ["Docs: inside"]);
  await drag.drop();
  await expect.poll(() => exists("Docs/Beta.md")).toBe(true);
  await settled(page);

  const far = await startDrag(page, row(page, "Gamma"));
  const rowBox = (await row(page, "Docs").boundingBox())!;
  await far.moveTo(rowBox.x + rowBox.width - 3, rowBox.y + rowBox.height / 2);
  await expectIndicator(page, ["Docs: inside"]);
  await far.drop();
  await expect.poll(() => exists("Docs/Gamma.md")).toBe(true);
});

test("a nested page dropped on the Top level strip, or before a top-level row, moves out of its folder", async ({ page }) => {
  await open(page, "Docs");
  const out = await startDrag(page, row(page, "One"));
  const strip = page.locator(".tree-root-drop");
  await out.over(row(page, "Gamma"), 0.5); // moving anywhere makes the strip appear
  await expect(strip).toBeVisible();
  const box = (await strip.boundingBox())!;
  await out.moveTo(box.x + box.width / 2, box.y + box.height / 2);
  await expect(strip).toHaveAttribute("data-drop", "inside");
  await out.drop();
  await expect.poll(() => exists("One.md")).toBe(true);
  expect(await exists("Docs/One.md")).toBe(false);
  await expect.poll(() => rowNames(tree(page))).toEqual(["Docs", "Deep", "Three", "Two", "Empty", "Alpha", "Beta", "Gamma", "One"]);
  await expect.poll(async () => (await order())[""]).toEqual(["Docs", "Empty", "Alpha.md", "Beta.md", "Gamma.md", "One.md"]);

  // Before a top-level row, from inside a folder.
  const before = await startDrag(page, row(page, "Two"));
  await before.over(row(page, "Alpha"), 0.2);
  await expectIndicator(page, ["Alpha: before"]);
  await before.drop();
  await expect.poll(() => exists("Two.md")).toBe(true);
  await expect.poll(() => rowNames(tree(page))).toEqual(["Docs", "Deep", "Three", "Empty", "Two", "Alpha", "Beta", "Gamma", "One"]);
  await expect.poll(async () => (await order())[""]).toEqual(["Docs", "Empty", "Two.md", "Alpha.md", "Beta.md", "Gamma.md", "One.md"]);
});

test("a closed folder under the dragged page opens by itself, and the page can then go in at an exact place", async ({ page }) => {
  const drag = await startDrag(page, row(page, "Alpha"));
  await drag.over(row(page, "Docs"), 0.5);
  await expectIndicator(page, ["Docs: inside"]);
  await expect(row(page, "Docs")).toHaveAttribute("aria-expanded", "true", { timeout: 3000 });
  await expect(row(page, "Two")).toBeVisible();
  await drag.over(row(page, "Three"), 0.2);
  await expectIndicator(page, ["Three: before"]);
  await drag.drop();
  await expect.poll(() => exists("Docs/Alpha.md")).toBe(true);
  await expect.poll(() => rowNames(tree(page))).toEqual(["Docs", "Deep", "One", "Alpha", "Three", "Two", "Empty", "Beta", "Gamma"]);
  await expect.poll(async () => (await order())["Docs"]).toEqual(["Deep", "One.md", "Alpha.md", "Three.md", "Two.md"]);
});

test("a folder cannot be dropped into itself or into its own descendant: no indicator, nothing moves", async ({ page }) => {
  await open(page, "Docs");
  const drag = await startDrag(page, row(page, "Docs"));
  await drag.over(row(page, "Deep"), 0.5);
  await expectIndicator(page, []);
  await drag.over(row(page, "One"), 0.2); // before One would put Docs inside Docs
  await expectIndicator(page, []);
  await drag.over(row(page, "Docs"), 0.5);
  await expectIndicator(page, []);
  await drag.drop();
  await page.waitForTimeout(300);
  expect(await exists("Docs/Deep/Inner.md")).toBe(true);
  expect(await exists("Docs/Docs")).toBe(false);
  await expect.poll(() => rowNames(tree(page))).toEqual(["Docs", "Deep", "One", "Three", "Two", "Empty", "Alpha", "Beta", "Gamma"]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("the lower edge of an open folder puts the page first inside it, which is where the line is drawn", async ({ page }) => {
  await open(page, "Docs");
  const drag = await startDrag(page, row(page, "Alpha"));
  await drag.over(row(page, "Docs"), 0.95);
  // The line is drawn between the folder and its first child, because that is where the page goes.
  await expectIndicator(page, ["Deep: before"]);
  await drag.drop();
  await expect.poll(() => exists("Docs/Alpha.md")).toBe(true);
  await expect.poll(() => rowNames(tree(page))).toEqual(["Docs", "Alpha", "Deep", "One", "Three", "Two", "Empty", "Beta", "Gamma"]);
  await expect.poll(async () => (await order())["Docs"]).toEqual(["Alpha.md", "Deep", "One.md", "Three.md", "Two.md"]);
});

test("Escape cancels a drag: nothing moves and no indicator is left", async ({ page }) => {
  const drag = await startDrag(page, row(page, "Gamma"));
  await drag.over(row(page, "Alpha"), 0.1);
  await expectIndicator(page, ["Alpha: before"]);
  await drag.cancel();
  await expectIndicator(page, []);
  await expect(page.locator("[data-dragging]")).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(await order()).toEqual({});
  await expect.poll(() => rowNames(tree(page))).toEqual(["Docs", "Empty", "Alpha", "Beta", "Gamma"]);
});

test("locator.dragTo (one jump, no intermediate moves) reorders and moves too", async ({ page }) => {
  await row(page, "Gamma").dragTo(row(page, "Alpha"), { targetPosition: { x: 60, y: 3 } });
  await expect.poll(() => rowNames(tree(page))).toEqual(["Docs", "Empty", "Gamma", "Alpha", "Beta"]);
  await expect.poll(async () => (await order())[""]).toEqual(["Docs", "Empty", "Gamma.md", "Alpha.md", "Beta.md"]);

  await row(page, "Beta").dragTo(row(page, "Empty"));
  await expect.poll(() => exists("Empty/Beta.md")).toBe(true);
  await expect.poll(() => rowNames(tree(page))).toEqual(["Docs", "Empty", "Beta", "Gamma", "Alpha"]);
});

test("moving a page by drag keeps its tab, in the background too, and leaves no drag picture behind", async ({ page }) => {
  await row(page, "Gamma").click();
  await row(page, "Beta").click({ modifiers: ["ControlOrMeta"] }); // Beta in a new tab; Gamma's tab stays behind it
  await expect(page.getByRole("tab", { name: "Gamma" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Beta" })).toBeVisible();

  const drag = await startDrag(page, row(page, "Gamma"));
  await drag.over(row(page, "Docs"), 0.5);
  await expectIndicator(page, ["Docs: inside"]);
  await expect(page.locator("html")).toHaveAttribute("data-tree-dragging", "");
  await drag.drop();
  await expect.poll(() => exists("Docs/Gamma.md")).toBe(true);
  await expect(page.getByRole("tab", { name: "Gamma" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Beta" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-tree-dragging");
  await expect(page.locator(".tree-drag-image")).toHaveCount(0);
});
