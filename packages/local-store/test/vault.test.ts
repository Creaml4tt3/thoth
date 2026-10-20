import { chmod, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isStableId, newStableId, sha256Hex } from "@thoth/domain";
import { NotEditableError } from "@thoth/content";
import { ConflictError, JOURNAL_DIR, journalTempPath, TEMP_DIR, type Vault } from "../src/index.ts";
import { openNodeVault } from "../src/node/index.ts";

let root: string;
let vault: Vault;

async function put(path: string, content: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thoth-vault-"));
  await put("Inbox/Welcome.md", "# Welcome\n\nStart at [[Overview]] and see ![[diagram.svg]].\n");
  await put("Projects/Thoth/Overview.md", "---\naliases: [Home]\ntags: [thoth]\nplugin_x: keep\n---\n# Overview\n\nRead [the architecture](Architecture.md).\n");
  await put("Projects/Thoth/Architecture.md", "# Architecture\n\nBack to [[Home]]. Missing [[Nowhere]].\n");
  await put("Assets/diagram.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
  await put("บันทึก/การประชุม 🚀.md", "ประชุมเรื่องสถาปัตยกรรมระบบ [[Welcome]]\n");
  ({ vault } = await openNodeVault(root));
});

afterEach(async () => {
  await vault.close();
  await rm(root, { recursive: true, force: true });
});

