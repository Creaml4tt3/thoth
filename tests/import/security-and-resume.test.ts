import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchiveRejectedError, loadManifest, planImport, resumeImport, runImport } from "@thoth/importer-core";
import { openZipSource } from "@thoth/importer-core/node";
import { ObsidianVaultImporter, ObsidianZipImporter } from "@thoth/importer-obsidian/node";
import { NotionZipImporter } from "@thoth/importer-notion/node";
import type { Vault } from "@thoth/local-store";
import { openNodeVault } from "@thoth/local-store/node";
import { snapshotTree } from "../helpers/fs.ts";
import { writeZip } from "../helpers/zip.ts";

const FIXTURE = resolve(import.meta.dirname, "../fixtures/obsidian-vault");

let work: string;
let vaultRoot: string;
let vault: Vault;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "thoth-sec-"));
  vaultRoot = join(work, "vault");
  ({ vault } = await openNodeVault(vaultRoot));
});

afterEach(async () => {
  await vault.close();
  await rm(work, { recursive: true, force: true });
});

describe("archive safety (spec §7.2, §12)", () => {
  it("rejects path traversal, absolute, drive-letter, backslash, and NUL entries but imports the rest", async () => {
    const zip = await writeZip(join(work, "evil.zip"), [
      { name: "../escape.md", data: "x" },
      { name: "a/../../escape2.md", data: "x" },
      { name: "/etc/passwd.md", data: "x" },
      { name: "C:/win.md", data: "x" },
      { name: "..\\..\\win.md", data: "x" },
      { name: "nul\0.md", data: "x" },
      { name: "ok.md", data: "# ok\n" },
    ]);
    const { source, provider } = await ObsidianZipImporter.open(zip);
    expect(source.entries.map((e) => e.path)).toEqual(["ok.md"]);
    expect(source.rejected.map((r) => r.code)).toEqual(Array(6).fill("unsafe_path"));
    const { manifest } = await planImport({ vault, source, provider, options: { destinationRoot: "" } });
    await runImport(vault, source, manifest);
    await source.close();
    expect(await readdir(work)).toEqual(expect.not.arrayContaining(["escape.md", "escape2.md"]));
    expect(await readdir(vaultRoot)).toEqual(expect.arrayContaining(["ok.md"]));
    expect(manifest.warnings.filter((w) => w.code === "unsafe_path")).toHaveLength(6);
  });

  it("rejects symlink entries", async () => {
    const zip = await writeZip(join(work, "link.zip"), [
      { name: "link.md", data: "/etc/passwd", mode: 0o120777, deflate: false },
      { name: "ok.md", data: "ok" },
    ]);
    const source = await openZipSource(zip);
    expect(source.entries.map((e) => e.path)).toEqual(["ok.md"]);
    expect(source.rejected).toContainEqual(expect.objectContaining({ code: "symlink_entry", sourcePath: "link.md" }));
    await source.close();
  });

  it("rejects archives with a suspicious compression ratio (zip bomb)", async () => {
    const zip = await writeZip(join(work, "bomb.zip"), [{ name: "bomb.md", data: Buffer.alloc(20 * 1024 * 1024) }]);
    await expect(openZipSource(zip)).rejects.toMatchObject({ code: "compression_ratio" });
  });

  it("rejects oversized entries and too many entries", async () => {
    const big = await writeZip(join(work, "big.zip"), [{ name: "big.bin", data: Buffer.alloc(2048, 7), deflate: false }, { name: "ok.md", data: "ok" }]);
    const source = await openZipSource(big, { maxEntryBytes: 1024 });
    expect(source.entries.map((e) => e.path)).toEqual(["ok.md"]);
    expect(source.rejected).toContainEqual(expect.objectContaining({ code: "entry_too_large" }));
    await source.close();

    const many = await writeZip(join(work, "many.zip"), Array.from({ length: 11 }, (_, i) => ({ name: `${i}.md`, data: "x" })));
    await expect(openZipSource(many, { maxEntries: 10 })).rejects.toMatchObject({ code: "too_many_entries" });
    await expect(openZipSource(many, { maxTotalBytes: 5 })).rejects.toMatchObject({ code: "too_large" });
  });

  it("rejects malformed and truncated archives with a clear error", async () => {
    await writeFile(join(work, "garbage.zip"), "this is not a zip file at all");
    await expect(openZipSource(join(work, "garbage.zip"))).rejects.toBeInstanceOf(ArchiveRejectedError);
    const good = await readFile(await writeZip(join(work, "good.zip"), [{ name: "a.md", data: "hello".repeat(100) }]));
    await writeFile(join(work, "truncated.zip"), good.subarray(0, good.length - 30));
    await expect(openZipSource(join(work, "truncated.zip"))).rejects.toMatchObject({ code: "malformed_zip" });
  });

  it("rejects entries whose declared size does not match the inflated data", async () => {
    const buf = await readFile(await writeZip(join(work, "lie.zip"), [{ name: "a.md", data: "x".repeat(5000) }]));
    // Under-declare the uncompressed size in both headers so the size check is bypassed at scan time.
    buf.writeUInt32LE(10, 22);
    const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(10, cd + 24);
    await writeFile(join(work, "lie.zip"), buf);
    const { source, provider } = await ObsidianZipImporter.open(join(work, "lie.zip"));
    // yauzl's validateEntrySizes catches the mismatch while inflating.
    await expect(planImport({ vault, source, provider })).rejects.toThrow(/too many bytes|size|exceed/i);
    await source.close();
  });
});

