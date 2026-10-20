import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFrontmatter } from "@thoth/content";
import { planImport, runImport } from "@thoth/importer-core";
import { parseNotionName, stripNotionIds } from "@thoth/importer-notion";
import { NotionMarkdownCsvImporter, NotionZipImporter } from "@thoth/importer-notion/node";
import type { Vault } from "@thoth/local-store";
import { openNodeVault } from "@thoth/local-store/node";
import { snapshotTree } from "../helpers/fs.ts";
import { buildZip, dirEntries, writeZip } from "../helpers/zip.ts";

const FIXTURE = resolve(import.meta.dirname, "../fixtures/notion-export");
const H = "Notion/Thoth Handbook";

let work: string;
let vaultRoot: string;
let vault: Vault;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "thoth-notion-"));
  vaultRoot = join(work, "vault");
  ({ vault } = await openNodeVault(vaultRoot));
});

afterEach(async () => {
  await vault.close();
  await rm(work, { recursive: true, force: true });
});

const read = (p: string) => readFile(join(vaultRoot, p), "utf8");

describe("Notion name handling", () => {
  it("parses and strips 32-hex ID suffixes", () => {
    expect(parseNotionName("Meeting Notes 2b3c4d5e6f7a48b9c0d1e2f3a4b5c6d7.md")).toEqual({ title: "Meeting Notes", id: "2b3c4d5e6f7a48b9c0d1e2f3a4b5c6d7", allVariant: false });
    expect(parseNotionName("Tasks 8b9c0d1e2f3a4e15c6d7e8f901122334_all.csv").allVariant).toBe(true);
    expect(parseNotionName("diagram.png")).toEqual({ title: "diagram", allVariant: false });
    expect(stripNotionIds("A 1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6/B 2b3c4d5e6f7a48b9c0d1e2f3a4b5c6d7.md")).toBe("A/B.md");
  });
});

