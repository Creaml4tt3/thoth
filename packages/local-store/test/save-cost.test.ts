import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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
    // One stat per page for the walk, plus a fixed amount for the page itself: it was about 4 calls per link before.
    expect(calls.length).toBeLessThan(PAGES * 1.5);
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
    expect(report).toMatchObject({ added: [], updated: [], removed: [] });
    expect(count("fs.list")).toBe(0);
    expect(calls.length).toBeLessThanOrEqual(2);
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
    expect(count("fs.list")).toBeGreaterThan(0);
    calls = [];
    await vault.reconcile({ changed: ["folder-3"] });
    expect(count("fs.list")).toBeGreaterThan(0);
  });
});