describe("review regressions", () => {
  it("never imports .thoth/ metadata from an archive, at any depth or case", async () => {
    const forged = (id: string, tempPath: string) => JSON.stringify({ id, kind: "write-file", path: "x.md", tempPath, expectedHash: null, newHash: "x", createdAt: 1 });
    await writeFile(join(vaultRoot, "Victim.md"), "# precious\n");
    for (const [i, prefix] of ["MyVault/.thoth", ".THOTH", "notes/.Thoth"].entries()) {
      const zip = await writeZip(join(work, `forge${i}.zip`), [
        { name: `${prefix}/operations/journal/evil.json`, data: forged("evil", "Victim.md") },
        { name: prefix.startsWith("MyVault") ? "MyVault/note.md" : `note${i}.md`, data: "# hi\n" },
      ]);
      const { source, provider } = await ObsidianZipImporter.open(zip);
      const { manifest } = await planImport({ vault, source, provider, options: { destinationRoot: "" } });
      expect(manifest.items.filter((it) => it.state !== "skipped").every((it) => !/\.thoth/i.test(it.destPath ?? ""))).toBe(true);
      await runImport(vault, source, manifest);
      await source.close();
    }
    await vault.close();
    ({ vault } = await openNodeVault(vaultRoot));
    expect(await readFile(join(vaultRoot, "Victim.md"), "utf8")).toBe("# precious\n");
  });

  it("rejects many medium entries that add up to a bomb", async () => {
    const zip = await writeZip(join(work, "medium.zip"), Array.from({ length: 80 }, (_, i) => ({ name: `f${i}.bin`, data: Buffer.alloc(1024 * 1024) })));
    await expect(openZipSource(zip)).rejects.toMatchObject({ code: "compression_ratio" });
  });

  it("copies UTF-8 BOM pages byte-for-byte when no edit is needed", async () => {
    const zip = await writeZip(join(work, "bom.zip"), [{ name: "bom.md", data: Buffer.from("\uFEFFbody\n", "utf8") }]);
    const { source, provider } = await ObsidianZipImporter.open(zip);
    const { manifest } = await planImport({ vault, source, provider, options: { destinationRoot: "", addIdentityFrontmatter: false } });
    await runImport(vault, source, manifest);
    await source.close();
    expect([...(await readFile(join(vaultRoot, "bom.md")))]).toEqual([...Buffer.from("\uFEFFbody\n", "utf8")]);
  });

  it("skips a file that conflicts with a folder instead of getting stuck", async () => {
    const zip = await writeZip(join(work, "fd.zip"), [{ name: "notes", data: "file" }, { name: "notes/x.md", data: "# x\n" }]);
    const { source, provider } = await ObsidianZipImporter.open(zip);
    const { manifest } = await planImport({ vault, source, provider, options: { destinationRoot: "" } });
    const report = await runImport(vault, source, manifest);
    await source.close();
    expect(report.state).toBe("completed");
    expect(report.warnings.map((w) => w.code)).toContain("file_folder_conflict");
    expect(await readFile(join(vaultRoot, "notes/x.md"), "utf8")).toContain("# x");
  });

  it("keeps a single real top-level folder when importing a vault directory", async () => {
    const src = join(work, "OneFolder");
    await mkdir(join(src, "Notes"), { recursive: true });
    await writeFile(join(src, "Notes/a.md"), "see [[Notes/b]]\n");
    await writeFile(join(src, "Notes/b.md"), "# b\n");
    const { source, provider } = await ObsidianVaultImporter.open(src);
    const { manifest } = await planImport({ vault, source, provider, options: { destinationRoot: "Imp" } });
    await runImport(vault, source, manifest);
    await source.close();
    expect(manifest.items.map((i) => i.destPath).sort()).toEqual(["Imp/Notes/a.md", "Imp/Notes/b.md"]);
    expect(await vault.unresolvedLinks()).toEqual([]);
  });

  it("keeps same-title Notion pages and their children in separate folders", async () => {
    const A = "a".repeat(32), B = "b".repeat(32);
    const zip = await writeZip(join(work, "dup.zip"), [
      { name: `Project ${A}.md`, data: "# A\n" },
      { name: `Project ${A}/Notes ${"c".repeat(32)}.md`, data: "# notes of A\n" },
      { name: `Project ${B}.md`, data: "# B\n" },
      { name: `Project ${B}/Notes ${"d".repeat(32)}.md`, data: "# notes of B\n" },
    ]);
    const { source, provider } = await NotionZipImporter.open(zip);
    const { manifest } = await planImport({ vault, source, provider, options: { destinationRoot: "" } });
    await runImport(vault, source, manifest);
    await source.close();
    const owner = (p: string) => readFile(join(vaultRoot, p), "utf8");
    const [first, second] = (await owner("Project.md")).includes("# A") ? ["A", "B"] : ["B", "A"];
    expect(await owner("Project/Notes.md")).toContain(`notes of ${first}`);
    expect(await owner("Project 2/Notes.md")).toContain(`notes of ${second}`);
  });

  it("tracks and rewrites links whose label contains a code span", async () => {
    await vault.createPage("Other.md", "# mine\n");
    const zip = await writeZip(join(work, "cs.zip"), [{ name: "idx.md", data: "[`a]`](Other.md) / [plain](Other.md)\n" }, { name: "Other.md", data: "# theirs\n" }]);
    const { source, provider } = await ObsidianZipImporter.open(zip);
    const { manifest } = await planImport({ vault, source, provider, options: { destinationRoot: "", addIdentityFrontmatter: false } });
    await runImport(vault, source, manifest);
    await source.close();
    expect(await readFile(join(vaultRoot, "idx.md"), "utf8")).toBe("[`a]`](Other%202.md) / [plain](Other%202.md)\n");
  });
});

