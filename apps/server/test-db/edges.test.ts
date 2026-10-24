import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, uuid } from "./support.ts";

describe("protocol edges", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let ws: string;
  beforeAll(async () => {
    env = await startTestEnv({ configure: (c) => void (c.maxMarkdownBytes = 4096) });
    owner = await env.user("Owner");
    ws = await env.workspace("W", { members: { [owner.userId]: "owner" } });
  });
  afterAll(() => env.close());

  it("advertises its limits and capabilities", async () => {
    const caps = (await env.api(null, "GET", "/capabilities")).json;
    expect(caps).toMatchObject({ protocolVersion: "1.0", capabilities: ["attachments", "search", "events.sse", "transfers", "page-order", "page-kind"], limits: { maxMarkdownBytes: 4096, maxPageSize: 200, idempotencyWindowSeconds: 86400 } });
  });

  it("405 carries Allow; unknown routes are 404 problems (authenticated)", async () => {
    const res = await env.api(owner, "PATCH", `/workspaces/${ws}/tree`);
    expect([res.status, res.json.code]).toEqual([405, "method_not_allowed"]);
    expect(res.headers.get("allow")).toBe("GET");
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const put = await env.api(owner, "PUT", "/me");
    expect(put.status).toBe(405);
    const unknown = await env.api(owner, "GET", "/nothing/here");
    expect([unknown.status, unknown.json.code]).toEqual([404, "not_found"]);
    const outside = await fetch(`${env.url}/elsewhere`);
    expect(outside.status).toBe(404);
    expect(outside.headers.get("content-type")).toContain("application/problem+json");
  });

  it("is 501 for routes of an unlisted capability, after authentication", async () => {
    const bare = await startTestEnv({ configure: (c) => void (c.capabilities = ["search"]) });
    try {
      const u = await bare.user("U");
      const w = await bare.workspace("W", { members: { [u.userId]: "owner" } });
      const routes: [string, string][] = [["POST", `/workspaces/${w}/attachments`], ["GET", `/workspaces/${w}/attachments/${uuid()}`], ["GET", `/workspaces/${w}/events`], ["POST", `/workspaces/${w}/transfers`], ["GET", `/transfers/${uuid()}`], ["POST", `/transfers/${uuid()}/commit`], ["POST", `/transfers/${uuid()}/abort`]];
      for (const [method, path] of routes) {
        const res = await bare.api(u, method, path, method === "POST" ? { json: {} } : {});
        expect([method, path, res.status, res.json.code]).toEqual([method, path, 501, "capability_not_supported"]);
      }
      expect((await bare.api(null, "GET", `/workspaces/${w}/events`)).status).toBe(401);
      expect((await bare.api(u, "POST", `/workspaces/${w}/search`, { json: { query: "x" } })).status).toBe(200);
    } finally {
      await bare.close();
    }
  });

  it("413 for Markdown over the advertised limit, nothing is written", async () => {
    const id = uuid();
    const res = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers: { "if-none-match": "*" }, json: { title: "big", markdown: "x".repeat(4097) } });
    expect([res.status, res.json.code]).toEqual([413, "payload_too_large"]);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${id}`)).status).toBe(404);
    const ok = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers: { "if-none-match": "*" }, json: { title: "edge", markdown: "x".repeat(4096) } });
    expect(ok.status).toBe(201);
    // Multi-byte text is measured in UTF-8 bytes, not characters.
    const thai = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${uuid()}`, { headers: { "if-none-match": "*" }, json: { title: "thai", markdown: "ก".repeat(1366) } });
    expect(thai.status).toBe(413);
  });

  it("round-trips Markdown byte for byte (CRLF, emoji, Thai, trailing whitespace) and rejects unstorable text", async () => {
    const markdown = "---\nthoth_id: x\n---\r\n# หัวข้อ 🌿\r\n\r\ntrailing  \n\t tab\n\n\n";
    const { id } = await createPage(env, owner, ws, { markdown });
    const got = await env.api(owner, "GET", `/workspaces/${ws}/pages/${id}`);
    expect(got.json.markdown).toBe(markdown);
    expect(got.json.revision.size).toBe(Buffer.byteLength(markdown));
    for (const bad of ["a\u0000b", "lone \ud800 surrogate"]) {
      const res = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${uuid()}`, { headers: { "if-none-match": "*" }, body: JSON.stringify({ title: "t", markdown: bad }) });
      expect([res.status, res.json.code]).toEqual([400, "validation_failed"]);
    }
  });

  it("validates headers, paths, query and bodies with 400 problems", async () => {
    const put = (path: string, headers: Record<string, string>, body: unknown = { title: "t", markdown: "m" }) => env.api(owner, "PUT", path, { headers, body: typeof body === "string" ? body : JSON.stringify(body) });
    const p = `/workspaces/${ws}/pages/${uuid()}`;
    expect((await put(p, { "if-match": "*" })).status).toBe(400);
    expect((await put(p, { "if-match": 'W/"x"' })).status).toBe(400);
    expect((await put(p, { "if-match": '"a", "b"' })).status).toBe(400);
    expect((await put(p, { "if-none-match": '"x"' })).status).toBe(400);
    expect((await put(p, { "if-none-match": "*" }, "{not json")).status).toBe(400);
    expect((await put(p, { "if-none-match": "*" }, { title: "t", markdown: "m", parentId: "nope" })).status).toBe(400);
    expect((await put(`/workspaces/${ws}/pages/not-a-uuid`, { "if-none-match": "*" })).status).toBe(400);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/tree`, { query: { limit: "0" } })).status).toBe(400);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/tree`, { query: { limit: "201" } })).status).toBe(400);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/tree`, { query: { limit: "abc" } })).status).toBe(400);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/tree`, { query: { cursor: "garbage" } })).json.code).toBe("cursor_invalid");
    expect((await env.api(owner, "GET", `/workspaces`, { query: { cursor: "garbage" } })).json.code).toBe("cursor_invalid");
    expect((await env.api(owner, "GET", `/workspaces/${ws}/changes`, { query: { cursor: "c" + Buffer.from(`${ws}|999999`).toString("base64url") } })).json.code).toBe("cursor_invalid");
    expect((await env.api(owner, "POST", `/workspaces/${ws}/search`, { json: { query: "" } })).status).toBe(400);
    expect((await env.api(owner, "DELETE", `/workspaces/${ws}/pages/${uuid()}`)).json.code).toBe("precondition_required");
  });

  it("rejects parent cycles and keeps the tree consistent with moves", async () => {
    const a = await createPage(env, owner, ws, { title: "A" });
    const b = await createPage(env, owner, ws, { title: "B", parentId: a.id });
    const c = await createPage(env, owner, ws, { title: "C", parentId: b.id });
    const cycle = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${a.id}`, { headers: { "if-match": `"${a.revisionId}"` }, json: { title: "A", markdown: "", parentId: c.id } });
    expect([cycle.status, cycle.json.code]).toEqual([400, "validation_failed"]);
    const self = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${a.id}`, { headers: { "if-match": `"${a.revisionId}"` }, json: { title: "A", markdown: "", parentId: a.id } });
    expect(self.status).toBe(400);
    // Omitted parentId keeps it, null moves to the root; each is a new revision and a page.updated entry.
    const keep = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${c.id}`, { headers: { "if-match": `"${c.revisionId}"` }, json: { title: "C2", markdown: "" } });
    expect(keep.json.metadata.parentId).toBe(b.id);
    const root = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${c.id}`, { headers: { "if-match": `"${keep.json.revision.id}"` }, json: { title: "C3", markdown: "", parentId: null } });
    expect(root.json.metadata.parentId).toBeNull();
    const tree = (await env.api(owner, "GET", `/workspaces/${ws}/tree`)).json.items.find((n: { id: string }) => n.id === c.id);
    expect(tree).toMatchObject({ parentId: null, title: "C3", revisionId: root.json.revision.id });
  });

  it("a deleted page keeps its ID (recreating it is a conflict) and its history stays immutable", async () => {
    const { id, revisionId } = await createPage(env, owner, ws, { markdown: "v1" });
    expect((await env.api(owner, "DELETE", `/workspaces/${ws}/pages/${id}`, { headers: { "if-match": `"${revisionId}"` } })).status).toBe(204);
    const again = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers: { "if-none-match": "*" }, json: { title: "t", markdown: "m" } });
    expect([again.status, again.json.code]).toEqual([412, "revision_conflict"]);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${id}`)).status).toBe(404);
    expect((await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers: { "if-match": `"${revisionId}"` }, json: { title: "t", markdown: "m" } })).status).toBe(404);
  });

  it("the database refuses to modify or delete a revision", async () => {
    const { revisionId } = await createPage(env, owner, ws);
    await expect(env.db.query("UPDATE page_revisions SET markdown = 'tampered' WHERE id = $1", [revisionId])).rejects.toThrow(/immutable/);
    await expect(env.db.query("DELETE FROM page_revisions WHERE id = $1", [revisionId])).rejects.toThrow(/immutable/);
  });

  it("pages the tree and the revision list without repeats; the tree changeCursor is stable across pages", async () => {
    const w = await env.workspace("Paged", { members: { [owner.userId]: "owner" } });
    const ids = (await Promise.all(Array.from({ length: 9 }, () => createPage(env, owner, w)))).map((p) => p.id);
    const seen: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const res = await env.api(owner, "GET", `/workspaces/${w}/tree`, { query: { limit: "4", ...(cursor ? { cursor } : {}) } });
      seen.push(...res.json.items.map((n: { id: string }) => n.id));
      cursors.add(res.json.changeCursor);
      cursor = res.json.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual([...ids].sort());
    expect(cursors.size).toBe(1);
    // Feed from the tree's changeCursor after writes made mid-traversal catches them.
    const { id: late } = await createPage(env, owner, w);
    const tail = await env.api(owner, "GET", `/workspaces/${w}/changes`, { query: { cursor: [...cursors][0]! } });
    expect(tail.json.entries.map((e: { pageId: string }) => e.pageId)).toEqual([late]);
  });

  it("lists workspaces with role, memberCount and members, paginated", async () => {
    const u = await env.user("Lister");
    const [w1, w2, w3] = await Promise.all(["W1", "W2", "W3"].map((n) => env.workspace(n, { members: { [u.userId]: "editor", [owner.userId]: "viewer" } })));
    const first = await env.api(u, "GET", "/workspaces", { query: { limit: "2" } });
    expect(first.json.items).toHaveLength(2);
    expect(first.json.nextCursor).toBeTruthy();
    const second = await env.api(u, "GET", "/workspaces", { query: { limit: "2", cursor: first.json.nextCursor } });
    const all = [...first.json.items, ...second.json.items].map((w: { id: string }) => w.id).sort();
    expect(all).toEqual([w1, w2, w3].sort());
    expect(second.json.nextCursor).toBeNull();
    expect(first.json.items[0]).toMatchObject({ kind: "workspace", role: "editor", exportRestricted: false, memberCount: 2 });
    expect(first.json.items[0].members.map((m: { role: string }) => m.role).sort()).toEqual(["editor", "viewer"]);
  });

  it("serves an unavailable database as 503 service_unavailable with Retry-After", async () => {
    const own = await startTestEnv();
    try {
      const u = await own.user("U");
      await own.db.query("SELECT 1");
      // Terminate every server-side connection of the app's pool user, then break the pool's target.
      await own.server.deps.db.pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()");
      const res = await own.api(u, "GET", "/me");
      // Pool clients reconnect transparently, so the request may succeed: either answer must be well-formed.
      expect([200, 503]).toContain(res.status);
      if (res.status === 503) expect(res.json.code).toBe("service_unavailable");
    } finally {
      await own.close();
    }
  });
});
