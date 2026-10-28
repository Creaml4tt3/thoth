/**
 * Phase 3b AC 6 (ADR-0016 rule 7): the real desktop UI in Chromium, on the real Rust host ports, driven with the
 * keyboard only. A person who cannot use a mouse creates a page, renames it, moves it, formats text, switches tab,
 * changes the theme, opens Settings and comes back to the same tabs after a restart.
 *
 * Only keys are pressed after the page loads. Where a control has to be reached first (the first button, the editor)
 * it is focused by script, which is what Tab does; no pointer event is sent anywhere. Files on disk are read to check
 * the bytes where they matter.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, type Bridge } from "./bridge.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";
import { welcomeDone } from "./welcome.ts";

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge;

test.beforeAll(async () => {
  built = await buildAll();
});

test.beforeEach(async ({ page, context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-")));
  vault = join(scratch, "Vault");
  await mkdir(vault);
  await welcomeDone(vault);
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, pickSource: join(scratch, "source"), dataDir: join(scratch, "data") } });
  // No network: only the bridge origin is reachable.
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
});

test.afterEach(async ({ page }) => {
  await page.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

const read = (path: string) => readFile(join(vault, path), "utf8");
const exists = (path: string) => read(path).then(
  () => true,
  () => false,
);

/** Moves focus to a button and presses Enter, as Tab then Enter would. */
async function press(page: Page, name: RegExp | string) {
  const button = page.getByRole("button", { name });
  await button.focus();
  await page.keyboard.press("Enter");
}

