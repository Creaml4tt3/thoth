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
const current = (page: Page) => page.getByRole("tab", { selected: true });

test("F2 renames a page and a folder in place, and Cmd/Ctrl+Shift+N makes a folder that starts in rename", async ({ page }) => {
  await openVault(page);
  await expect(current(page)).toHaveText("Notes"); // the first page, by path, opens by itself
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
  await expect(row(page, "Roadmap")).toBeFocused();
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
  expect(await isDirectory("Docs/Untitled folder")).toBe(true);
  await page.keyboard.type("Drafts");
  await page.keyboard.press("Enter");
  await expect.poll(() => isDirectory("Docs/Drafts")).toBe(true);
  expect(await isDirectory("Docs/Untitled folder")).toBe(false);
  await expect(row(page, "Drafts")).toBeVisible();

  // The palette's > New folder goes where the tree had focus (the Drafts row), as the shortcut does.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("> new folder");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Rename Untitled folder" })).toBeFocused();
  await page.keyboard.press("Escape"); // keeps the default name
  expect(await isDirectory("Docs/Drafts/Untitled folder")).toBe(true);

  // With focus outside the tree it is created at the top level, and a second one is numbered.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+Shift+N");
  await expect(page.getByRole("textbox", { name: "Rename Untitled folder" })).toBeFocused();
  await page.keyboard.press("Escape");
  expect(await isDirectory("Untitled folder")).toBe(true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+Shift+N");
  await expect(page.getByRole("textbox", { name: "Rename Untitled folder 2" })).toBeFocused();
  await page.keyboard.press("Escape");
  expect(await isDirectory("Untitled folder 2")).toBe(true);

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
  expect(await isDirectory("Papers/Drafts")).toBe(true);
  await expect(current(page)).toHaveText("Notes");
  await expect(page.getByRole("treeitem", { name: "Notes", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(row(page, "Papers")).toBeFocused();
});
