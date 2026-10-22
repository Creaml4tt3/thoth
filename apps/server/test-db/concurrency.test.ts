import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, uuid } from "./support.ts";

describe("conditional writes", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let ws: string;
  beforeAll(async () => {
    env = await startTestEnv();
    owner = await env.user("Owner");
    ws = await env.workspace("W", { members: { [owner.userId]: "owner" } });
  });
  afterAll(() => env.close());

  it("a stale If-Match is 412 revision_conflict with currentRevision, and nothing is written", async () => {
    const { id, revisionId } = await createPage(env, owner, ws, { markdown: "v1" });
    const ok = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers: { "if-match": `"${revisionId}"` }, json: { title: "T", markdown: "v2" } });
    expect(ok.status).toBe(200);
    const stale = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers: { "if-match": `"${revisionId}"` }, json: { title: "T", markdown: "STALE" } });
    expect(stale.status).toBe(412);
    expect(stale.json.code).toBe("revision_conflict");
    expect(stale.json.currentRevision.id).toBe(ok.json.revision.id);
    expect(stale.json.currentRevision.parentId).toBe(revisionId);
    const list = await env.api(owner, "GET", `/workspaces/${ws}/pages/${id}/revisions`);
    expect(list.json.items).toHaveLength(2);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${id}`)).json.markdown).toBe("v2");
  });

  it("exactly one of many concurrent writes with the same If-Match wins; the rest get 412", async () => {
    for (let round = 0; round < 5; round++) {
      const { id, revisionId } = await createPage(env, owner, ws, { markdown: "start" });
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers: { "if-match": `"${revisionId}"` }, json: { title: `writer ${i}`, markdown: `writer ${i}` } })),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 200), `round ${round}: ${statuses}`).toHaveLength(1);
      expect(statuses.filter((s) => s === 412)).toHaveLength(11);
      const winner = results.find((r) => r.status === 200)!;
      const current = (await env.api(owner, "GET", `/workspaces/${ws}/pages/${id}`)).json;
      expect(current.revision.id).toBe(winner.json.revision.id);
      for (const loser of results.filter((r) => r.status === 412)) expect(loser.json.currentRevision.id).toBe(winner.json.revision.id);
      const revisions = (await env.api(owner, "GET", `/workspaces/${ws}/pages/${id}/revisions`)).json.items;
      expect(revisions).toHaveLength(2);
      expect(revisions[0].parentId).toBe(revisionId);
    }
  });

  it("concurrent creates of the same page: one 201, the rest 412", async () => {
    const id = uuid();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers: { "if-none-match": "*" }, json: { title: `c${i}`, markdown: `c${i}` } })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 412)).toHaveLength(9);
  });

  it("a concurrent update and delete with the same If-Match: exactly one wins", async () => {
    const { id, revisionId } = await createPage(env, owner, ws);
    const [put, del] = await Promise.all([
      env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers: { "if-match": `"${revisionId}"` }, json: { title: "x", markdown: "x" } }),
      env.api(owner, "DELETE", `/workspaces/${ws}/pages/${id}`, { headers: { "if-match": `"${revisionId}"` } }),
    ]);
    expect([put.status === 200, del.status === 204].filter(Boolean)).toHaveLength(1);
    expect([put.status, del.status].filter((s) => s === 412 || s === 404)).toHaveLength(1);
  });

  it("the change feed stays gap-free and ordered under concurrent writes from many pages", async () => {
    const ws2 = await env.workspace("Busy", { members: { [owner.userId]: "owner" } });
    await Promise.all(Array.from({ length: 40 }, () => createPage(env, owner, ws2)));
    const seen: number[] = [];
    let cursor: string | undefined;
    for (;;) {
      const res = await env.api(owner, "GET", `/workspaces/${ws2}/changes`, { query: { limit: "7", ...(cursor ? { cursor } : {}) } });
      for (const e of res.json.entries) seen.push(Number(e.id.slice(4)));
      cursor = res.json.cursor;
      if (!res.json.hasMore) break;
    }
    expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it("a change cursor never skips an entry committed after it was issued, even with writers racing the reader", async () => {
    const ws3 = await env.workspace("Racing", { members: { [owner.userId]: "owner" } });
    let stop = false;
    const writer = (async () => {
      while (!stop) await createPage(env, owner, ws3);
    })();
    const ids = new Set<string>();
    let cursor: string | undefined;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const res = await env.api(owner, "GET", `/workspaces/${ws3}/changes`, { query: { limit: "5", ...(cursor ? { cursor } : {}) } });
      for (const e of res.json.entries) ids.add(e.id);
      cursor = res.json.cursor;
    }
    stop = true;
    await writer;
    for (;;) {
      const res = await env.api(owner, "GET", `/workspaces/${ws3}/changes`, { query: { limit: "50", ...(cursor ? { cursor } : {}) } });
      for (const e of res.json.entries) ids.add(e.id);
      cursor = res.json.cursor;
      if (!res.json.hasMore) break;
    }
    const total = (await env.db.query<{ change_seq: number }>("SELECT change_seq FROM workspaces WHERE id = $1", [ws3])).rows[0]!.change_seq;
    expect(ids.size).toBe(total);
    expect(total).toBeGreaterThan(5);
  });
});
