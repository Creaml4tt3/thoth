// @vitest-environment jsdom
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planImport } from "@thoth/importer-core";
import { ObsidianVaultImporter } from "@thoth/importer-obsidian/node";
import { openNodeVault } from "@thoth/local-store/node";
import { snapshotTree } from "../../../tests/helpers/fs.ts";
import { cleanup, openApp, screen, waitFor, within } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { createGate, nodeOpenImportSource } from "./support/import-source.ts";
import { seed } from "./support/fixtures.ts";
import { th } from "../src/strings/index.ts";

const FIXTURE = resolve(import.meta.dirname, "../../../tests/fixtures/obsidian-vault");
const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  root = await dirs.dir();
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

const stat = (group: HTMLElement, label: string): number => {
  const span = within(group).getByText(label, { selector: "span" });
  return Number(span.previousElementSibling!.textContent);
};

async function walkToPreview(app: Awaited<ReturnType<typeof openApp>>) {
  await app.user.click(await screen.findByRole("radio", { name: /obsidian/i }));
  await app.user.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByText(/never changes, moves or deletes|reads the vault and never changes it/i)).toBeTruthy();
  await app.user.click(screen.getByRole("button", { name: /i have it ready/i }));
  await app.user.click(screen.getByRole("button", { name: /choose folder/i }));
  await screen.findByText(/Preview of/);
}

