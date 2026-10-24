import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backfillPageKind } from "../src/backfill.ts";
import { createDatabase } from "../src/db.ts";
import { migrate, MIGRATIONS_DIR } from "../src/migrate.ts";
import { createTestDatabase, startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, createTransfer, toWorkspacePlan, uuid } from "./support.ts";

const FOLDER = "---\nthoth_id: x\nthoth_kind: folder\n---\n";
const PLAIN = "# Plain\n";
/** Frontmatter that does not parse (an unclosed flow sequence). */
const MALFORMED = "---\nthoth_kind: [folder\n---\n# Broken\n";

/** Page kind (capability `page-kind`, ADR-0017): derived from frontmatter `thoth_kind` on every write. */
describe("page kind derived from frontmatter", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let ws: string;
  const put = (id: string, headers: Record<string, string>, json: Record<string, unknown>) => env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers, json: { title: "Page", markdown: PLAIN, ...json } });
  const tree = async () => (await env.api(owner, "GET", `/workspaces/${ws}/tree`)).json as { items: { id: string; kind?: string | null; revisionId: string }[]; changeCursor: string };
  const kindInTree = async (id: string) => (await tree()).items.find((n) => n.id === id)?.kind;
  const changesAfter = async (cursor: string) => (await env.api(owner, "GET", `/workspaces/${ws}/changes`, { query: { cursor } })).json.entries as { kind: string; pageId?: string; pageKind?: string | null }[];

  beforeAll(async () => {
    env = await startTestEnv();
    owner = await env.user("Owner");
    ws = await env.workspace("Kinds", { members: { [owner.userId]: "owner" } });
  });
  afterAll(() => env.close());

  it("lists page-kind in the capabilities", async () => {
    expect((await env.api(null, "GET", "/capabilities")).json.capabilities).toContain("page-kind");
  });

  it("derives the kind on create: folder, page and unknown (malformed frontmatter never fails the write)", async () => {
    const folder = await createPage(env, owner, ws, { markdown: FOLDER });
    const plain = await createPage(env, owner, ws, { markdown: PLAIN });
    const other = await createPage(env, owner, ws, { markdown: "---\nthoth_kind: database\n---\n" });
    const body = await createPage(env, owner, ws, { markdown: "# thoth_kind: folder\n\nthoth_kind: folder\n" });
    const broken = await createPage(env, owner, ws, { markdown: MALFORMED });
    expect(broken.res.status).toBe(201);
    expect(folder.res.json.metadata.kind).toBe("folder");
    expect(plain.res.json.metadata.kind).toBe("page");
    expect(other.res.json.metadata.kind).toBe("page");
    expect(body.res.json.metadata.kind).toBe("page"); // only the frontmatter counts
    expect(broken.res.json.metadata.kind).toBeNull();
    // The Markdown is still stored byte for byte, whatever its kind.
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${broken.id}`)).json.markdown).toBe(MALFORMED);
    const t = await tree();
    const kinds = Object.fromEntries(t.items.map((n) => [n.id, n.kind]));
    expect(kinds).toMatchObject({ [folder.id]: "folder", [plain.id]: "page", [other.id]: "page", [body.id]: "page", [broken.id]: null });
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${folder.id}`)).json.metadata.kind).toBe("folder");
  });

  it("re-derives the kind on every update, and the change feed carries it as pageKind", async () => {
    const { changeCursor } = await tree();
    const id = uuid();
    const created = await put(id, { "if-none-match": "*" }, { markdown: PLAIN });
    const toFolder = await put(id, { "if-match": `"${created.json.revision.id}"` }, { markdown: FOLDER });
    expect(toFolder.json.metadata.kind).toBe("folder");
    expect(await kindInTree(id)).toBe("folder");
    const toBroken = await put(id, { "if-match": `"${toFolder.json.revision.id}"` }, { markdown: MALFORMED });
    expect(toBroken.status).toBe(200);
    expect(toBroken.json.metadata.kind).toBeNull();
    expect(await kindInTree(id)).toBeNull();
    const toPage = await put(id, { "if-match": `"${toBroken.json.revision.id}"` }, { markdown: PLAIN });
    expect(toPage.json.metadata.kind).toBe("page");
    expect(await kindInTree(id)).toBe("page");
    const entries = (await changesAfter(changeCursor)).filter((e) => e.pageId === id);
    expect(entries.map((e) => [e.kind, e.pageKind])).toEqual([["page.created", "page"], ["page.updated", "folder"], ["page.updated", null], ["page.updated", "page"]]);
  });

  it("keeps the kind through a metadata-only move, in the tree node, the page and the feed", async () => {
    const folder = await createPage(env, owner, ws, { markdown: FOLDER });
    const { changeCursor } = await tree();
    const moved = await env.api(owner, "POST", `/workspaces/${ws}/pages/${folder.id}/move`, { headers: { "if-match": `"${folder.revisionId}"` }, json: { position: "a0" } });
    expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({ id: folder.id, position: "a0", kind: "folder" });
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${folder.id}`)).json.metadata).toMatchObject({ position: "a0", kind: "folder" });
    expect(await kindInTree(folder.id)).toBe("folder");
    expect(await changesAfter(changeCursor)).toEqual([expect.objectContaining({ kind: "page.updated", pageId: folder.id, pageKind: "folder" })]);
    // A later content write moves nothing back: the kind follows the new Markdown, the position stays.
    const edit = await put(folder.id, { "if-match": `"${folder.revisionId}"` }, { markdown: PLAIN });
    expect(edit.json.metadata).toMatchObject({ position: "a0", kind: "page" });
  });

  it("reports the kind of the revision returned for an older revision", async () => {
    const id = uuid();
    const first = await put(id, { "if-none-match": "*" }, { markdown: FOLDER });
    await put(id, { "if-match": `"${first.json.revision.id}"` }, { markdown: PLAIN });
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${id}`)).json.metadata.kind).toBe("page");
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${id}`, { query: { revision: first.json.revision.id } })).json.metadata.kind).toBe("folder");
  });

  it("derives the kind of transferred pages when the transfer commits", async () => {
    const pageId = uuid();
    const plan = toWorkspacePlan(pageId, uuid(), FOLDER);
    expect((await createTransfer(env, owner, ws, plan)).status).toBe(201);
    expect((await env.api(owner, "POST", `/transfers/${plan.operationId}/commit`, { json: {} })).json.state).toBe("done");
    expect(await kindInTree(pageId)).toBe("folder");
  });

  it("ignores a kind sent by the client: the Markdown is the only source", async () => {
    const id = uuid();
    const res = await put(id, { "if-none-match": "*" }, { markdown: PLAIN, kind: "folder" });
    expect(res.status).toBe(201);
    expect(res.json.metadata.kind).toBe("page");
  });

  it("omits kind and pageKind when the capability is not listed, but still stores it", async () => {
    const off = await startTestEnv({ configure: (c) => void (c.capabilities = c.capabilities.filter((x) => x !== "page-kind")) });
    try {
      const who = await off.user("Owner");
      const space = await off.workspace("W", { members: { [who.userId]: "owner" } });
      const page = await createPage(off, who, space, { markdown: FOLDER });
      expect(page.res.json.metadata).not.toHaveProperty("kind");
      const treeJson = (await off.api(who, "GET", `/workspaces/${space}/tree`)).json;
      expect(treeJson.items[0]).not.toHaveProperty("kind");
      const feed = (await off.api(who, "GET", `/workspaces/${space}/changes`)).json.entries[0];
      expect(feed).not.toHaveProperty("pageKind");
      expect((await off.db.query("SELECT kind FROM pages WHERE id = $1", [page.id])).rows).toEqual([{ kind: "folder" }]);
    } finally {
      await off.close();
    }
  });
});

describe("migration 009_page_kind and the backfill", () => {
  const run = promisify(execFile);
  const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: pg.Pool;
  const ids = { folder: uuid(), plain: uuid(), broken: uuid(), moved: uuid(), deleted: uuid(), second: uuid() };

  /** Inserts a page with one revision and its feed entry the way a pre-009 build did: no kind anywhere. */
  async function insertOld(workspace: string, id: string, markdown: string, seq: number, extra: { deleted?: boolean } = {}): Promise<string> {
    const revision = `rev_${id}`;
    await pool.query("BEGIN");
    await pool.query(
      `INSERT INTO pages (workspace_id, id, parent_id, title, current_revision_id, revision_count, created_at, updated_at, deleted_at) VALUES ($1, $2, NULL, 'Old', $3, 1, now(), now(), $4)`,
      [workspace, id, revision, extra.deleted ? new Date() : null],
    );
    await pool.query(`INSERT INTO page_revisions (id, workspace_id, page_id, rev_no, created_at, title, markdown, size, content_hash) VALUES ($1, $2, $3, 1, now(), 'Old', $4, $5, $6)`, [revision, workspace, id, markdown, Buffer.byteLength(markdown), "0".repeat(64)]);
    await pool.query("INSERT INTO changes (workspace_id, seq, kind, occurred_at, page_id, revision_id, title) VALUES ($1, $2, 'page.created', now(), $3, $4, 'Old')", [workspace, seq, id, revision]);
    await pool.query("COMMIT");
    return revision;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = new pg.Pool({ connectionString: database.url, max: 3 });
    // Everything before 009, as on a live database deployed before this change.
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_.+\.sql$/.test(f) && f < "009").sort();
    for (const file of files) await pool.query(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
    await pool.query("INSERT INTO workspaces (id, name, change_seq) VALUES ('ws_old', 'Old', 5), ('ws_two', 'Two', 1)");
    await insertOld("ws_old", ids.folder, FOLDER, 1);
    await insertOld("ws_old", ids.plain, PLAIN, 2);
    await insertOld("ws_old", ids.broken, MALFORMED, 3);
    await insertOld("ws_old", ids.moved, FOLDER, 4);
    await insertOld("ws_old", ids.deleted, FOLDER, 5, { deleted: true });
    await insertOld("ws_two", ids.second, FOLDER, 1);
  });
  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  it("is additive: existing rows read as NULL, and applying it twice is harmless", async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, "009_page_kind.sql"), "utf8");
    await pool.query(sql);
    await pool.query(sql);
    expect((await pool.query("SELECT DISTINCT kind FROM pages")).rows).toEqual([{ kind: null }]);
    expect((await pool.query("SELECT DISTINCT page_kind FROM changes")).rows).toEqual([{ page_kind: null }]);
  });

  it("the shipped migrations include it", async () => {
    const fresh = await createTestDatabase();
    const p = new pg.Pool({ connectionString: fresh.url, max: 2 });
    try {
      expect((await migrate(p)).applied).toContain("009_page_kind.sql");
    } finally {
      await p.end();
      await fresh.drop();
    }
  });

  it("backfill fills pages and change entries in small batches, leaves malformed ones unknown, and touches nothing else", async () => {
    const before = (await pool.query("SELECT workspace_id, id, updated_at, current_revision_id FROM pages ORDER BY id")).rows;
    const db = createDatabase(database.url, { max: 2 });
    try {
      const batches: string[] = [];
      const result = await backfillPageKind(db, { batchSize: 2, onBatch: (p) => batches.push(`${p.table}:${p.scanned}`) });
      expect(result).toEqual({ pages: { scanned: 6, updated: 5, unknown: 1 }, changes: { scanned: 6, updated: 5, unknown: 1 } });
      expect(batches.length).toBeGreaterThan(2); // 6 rows in batches of 2, per table
      const kinds = Object.fromEntries((await pool.query<{ id: string; kind: string | null }>("SELECT id, kind FROM pages")).rows.map((r) => [r.id, r.kind]));
      expect(kinds).toEqual({ [ids.folder]: "folder", [ids.plain]: "page", [ids.broken]: null, [ids.moved]: "folder", [ids.deleted]: "folder", [ids.second]: "folder" });
      const feed = (await pool.query<{ page_id: string; page_kind: string | null }>("SELECT page_id, page_kind FROM changes")).rows;
      expect(Object.fromEntries(feed.map((r) => [r.page_id, r.page_kind]))).toEqual(kinds);
      expect((await pool.query("SELECT workspace_id, id, updated_at, current_revision_id FROM pages ORDER BY id")).rows).toEqual(before);
      expect((await pool.query("SELECT change_seq FROM workspaces ORDER BY id")).rows).toEqual([{ change_seq: "5" }, { change_seq: "1" }]);
      // Repeating it changes nothing: only the malformed page is read again.
      expect(await backfillPageKind(db)).toEqual({ pages: { scanned: 1, updated: 0, unknown: 1 }, changes: { scanned: 1, updated: 0, unknown: 1 } });
    } finally {
      await db.close();
    }
  });

  it("backfill never overwrites a kind that a write has already derived", async () => {
    const id = uuid();
    await insertOld("ws_two", id, FOLDER, 2);
    // A write got there first: the row already has a kind.
    await pool.query("UPDATE pages SET kind = 'page' WHERE id = $1", [id]);
    const db = createDatabase(database.url, { max: 2 });
    try {
      await backfillPageKind(db);
      expect((await pool.query("SELECT kind FROM pages WHERE id = $1", [id])).rows).toEqual([{ kind: "page" }]);
    } finally {
      await db.close();
    }
  });

  it("rejects a batch size outside 1 to 1000", async () => {
    const db = createDatabase(database.url, { max: 1 });
    try {
      await expect(backfillPageKind(db, { batchSize: 0 })).rejects.toThrow(/batch size/);
      await expect(backfillPageKind(db, { batchSize: 1001 })).rejects.toThrow(/batch size/);
    } finally {
      await db.close();
    }
  });

  it("the CLI: migrate hints at backfill-kind when it applies 009, and backfill-kind prints the counts", async () => {
    const cli = async (args: string[], url: string) => {
      try {
        const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", DATABASE_URL: url } });
        return { code: 0, stdout, stderr };
      } catch (error) {
        const e = error as { code: number; stdout: string; stderr: string };
        return { code: e.code, stdout: e.stdout, stderr: e.stderr };
      }
    };
    const fresh = await createTestDatabase();
    try {
      const first = await cli(["migrate"], fresh.url);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain("009_page_kind.sql");
      expect(first.stdout).toMatch(/hint: .*backfill-kind/);
      const again = await cli(["migrate"], fresh.url);
      expect(again.stdout).toContain("up to date");
      expect(again.stdout).not.toContain("hint:");
      const empty = await cli(["backfill-kind"], fresh.url);
      expect(empty.code).toBe(0);
      expect(JSON.parse(empty.stdout)).toEqual({ pages: { scanned: 0, updated: 0, unknown: 0 }, changes: { scanned: 0, updated: 0, unknown: 0 } });
      expect((await cli(["backfill-kind", "--batch", "0"], fresh.url)).code).toBe(2);
      expect((await cli(["backfill-kind", "--batch", "5000"], fresh.url)).code).toBe(2);
      expect((await cli(["backfill-kind", "--batch", "abc"], fresh.url)).code).toBe(2);
    } finally {
      await fresh.drop();
    }
    // And on the old database from above, through the CLI.
    const viaCli = await cli(["backfill-kind", "--batch", "3"], database.url);
    expect(viaCli.code).toBe(0);
    expect(JSON.parse(viaCli.stdout).pages.updated).toBe(0); // already filled in by the earlier test
  });
});
