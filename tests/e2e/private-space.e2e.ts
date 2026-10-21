/**
 * Phase 1c acceptance (docs/architecture/implementation-plan.md): the real UI in
 * Chromium, on the real Rust host ports, through the e2e bridge.
 *
 * 1. Create a note offline → edit → edit externally → conflict prompt → keep both.
 * 2. Import wizard: Obsidian ZIP happy path, then cancel and resume.
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