/** No serious or critical accessibility problem in the part of the page under `selector` (once its motion has finished, so no colour is read half faded). */
async function expectAccessible(page: Page, selector: string) {
  await settled(page);
  const results = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** Cmd/Ctrl+K, then a command typed after `>`, then Enter. */
async function command(page: Page, text: string) {
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Search" });
  await expect(palette).toBeVisible();
  await page.keyboard.type(`> ${text}`);
  await expect(palette.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
}

/**
 * A new page by keyboard (0.2.6): Cmd/Ctrl+Shift+N makes a folder in rename when `folder` is given, and Cmd/Ctrl+N with
 * that folder's row focused makes "Untitled" in it and starts the rename, which takes the name.
 */
async function newPage(page: Page, name: string, folder?: string) {
  if (folder) {
    await page.keyboard.press("ControlOrMeta+Shift+n");
    await expect(page.getByRole("textbox", { name: /^Rename Untitled folder/ })).toBeFocused();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(folder);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("treeitem", { name: folder, exact: true })).toBeFocused();
  }
  await page.keyboard.press("ControlOrMeta+n");
  const field = page.getByRole("textbox", { name: /^Rename Untitled/ });
  await expect(field).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
  await expect(field).toBeHidden();
}

const current = (page: Page) => page.getByRole("tab", { selected: true });
const tabNames = (page: Page) => page.getByRole("tab").allTextContents();
const editorOf = (page: Page) => page.getByRole("textbox", { name: /page content/i });
const theme = (page: Page) => page.evaluate(() => document.documentElement.getAttribute("data-theme"));

/** Select back to the start of the line: Cmd+Shift+Left on a Mac (where Home goes to the start of the document), Shift+Home elsewhere. */
const SELECT_TO_LINE_START = process.platform === "darwin" ? "Meta+Shift+ArrowLeft" : "Shift+Home";

/** Asks the editor's own state (the same ProseMirror state the app saves from). */
function editorState<T>(page: Page, read: (state: { selection: { empty: boolean; from: number; to: number }; doc: { content: { size: number } } }) => T): Promise<T> {
  return editorOf(page).evaluate((el, source) => {
    const { state } = (el as unknown as { editor: { state: Parameters<typeof read>[0] } }).editor;
    return (0, eval)(`(${source})`)(state) as T;
  }, read.toString());
}

/** The browser's own "end of the document" key: Cmd+Down on a Mac, Ctrl+End elsewhere. */
const END_OF_DOCUMENT = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

/** Puts focus in the page's text (what Tab does), goes to the end of the last line and types a new line. */
async function typeAtEnd(page: Page, text: string) {
  const box = editorOf(page);
  await expect(box).toBeVisible();
  await box.focus();
  await page.keyboard.press(END_OF_DOCUMENT);
  // ProseMirror reads the browser's caret a tick later: wait until it is at the end, as a person would see it.
  await expect.poll(() => editorState(page, ({ selection, doc }) => selection.empty && selection.to === doc.content.size - 1)).toBe(true);
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}

test("with the keyboard only: create, rename, move, format, switch tab, change theme, open Settings, and come back to the same tabs", async ({ page }) => {
  await press(page, /choose or create a private space/i);
  await press(page, /start writing/i);
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible(); // an empty Private Space: a new tab
  expect(await tabNames(page)).toEqual(["New tab"]);

  // 1. Create two pages: one in a folder (so there is somewhere to move to), then the one we work on. The new folder's
  //    row has focus after its rename, so the page made next goes in it (0.2.6); Plan, made before, is at the top.
  await newPage(page, "Plan");
  await expect(current(page)).toHaveText("Plan");
  expect(await tabNames(page)).toEqual(["Plan"]); // a page opens in the current tab
  await newPage(page, "Old", "Archive");
  await expect(current(page)).toHaveText("Old");
  // Back to Plan from the palette: the rest works on it.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("Plan");
  await expect(page.getByRole("option", { name: /^Plan/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(current(page)).toHaveText("Plan");
  expect(await tabNames(page)).toEqual(["Plan"]);
  const created = await read("Plan.md");
  expect(created).toMatch(/^---\nthoth_id: [0-9a-f-]{36}\n---\n# Plan\n$/);
  expect(await read("Archive/Old.md")).toMatch(/^---\nthoth_id: [0-9a-f-]{36}\n---\n# Old\n$/);

  // 2. Rename it from the palette, as F2 does: the file is renamed, the heading that was the old name follows, and
  //    nothing else in the file changes (same thoth_id); the tab follows.
  await command(page, "rename");
  const rename = page.getByRole("dialog", { name: "Rename “Plan”" });
  await expect(rename).toBeVisible();
  await page.keyboard.type("Roadmap"); // the field starts selected
  await page.keyboard.press("Enter");
  await expect(rename).toBeHidden();
  await expect(current(page)).toHaveText("Roadmap");
  await expect.poll(() => exists("Roadmap.md")).toBe(true);
  expect(await exists("Plan.md")).toBe(false);
  const renamed = created.replace("# Plan\n", "# Roadmap\n");
  await expect.poll(() => read("Roadmap.md")).toBe(renamed);
  expect(await exists(".thoth/order.json")).toBe(false); // renaming creates no order record

  // 3. Move it into the folder with Move to…: Down picks "Archive", Tab goes to the Move button, Enter presses it.
  await command(page, "move to");
  const move = page.getByRole("dialog", { name: "Move “Roadmap” to…" });
  await expect(move).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(move).toBeHidden();
  await expect.poll(() => exists("Archive/Roadmap.md")).toBe(true);
  expect(await exists("Roadmap.md")).toBe(false);
  expect(await read("Archive/Roadmap.md")).toBe(renamed);
  await expect(current(page)).toHaveText("Roadmap");

  // 4. And up, ahead of Old in that folder, by command (the tree's Alt+Shift+Up does the same).
  await command(page, "move page up");
  await expect
    .poll(async () => (await exists(".thoth/order.json")) && (JSON.parse(await read(".thoth/order.json")) as { folders: Record<string, string[]> }).folders["Archive"])
    .toEqual(["Roadmap.md", "Old.md"]);
  // The tree gives focus back to the row it moved (so a keyboard user does not lose their place); wait for that before going on.
  await expect(page.getByRole("treeitem", { name: "Roadmap" })).toBeFocused();

  // 5. Type a line, select it with the keyboard and highlight it with Cmd/Ctrl+Shift+H. Save, and read the bytes.
  await typeAtEnd(page, "Write the plan.");
  await page.keyboard.press(SELECT_TO_LINE_START);
  await expect.poll(() => editorState(page, ({ selection }) => !selection.empty)).toBe(true);
  await page.keyboard.press("ControlOrMeta+Shift+H");
  await expect(editorOf(page).locator("mark")).toHaveText("Write the plan.");
  await page.keyboard.press("ControlOrMeta+s");
  const formatted = `${renamed}\n==Write the plan.==\n`;
  await expect.poll(() => read("Archive/Roadmap.md")).toBe(formatted);

  // 6. Switch tabs. Cmd/Ctrl+T opens an empty tab, the palette fills it with Old; Ctrl+Tab and Cmd/Ctrl+1 go back.
  await page.keyboard.press("ControlOrMeta+t");
  await expect(current(page)).toHaveText("New tab");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("Old");
  const hit = page.getByRole("option", { name: /Old/ });
  await expect(hit).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(current(page)).toHaveText("Old");
  expect(await tabNames(page)).toEqual(["Roadmap", "Old"]);
  await expectAccessible(page, ".tabstrip"); // a tablist that owns tabs only, with valid references

  await page.keyboard.press("Control+Tab"); // wraps round to the first tab
  await expect(current(page)).toHaveText("Roadmap");
  // An edit that is not saved yet is written when the tab is left.
  await typeAtEnd(page, "Unsaved when I left.");
  await page.keyboard.press("Control+Tab");
  await expect(current(page)).toHaveText("Old");
  await expect.poll(() => read("Archive/Roadmap.md")).toContain("Unsaved when I left.");
  // Everything saved before is as it was (the new line continues the highlight, as typing after marked text does).
  expect(await read("Archive/Roadmap.md")).toBe(`${formatted}\n==Unsaved when I left.==\n`);
  await page.keyboard.press("Control+Shift+Tab");
  await expect(current(page)).toHaveText("Roadmap");
  await expect(editorOf(page)).toContainText("Unsaved when I left.");
  await page.keyboard.press("ControlOrMeta+2");
  await expect(current(page)).toHaveText("Old");
  await page.keyboard.press("ControlOrMeta+1");
  await expect(current(page)).toHaveText("Roadmap");

  // 7. Change the theme from the palette (checked for accessibility while it lists commands), then with its shortcut.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(">");
  await expect(page.getByRole("option", { name: /Change theme: Dark/ })).toBeVisible();
  await expectAccessible(page, '[role="dialog"]');
  await page.keyboard.press("Escape");
  await command(page, "theme dark");
  await expect.poll(() => theme(page)).toBe("night");
  await page.keyboard.press("ControlOrMeta+Shift+L"); // dark → system
  await expect.poll(() => theme(page)).toBe("system");
  expect(await page.evaluate(() => localStorage.getItem("thoth.desktop.theme"))).toBe("system");

  // 8. Open Settings (a tab), see the theme chosen there, then look at the shortcuts list.
  await page.keyboard.press("ControlOrMeta+,");
  await expect(current(page)).toHaveText("Settings");
  expect(await tabNames(page)).toEqual(["Roadmap", "Settings", "Old"]);
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Theme" })).toHaveValue("system");
  await page.keyboard.press("ControlOrMeta+/");
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts.getByText("Highlight")).toBeVisible();
  await expectAccessible(page, '[role="dialog"]');
  await expect(shortcuts.locator('[data-shortcut="tab.close"]')).toContainText(/(Cmd|Ctrl)\+W/);
  await page.keyboard.press("Escape");
  await expect(shortcuts).toBeHidden();

  // 9. Restart: the same tabs come back for this Private Space, the same one is current, and so is the theme.
  await page.reload();
  expect(await theme(page)).toBe("system");
  await press(page, /choose or create a private space/i);
  await expect(page.getByRole("tab")).toHaveCount(3);
  expect(await tabNames(page)).toEqual(["Roadmap", "Settings", "Old"]);
  await expect(current(page)).toHaveText("Settings");
  await page.keyboard.press("ControlOrMeta+1");
  await expect(current(page)).toHaveText("Roadmap");
  await expect(editorOf(page)).toContainText("Write the plan.");

  // Cmd/Ctrl+W closes the current tab; the others stay.
  await page.keyboard.press("ControlOrMeta+w");
  await expect.poll(() => tabNames(page)).toEqual(["Settings", "Old"]);

  // Nothing but our own files is in the vault.
  expect((await readdir(vault)).sort()).toEqual([".thoth", "Archive"]);
  expect((await readdir(join(vault, "Archive"))).sort()).toEqual(["Old.md", "Roadmap.md"]);
});