describe("NotionZipImporter", () => {
  async function importZip(zipPath: string) {
    const { source, provider } = await NotionZipImporter.open(zipPath);
    const plan = await planImport({ vault, source, provider, options: { destinationRoot: "Notion" } });
    const report = await runImport(vault, source, plan.manifest);
    await source.close();
    return { ...plan, report };
  }

  it("previews hierarchy, duplicates, databases, and lossy constructs", async () => {
    const zip = await writeZip(join(work, "export.zip"), await dirEntries(FIXTURE));
    const { source, provider } = await NotionZipImporter.open(zip);
    const { preview } = await planImport({ vault, source, provider, options: { destinationRoot: "Notion" } });
    await source.close();
    expect(preview.pages).toBe(9);
    expect(preview.databases).toBe(2);
    expect(preview.attachments).toBe(3);
    expect(preview.duplicateTitles.map((d) => [d.title, d.sourcePaths.length])).toEqual([["Meeting Notes", 2]]);
    expect(preview.warningCounts["database_semantics_lost"]).toBe(2);
    expect(preview.warningCounts["html_block"]).toBeGreaterThanOrEqual(2);
    expect(preview.links.rewritten).toBeGreaterThan(0);
  });

  it("imports pages with clean names, rewritten links, attachments, and preserved CSV", async () => {
    const sourceBefore = await snapshotTree(FIXTURE);
    const zip = await writeZip(join(work, "export.zip"), await dirEntries(FIXTURE));
    const zipBefore = await readFile(zip);
    const { report } = await importZip(zip);
    expect(report.state).toBe("completed");
    expect(report.failed).toEqual([]);
    expect(report.imported).toEqual({ pages: 9, attachments: 3, databases: 2 });
    expect(await snapshotTree(FIXTURE)).toEqual(sourceBefore);
    expect(await readFile(zip)).toEqual(zipBefore);

    // Hierarchy with ID suffixes removed; same-title pages kept separate.
    const paths = (await vault.listPages()).map((p) => p.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        `${H}.md`,
        `${H}/Meeting Notes.md`,
        `${H}/Engineering/Meeting Notes.md`,
        `${H}/Engineering/Deep Dive.md`,
        `${H}/Tasks/Write importer.md`,
        `${H}/บันทึกการประชุม 🚀.md`,
      ]),
    );

    // Source IDs kept as provenance.
    const atlas = await read(`${H}/Project Atlas.md`);
    expect(parseFrontmatter(atlas).data["thoth_source"]).toMatchObject({ system: "notion", sourceId: "6f708192a3b44cf3a4b5c6d7e8f90112" });
    // HTML callout/toggle kept verbatim.
    expect(atlas).toContain("<aside>");
    expect(atlas).toContain("<summary>Toggle: implementation notes</summary>");
    // Links rewritten to new relative paths; attachment links resolve.
    expect(atlas).toContain("[Write importer](Tasks/Write%20importer.md)");
    expect(atlas).toContain("![diagram.png](Project%20Atlas/diagram.png)");
    expect((await vault.backlinks(`${H}/Project Atlas/diagram.png`)).map((b) => b.sourcePath)).toEqual([`${H}/Project Atlas.md`]);
    expect((await vault.backlinks(`${H}/Project Atlas/ไฟล์แนบ.txt`)).length).toBe(1);
    expect((await vault.backlinks(`${H}/Engineering/Deep Dive.md`)).map((b) => b.sourcePath)).toEqual([`${H}/Engineering.md`]);
    expect(await read(`${H}/Engineering.md`)).toContain("(Engineering/Deep%20Dive.md#architecture)");
    expect((await vault.backlinks(`${H}/Project Atlas.md`)).map((b) => b.sourcePath)).toEqual(
      expect.arrayContaining([`${H}.md`, `${H}/Tasks/Write importer.md`]),
    );

    // Database CSVs byte-identical, all columns preserved.
    const csvName = "Tasks 8b9c0d1e2f3a4e15c6d7e8f901122334_all.csv";
    expect(await readFile(join(vaultRoot, `${H}/Tasks_all.csv`))).toEqual(await readFile(join(FIXTURE, "Thoth Handbook 1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6", csvName)));

    // Thai/emoji page names survive and are searchable.
    expect((await vault.search("ประชุม")).map((h) => h.path)).toContain(`${H}/บันทึกการประชุม 🚀.md`);

    // Every unresolved link is reported with a location.
    for (const w of report.warnings.filter((w) => w.code === "unresolved_link")) expect(w.sourcePath && w.line).toBeTruthy();
  });

  it("opens multi-part exports made of nested ZIPs", async () => {
    const entries = await dirEntries(FIXTURE);
    const half = Math.ceil(entries.length / 2);
    const outer = await writeZip(join(work, "multi.zip"), [
      { name: "Export-0f0e0d0c-0b0a-4908-8706-050403020100-Part-1.zip", data: buildZip(entries.slice(0, half)) },
      { name: "Export-0f0e0d0c-0b0a-4908-8706-050403020100-Part-2.zip", data: buildZip(entries.slice(half)) },
    ]);
    const { report } = await importZip(outer);
    expect(report.imported).toEqual({ pages: 9, attachments: 3, databases: 2 });
  });

  it("strips an Export-<uuid>/ wrapper folder", async () => {
    const zip = await writeZip(join(work, "wrapped.zip"), await dirEntries(FIXTURE, "Export-0f0e0d0c-0b0a-4908-8706-050403020100/"));
    const { manifest } = await importZip(zip);
    expect(manifest.sourceRootPrefix).toBe("Export-0f0e0d0c-0b0a-4908-8706-050403020100/");
    expect(await vault.pageByPath(`${H}.md`)).toBeDefined();
  });
});

describe("NotionMarkdownCsvImporter", () => {
  it("imports an extracted export folder identically to the ZIP", async () => {
    const { source, provider } = await NotionMarkdownCsvImporter.open(FIXTURE);
    const { manifest } = await planImport({ vault, source, provider, options: { destinationRoot: "Notion" } });
    const report = await runImport(vault, source, manifest);
    await source.close();
    expect(report.imported).toEqual({ pages: 9, attachments: 3, databases: 2 });
    expect(manifest.sourceKind).toBe("notion-folder");
  });
});
