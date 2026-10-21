/**
 * The real `Vault` (packages/local-store) on the Rust host's ports, through
 * `RemoteVaultFs`/`RemoteSqlDriver` over the stdio harness. Mirrors the core
 * of packages/local-store/test/vault.test.ts.
 */
import { mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newStableId, sha256Hex } from "@thoth/domain";
import { ConflictError, JOURNAL_DIR, journalTempPath, Vault, type ReconcileReport } from "@thoth/local-store";
import type { VaultConnection } from "@thoth/platform";
import type { StdioTransport } from "@thoth/platform/stdio";
import { buildHarness, rustVault, tempDir } from "./harness.ts";

let root: string;
let vault: Vault;
let connection: VaultConnection;
let transport: StdioTransport;

async function put(path: string, content: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

async function open(): Promise<ReconcileReport> {
  ({ connection, transport } = await rustVault(root));
  const opened = await Vault.open({ fs: connection.fs, sql: connection.sql });
  vault = opened.vault;
  return opened.report;
}

async function close() {
  await vault.close();
  await connection.close();
  await transport.close();
}

beforeAll(() => buildHarness(), 600_000);

beforeEach(async () => {
  root = await tempDir("thoth-vault-rust-");
  await put("Inbox/Welcome.md", "# Welcome\n\nStart at [[Overview]] and see ![[diagram.svg]].\n");
  await put("Projects/Thoth/Overview.md", "---\naliases: [Home]\ntags: [thoth]\nplugin_x: keep\n---\n# Overview\n\nRead [the architecture](Architecture.md).\n");
  await put("Projects/Thoth/Architecture.md", "# Architecture\n\nBack to [[Home]]. Missing [[Nowhere]].\n");
  await put("Assets/diagram.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
  await put("บันทึก/การประชุม 🚀.md", "ประชุมเรื่องสถาปัตยกรรมระบบ [[Welcome]]\n");
  await put("Café/Crème brûlée.md", "# Crème brûlée\n\nA dessert served at the café.\n");
  await open();
});

afterEach(async () => {
  await close();
  await rm(root, { recursive: true, force: true });
});

describe("Vault on Rust ports", () => {
  it("indexes pages, links and attachments", async () => {
    expect((await vault.listPages()).map((p) => p.path)).toEqual([
      "Café/Crème brûlée.md",
      "Inbox/Welcome.md",
      "Projects/Thoth/Architecture.md",
      "Projects/Thoth/Overview.md",
      "บันทึก/การประชุม 🚀.md",
    ]);
    expect((await vault.backlinks("Projects/Thoth/Overview.md")).map((b) => b.sourcePath)).toEqual(["Inbox/Welcome.md", "Projects/Thoth/Architecture.md"]);
    expect((await vault.listAttachments()).map((a) => a.path)).toEqual(["Assets/diagram.svg"]);
    expect(await readdir(join(root, ".thoth"))).toEqual(expect.arrayContaining(["config.json", "index.sqlite", "operations", "manifests"]));
  });

  it("searches Latin text with diacritics folded and Thai by substring", async () => {
    expect((await vault.search("architecture")).map((h) => h.path)).toContain("Projects/Thoth/Architecture.md");
    expect((await vault.search("creme brulee")).map((h) => h.path)).toContain("Café/Crème brûlée.md");
    expect((await vault.search("cafe")).map((h) => h.path)).toContain("Café/Crème brûlée.md");
    expect((await vault.search("สถาปัตย")).map((h) => h.path)).toEqual(["บันทึก/การประชุม 🚀.md"]);
    await expect(vault.search('"unbalanced OR NEAR(')).resolves.toBeInstanceOf(Array);
  });

  it("writes with compare-and-swap: a stale hash is a ConflictError", async () => {
    const read = await vault.readPage("Inbox/Welcome.md");
    await put("Inbox/Welcome.md", "edited elsewhere\n");
    await expect(vault.writePage("Inbox/Welcome.md", "mine\n", { expectedHash: read.hash })).rejects.toBeInstanceOf(ConflictError);
    expect(await readFile(join(root, "Inbox/Welcome.md"), "utf8")).toBe("edited elsewhere\n");
    const fresh = await vault.readPage("Inbox/Welcome.md");
    expect(await vault.writePage("Inbox/Welcome.md", "mine\n", { expectedHash: fresh.hash })).toBe(sha256Hex("mine\n"));
    expect(await readFile(join(root, "Inbox/Welcome.md"), "utf8")).toBe("mine\n");
    const { id } = await vault.createPage("Inbox/Idea.md", "# Idea\n");
    expect((await vault.pageByPath("Inbox/Idea.md"))?.id).toBe(id);
    await expect(vault.createPage("Inbox/Idea.md", "again")).rejects.toBeInstanceOf(ConflictError);
  });

  it("reconciles external edits, additions and deletions", async () => {
    await put("Inbox/New.md", "# New\n[[Architecture]]\n");
    await put("Projects/Thoth/Architecture.md", "# Architecture v2\n\nNow mentions zebra.\n");
    const future = new Date(Date.now() + 5000);
    await utimes(join(root, "Projects/Thoth/Architecture.md"), future, future);
    await rm(join(root, "Inbox/Welcome.md"));
    const report = await vault.reconcile();
    expect(report.added).toEqual(["Inbox/New.md"]);
    expect(report.updated).toEqual(["Projects/Thoth/Architecture.md"]);
    expect(report.removed).toEqual(["Inbox/Welcome.md"]);
    expect(await vault.search("zebra")).toHaveLength(1);
  });

  it("recovers from a crash between temp write and rename", async () => {
    const original = await readFile(join(root, "Inbox/Welcome.md"), "utf8");
    const id = newStableId();
    await writeFile(join(root, journalTempPath(id)), "half-written");
    await writeFile(
      join(root, JOURNAL_DIR, `${id}.json`),
      JSON.stringify({ id, kind: "write-file", path: "Inbox/Welcome.md", tempPath: journalTempPath(id), expectedHash: null, newHash: "x", createdAt: 1 }),
    );
    await close();
    const report = await open();
    expect(report.recoveredJournalEntries).toBe(1);
    expect(await readFile(join(root, "Inbox/Welcome.md"), "utf8")).toBe(original);
    await expect(stat(join(root, journalTempPath(id)))).rejects.toThrow();
    expect(await readdir(join(root, JOURNAL_DIR))).toEqual([]);
  });

  it("refuses unsafe paths, writes into .thoth and symlinked directories", async () => {
    await expect(vault.writePage("../escape.md", "x", { expectedHash: null })).rejects.toThrow(/Unsafe path/);
    await expect(vault.writeFileAtomic(".thoth/config.json", new Uint8Array(), { expectedHash: null })).rejects.toThrow(/\.thoth/);
    const outside = await tempDir("thoth-outside-");
    await writeFile(join(outside, "secret.md"), "secret");
    await symlink(outside, join(root, "linked"));
    const report = await vault.reconcile();
    expect(report.warnings).toContainEqual({ path: "linked", code: "skipped_entry", message: "symlink not followed" });
    expect(await vault.search("secret")).toHaveLength(0);
    await expect(vault.writePage("linked/x.md", "x", { expectedHash: null })).rejects.toThrow(/symlink/);
    expect(await readdir(outside)).toEqual(["secret.md"]);
    await rm(outside, { recursive: true, force: true });
  });

  it("rebuilds an identical index after the database is deleted", async () => {
    const before = (await vault.listPages()).map(({ mtimeMs: _, ...p }) => p);
    await close();
    for (const f of ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm"]) await rm(join(root, ".thoth", f), { force: true });
    await open();
    expect((await vault.listPages()).map(({ mtimeMs: _, ...p }) => p)).toEqual(before);
  });

  it("serializes concurrent saves and reconciles over IPC", async () => {
    const created = await Promise.all(Array.from({ length: 6 }, (_, i) => vault.createPage(`Burst/Note ${i}.md`, `# Note ${i}\n`)));
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 6; i++) {
      work.push(vault.writePage(`Burst/Note ${i}.md`, `# Note ${i}\nzebramark${i}\n`, { expectedHash: created[i]!.hash }));
      work.push(vault.reconcile());
    }
    await Promise.all(work);
    for (let i = 0; i < 6; i++) expect((await vault.search(`zebramark${i}`)).some((h) => h.path === `Burst/Note ${i}.md`)).toBe(true);
  });
});
