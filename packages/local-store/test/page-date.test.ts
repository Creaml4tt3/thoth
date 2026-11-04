// The page date in the index (ADR-0051 rule 15): frontmatter `date` when valid, kept as `page_date`, returned by
// listPages(); an index from before (schema version 2, no column) is dropped and rebuilt once, from the files.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INDEX_SCHEMA_VERSION, type Vault } from "../src/index.ts";
import { NodeSqlDriver, openNodeVault } from "../src/node/index.ts";

let root: string;
let vault: Vault;
const put = async (path: string, text: string) => {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), text);
};
const dateOf = async (path: string) => (await vault.listPages()).find((p) => p.path === path)?.date;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thoth-page-date-"));
  await put("Dated.md", "---\ndate: 2025-03-14\n---\n# Dated\n");
  await put("Timed.md", "---\ndate: 2025-03-14T09:30:00\n---\n# Timed\n");
  await put("Impossible.md", "---\ndate: 2025-02-30\n---\n# Impossible\n");
  await put("Words.md", "---\ndate: next week\n---\n# Words\n");
  await put("Plain.md", "# Plain\n");
  ({ vault } = await openNodeVault(root));
});
afterEach(async () => {
  await vault.close();
  await rm(root, { recursive: true, force: true });
});

describe("page_date", () => {
  it("keeps a valid frontmatter date (the day of a date-time) and no date otherwise", async () => {
    expect(await dateOf("Dated.md")).toBe("2025-03-14");
    expect(await dateOf("Timed.md")).toBe("2025-03-14");
    expect(await dateOf("Impossible.md")).toBeUndefined();
    expect(await dateOf("Words.md")).toBeUndefined();
    expect(await dateOf("Plain.md")).toBeUndefined();
  });

  it("follows an edit made by another app, on reconcile", async () => {
    await put("Plain.md", "---\ndate: 2026-01-02\n---\n# Plain\n");
    await vault.reconcile();
    expect(await dateOf("Plain.md")).toBe("2026-01-02");
  });

  it("rebuilds an index from the previous schema version once, filling the dates from the files", async () => {
    await vault.close();
    // Make it look like a 0.6.0 index: version 2, and no page_date column.
    const sql = new NodeSqlDriver(join(root, ".thoth", "index.sqlite"));
    await sql.exec("ALTER TABLE pages DROP COLUMN page_date");
    await sql.run("UPDATE schema_meta SET value = '2' WHERE key = 'version'");
    await sql.close();
    ({ vault } = await openNodeVault(root));
    expect(await dateOf("Dated.md")).toBe("2025-03-14");
    const check = new NodeSqlDriver(join(root, ".thoth", "index.sqlite"));
    expect(await check.get<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'version'")).toEqual({ value: String(INDEX_SCHEMA_VERSION) });
    await check.close();
  });
});
