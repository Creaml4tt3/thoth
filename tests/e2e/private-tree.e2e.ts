/**
 * Rename in place (F2) and New folder in the Private Space tree, on the real desktop UI in Chromium and the real Rust
 * host ports (mkdir, directory rename, compare-and-swap writes). Driven with the keyboard: F2, Enter, Escape and
 * Cmd/Ctrl+Shift+N. Files on disk are read to check the bytes where they matter.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startBridge, type Bridge } from "./bridge.ts";
import { buildAll } from "./setup.ts";

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge;

test.beforeAll(async () => {
  built = await buildAll();
});

const put = async (path: string, text: string) => {
  await mkdir(dirname(join(vault, path)), { recursive: true });
  await writeFile(join(vault, path), text);
};
const read = (path: string) => readFile(join(vault, path), "utf8");
const isDirectory = (path: string) => stat(join(vault, path)).then((s) => s.isDirectory(), () => false);

test.beforeEach(async ({ page, context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-")));
  vault = join(scratch, "Vault");
  await mkdir(vault);
  await put("Plan.md", "# Plan\n\nThe plan.\n");
  await put("Docs/Notes.md", "# Notes\n\nSee [[Plan]] and [the plan](../Plan.md).\n");
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, pickSource: join(scratch, "source"), dataDir: join(scratch, "data") } });
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
});

test.afterEach(async ({ page }) => {
  await page.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

async function openVault(page: Page) {
  const choose = page.getByRole("button", { name: /choose or create a private space/i });
  await choose.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tree", { name: "Pages in this Private Space" })).toBeVisible();
}

const row = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
/**
 * A row by its path. While a rename saves, its field row (named after the new text) and the renamed row can both be on
 * screen for a moment, so a row asked for by name may match twice (Playwright then fails at once instead of retrying).
 */
const rowAt = (page: Page, path: string) => page.locator(`[data-tree-id="${path}"]`);
const current = (page: Page) => page.getByRole("tab", { selected: true });

test("F2 renames a page and a folder in place, and Cmd/Ctrl+Shift+N makes a folder that starts in rename", async ({ page }) => {
  await openVault(page);
  await expect(current(page)).not.toHaveText("New tab"); // nothing was open: the first page
  await row(page, "Plan").focus();
  await page.keyboard.press("Enter");
  await expect(current(page)).toHaveText("Plan");

  // F2 on a page: the field holds the file name; a refused name stays open with the reason and passes the accessibility check.
  await row(page, "Plan").focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "Rename Plan" });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Plan");
  await page.keyboard.type("a:b");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("cannot contain");
  await expect(field).toBeFocused();
  const bad = (await new AxeBuilder({ page }).include('[role="tree"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  expect(await read("Plan.md")).toBe("# Plan\n\nThe plan.\n");

  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Roadmap");
  await page.keyboard.press("Enter");
  await expect.poll(() => read("Roadmap.md").catch(() => null)).toBe("# Roadmap\n\nThe plan.\n"); // moved; the heading that was the old name follows
  expect(await readdir(vault)).not.toContain("Plan.md");
  expect(await read("Docs/Notes.md")).toBe("# Notes\n\nSee [[Roadmap]] and [the plan](../Roadmap.md).\n"); // links follow
  await expect(current(page)).toHaveText("Roadmap"); // the tab follows
  await expect(rowAt(page, "Roadmap.md")).toBeFocused();
  expect(await readdir(join(vault, ".thoth"))).not.toContain("order.json");

  // Escape cancels.
  await page.keyboard.press("F2");
  await page.keyboard.type("Nope");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: /^Rename / })).toHaveCount(0);
  expect(await readdir(vault)).not.toContain("Nope.md");

  // Cmd/Ctrl+Shift+N with the tree on a folder: a folder inside it, in rename, named 'Untitled folder'.
  await row(page, "Docs").focus();
  await page.keyboard.press("ControlOrMeta+Shift+N");
  const naming = page.getByRole("textbox", { name: "Rename Untitled folder" });
  await expect(naming).toBeFocused();
  await expect.poll(() => isDirectory("Docs/Untitled folder")).toBe(true);
  await page.keyboard.type("Drafts");
  await page.keyboard.press("Enter");
  await expect.poll(() => isDirectory("Docs/Drafts")).toBe(true);
  expect(await isDirectory("Docs/Untitled folder")).toBe(false);
  await expect(rowAt(page, "Docs/Drafts")).toBeVisible();

  // The palette's > New folder goes where the tree had focus (the Drafts row), as the shortcut does. After a rename,
  // focus is nowhere until the tree has read the folder again and shows the renamed row; wait for it to be back, or
  // "where the tree has focus" is nowhere and the folder is made at the top level.
  await expect(rowAt(page, "Docs/Drafts")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("> new folder");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Rename Untitled folder" })).toBeFocused();
  await page.keyboard.press("Escape"); // keeps the default name
  await expect.poll(() => isDirectory("Docs/Drafts/Untitled folder")).toBe(true);

  // With focus outside the tree it is created at the top level, and a second one is numbered. Focus goes back to the
  // row when the rename ends; wait for that, so that the blur below is the last word on where focus is.
  await expect(rowAt(page, "Docs/Drafts/Untitled folder")).toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+Shift+N");
  await expect(page.getByRole("textbox", { name: "Rename Untitled folder" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect.poll(() => isDirectory("Untitled folder")).toBe(true);
  await expect(rowAt(page, "Untitled folder")).toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+Shift+N");
  await expect(page.getByRole("textbox", { name: "Rename Untitled folder 2" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect.poll(() => isDirectory("Untitled folder 2")).toBe(true);

  // F2 on a folder renames the directory; links to what is in it follow, and the page keeps its tab.
  await page.getByRole("treeitem", { name: "Notes", exact: true }).click();
  await expect(current(page)).toHaveText("Notes");
  await row(page, "Docs").focus();
  await page.keyboard.press("F2");
  await expect(page.getByRole("textbox", { name: "Rename Docs" })).toHaveValue("Docs");
  await page.keyboard.type("Papers");
  await page.keyboard.press("Enter");
  await expect.poll(() => isDirectory("Papers")).toBe(true);
  expect(await isDirectory("Docs")).toBe(false);
  expect(await read("Papers/Notes.md")).toBe("# Notes\n\nSee [[Roadmap]] and [the plan](../Roadmap.md).\n");
  await expect.poll(() => isDirectory("Papers/Drafts")).toBe(true);
  await expect(current(page)).toHaveText("Notes");
  await expect(page.getByRole("treeitem", { name: "Notes", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(rowAt(page, "Papers")).toBeFocused();
});

test("the row menu of the last row of a long tree in a short window opens fully inside the window", async ({ page }) => {
  for (let i = 1; i <= 30; i++) await put(`Page ${String(i).padStart(2, "0")}.md`, `# Page ${i}\n`);
  await page.setViewportSize({ width: 900, height: 420 });
  await openVault(page);
  const last = row(page, "Plan"); // "Plan" sorts after "Page NN"
  await last.scrollIntoViewIfNeeded();
  await last.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
});