describe("Vault indexing", () => {
  it("creates the .thoth layout without touching user files", async () => {
    const entries = await readdir(join(root, ".thoth"));
    expect(entries).toEqual(expect.arrayContaining(["config.json", "index.sqlite", "operations", "manifests"]));
    // Indexing alone must not inject frontmatter (ADR-003).
    expect(await readFile(join(root, "Inbox/Welcome.md"), "utf8")).toBe("# Welcome\n\nStart at [[Overview]] and see ![[diagram.svg]].\n");
  });

  it("indexes pages, attachments, aliases and tags", async () => {
    const pages = await vault.listPages();
    expect(pages.map((p) => p.path)).toEqual([
      "Inbox/Welcome.md",
      "Projects/Thoth/Architecture.md",
      "Projects/Thoth/Overview.md",
      "บันทึก/การประชุม 🚀.md",
    ]);
    const overview = pages.find((p) => p.title === "Overview")!;
    expect(overview.aliases).toEqual(["Home"]);
    expect(overview.tags).toEqual(["thoth"]);
    expect(overview.id).toMatch(/^local:/);
    expect((await vault.listAttachments()).map((a) => [a.path, a.mimeType])).toEqual([["Assets/diagram.svg", "image/svg+xml"]]);
  });

  it("resolves links and computes backlinks via path, basename, and alias", async () => {
    expect((await vault.backlinks("Projects/Thoth/Overview.md")).map((b) => b.sourcePath)).toEqual([
      "Inbox/Welcome.md",
      "Projects/Thoth/Architecture.md",
    ]);
    expect((await vault.backlinks("Assets/diagram.svg")).map((b) => b.syntax)).toEqual(["embed"]);
    expect(await vault.unresolvedLinks()).toEqual([
      { sourcePath: "Projects/Thoth/Architecture.md", target: "Nowhere", resolution: "unresolved", line: 3 },
    ]);
    const graph = await vault.graph();
    expect(graph.edges.length).toBe(4);
  });

  it("searches with FTS5 including diacritics and Thai substrings", async () => {
    expect((await vault.search("architecture")).map((h) => h.path)).toContain("Projects/Thoth/Architecture.md");
    expect((await vault.search("Home")).map((h) => h.path)).toContain("Projects/Thoth/Overview.md");
    expect((await vault.search("สถาปัตย")).map((h) => h.path)).toEqual(["บันทึก/การประชุม 🚀.md"]);
    // FTS syntax in user input is treated as text, not operators.
    await expect(vault.search('"unbalanced OR NEAR(')).resolves.toBeInstanceOf(Array);
  });

  it("detects external edits, additions, and deletions on reconcile", async () => {
    await put("Inbox/New.md", "# New\n[[Architecture]]\n");
    await put("Projects/Thoth/Architecture.md", "# Architecture v2\n\nNow mentions zebra.\n");
    const future = new Date(Date.now() + 5000);
    await utimes(join(root, "Projects/Thoth/Architecture.md"), future, future);
    await rm(join(root, "Inbox/Welcome.md"));
    const report = await vault.reconcile();
    expect(report.added).toEqual(["Inbox/New.md"]);
    expect(report.updated).toEqual(["Projects/Thoth/Architecture.md"]);
    expect(report.removed).toEqual(["Inbox/Welcome.md"]);
    expect((await vault.search("zebra")).length).toBe(1);
    expect((await vault.backlinks("Projects/Thoth/Architecture.md")).map((b) => b.sourcePath)).toEqual([
      "Inbox/New.md",
      "Projects/Thoth/Overview.md",
    ]);
  });

  it("rebuilds an identical index after the database is deleted", async () => {
    const before = await vault.listPages();
    const backlinksBefore = await vault.backlinks("Projects/Thoth/Overview.md");
    await vault.close();
    await rm(join(root, ".thoth/index.sqlite"));
    await rm(join(root, ".thoth/index.sqlite-wal"), { force: true });
    await rm(join(root, ".thoth/index.sqlite-shm"), { force: true });
    ({ vault } = await openNodeVault(root));
    expect((await vault.listPages()).map(({ mtimeMs: _, ...p }) => p)).toEqual(before.map(({ mtimeMs: _, ...p }) => p));
    expect(await vault.backlinks("Projects/Thoth/Overview.md")).toEqual(backlinksBefore);
  });

  it("does not follow symlinks out of the vault", async () => {
    const outside = await mkdtemp(join(tmpdir(), "thoth-outside-"));
    await writeFile(join(outside, "secret.md"), "secret");
    await symlink(outside, join(root, "linked"));
    const report = await vault.reconcile();
    expect(report.warnings).toContainEqual({ path: "linked", code: "skipped_entry", message: "symlink not followed" });
    expect((await vault.search("secret")).length).toBe(0);
    await expect(vault.writePage("linked/x.md", "x", { expectedHash: null })).rejects.toThrow(/symlink/);
    await rm(outside, { recursive: true, force: true });
  });

  it("indexes malformed frontmatter with a warning and keeps the file intact", async () => {
    const src = "---\ntitle: [unclosed\n---\nBody text\n";
    await put("Broken.md", src);
    const report = await vault.reconcile();
    expect(report.warnings.some((w) => w.path === "Broken.md" && w.code === "malformed_frontmatter")).toBe(true);
    expect(await readFile(join(root, "Broken.md"), "utf8")).toBe(src);
  });

  it("works with no network access (no fetch/socket use)", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("network used");
    };
    try {
      await vault.createPage("Offline.md", "# Offline\n");
      expect((await vault.search("Offline")).length).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("Vault writes", () => {
  it("creates pages with a stable thoth_id and refuses to overwrite", async () => {
    const { id } = await vault.createPage("Inbox/Idea.md", "# Idea\n\nLink to [[Overview]].\n", { custom: 1 });
    expect(isStableId(id)).toBe(true);
    const page = await vault.pageByPath("Inbox/Idea.md");
    expect(page?.id).toBe(id);
    expect((await vault.backlinks("Projects/Thoth/Overview.md")).map((b) => b.sourcePath)).toContain("Inbox/Idea.md");
    await expect(vault.createPage("Inbox/Idea.md", "again")).rejects.toBeInstanceOf(ConflictError);
  });

  it("uses compare-and-swap and never silently overwrites external edits", async () => {
    const read = await vault.readPage("Inbox/Welcome.md");
    await put("Inbox/Welcome.md", "edited elsewhere\n");
    await expect(vault.writePage("Inbox/Welcome.md", "mine\n", { expectedHash: read.hash })).rejects.toBeInstanceOf(ConflictError);
    expect(await readFile(join(root, "Inbox/Welcome.md"), "utf8")).toBe("edited elsewhere\n");

    const fresh = await vault.readPage("Inbox/Welcome.md");
    const hash = await vault.writePage("Inbox/Welcome.md", "mine\n", { expectedHash: fresh.hash });
    expect(hash).toBe(sha256Hex("mine\n"));
    expect(await readFile(join(root, "Inbox/Welcome.md"), "utf8")).toBe("mine\n");
  });

  it("adopts a page by adding thoth_id while preserving unknown frontmatter", async () => {
    const id = await vault.adoptPage("Projects/Thoth/Overview.md");
    const text = await readFile(join(root, "Projects/Thoth/Overview.md"), "utf8");
    expect(text).toContain("plugin_x: keep");
    expect(text).toContain(`thoth_id: ${id}`);
    expect(text.endsWith("# Overview\n\nRead [the architecture](Architecture.md).\n")).toBe(true);
    expect((await vault.pageByPath("Projects/Thoth/Overview.md"))?.id).toBe(id);
    // Backlinks survive the identity change.
    expect((await vault.backlinks("Projects/Thoth/Overview.md")).length).toBe(2);
  });

  it("flags duplicate thoth_id values instead of rewriting files", async () => {
    const { id } = await vault.createPage("A.md", "# A\n");
    const copy = await readFile(join(root, "A.md"), "utf8");
    await put("B.md", copy);
    const report = await vault.reconcile();
    expect(report.warnings.some((w) => w.code === "duplicate_id" && w.path === "B.md")).toBe(true);
    expect((await vault.pageByPath("A.md"))?.id).toBe(id);
    expect((await vault.pageByPath("B.md"))?.id).toMatch(/^local:/);
    expect(await readFile(join(root, "B.md"), "utf8")).toBe(copy);
  });

  it("rejects unsafe paths and writes into .thoth", async () => {
    await expect(vault.writePage("../escape.md", "x", { expectedHash: null })).rejects.toThrow(/Unsafe path/);
    await expect(vault.writeFileAtomic(".thoth/config.json", new Uint8Array(), { expectedHash: null })).rejects.toThrow(/\.thoth/);
  });

  it("recovers from a crash between temp write and rename without touching content", async () => {
    // Simulate a crash: a well-formed journal entry + its temp file exist, target untouched.
    const original = await readFile(join(root, "Inbox/Welcome.md"), "utf8");
    const id = newStableId();
    await writeFile(join(root, journalTempPath(id)), "half-written");
    await writeFile(
      join(root, JOURNAL_DIR, `${id}.json`),
      JSON.stringify({ id, kind: "write-file", path: "Inbox/Welcome.md", tempPath: journalTempPath(id), expectedHash: null, newHash: "x", createdAt: 1 }),
    );
    await vault.close();
    const reopened = await openNodeVault(root);
    vault = reopened.vault;
    expect(reopened.report.recoveredJournalEntries).toBe(1);
    expect(await readFile(join(root, "Inbox/Welcome.md"), "utf8")).toBe(original);
    await expect(stat(join(root, journalTempPath(id)))).rejects.toThrow();
    expect(await readdir(join(root, JOURNAL_DIR))).toEqual([]);
  });

  it("never lets a forged journal entry delete anything outside .thoth/tmp", async () => {
    const id = newStableId();
    for (const [name, tempPath] of [
      [`${id}.json`, "Projects"],
      ["evil.json", "Inbox/Welcome.md"],
      [`${newStableId()}.json`, `${TEMP_DIR}/../../Inbox`],
    ] as const) {
      await writeFile(join(root, JOURNAL_DIR, name), JSON.stringify({ id, kind: "write-file", path: "x.md", tempPath, expectedHash: null, newHash: "x", createdAt: 1 }));
    }
    await vault.close();
    const reopened = await openNodeVault(root);
    vault = reopened.vault;
    expect(reopened.report.recoveredJournalEntries).toBe(0);
    expect(reopened.report.warnings.filter((w) => w.code === "invalid_journal_entry")).toHaveLength(3);
    expect(await readFile(join(root, "Inbox/Welcome.md"), "utf8")).toContain("# Welcome");
    expect(await readdir(join(root, "Projects/Thoth"))).toEqual(["Architecture.md", "Overview.md"]);
  });
});

describe("Vault robustness", () => {
  it("opens and indexes the rest of the vault when one file is pathological or unreadable", async () => {
    await put("alias.md", "---\na: *nope\n---\nbody\n");
    await put("bomb.md", "---\na: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\n---\nbody\n");
    await put("locked.md", "secret");
    await chmod(join(root, "locked.md"), 0o000);
    await vault.close();
    const reopened = await openNodeVault(root);
    vault = reopened.vault;
    await chmod(join(root, "locked.md"), 0o644);
    const codes = reopened.report.warnings.map((w) => `${w.path}:${w.code}`);
    expect(codes).toEqual(expect.arrayContaining(["alias.md:malformed_frontmatter", "bomb.md:malformed_frontmatter", "locked.md:unreadable_file"]));
    expect((await vault.listPages()).map((p) => p.path)).toEqual(expect.arrayContaining(["Inbox/Welcome.md", "alias.md", "bomb.md"]));
  });

  it("refuses to edit non-UTF-8 files and preserves a BOM byte-for-byte", async () => {
    await writeFile(join(root, "latin1.md"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await writeFile(join(root, "bom.md"), Buffer.from("\uFEFF# Bom\n", "utf8"));
    await vault.reconcile();
    await expect(vault.adoptPage("latin1.md")).rejects.toBeInstanceOf(NotEditableError);
    expect([...(await readFile(join(root, "latin1.md")))]).toEqual([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    await vault.adoptPage("bom.md");
    const bytes = await readFile(join(root, "bom.md"));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8").endsWith("---\n# Bom\n")).toBe(true);
  });

  it("keeps duplicate thoth_id ownership stable across index rebuilds and clears fixed warnings", async () => {
    const { id } = await vault.createPage("Z.md", "# Z\n");
    await put("A.md", await readFile(join(root, "Z.md"), "utf8"));
    await vault.reconcile();
    const owner = (await vault.listPages()).find((p) => p.id === id)!.path;
    await vault.rebuildIndex();
    expect((await vault.listPages()).find((p) => p.id === id)!.path).toBe(owner);
    const loser = owner === "A.md" ? "Z.md" : "A.md";
    await rm(join(root, loser));
    const report = await vault.reconcile();
    expect(report.warnings.filter((w) => w.code === "duplicate_id")).toEqual([]);
  });
});

describe("NodeVaultFs no-replace rename", () => {
  it("falls back to an exclusive copy when hardlinks are unsupported, and never replaces", async () => {
    const { NodeVaultFs } = await import("../src/node/index.ts");
    const link = vi.fn(async () => {
      throw Object.assign(new Error("no hardlinks"), { code: "ENOTSUP" });
    });
    const vfs = new NodeVaultFs(root, { link });
    await vfs.writeFile("a.tmp", new TextEncoder().encode("A"));
    await vfs.rename("a.tmp", "moved.md", { noReplace: true });
    expect(link).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, "moved.md"), "utf8")).toBe("A");
    await expect(stat(join(root, "a.tmp"))).rejects.toThrow();
    await vfs.writeFile("b.tmp", new TextEncoder().encode("B"));
    await expect(vfs.rename("b.tmp", "moved.md", { noReplace: true })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(root, "moved.md"), "utf8")).toBe("A");
  });
});

describe("search input hardening", () => {
  it("treats NUL and control characters as plain text", async () => {
    await expect(vault.search("\u0000x")).resolves.toBeInstanceOf(Array);
    await expect(vault.search('a"\u0007b')).resolves.toBeInstanceOf(Array);
  });
});
