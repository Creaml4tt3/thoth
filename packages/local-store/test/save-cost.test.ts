import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault, type SqlDriver, type VaultFs } from "../src/index.ts";
import { NodeSqlDriver, NodeVaultFs } from "../src/node/index.ts";

/**
 * What one save costs in port calls: on desktop every call is a round trip to the host, so this is the number that grows
 * with the Private Space. The budgets fail when a save goes back to touching every page or every link.
 */

const PAGES = 300;
let root: string;
let vault: Vault;
let calls: string[] = [];

function counted<T extends object>(target: T, prefix: string): T {
  return new Proxy(target, {
    get(t, key, receiver) {
      const value = Reflect.get(t, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(`${prefix}.${String(key)} ${typeof args[0] === "string" ? args[0] : ""}`);
        return value.apply(t, args);
      };
    },
  });
}

const count = (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length;
/** A walk of the vault: one `scan` (or `list` per folder, for a port without it). */
const walks = () => count("fs.scan") + count("fs.list");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thoth-save-cost-"));
  for (let i = 0; i < PAGES; i++) {
    await mkdir(join(root, `folder-${i % 10}`), { recursive: true });
    const links = [1, 2, 3].map((k) => `[[Page ${(i + k * 7) % PAGES}]]`).join(" ");
    await writeFile(join(root, `folder-${i % 10}`, `Page ${i}.md`), `# Page ${i}\n\nSome text ${links} [[Nowhere]].\n`);
  }
  const fs = new NodeVaultFs(root);
  await fs.mkdirp(".thoth");
  ({ vault } = await Vault.open({ fs: counted<VaultFs>(fs, "fs"), sql: counted<SqlDriver>(new NodeSqlDriver(join(fs.root, ".thoth", "index.sqlite")), "sql") }));
  calls = [];
});

afterEach(async () => {
  await vault.close();
  await rm(root, { recursive: true, force: true });
});

describe("the cost of one save", () => {
  it("rewrites only the saved page's links, not every link in the vault", async () => {
    const path = "folder-0/Page 0.md";
    const read = await vault.readPage(path);
    calls = [];
    await vault.writePage(path, `${read.source}More text.\n`, { expectedHash: read.hash });
    // Only the saved page's own links, which are stored again as it is reindexed (three of its four resolve).
    expect(count("sql.run UPDATE refs")).toBe(3);
    // Only the page itself is checked: no walk, so the cost is the same however many pages there are (it was about
    // 4 calls per link in 0.7.0, then one stat per page).
    expect(walks()).toBe(0);
    expect(count("fs.stat")).toBeLessThanOrEqual(4);
    expect(calls.length).toBeLessThan(50);
  });

  it("deleting a page checks only that page", async () => {
    const read = await vault.readPage("folder-2/Page 2.md");
    calls = [];
    await vault.deleteFileAtomic("folder-2/Page 2.md", { expectedHash: read.hash });
    expect(walks()).toBe(0);
    expect((await vault.pageByPath("folder-2/Page 2.md"))).toBeUndefined();
    // Its links in other pages are unresolved now.
    expect((await vault.unresolvedLinks()).filter((l) => l.target === "Page 2")).toHaveLength(3);
  });

  it("walks when the index has the page under another letter case", async () => {
    // Renamed outside Thoth to differ only in case: the index still has the old spelling.
    await rename(join(root, "folder-0", "Page 0.md"), join(root, "folder-0", "page 0.md"));
    const read = await vault.readPage("folder-0/page 0.md");
    calls = [];
    await vault.writePage("folder-0/page 0.md", `${read.source}x\n`, { expectedHash: read.hash });
    // On a case-insensitive disk both spellings are one file, so the index cannot settle it from the path alone.
    expect(walks()).toBe(1);
    expect((await vault.listPages()).filter((p) => p.path.toLowerCase() === "folder-0/page 0.md").map((p) => p.path)).toEqual(["folder-0/page 0.md"]);
  });

  it("a page written into an ignored folder is not indexed", async () => {
    await vault.writeFileAtomic(".obsidian-not/x.md", new TextEncoder().encode("# x\n"), { expectedHash: null });
    await vault.writeFileAtomic("node_modules/x.md", new TextEncoder().encode("# x\n"), { expectedHash: null });
    expect(await vault.pageByPath(".obsidian-not/x.md")).toBeDefined();
    expect(await vault.pageByPath("node_modules/x.md")).toBeUndefined();
  });

  it("a scoped reindex leaves the index as a full reconcile would", async () => {
    const read = await vault.readPage("folder-3/Page 3.md");
    await vault.writePage("folder-3/Page 3.md", "---\naliases: [Third]\n---\n# Renamed\n\n[[Page 4]] [[Nowhere]]\n", { expectedHash: read.hash });
    await vault.writePage("Other.md", "# Other\n\n[[Third]]\n", { expectedHash: null });
    const snapshot = async () => ({
      pages: await vault.listPages(),
      links: await vault.unresolvedLinks(),
      graph: await vault.graph(),
      back: await vault.backlinks("folder-3/Page 3.md"),
    });
    const scoped = await snapshot();
    await vault.rebuildIndex();
    expect(await snapshot()).toEqual(scoped);
    expect(scoped.back.map((b) => b.sourcePath)).toContain("Other.md");
  });

  it("still resolves a link whose target appears", async () => {
    const read = await vault.readPage("folder-1/Page 1.md");
    await vault.writePage("Nowhere.md", "# Nowhere\n", { expectedHash: null });
    expect((await vault.backlinks("Nowhere.md")).length).toBe(PAGES);
    expect(read.source).toContain("[[Nowhere]]");
  });

  it("does not walk the vault again for the watcher event of its own save", async () => {
    const path = "folder-0/Page 0.md";
    const read = await vault.readPage(path);
    await vault.writePage(path, `${read.source}More text.\n`, { expectedHash: read.hash });
    calls = [];
    const report = await vault.reconcile({ changed: [path] });
    expect(report).toMatchObject({ added: [], updated: [], removed: [], echo: true });
    expect(walks()).toBe(0);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("is not an echo for a file it did not write, even one the index already has", async () => {
    // Indexed when the vault opened, never written by it: another window's save looks like this (ADR-0019).
    const report = await vault.reconcile({ changed: ["folder-5/Page 5.md"] });
    expect(report.echo).toBeUndefined();
    expect(walks()).toBe(0);
  });

  it("walks when a named path changed outside Thoth, is new, or is gone", async () => {
    const path = "folder-0/Page 0.md";
    await writeFile(join(root, path), "# Page 0\n\nEdited elsewhere [[Page 5]].\n");
    await utimes(join(root, path), new Date(), new Date(Date.now() + 5000));
    expect((await vault.reconcile({ changed: [path] })).updated).toEqual([path]);

    await writeFile(join(root, "New.md"), "# New\n");
    expect((await vault.reconcile({ changed: ["New.md"] })).added).toEqual(["New.md"]);

    await rm(join(root, "New.md"));
    expect((await vault.reconcile({ changed: ["New.md"] })).removed).toEqual(["New.md"]);

    // A folder's own event: the index has no row for it, so everything under it is checked.
    expect(walks()).toBeGreaterThan(0);
    calls = [];
    await vault.reconcile({ changed: ["folder-3"] });
    expect(walks()).toBe(1);
  });
});