describe("interruption and resume (spec §7.1.8, §7.5)", () => {
  it("resumes after a crash mid-commit without duplicating pages", async () => {
    const sourceBefore = await snapshotTree(FIXTURE);
    const { source, provider } = await ObsidianVaultImporter.open(FIXTURE);
    const { manifest } = await planImport({ vault, source, provider, options: { destinationRoot: "Imported" } });
    let committed = 0;
    await expect(
      runImport(vault, source, manifest, {
        afterCommitItem: () => {
          if (++committed === 5) throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    await source.close();

    // Durable manifest records progress; partial results are visible but not duplicated.
    const saved = await loadManifest(vault.fs, manifest.jobId);
    expect(saved.state).toBe("committing");

    // Simulate an app restart.
    await vault.close();
    ({ vault } = await openNodeVault(vaultRoot));
    const reopened = await ObsidianVaultImporter.open(FIXTURE);
    const report = await resumeImport(vault, manifest.jobId, reopened.source);
    await reopened.source.close();

    expect(report.state).toBe("completed");
    expect(report.imported).toEqual({ pages: 11, attachments: 2, databases: 0 });
    const paths = (await vault.listPages()).map((p) => p.path);
    expect(paths).toHaveLength(11);
    expect(paths.some((p) => / 2\.md$/.test(p))).toBe(false);
    // Assigned IDs are stable across the resume.
    const ids = (await vault.listPages()).map((p) => p.id).filter((id) => !id.startsWith("local:")).sort();
    expect(ids).toEqual(saved.items.flatMap((i) => (i.kind === "page" && i.pageId ? [i.pageId] : [])).sort());
    expect(ids).toHaveLength(10); // the malformed-frontmatter page keeps a provisional ID
    expect(await snapshotTree(FIXTURE)).toEqual(sourceBefore);
    // Staging is cleaned up.
    expect(await readdir(join(vaultRoot, ".thoth/operations/imports"))).toEqual([]);
  });

  it("supports cancellation and later resumption", async () => {
    const controller = new AbortController();
    const { source, provider } = await ObsidianVaultImporter.open(FIXTURE);
    const { manifest } = await planImport({ vault, source, provider, options: { destinationRoot: "Imported" } });
    const partial = await runImport(vault, source, manifest, {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === "committing" && p.done === 3) controller.abort();
      },
    });
    expect(partial.state).toBe("cancelled");
    expect(partial.imported.pages + partial.imported.attachments).toBe(3);
    const finished = await resumeImport(vault, manifest.jobId, source);
    await source.close();
    expect(finished.state).toBe("completed");
    expect((await vault.listPages()).length).toBe(11);
  });

  it("refuses to commit if the source changed after planning", async () => {
    const zipPath = join(work, "v.zip");
    await writeZip(zipPath, [{ name: "a.md", data: "one" }]);
    const first = await ObsidianZipImporter.open(zipPath);
    const { manifest } = await planImport({ vault, source: first.source, provider: first.provider, options: { destinationRoot: "" } });
    await first.source.close();
    await writeZip(zipPath, [{ name: "a.md", data: "two" }]);
    const second = await ObsidianZipImporter.open(zipPath);
    const report = await runImport(vault, second.source, manifest);
    await second.source.close();
    expect(report.state).toBe("failed");
    expect(report.failed[0]?.error).toMatch(/Source file changed/);
    expect(await vault.pageByPath("a.md")).toBeUndefined();
  });

  it("never overwrites a destination file created during the import", async () => {
    const zipPath = await writeZip(join(work, "race.zip"), [{ name: "a.md", data: "imported" }, { name: "b.md", data: "imported b" }]);
    const { source, provider } = await ObsidianZipImporter.open(zipPath);
    const { manifest } = await planImport({ vault, source, provider, options: { destinationRoot: "", addIdentityFrontmatter: false } });
    let first = true;
    const report = await runImport(vault, source, manifest, {
      afterCommitItem: async () => {
        if (first) await writeFile(join(vaultRoot, "b.md"), "user content");
        first = false;
      },
    });
    await source.close();
    expect(await readFile(join(vaultRoot, "b.md"), "utf8")).toBe("user content");
    expect(report.failed).toEqual([{ sourcePath: "b.md", error: expect.stringMatching(/not overwritten/) }]);
  });
});