describe("import wizard", () => {
  it("imports an Obsidian vault end to end: preview numbers, run, report, source untouched", async () => {
    // What the pipeline itself plans, in a scratch vault, is the truth the preview must show.
    const scratch = await dirs.dir();
    const { vault: scratchVault } = await openNodeVault(scratch);
    const planned = await ObsidianVaultImporter.open(FIXTURE);
    const expected = (await planImport({ vault: scratchVault, source: planned.source, provider: planned.provider })).preview;
    await planned.source.close();
    await scratchVault.close();
    const before = await snapshotTree(FIXTURE);

    const platform = createNodePlatform({ vault: root });
    platform.pickedSource = FIXTURE;
    const app = await openApp(root, { openImportSource: nodeOpenImportSource }, platform);

    // Empty Private Space: onboarding offers the import.
    await app.user.click(await screen.findByText(/import from notion or obsidian/i, { selector: "button" }));
    await walkToPreview(app);

    const contents = screen.getByRole("group", { name: "Import contents" });
    expect(stat(contents, "pages")).toBe(expected.pages);
    expect(stat(contents, "attachments")).toBe(expected.attachments);
    expect(stat(contents, "folders")).toBe(expected.folders);
    expect(stat(contents, "databases / CSV")).toBe(expected.databases);
    expect(stat(contents, "skipped")).toBe(expected.skipped);
    expect(expected.pages).toBe(11);
    const links = screen.getByRole("group", { name: "Links" });
    expect(stat(links, "resolved")).toBe(expected.links.resolved);
    expect(stat(links, "unresolved")).toBe(expected.links.unresolved);
    expect(stat(links, "ambiguous")).toBe(expected.links.ambiguous);
    // Warnings are grouped by code with a human explanation.
    expect(screen.getByText(/Unreadable frontmatter/)).toBeTruthy();
    expect(screen.getByText(/Your source is only read/)).toBeTruthy();
    // Nothing has been written to the Private Space yet.
    expect((await readdir(root)).filter((n) => !n.startsWith("."))).toEqual([]);

    await app.user.click(screen.getByRole("button", { name: "Continue" }));
    // Destination: Private Space, default Imports/<name>, Workspace disabled.
    expect((within(screen.getByRole("region", { name: "Import" })).getByRole("textbox") as HTMLInputElement).value).toBe("Imports/obsidian-vault");
    expect((screen.getByRole("radio", { name: /workspace/i }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Coming later")).toBeTruthy();
    await app.user.click(screen.getByRole("button", { name: "Continue" }));
    // Options.
    expect(screen.getByRole("radio", { name: /keep both/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /skip it/i })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /identity frontmatter/i })).toBeTruthy();
    await app.user.click(screen.getByRole("button", { name: /start import/i }));

    const report = await screen.findByTestId("import-report", {}, { timeout: 15000 });
    expect(within(report).getByText("Import complete")).toBeTruthy();
    const results = within(report).getByRole("group", { name: "Import results" });
    expect(stat(results, "pages imported")).toBe(11);
    expect(stat(results, "attachments")).toBe(2);
    expect(stat(results, "failed")).toBe(0);
    expect(within(report).getByText(/source was only read/i)).toBeTruthy();

    // Open the imported folder: the tree shows the pages and the first one is open.
    await app.user.click(within(report).getByRole("button", { name: /open imported folder/i }));
    const tree = await screen.findByRole("tree");
    await waitFor(() => expect(within(tree).getByRole("treeitem", { name: "Imports" })).toBeTruthy());
    expect(await app.read("Imports/obsidian-vault/Welcome.md")).toContain("thoth_id");
    expect(await snapshotTree(FIXTURE)).toEqual(before);
  });

  it("cancels mid-run, lists the job as interrupted, and Resume completes it without duplicates", async () => {
    await seed(root, { "Existing.md": "# Existing\n" });
    const gate = createGate();
    gate.arm();
    const platform = createNodePlatform({ vault: root });
    platform.pickedSource = FIXTURE;
    const app = await openApp(root, { openImportSource: gate.open }, platform);

    await app.user.click(await screen.findByRole("button", { name: "Settings" }));
    await app.user.click(await screen.findByText(/import from notion or obsidian/i, { selector: "button" }));
    await walkToPreview(app);
    await app.user.click(screen.getByRole("button", { name: "Continue" }));
    await app.user.click(screen.getByRole("button", { name: "Continue" }));
    await app.user.click(screen.getByRole("button", { name: /start import/i }));

    await gate.reached;
    await app.user.click(screen.getByRole("button", { name: /cancel import/i }));
    gate.release();

    const report = await screen.findByTestId("import-report", {}, { timeout: 15000 });
    expect(within(report).getByText("Import cancelled")).toBeTruthy();
    await app.user.click(within(report).getByRole("button", { name: "Close" }));

    // The job is listed as interrupted, with a Resume action.
    await app.user.click(await screen.findByText(/import from notion or obsidian/i, { selector: "button" }));
    expect(await screen.findByText("Unfinished imports")).toBeTruthy();
    expect(screen.getByText("Cancelled")).toBeTruthy();
    await app.user.click(screen.getByRole("button", { name: /resume import of/i }));

    const done = await screen.findByTestId("import-report", {}, { timeout: 15000 });
    expect(within(done).getByText("Import complete")).toBeTruthy();
    const results = within(done).getByRole("group", { name: "Import results" });
    expect(stat(results, "pages imported")).toBe(11);
    expect(stat(results, "attachments")).toBe(2);

    // No duplicate pages: exactly the fixture's 11 plus the page that was already there.
    const { vault } = await openNodeVault(root);
    const paths = (await vault.listPages()).map((p) => p.path);
    await vault.close();
    expect(paths.filter((p) => p.startsWith("Imports/"))).toHaveLength(11);
    expect(paths.some((p) => / 2\.md$/.test(p))).toBe(false);
    expect(await readdir(join(root, ".thoth/operations/imports"))).toEqual([]);
    expect(gate.opened()).toBe(2);
  });

  it("runs in Thai from the first step to the report", async () => {
    localStorage.setItem("thoth.desktop.lang", "th");
    try {
      const w = th.wizard;
      const platform = createNodePlatform({ vault: root });
      platform.pickedSource = FIXTURE;
      const app = await openApp(root, { openImportSource: nodeOpenImportSource }, platform);
      await app.user.click(await screen.findByRole("button", { name: th.onboarding.importFrom }));
      expect(screen.getByRole("heading", { name: w.titles.source })).toBeTruthy();
      expect(screen.getByText(w.stepOf(1, 8))).toBeTruthy();
      await app.user.click(screen.getByRole("radio", { name: /obsidian/i }));
      await app.user.click(screen.getByRole("button", { name: w.continue }));
      expect(screen.getByText(w.how.obsidian.title)).toBeTruthy();
      await app.user.click(screen.getByRole("button", { name: w.ready }));
      await app.user.click(screen.getByRole("button", { name: w.pick.folder }));
      await screen.findByText(w.preview.of.trim(), { exact: false });
      expect(screen.getByRole("group", { name: w.preview.contents })).toBeTruthy();
      // A known warning is explained in Thai.
      expect(screen.getByText(w.warnings.malformed_frontmatter!.title)).toBeTruthy();
      await app.user.click(screen.getByRole("button", { name: w.continue }));
      expect(screen.getByText(w.destination.later)).toBeTruthy();
      await app.user.click(screen.getByRole("button", { name: w.continue }));
      await app.user.click(screen.getByRole("button", { name: w.options.start }));
      const report = await screen.findByTestId("import-report", {}, { timeout: 15000 });
      expect(within(report).getByText(w.report.headline.completed)).toBeTruthy();
      expect(within(report).getByRole("group", { name: w.report.results })).toBeTruthy();
      expect(within(report).getByText(w.report.safe)).toBeTruthy();
    } finally {
      localStorage.removeItem("thoth.desktop.lang");
    }
  });
});
