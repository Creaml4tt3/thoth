/**
 * ADR-0056 on the real desktop UI (Chromium, real Rust host, the e2e bridge): the Board opens from the sidebar on the
 * Overview, which shows every page of the Private Space as a sticky note and its links as string; New board makes a
 * `.canvas` file; Add note pins pages; string drawn from one note's pin onto another adds one link line at the end of the
 * source page (never a canvas edge); a moved note keeps its place on disk and after a reload. It passes the
 * accessibility check.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startBridge, type Bridge } from "./bridge.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";
import { pickSpace } from "./pick-space.ts";

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge;

const FILES: Record<string, string> = {
  "Plan.md": "---\ntags: [work]\n---\n# Plan\n\nSee [[Notes]].\n",
  "Notes.md": "# Notes\n\nThe notes.\n",
  "Ideas.md": "# Ideas\n\nAbout #idea.\n",
  "Work/Trip.md": "# Trip\n\nBack to [[Plan]].\n",
};

test.beforeAll(async () => {
  built = await buildAll();
});

test.beforeEach(async ({ page, context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-board-")));
  vault = join(scratch, "Vault");
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(vault, path)), { recursive: true });
    await writeFile(join(vault, path), text);
  }
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, dataDir: join(scratch, "data") } });
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await page.addInitScript(bridge.initScript);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(bridge.url);
  await pickSpace(page);
  await expect(page.getByRole("tree", { name: "Pages in this Private Space" })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await page.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

async function axe(page: Page, ...selectors: string[]) {
  await settled(page);
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  for (const s of selectors) builder = builder.include(s);
  const results = await builder.analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

type Canvas = { nodes: { id: string; type: string; file?: string; x: number; y: number }[]; edges: unknown[] };
const canvas = async (): Promise<Canvas> => JSON.parse(await readFile(join(vault, "Case.canvas"), "utf8")) as Canvas;
const nodeOf = (c: Canvas, file: string) => c.nodes.find((n) => n.file === file);
/** A note's place on the board, in board units (its inline left/top). */
const placeOf = (note: Locator) => note.evaluate((el) => ({ x: parseFloat((el as HTMLElement).style.left), y: parseFloat((el as HTMLElement).style.top) }));

/** The string between two notes (strings have no direction: drawn from the path that sorts first). */
const string = (within: Locator, a: string, b: string) => {
  const [from, to] = a < b ? [a, b] : [b, a];
  return within.locator(`.board-strings path[data-from="${from}"][data-to="${to}"]`);
};

async function centre(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error("not on screen");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A hand's drag: press at `from`, move there in small steps, release. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

test("the Board shows the Overview, builds a board, draws string into a link, and keeps a board's places after a reload", async ({ page }) => {
  // The sidebar's Board entry opens the Overview: every page is a note, every link a string.
  await page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.getByRole("tab", { selected: true })).toHaveText("Overview");
  const overview = page.getByRole("application", { name: "Overview" });
  for (const title of ["Plan", "Notes", "Ideas", "Trip"]) await expect(overview.getByRole("button", { name: new RegExp(`^${title},`) })).toBeVisible();
  await expect(overview.getByRole("button", { name: "Plan, See [[Notes]]., #work, 2 links" })).toBeVisible();
  await expect(string(overview, "Plan.md", "Notes.md")).toHaveCount(1);
  await expect(string(overview, "Work/Trip.md", "Plan.md")).toHaveCount(1);
  expect(await axe(page, ".board-tab")).toEqual([]);

  // New board: a `.canvas` file at the top level (nothing chosen in the sidebar), opened in this tab.
  await page.getByRole("button", { name: "New board" }).click();
  const named = page.getByRole("dialog", { name: "New board" });
  await named.getByRole("textbox", { name: "Board name" }).fill("Case");
  await named.getByRole("button", { name: "Create" }).click();
  await expect(named).toBeHidden();
  await expect(page.getByRole("tab", { selected: true })).toHaveText("Case");
  const board = page.getByRole("application", { name: "Case" });
  await expect(board).toBeVisible();
  expect(await canvas()).toEqual({ nodes: [], edges: [] });

  // Add note, twice.
  for (const title of ["Ideas", "Notes"]) {
    await page.getByRole("button", { name: "Add note" }).click();
    const add = page.getByRole("dialog", { name: "Add note" });
    await add.getByRole("list", { name: "Pages not on this board" }).getByRole("button", { name: new RegExp(`^${title}`) }).click();
    await expect(add).toBeHidden();
    await expect(board.getByRole("button", { name: new RegExp(`^${title},`) })).toBeVisible();
  }
  const ideas = board.getByRole("button", { name: /^Ideas,/ });
  const notes = board.getByRole("button", { name: /^Notes,/ });
  // Saved after a short pause; pinned pages only, no edges.
  await expect.poll(async () => (await canvas()).nodes.map((n) => n.file)).toEqual(["Ideas.md", "Notes.md"]);

  // String from Ideas' pin onto Notes: one link line at the end of Ideas.md, never a canvas edge.
  await drag(page, await centre(ideas.locator(".board-pin")), await centre(notes));
  await expect(page.locator(".board-tab .board-status")).toHaveText("Linked.");
  await expect.poll(() => readFile(join(vault, "Ideas.md"), "utf8")).toBe(`${FILES["Ideas.md"]}[[Notes]]\n`);
  await expect(string(board, "Ideas.md", "Notes.md")).toHaveCount(1);
  expect((await canvas()).edges).toEqual([]);
  expect(await axe(page, ".board-tab")).toEqual([]);

  // Move Notes down and right; the board saves its new place.
  const before = await placeOf(notes);
  const start = await centre(notes);
  await drag(page, start, { x: start.x + 120, y: start.y + 160 });
  await expect.poll(async () => {
    const node = nodeOf(await canvas(), "Notes.md");
    return node ? { x: node.x, y: node.y } : null;
  }).not.toEqual(before);
  const saved = await canvas();
  const moved = nodeOf(saved, "Notes.md")!;
  expect(moved.x).toBeGreaterThan(before.x);
  expect(moved.y).toBeGreaterThan(before.y);

  // After a reload the board shows every note where the file has it, and the file is unchanged.
  await page.reload();
  await pickSpace(page);
  await page.getByRole("tree", { name: "Pages in this Private Space" }).getByRole("treeitem", { name: "Case" }).click();
  const again = page.getByRole("application", { name: "Case" });
  for (const file of ["Ideas.md", "Notes.md"]) {
    const node = nodeOf(saved, file)!;
    await expect.poll(() => placeOf(again.locator(`.board-note[data-path="${file}"]`))).toEqual({ x: node.x, y: node.y });
  }
  expect(await canvas()).toEqual(saved);
  // Nothing else was written: only Ideas.md got its link line.
  for (const [path, text] of Object.entries(FILES)) if (path !== "Ideas.md") expect(await readFile(join(vault, path), "utf8"), path).toBe(text);
});
