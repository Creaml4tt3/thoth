import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, MIGRATIONS_DIR } from "../src/migrate.ts";
import { createTestDatabase, startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, toWorkspacePlan, createTransfer, uuid } from "./support.ts";

/** Page order (capability `page-order`, ADR-0016 rule 4): `position` on putPage, the tree and the feed; `movePage` without a revision. */
describe("page position and metadata-only moves", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let viewer: TestPrincipal;
  let ws: string;
  const put = (id: string, headers: Record<string, string>, json: Record<string, unknown>) => env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers, json: { title: "Page", markdown: "# Page\n", ...json } });
  const move = (who: TestPrincipal, id: string, json: unknown, etag?: string, headers: Record<string, string> = {}) =>
    env.api(who, "POST", `/workspaces/${ws}/pages/${id}/move`, { headers: { ...(etag === undefined ? {} : { "if-match": `"${etag}"` }), ...headers }, json });
  const tree = async () => (await env.api(owner, "GET", `/workspaces/${ws}/tree`)).json as { items: { id: string; parentId: string | null; position?: string | null; revisionId: string }[]; changeCursor: string };
  const changesAfter = async (cursor: string) => (await env.api(owner, "GET", `/workspaces/${ws}/changes`, { query: { cursor } })).json.entries as { kind: string; pageId?: string; revisionId?: string; parentId?: string | null; position?: string | null }[];

  beforeAll(async () => {
    env = await startTestEnv();
    owner = await env.user("Owner");
    viewer = await env.user("Viewer");
    ws = await env.workspace("Ordered", { members: { [owner.userId]: "owner", [viewer.userId]: "viewer" } });
  });
  afterAll(() => env.close());

  it("lists page-order in the capabilities", async () => {
    expect((await env.api(null, "GET", "/capabilities")).json.capabilities).toContain("page-order");
  });

  it("stores a position on create, keeps it on an update without one, clears it with null, and reports it in the tree and the feed", async () => {
    const { changeCursor } = await tree();
    const id = uuid();
    const created = await put(id, { "if-none-match": "*" }, { position: "a0" });
    expect(created.status).toBe(201);
    expect(created.json.metadata.position).toBe("a0");
    const kept = await put(id, { "if-match": `"${created.json.revision.id}"` }, { markdown: "# Page\nmore\n" });
    expect(kept.status).toBe(200);
    expect(kept.json.metadata.position).toBe("a0");
    expect((await tree()).items.find((n) => n.id === id)?.position).toBe("a0");
    const cleared = await put(id, { "if-match": `"${kept.json.revision.id}"` }, { position: null });
    expect(cleared.json.metadata.position).toBeNull();
    const entries = (await changesAfter(changeCursor)).filter((e) => e.pageId === id);
    expect(entries.map((e) => e.position)).toEqual(["a0", "a0", null]);
    const plain = await createPage(env, owner, ws);
    expect((await tree()).items.find((n) => n.id === plain.id)?.position).toBeNull();
  });

  it("refuses a malformed position", async () => {
    expect((await put(uuid(), { "if-none-match": "*" }, { position: "a 0" })).json.code).toBe("validation_failed");
    expect((await put(uuid(), { "if-none-match": "*" }, { position: "x".repeat(129) })).status).toBe(400);
  });

  it("moves a page to a new parent and position without a new revision, and the feed records page.updated", async () => {
    const parent = await createPage(env, owner, ws, { title: "Folder" });
    const page = await createPage(env, owner, ws, { title: "Moved" });
    const { changeCursor } = await tree();
    const res = await move(owner, page.id, { parentId: parent.id, position: "Zz" }, page.revisionId);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(`"${page.revisionId}"`);
    expect(res.json).toMatchObject({ id: page.id, parentId: parent.id, position: "Zz", title: "Moved", revisionId: page.revisionId });
    const revisions = await env.api(owner, "GET", `/workspaces/${ws}/pages/${page.id}/revisions`);
    expect(revisions.json.items).toHaveLength(1);
    const get = await env.api(owner, "GET", `/workspaces/${ws}/pages/${page.id}`);
    expect(get.headers.get("etag")).toBe(`"${page.revisionId}"`);
    expect(get.json.metadata).toMatchObject({ parentId: parent.id, position: "Zz" });
    // `?revision=` of the current revision reads parent and position from the page row too.
    const same = await env.api(owner, "GET", `/workspaces/${ws}/pages/${page.id}`, { query: { revision: page.revisionId } });
    expect(same.json.metadata).toMatchObject({ parentId: parent.id, position: "Zz" });
    const entries = await changesAfter(changeCursor);
    expect(entries).toEqual([expect.objectContaining({ kind: "page.updated", pageId: page.id, revisionId: page.revisionId, parentId: parent.id, position: "Zz" })]);
    // A later content write keeps the moved parent and position.
    const edit = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${page.id}`, { headers: { "if-match": `"${page.revisionId}"` }, json: { title: "Moved", markdown: "# Moved\nedited\n" } });
    expect(edit.json.metadata).toMatchObject({ parentId: parent.id, position: "Zz" });
    // Once it is historical, a revision shows where the page was when it was written, and no position.
    const back = await env.api(owner, "GET", `/workspaces/${ws}/pages/${page.id}`, { query: { revision: page.revisionId } });
    expect(back.json.metadata).toMatchObject({ parentId: null, position: null });
    const root = await move(owner, page.id, { parentId: null }, edit.json.revision.id);
    expect(root.json).toMatchObject({ parentId: null, position: "Zz" });
  });

  it("answers 428 without If-Match, 412 with a stale one, 400 for cycles and empty bodies, 404 for unknown pages", async () => {
    const parent = await createPage(env, owner, ws);
    const child = await createPage(env, owner, ws, { parentId: parent.id });
    expect((await move(owner, child.id, { position: "a0" })).json.code).toBe("precondition_required");
    const stale = await move(owner, child.id, { position: "a0" }, "rev_stale");
    expect(stale.status).toBe(412);
    expect(stale.json.currentRevision.id).toBe(child.revisionId);
    expect((await move(owner, child.id, { parentId: child.id }, child.revisionId)).json.code).toBe("validation_failed");
    expect((await move(owner, parent.id, { parentId: child.id }, parent.revisionId)).json.code).toBe("validation_failed");
    expect((await move(owner, child.id, {}, child.revisionId)).json.code).toBe("validation_failed");
    expect((await move(owner, uuid(), { position: "a0" }, child.revisionId)).status).toBe(404);
    // Nothing above changed the page.
    expect((await tree()).items.find((n) => n.id === child.id)).toMatchObject({ parentId: parent.id, position: null });
  });

  it("forbids viewers and replays an idempotent move once", async () => {
    const page = await createPage(env, owner, ws);
    expect((await move(viewer, page.id, { position: "a0" }, page.revisionId)).status).toBe(403);
    const { changeCursor } = await tree();
    const key = { "idempotency-key": `move-${uuid()}` };
    const first = await move(owner, page.id, { position: "b0" }, page.revisionId, key);
    const replay = await move(owner, page.id, { position: "b0" }, page.revisionId, key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json).toEqual(first.json);
    expect((await changesAfter(changeCursor)).filter((e) => e.pageId === page.id)).toHaveLength(1);
    expect((await move(owner, page.id, { position: "c0" }, page.revisionId, key)).json.code).toBe("idempotency_key_reused");
  });

  it("publishes transferred pages without a position", async () => {
    const pageId = uuid();
    const plan = toWorkspacePlan(pageId);
    expect((await createTransfer(env, owner, ws, plan)).status).toBe(201);
    expect((await env.api(owner, "POST", `/transfers/${plan.operationId}/commit`, { json: {} })).json.state).toBe("done");
    expect((await tree()).items.find((n) => n.id === pageId)?.position).toBeNull();
  });

  it("answers 501 when the capability is off", async () => {
    const off = await startTestEnv({ configure: (c) => void (c.capabilities = c.capabilities.filter((x) => x !== "page-order")) });
    try {
      const who = await off.user("Owner");
      const space = await off.workspace("W", { members: { [who.userId]: "owner" } });
      const page = await createPage(off, who, space);
      const res = await off.api(who, "POST", `/workspaces/${space}/pages/${page.id}/move`, { headers: { "if-match": `"${page.revisionId}"` }, json: { position: "a0" } });
      expect(res.json.code).toBe("capability_not_supported");
    } finally {
      await off.close();
    }
  });
});

describe("migration 008_page_position", () => {
  it("applies to a database that already holds pages and changes, which then read as unpositioned", async () => {
    const database = await createTestDatabase();
    const pool = new pg.Pool({ connectionString: database.url, max: 2 });
    try {
      // Apply everything before 008 by hand, as on a live database deployed before this change.
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_.+\.sql$/.test(f) && f < "008").sort();
      for (const file of files) await pool.query(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
      await pool.query("INSERT INTO workspaces (id, name) VALUES ('ws_old', 'Old')");
      await pool.query("BEGIN");
      await pool.query(
        `INSERT INTO pages (workspace_id, id, parent_id, title, current_revision_id, revision_count, created_at, updated_at) VALUES ('ws_old', $1, NULL, 'Old', 'rev_old', 1, now(), now())`,
        [uuid()],
      );
      await pool.query(
        `INSERT INTO page_revisions (id, workspace_id, page_id, rev_no, created_at, title, markdown, size, content_hash) SELECT 'rev_old', 'ws_old', id, 1, now(), 'Old', '', 0, $1 FROM pages`,
        ["0".repeat(64)],
      );
      await pool.query("INSERT INTO changes (workspace_id, seq, kind, occurred_at) VALUES ('ws_old', 1, 'page.created', now())");
      await pool.query("COMMIT");
      await pool.query(await readFile(join(MIGRATIONS_DIR, "008_page_position.sql"), "utf8"));
      // Applying it again is harmless (IF NOT EXISTS).
      await pool.query(await readFile(join(MIGRATIONS_DIR, "008_page_position.sql"), "utf8"));
      expect((await pool.query("SELECT position FROM pages")).rows).toEqual([{ position: null }]);
      expect((await pool.query("SELECT position FROM changes")).rows).toEqual([{ position: null }]);
    } finally {
      await pool.end();
      await database.drop();
    }
  });

  it("is part of the shipped migrations", async () => {
    const database = await createTestDatabase();
    const pool = new pg.Pool({ connectionString: database.url, max: 2 });
    try {
      expect((await migrate(pool)).applied).toContain("008_page_position.sql");
    } finally {
      await pool.end();
      await database.drop();
    }
  });
});
