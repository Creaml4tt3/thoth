import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFrontmatter } from "@thoth/content";
import { isStableId } from "@thoth/domain";
import { planImport, runImport } from "@thoth/importer-core";
import { ObsidianVaultImporter, ObsidianZipImporter } from "@thoth/importer-obsidian/node";
import type { Vault } from "@thoth/local-store";
import { openNodeVault } from "@thoth/local-store/node";
import { snapshotTree } from "../helpers/fs.ts";
import { dirEntries, writeZip } from "../helpers/zip.ts";

const FIXTURE = resolve(import.meta.dirname, "../fixtures/obsidian-vault");

let work: string;
let vaultRoot: string;
let vault: Vault;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "thoth-obsidian-"));
  vaultRoot = join(work, "vault");
  ({ vault } = await openNodeVault(vaultRoot));
});

afterEach(async () => {
  await vault.close();
  await rm(work, { recursive: true, force: true });
});

const read = (p: string) => readFile(join(vaultRoot, p), "utf8");

describe("ObsidianVaultImporter", () => {
  it("previews without writing anything to the vault", async () => {
    const before = await snapshotTree(vaultRoot);
    const { source, provider } = await ObsidianVaultImporter.open(FIXTURE);
    const { preview } = await planImport({ vault, source, provider, options: { destinationRoot: "Imported" } });
    await source.close();
    expect(preview.pages).toBe(11);
    expect(preview.attachments).toBe(2);
    expect(preview.skipped).toBe(7); // .obsidian/ config and plugin
    expect(preview.duplicateTitles.map((d) => d.title)).toEqual(["Alpha"]);
    expect(preview.links.ambiguous).toBe(1);
    expect(preview.links.unresolved).toBe(1);
    expect(preview.warningCounts["plugin_syntax"]).toBeGreaterThanOrEqual(2);
    expect(preview.warningCounts["malformed_frontmatter"]).toBe(1);
    const after = await snapshotTree(vaultRoot);
    expect(Object.keys(after).filter((k) => !k.startsWith(".thoth"))).toEqual(Object.keys(before).filter((k) => !k.startsWith(".thoth")));
  });

  it("imports the vault, preserving hierarchy, frontmatter, links, and attachments without mutating the source", async () => {
    const sourceBefore = await snapshotTree(FIXTURE);
    const { source, provider } = await ObsidianVaultImporter.open(FIXTURE);
    const { manifest } = await planImport({ vault, source, provider, options: { destinationRoot: "Imported" } });
    const report = await runImport(vault, source, manifest);
    await source.close();

    expect(report.state).toBe("completed");
    expect(report.failed).toEqual([]);
    expect(report.imported).toEqual({ pages: 11, attachments: 2, databases: 0 });
    expect(await snapshotTree(FIXTURE)).toEqual(sourceBefore);

    // Unknown frontmatter and nested maps survive; identity and provenance are added.
    const home = await read("Imported/Home.md");
    const fm = parseFrontmatter(home).data;
    expect(fm["cssclasses"]).toEqual(["wide-page"]);
    expect(fm["custom"]).toEqual({ owner: "Somchai", review: { status: "draft", due: "2026-11-01" } });
    expect(isStableId(fm["thoth_id"] as string)).toBe(true);
    expect(fm["thoth_source"]).toMatchObject({ system: "obsidian", sourcePath: "Home.md", importJobId: manifest.jobId });
    // Body is byte-identical (no conversion was needed).
    const original = await readFile(join(FIXTURE, "Home.md"), "utf8");
    expect(home.endsWith(original.slice(original.indexOf("# Home")))).toBe(true);

    // Never executed or imported: plugin code and app config.
    await expect(read("Imported/.obsidian/plugins/evil-plugin/main.js")).rejects.toThrow();

    // Attachments are byte-identical.
    expect(await readFile(join(vaultRoot, "Imported/Attachments/diagram.png"))).toEqual(await readFile(join(FIXTURE, "Attachments/diagram.png")));

    // Malformed frontmatter is imported verbatim (no identity injected).
    expect(await read("Imported/Broken Frontmatter.md")).toBe(await readFile(join(FIXTURE, "Broken Frontmatter.md"), "utf8"));

    // Links resolve in the destination vault index.
    const backlinks = (await vault.backlinks("Imported/Home.md")).map((b) => b.sourcePath);
    expect(backlinks).toEqual(expect.arrayContaining(["Imported/Projects/Beta.md", "Imported/บันทึก/การประชุม 🚀.md"]));
    expect((await vault.backlinks("Imported/Attachments/diagram.png")).length).toBe(2);
    expect((await vault.backlinks("Imported/Welcome.md")).map((b) => b.sourcePath)).toContain("Imported/Meeting Notes.md");
    const unresolved = (await vault.unresolvedLinks()).map((u) => `${u.sourcePath} -> ${u.target} (${u.resolution})`);
    expect(unresolved).toEqual(["Imported/Home.md -> Does Not Exist (unresolved)", "Imported/Meeting Notes.md -> Alpha (ambiguous)"]);

    // Thai + emoji and NFC names are preserved and searchable.
    expect((await vault.search("การประชุม")).map((h) => h.path)).toContain("Imported/บันทึก/การประชุม 🚀.md");
    expect(await vault.pageByPath("Imported/Café.md")).toBeDefined();

    // Every warning is inspectable in the durable report.
    expect(report.warnings.every((w) => w.code && w.message)).toBe(true);
  });

  it("rewrites wikilinks only when the destination would resolve them differently", async () => {
    // An existing note with the same basename makes [[Home]] ambiguous after import.
    await vault.createPage("Home.md", "# Existing home\n");
    const { source, provider } = await ObsidianVaultImporter.open(FIXTURE);
    const { manifest } = await planImport({ vault, source, provider, options: { destinationRoot: "Imported" } });
    await runImport(vault, source, manifest);
    await source.close();
    const beta = await read("Imported/Projects/Beta.md");
    expect(beta).toContain("Back to [[Imported/Home]].");
    expect((await vault.backlinks("Imported/Home.md")).map((b) => b.sourcePath)).toContain("Imported/Projects/Beta.md");
    expect((await vault.backlinks("Home.md")).length).toBe(0);
  });

  it("is idempotent: a re-import of the same source is detected and does not overwrite", async () => {
    const first = await ObsidianVaultImporter.open(FIXTURE);
    const plan1 = await planImport({ vault, source: first.source, provider: first.provider, options: { destinationRoot: "Imported" } });
    await runImport(vault, first.source, plan1.manifest);
    await first.source.close();

    const second = await ObsidianVaultImporter.open(FIXTURE);
    const plan2 = await planImport({ vault, source: second.source, provider: second.provider, options: { destinationRoot: "Imported", conflictPolicy: "skip" } });
    expect(plan2.preview.previousImports.map((p) => p.jobId)).toEqual([plan1.manifest.jobId]);
    expect(plan2.preview.pages).toBe(0);
    const report = await runImport(vault, second.source, plan2.manifest);
    await second.source.close();
    expect(report.imported.pages).toBe(0);
    expect((await vault.listPages()).length).toBe(11);
  });

  it("renames on collision by default and never merges same-name files", async () => {
    await vault.createPage("Imported/Welcome.md", "# Mine\n");
    const { source, provider } = await ObsidianVaultImporter.open(FIXTURE);
    const { manifest, preview } = await planImport({ vault, source, provider, options: { destinationRoot: "Imported" } });
    expect(preview.collisions).toEqual([{ sourcePath: "Welcome.md", destPath: "Imported/Welcome 2.md", action: "renamed" }]);
    await runImport(vault, source, manifest);
    await source.close();
    expect(await read("Imported/Welcome.md")).toContain("# Mine");
    expect(await read("Imported/Welcome 2.md")).toContain("aliases: [Start]");
    // [[Start]] still resolves to the imported note via its alias.
    expect((await vault.backlinks("Imported/Welcome 2.md")).map((b) => b.sourcePath)).toContain("Imported/Home.md");
  });

  it("works with no network access", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("network used");
    };
    try {
      const { source, provider } = await ObsidianVaultImporter.open(FIXTURE);
      const { manifest } = await planImport({ vault, source, provider });
      expect((await runImport(vault, source, manifest)).state).toBe("completed");
      await source.close();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("ObsidianZipImporter", () => {
  it("imports a zipped vault folder, stripping the wrapper folder", async () => {
    const zip = await writeZip(join(work, "MyVault.zip"), await dirEntries(FIXTURE, "MyVault/"));
    const { source, provider } = await ObsidianZipImporter.open(zip);
    const { manifest } = await planImport({ vault, source, provider });
    expect(manifest.options.destinationRoot).toBe("Imports/MyVault");
    const report = await runImport(vault, source, manifest);
    await source.close();
    expect(report.imported.pages).toBe(11);
    expect(await read("Imports/MyVault/Projects/Beta.md")).toContain("Summary paragraph ^summary");
    expect((await vault.backlinks("Imports/MyVault/Projects/Beta.md")).map((b) => b.sourcePath)).toEqual(
      expect.arrayContaining(["Imports/MyVault/Home.md", "Imports/MyVault/Projects/Alpha.md"]),
    );
  });

  it("imports case-colliding names on a case-insensitive filesystem without data loss", async () => {
    const zip = await writeZip(join(work, "case.zip"), [
      { name: "notes/Readme.md", data: "# lower\n" },
      { name: "notes/README.md", data: "# upper\n" },
      { name: "index.md", data: "[[notes/Readme]] and [[notes/README]]\n" },
    ]);
    const { source, provider } = await ObsidianZipImporter.open(zip);
    const { manifest, preview } = await planImport({ vault, source, provider, options: { destinationRoot: "" } });
    expect(preview.collisions).toHaveLength(1);
    const report = await runImport(vault, source, manifest);
    await source.close();
    expect(report.imported.pages).toBe(3);
    const texts = [await read("notes/README.md"), await read("notes/Readme 2.md")].map((t) => t.slice(t.lastIndexOf("---\n") + 4));
    expect(texts.sort()).toEqual(["# lower\n", "# upper\n"]);
    // Both links still point at their own file after the rename.
    const index = await read("index.md");
    expect(index).toMatch(/\[\[notes\/(Readme 2|README)\]\] and \[\[notes\/(Readme 2|README)\]\]/);
    expect(new Set(index.match(/\[\[[^\]]+\]\]/g)).size).toBe(2);
  });
});

describe("source safety", () => {
  it("does not follow symlinks out of a vault folder", async () => {
    const copy = join(work, "vault-copy");
    await cp(FIXTURE, copy, { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await writeFile(join(work, "outside.md"), "secret");
    await symlink(join(work, "outside.md"), join(copy, "link.md"));
    const { source } = await ObsidianVaultImporter.open(copy);
    expect(source.entries.some((e) => e.path === "link.md")).toBe(false);
    expect(source.rejected).toContainEqual(expect.objectContaining({ code: "symlink_entry", sourcePath: "link.md" }));
    await source.close();
  });
});
