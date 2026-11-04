/**
 * Page tags and date (ADR-0051 rule 16, capability `page-tags`) against the real server and PostgreSQL: derived on
 * every write with the clients' `parsePage` rules, returned on tree nodes only when the capability is listed, never for
 * a page the reader may not see, and filled for older pages by migration 018 and `backfill-tags`.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backfillPageTags } from "../src/backfill.ts";
import { createDatabase } from "../src/db.ts";
import { migrate, MIGRATIONS_DIR } from "../src/migrate.ts";
import { createTestDatabase, startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, uuid } from "./support.ts";

type Node = { id: string; tags?: string[] | null; date?: string | null; revisionId: string };
const TAGGED = "---\ntags: [project, Plan]\ndate: 2026-03-14\n---\n# Roadmap\n\nShip it #launch, not `#code`.\n";

describe("page tags and date on tree nodes", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let ws: string;
  const tree = async (who: TestPrincipal = owner) => (await env.api(who, "GET", `/workspaces/${ws}/tree`)).json.items as Node[];
  const node = async (id: string, who?: TestPrincipal) => (await tree(who)).find((n) => n.id === id);

  beforeAll(async () => {
    env = await startTestEnv();
    owner = await env.user("Owner");
    ws = await env.workspace("Tags", { members: { [owner.userId]: "owner" } });
  });
  afterAll(() => env.close());

  it("lists page-tags in the capabilities", async () => {
    expect((await env.api(null, "GET", "/capabilities")).json.capabilities).toContain("page-tags");
  });

  it("derives tags (frontmatter and inline, not in code) and the date on create and on every update", async () => {
    const page = await createPage(env, owner, ws, { markdown: TAGGED });
    expect(await node(page.id)).toMatchObject({ tags: ["project", "Plan", "launch"], date: "2026-03-14" });
    const res = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${page.id}`, { headers: { "if-match": `"${page.revisionId}"` }, json: { title: "Roadmap", markdown: "# Roadmap\n\nNo tags now.\n" } });
    expect(res.status).toBe(200);
    expect(await node(page.id)).toMatchObject({ tags: [], date: null });
    // The Markdown is still stored byte for byte.
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${page.id}`)).json.markdown).toBe("# Roadmap\n\nNo tags now.\n");
  });

  it("never fails a write because of its content: malformed frontmatter gives the inline tags and no date", async () => {
    const page = await createPage(env, owner, ws, { markdown: "---\ntags: [broken\ndate: 2026-01-01\n---\n#inline\n" });
    expect(await node(page.id)).toMatchObject({ tags: ["inline"], date: null });
    const bad = await createPage(env, owner, ws, { markdown: "---\ndate: 2026-02-30\n---\n" });
    expect(await node(bad.id)).toMatchObject({ tags: [], date: null });
  });

  it("keeps tags and date through a metadata-only move", async () => {
    const page = await createPage(env, owner, ws, { markdown: TAGGED });
    const moved = await env.api(owner, "POST", `/workspaces/${ws}/pages/${page.id}/move`, { headers: { "if-match": `"${page.revisionId}"` }, json: { position: "a0" } });
    expect(moved.json).toMatchObject({ tags: ["project", "Plan", "launch"], date: "2026-03-14" });
    expect(await node(page.id)).toMatchObject({ tags: ["project", "Plan", "launch"] });
  });
});

describe("without the capability", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let ws: string;
  beforeAll(async () => {
    env = await startTestEnv({ configure: (c) => void (c.capabilities = c.capabilities.filter((x) => x !== "page-tags")) });
    owner = await env.user("Owner");
    ws = await env.workspace("Plain", { members: { [owner.userId]: "owner" } });
  });
  afterAll(() => env.close());

  it("does not list it, and tree nodes carry no tags or date", async () => {
    expect((await env.api(null, "GET", "/capabilities")).json.capabilities).not.toContain("page-tags");
    const page = await createPage(env, owner, ws, { markdown: TAGGED });
    const n = ((await env.api(owner, "GET", `/workspaces/${ws}/tree`)).json.items as Node[]).find((x) => x.id === page.id)!;
    expect("tags" in n || "date" in n).toBe(false);
  });
});

describe("hidden pages (ADR-0042): their tags never leave the server", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let insider: TestPrincipal;
  let outsider: TestPrincipal;
  let ws: string;

  beforeAll(async () => {
    env = await startTestEnv();
    [owner, insider, outsider] = (await Promise.all(["Olive", "Ines", "Otto"].map((n) => env.user(n)))) as [TestPrincipal, TestPrincipal, TestPrincipal];
    ws = await env.workspace("Company", { members: { [owner.userId]: "owner", [insider.userId]: "editor", [outsider.userId]: "editor" } });
  });
  afterAll(() => env.close());

  it("a member outside the team sees neither the limited pages nor their tags; a member inside sees both", async () => {
    const team = (await env.api(owner, "POST", `/workspaces/${ws}/teams`, { json: { name: "Finance" } })).json.id as string;
    await env.api(owner, "PUT", `/workspaces/${ws}/teams/${team}/members/${insider.userId}`);
    const folder = (await createPage(env, owner, ws, { title: "Finance", markdown: "---\nthoth_kind: folder\ntags: [folder-secret]\n---\n" })).id;
    const secret = await createPage(env, owner, ws, { title: "Salaries", markdown: "---\ntags: [salaries-2026]\ndate: 2026-04-01\n---\n#bonus\n", parentId: folder });
    const open = await createPage(env, owner, ws, { title: "Lunch", markdown: "#lunch\n" });
    expect((await env.api(owner, "PUT", `/workspaces/${ws}/pages/${folder}/visibility`, { json: { teamIds: [team] } })).status).toBe(200);

    const outside = await env.api(outsider, "GET", `/workspaces/${ws}/tree`);
    expect(outside.json.items.map((n: Node) => n.id).sort()).toEqual([open.id]);
    for (const word of ["folder-secret", "salaries-2026", "bonus", "2026-04-01", "Salaries"]) expect(outside.text, word).not.toContain(word);

    const inside = (await env.api(insider, "GET", `/workspaces/${ws}/tree`)).json.items as Node[];
    expect(inside.find((n) => n.id === secret.id)).toMatchObject({ tags: ["salaries-2026", "bonus"], date: "2026-04-01" });
  });
});

describe("migration 018_page_tags and backfill-tags", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: pg.Pool;
  const ids = { tagged: uuid(), plain: uuid(), deleted: uuid(), other: uuid() };

  /** A page with one revision, as a pre-018 build wrote it: no tags anywhere. */
  async function insertOld(workspace: string, id: string, markdown: string, extra: { deleted?: boolean } = {}) {
    const revision = `rev_${id}`;
    await pool.query("BEGIN");
    await pool.query(`INSERT INTO pages (workspace_id, id, parent_id, title, current_revision_id, revision_count, created_at, updated_at, deleted_at) VALUES ($1, $2, NULL, 'Old', $3, 1, now(), now(), $4)`, [workspace, id, revision, extra.deleted ? new Date() : null]);
    await pool.query(`INSERT INTO page_revisions (id, workspace_id, page_id, rev_no, created_at, title, markdown, size, content_hash) VALUES ($1, $2, $3, 1, now(), 'Old', $4, $5, $6)`, [revision, workspace, id, markdown, Buffer.byteLength(markdown), "0".repeat(64)]);
    await pool.query("COMMIT");
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = new pg.Pool({ connectionString: database.url, max: 3 });
    // Everything before 018, as on a live database deployed with 0.6.0.
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_.+\.sql$/.test(f) && f < "018").sort();
    for (const file of files) await pool.query(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
    await pool.query("INSERT INTO workspaces (id, name, change_seq) VALUES ('ws_old', 'Old', 0), ('ws_two', 'Two', 0)");
    await insertOld("ws_old", ids.tagged, TAGGED);
    await insertOld("ws_old", ids.plain, "# Plain\n");
    await insertOld("ws_old", ids.deleted, "#gone\n", { deleted: true });
    await insertOld("ws_two", ids.other, "---\ntag: solo\n---\n");
  });
  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  it("is additive: existing rows read as NULL, and applying it twice is harmless", async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, "018_page_tags.sql"), "utf8");
    await pool.query(sql);
    await pool.query(sql);
    expect((await pool.query("SELECT DISTINCT tags, page_date FROM pages")).rows).toEqual([{ tags: null, page_date: null }]);
  });

  it("the shipped migrations include it", async () => {
    const fresh = await createTestDatabase();
    const p = new pg.Pool({ connectionString: fresh.url, max: 2 });
    try {
      expect((await migrate(p)).applied).toContain("018_page_tags.sql");
    } finally {
      await p.end();
      await fresh.drop();
    }
  });

  it("backfill fills every page in batches, touches nothing else, and a second run has nothing to do", async () => {
    const before = (await pool.query("SELECT workspace_id, id, updated_at, current_revision_id FROM pages ORDER BY id")).rows;
    const db = createDatabase(database.url, { max: 2 });
    try {
      const batches: number[] = [];
      expect(await backfillPageTags(db, { batchSize: 1, onBatch: (p) => batches.push(p.scanned) })).toEqual({ pages: { scanned: 4, updated: 4 } });
      expect(batches).toEqual([1, 2, 3, 4]);
      const rows = Object.fromEntries((await pool.query<{ id: string; tags: string[]; page_date: string | null }>("SELECT id, tags, page_date FROM pages")).rows.map((r) => [r.id, [r.tags, r.page_date]]));
      expect(rows).toEqual({ [ids.tagged]: [["project", "Plan", "launch"], "2026-03-14"], [ids.plain]: [[], null], [ids.deleted]: [["gone"], null], [ids.other]: [["solo"], null] });
      expect((await pool.query("SELECT workspace_id, id, updated_at, current_revision_id FROM pages ORDER BY id")).rows).toEqual(before);
      expect((await pool.query("SELECT count(*)::int AS n FROM changes")).rows).toEqual([{ n: 0 }]);
      expect(await backfillPageTags(db)).toEqual({ pages: { scanned: 0, updated: 0 } });
    } finally {
      await db.close();
    }
  });

  it("never overwrites tags a write has already derived, and refuses a bad batch size", async () => {
    const id = uuid();
    await insertOld("ws_two", id, "#old\n");
    await pool.query("UPDATE pages SET tags = ARRAY['new'] WHERE id = $1", [id]);
    const db = createDatabase(database.url, { max: 2 });
    try {
      await backfillPageTags(db);
      expect((await pool.query("SELECT tags FROM pages WHERE id = $1", [id])).rows).toEqual([{ tags: ["new"] }]);
      await expect(backfillPageTags(db, { batchSize: 0 })).rejects.toThrow(/batch size/);
    } finally {
      await db.close();
    }
  });
});
