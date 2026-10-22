/**
 * Phase 1c acceptance (docs/architecture/implementation-plan.md): the real UI in
 * Chromium, on the real Rust host ports, through the e2e bridge.
 *
 * 1. Create a note offline → edit → edit externally → conflict prompt → keep both.
 * 2. Import wizard: Obsidian ZIP happy path, then cancel and resume.
 * 3. Plain mode: real keystrokes, mode switching, exact bytes.
 * 4. `[[` autocomplete in both modes.
 * 5. Blocks mode: `/` menu, toggle and to-do, drag with the handle, fold, exact bytes on disk.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "../ports/harness.ts";
import { writeZip } from "../helpers/zip.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { buildAll } from "./setup.ts";

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
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, pickSource: join(scratch, "source"), dataDir: join(scratch, "data") } });
  // No network: only the bridge origin is reachable.
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
});

test.afterEach(async ({ page }) => {
  await page.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

async function editor(page: Page) {
  const box = page.getByRole("textbox", { name: /page content/i });
  await expect(box).toBeVisible();
  return box;
}

test("create a note offline, edit it, edit it externally, resolve the conflict", async ({ page }) => {
  await page.getByRole("button", { name: /start writing/i }).click();
  await page.getByRole("button", { name: "New page" }).click();
  const dialog = page.getByRole("dialog", { name: "New page" });
  await dialog.getByRole("textbox").fill("Journal/Today");
  await dialog.getByRole("button", { name: "Create" }).click();

  const box = await editor(page);
  await box.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Written in Thoth.");
  await page.keyboard.press("ControlOrMeta+s");
  const file = join(vault, "Journal/Today.md");
  await expect.poll(() => readFile(file, "utf8")).toContain("Written in Thoth.");
  const saved = await readFile(file, "utf8");
  expect(saved).toMatch(/^---\nthoth_id: [0-9a-f-]{36}\n---\n/);

  // Unsaved edit in the app, then another program rewrites the file; the Rust watcher notices.
  await page.keyboard.type(" Unsaved line.");
  const external = saved.replace("Written in Thoth.", "Rewritten by another editor.");
  await writeFile(file, external);
  const later = new Date(Date.now() + 5000);
  await utimes(file, later, later);

  const conflict = page.getByRole("dialog", { name: /changed on disk/i });
  await expect(conflict).toBeVisible({ timeout: 15_000 });
  await expect(conflict.getByText("Rewritten by another editor.")).toBeVisible();
  expect(await readFile(file, "utf8")).toBe(external); // never silently overwritten
  await conflict.getByRole("button", { name: /keep both/i }).click();
  await expect(conflict).toBeHidden();

  expect(await readFile(file, "utf8")).toBe(external);
  const copies = (await readdir(join(vault, "Journal"))).filter((n) => n.includes("(conflict "));
  expect(copies).toHaveLength(1);
  expect(await readFile(join(vault, "Journal", copies[0]!), "utf8")).toContain("Written in Thoth. Unsaved line.");
  await expect(box).toContainText("Rewritten by another editor.");
});

test("import an Obsidian ZIP through the wizard, cancel a second import and resume it", async ({ page }) => {
  // The fixture vault, zipped with a wrapper folder like a real download.
  const fixture = join(REPO, "tests/fixtures/obsidian-vault");
  const entries: { name: string; data: Uint8Array }[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (d.isDirectory()) await walk(join(dir, d.name), `${rel}${d.name}/`);
      else entries.push({ name: `My Vault/${rel}${d.name}`, data: await readFile(join(dir, d.name)) });
    }
  };
  await walk(fixture, "");
  // Enough padding attachments that the run takes long enough to cancel.
  for (let i = 0; i < 400; i++) entries.push({ name: `My Vault/padding/blob-${i}.bin`, data: new Uint8Array(64 * 1024).fill(i % 251) });
  await writeZip(join(scratch, "source"), entries);
  const sourceBefore = await readFile(join(scratch, "source"));

  const runWizardToStart = async (destination: string) => {
    await page.getByRole("radio", { name: /obsidian/i }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /i have it ready/i }).click();
    await page.getByRole("button", { name: /choose zip file/i }).click();
    await expect(page.getByText(/Preview of/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Continue" }).click();
    const dest = page.getByRole("region", { name: "Import" }).getByRole("textbox");
    await dest.fill(destination);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /start import/i }).click();
  };

  await page.getByRole("button", { name: /import from notion or obsidian/i }).click();
  await runWizardToStart("Imports/First");
  const report = page.getByTestId("import-report");
  await expect(report.getByText("Import complete")).toBeVisible({ timeout: 60_000 });
  expect((await readdir(join(vault, "Imports/First"))).length).toBeGreaterThan(0);
  await report.getByRole("button", { name: "Close" }).click();

  // Second import: cancel mid-run, then resume from "Unfinished imports".
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /import from notion or obsidian/i }).click();
  await runWizardToStart("Imports/Second");
  await page.getByRole("button", { name: /cancel import/i }).click({ timeout: 30_000 });
  await expect(report.getByText("Import cancelled")).toBeVisible({ timeout: 60_000 });
  await report.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /import from notion or obsidian/i }).click();
  await expect(page.getByText("Unfinished imports")).toBeVisible();
  await page.getByRole("button", { name: /resume import of/i }).first().click();
  await expect(report.getByText("Import complete")).toBeVisible({ timeout: 60_000 });

  // Resumed import has the same files as the first one, with no duplicates; the source is untouched.
  const list = async (root: string): Promise<string[]> => {
    const out: string[] = [];
    const go = async (dir: string, rel: string) => {
      for (const d of await readdir(dir, { withFileTypes: true })) d.isDirectory() ? await go(join(dir, d.name), `${rel}${d.name}/`) : out.push(rel + d.name);
    };
    await go(root, "");
    return out.sort();
  };
  expect(await list(join(vault, "Imports/Second"))).toEqual(await list(join(vault, "Imports/First")));
  expect(Buffer.compare(await readFile(join(scratch, "source")), sourceBefore)).toBe(0);
});

test("Plain mode: type real keystrokes, switch modes, save exact bytes", async ({ page }) => {
  // CRLF, a BOM and odd spacing: Plain mode must change only what is typed.
  const source = "﻿# Plain\r\n\r\n* star   bullet\r\n\r\nSee [[Plain]] here.\r\n";
  await page.getByRole("button", { name: /start writing/i }).click();
  await writeFile(join(vault, "Plain.md"), source); // the Rust watcher picks it up
  await page.getByRole("treeitem", { name: "Plain" }).click({ timeout: 15_000 });

  const modes = page.getByRole("group", { name: "Editor mode" });
  await modes.getByRole("button", { name: "Plain" }).click();
  const box = await editor(page);
  await expect(box).toHaveClass(/cm-content/);
  // The line with the cursor shows its exact source; other lines show the live preview.
  await expect(box.getByText("# Plain")).toBeVisible();
  await box.getByText("star   bullet").click();
  await expect(box.getByText("# Plain")).toHaveCount(0);
  await expect(box.locator(".md-line-h1")).toHaveText("Plain");
  await expect(box.locator(".wikilink", { hasText: "Plain" })).toBeVisible();

  await page.keyboard.press("End");
  await page.keyboard.type(" typed");
  await page.keyboard.press("Enter");
  await page.keyboard.type("new item");
  // Switch back to Blocks with the edit unsaved: nothing is written, the edit is kept.
  await page.keyboard.press("ControlOrMeta+Shift+E");
  await expect(modes.getByRole("button", { name: "Blocks" })).toHaveAttribute("aria-pressed", "true");
  expect(await readFile(join(vault, "Plain.md"), "utf8")).toBe(source);
  await page.keyboard.press("ControlOrMeta+Shift+E");
  await expect(modes.getByRole("button", { name: "Plain" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ControlOrMeta+s");

  // Enter continued the list with the file's own CRLF; nothing else changed.
  const expected = source.replace("* star   bullet\r\n", "* star   bullet typed\r\n* new item\r\n");
  await expect.poll(() => readFile(join(vault, "Plain.md"), "utf8")).toBe(expected);
});

test("[[ autocomplete in both modes, with real keystrokes", async ({ page }) => {
  await page.getByRole("button", { name: /start writing/i }).click();
  await mkdir(join(vault, "Projects"));
  await writeFile(join(vault, "Projects/Roadmap.md"), "# Roadmap\n");
  await writeFile(join(vault, "Linking.md"), "# Linking\n\nBlocks:\n\nPlain:\n");
  await page.getByRole("treeitem", { name: "Linking" }).click({ timeout: 15_000 });
  const box = await editor(page);
  const menu = page.getByRole("listbox", { name: "Link to page" });

  // Blocks: type, pick with Enter.
  await box.getByText("Blocks:").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" [[road");
  await expect(menu.getByRole("option", { name: /Roadmap/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(box.locator('.wikilink[data-target="Projects/Roadmap.md"]')).toBeVisible();

  // Plain: same page, same menu, plain text result.
  await page.getByRole("group", { name: "Editor mode" }).getByRole("button", { name: "Plain" }).click();
  await box.getByText("Plain:").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" [[road");
  await expect(menu.getByRole("option", { name: /Roadmap/ })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(menu).toBeHidden();
  await page.keyboard.press("ControlOrMeta+s");

  await expect.poll(() => readFile(join(vault, "Linking.md"), "utf8")).toBe("# Linking\n\nBlocks: [[Roadmap]]\n\nPlain: [[Roadmap]]\n");
});

test("Blocks mode: / menu, drag a block by its handle, fold a toggle, exact bytes on disk", async ({ page }) => {
  // Odd formatting that Blocks must not touch: double spaces, a `*` bullet, trailing spaces.
  const source = "# Blocks\n\nalpha  para\n\n* star   bullet\n\nomega para   \n";
  await page.getByRole("button", { name: /start writing/i }).click();
  await writeFile(join(vault, "Blocks.md"), source); // the Rust watcher picks it up
  await page.getByRole("treeitem", { name: "Blocks" }).click({ timeout: 15_000 });
  const box = await editor(page);
  await expect(box).toContainText("omega para");
  const menu = page.getByRole("listbox", { name: "Insert block" });
  // ProseMirror reads a click's selection a tick later: wait until the caret is in the block, as a person would see it.
  const clickBlock = async (text: string) => {
    await box.getByText(text).click();
    await expect.poll(() => box.evaluate((el) => (el as unknown as { editor: { state: { selection: { $from: { parent: { textContent: string } } } } } }).editor.state.selection.$from.parent.textContent)).toBe(text);
  };

  // 1. A to-do after the last paragraph and a toggle after the first, both from the `/` menu.
  await clickBlock("omega para");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/todo");
  await expect(menu.getByRole("option", { name: /To-do list/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await page.keyboard.type("buy milk");

  await clickBlock("alpha  para");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/tog");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await page.keyboard.type("Fold me");
  await page.keyboard.press("Enter"); // title to body
  await page.keyboard.type("hidden line");
  const toggle = box.locator('.callout[data-callout="toggle"]');
  await expect(toggle).toHaveAttribute("data-collapsed", "false");
  await expect(toggle.locator(".callout-title")).toHaveText("Fold me");

  // 2. Drag "omega para" above the toggle by its gutter handle (real mouse, real drag events).
  const omega = box.locator("p", { hasText: "omega para" });
  await omega.hover();
  const handle = page.locator(".block-handle");
  await expect(handle).toBeVisible();
  const from = (await handle.boundingBox())!;
  const target = (await toggle.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y - 10, { steps: 4 });
  await page.mouse.move(target.x + 60, target.y + 2, { steps: 10 });
  await expect(page.locator(".block-drop-indicator")).toBeVisible();
  await page.mouse.up();
  await expect(page.locator(".block-drop-indicator")).toBeHidden();
  await expect(box.locator("p, .callout").filter({ hasText: /omega para|Fold me/ }).first()).toContainText("omega para");

  // 3. Collapse the toggle: view only, nothing becomes unsaved by it. (The page is already dirty from typing; save first.)
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(join(vault, "Blocks.md"), "utf8")).not.toBe(source);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const saved = await readFile(join(vault, "Blocks.md"), "utf8");
  await toggle.getByRole("button", { name: /collapse toggle/i }).click();
  await expect(toggle).toHaveAttribute("data-collapsed", "true");
  await expect(toggle.getByText("hidden line")).toBeHidden();
  await page.waitForTimeout(500);
  expect(await readFile(join(vault, "Blocks.md"), "utf8")).toBe(saved);
  await expect(page.getByRole("status").filter({ hasText: /Unsaved/ })).toHaveCount(0);

  // 4. Save and check the file: new blocks canonical, every untouched line byte-identical.
  await page.keyboard.press("ControlOrMeta+s");
  const expected = "# Blocks\n\nalpha  para\n\nomega para   \n\n> [!toggle]+ Fold me\n> hidden line\n\n* star   bullet\n\n- [ ] buy milk\n";
  await expect.poll(() => readFile(join(vault, "Blocks.md"), "utf8")).toBe(expected);
});
