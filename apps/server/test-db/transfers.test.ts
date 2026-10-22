import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, createTransfer, toWorkspacePlan, uuid } from "./support.ts";

describe("transfers", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let ws: string;
  beforeAll(async () => {
    env = await startTestEnv();
    owner = await env.user("Owner");
    ws = await env.workspace("W", { members: { [owner.userId]: "owner" } });
  });
  afterAll(() => env.close());

  const commit = (op: string, json?: unknown) => env.api(owner, "POST", `/transfers/${op}/commit`, json === undefined ? {} : { json });

  it("stages invisibly, commits all pages atomically with parent links, and preserves page IDs", async () => {
    const root = uuid();
    const child = uuid();
    const plan = {
      operationId: uuid(), direction: "to_workspace" as const, mode: "move" as const,
      pages: [
        { sourceId: "local:a", pageId: child, parentId: root, title: "Child", markdown: "# child\n" },
        { sourceId: "local:b", pageId: root, parentId: null, title: "Root", markdown: "# root\nไทย\n" },
      ],
    };
    const head = (await env.api(owner, "GET", `/workspaces/${ws}/changes`)).json.cursor;
    const created = await createTransfer(env, owner, ws, plan);
    expect(created.status).toBe(201);
    expect(created.json.items.map((i: { state: string; sourceId: string }) => [i.state, i.sourceId])).toEqual([["staged", "local:a"], ["staged", "local:b"]]);
    expect(created.headers.get("location")).toBe(`/api/v1/transfers/${plan.operationId}`);
    // Staged: invisible to every page route, the tree, search and the feed.
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${root}`)).status).toBe(404);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/tree`)).json.items).toEqual([]);
    expect((await env.api(owner, "POST", `/workspaces/${ws}/search`, { json: { query: "root" } })).json.items).toEqual([]);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/changes`, { query: { cursor: head } })).json.entries).toEqual([]);

    const done = await commit(plan.operationId);
    expect(done.status).toBe(200);
    expect(done.json.state).toBe("done");
    expect(done.json.items.every((i: { state: string; revisionId: string }) => i.state === "committed" && i.revisionId)).toBe(true);
    const page = await env.api(owner, "GET", `/workspaces/${ws}/pages/${child}`);
    expect(page.json.metadata.parentId).toBe(root);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${root}`)).json.markdown).toBe("# root\nไทย\n");
    const feed = (await env.api(owner, "GET", `/workspaces/${ws}/changes`, { query: { cursor: head } })).json.entries;
    expect(feed.map((e: { kind: string }) => e.kind)).toEqual(["page.created", "page.created"]);
    // Staged markdown is dropped once published.
    expect((await env.db.query("SELECT 1 FROM transfer_items WHERE operation_id = $1 AND markdown IS NOT NULL", [plan.operationId])).rowCount).toBe(0);
  });

  it("commit is all-or-nothing: a pageId taken meanwhile fails the transfer and publishes nothing", async () => {
    const taken = uuid();
    const other = uuid();
    const plan = { ...toWorkspacePlan(), pages: [
      { sourceId: "s1", pageId: other, parentId: null, title: "Other", markdown: "o" },
      { sourceId: "s2", pageId: taken, parentId: null, title: "Taken", markdown: "t" },
    ] };
    expect((await createTransfer(env, owner, ws, plan)).status).toBe(201);
    await createPage(env, owner, ws, { id: taken });
    const res = await commit(plan.operationId);
    expect([res.status, res.json.code]).toEqual([409, "invalid_transfer_state"]);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${other}`)).status).toBe(404);
    const state = await env.api(owner, "GET", `/transfers/${plan.operationId}`);
    expect(state.json.state).toBe("failed");
    expect(state.json.error.code).toBe("validation_failed");
    expect((await commit(plan.operationId)).status).toBe(409);
  });

  it("rejects bad plans without staging anything", async () => {
    const taken = (await createPage(env, owner, ws)).id;
    const cases: [string, Record<string, unknown>, number, string][] = [
      ["existing pageId", { ...toWorkspacePlan(taken) }, 400, "validation_failed"],
      ["duplicate pageId", { ...toWorkspacePlan(), pages: [toWorkspacePlan("0191a3a0-0000-7000-8000-000000000001").pages[0], toWorkspacePlan("0191a3a0-0000-7000-8000-000000000001").pages[0]] }, 400, "validation_failed"],
      ["self parent", (() => { const p = toWorkspacePlan(); p.pages[0]!.parentId = p.pages[0]!.pageId as never; return p; })(), 400, "validation_failed"],
      ["parent cycle", (() => { const a = uuid(); const b = uuid(); return { ...toWorkspacePlan(), pages: [{ sourceId: "a", pageId: a, parentId: b, title: "a", markdown: "" }, { sourceId: "b", pageId: b, parentId: a, title: "b", markdown: "" }] }; })(), 400, "validation_failed"],
      ["unknown attachment", { ...toWorkspacePlan(), attachmentIds: [uuid()] }, 400, "validation_failed"],
      ["NUL in markdown", toWorkspacePlan(uuid(), uuid(), "a\u0000b"), 400, "validation_failed"],
    ];
    for (const [name, plan, status, code] of cases) {
      const res = await createTransfer(env, owner, ws, plan as never);
      expect([name, res.status, res.json.code]).toEqual([name, status, code]);
      expect((await env.db.query("SELECT 1 FROM transfers WHERE operation_id = $1", [plan.operationId])).rowCount, name).toBe(0);
    }
  });

  it("requires Idempotency-Key equal to operationId", async () => {
    const plan = toWorkspacePlan();
    for (const headers of [{}, { "idempotency-key": uuid() }] as Record<string, string>[]) {
      const res = await env.api(owner, "POST", `/workspaces/${ws}/transfers`, { headers, json: plan });
      expect([res.status, res.json.code]).toEqual([400, "validation_failed"]);
    }
  });

  it("abort discards staged content, is repeatable, and blocks commit", async () => {
    const plan = toWorkspacePlan();
    await createTransfer(env, owner, ws, plan);
    const a = await env.api(owner, "POST", `/transfers/${plan.operationId}/abort`);
    expect([a.status, a.json.state, a.json.items[0].state]).toEqual([200, "aborted", "skipped"]);
    expect((await env.api(owner, "POST", `/transfers/${plan.operationId}/abort`)).status).toBe(200);
    expect((await env.db.query("SELECT 1 FROM transfer_items WHERE operation_id = $1 AND (markdown IS NOT NULL OR title IS NOT NULL)", [plan.operationId])).rowCount).toBe(0);
    expect((await commit(plan.operationId)).json.code).toBe("invalid_transfer_state");
  });

  it("a committed transfer cannot be aborted; commit twice is the same answer", async () => {
    const plan = toWorkspacePlan();
    await createTransfer(env, owner, ws, plan);
    const first = await commit(plan.operationId);
    const second = await commit(plan.operationId);
    expect(second.json).toEqual(first.json);
    const abort = await env.api(owner, "POST", `/transfers/${plan.operationId}/abort`);
    expect([abort.status, abort.json.code]).toEqual([409, "invalid_transfer_state"]);
  });

  it("concurrent commits publish the pages once", async () => {
    const plan = toWorkspacePlan();
    await createTransfer(env, owner, ws, plan);
    const results = await Promise.all(Array.from({ length: 6 }, () => commit(plan.operationId)));
    expect(results.every((r) => r.status === 200 && r.json.state === "done")).toBe(true);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${plan.pages[0]!.pageId}/revisions`)).json.items).toHaveLength(1);
  });

  describe("from_workspace", () => {
    const fromPlan = (mode: "copy" | "move", pageIds: string[]) => ({ operationId: uuid(), direction: "from_workspace" as const, mode, pages: pageIds.map((pageId) => ({ pageId })) });

    it("move: pins revisions, deletes only the verified revision, reports cleanup pending otherwise", async () => {
      const a = await createPage(env, owner, ws, { markdown: "a" });
      const b = await createPage(env, owner, ws, { markdown: "b" });
      const plan = fromPlan("move", [a.id, b.id]);
      const created = await createTransfer(env, owner, ws, plan);
      expect(created.json.items.map((i: { revisionId: string }) => i.revisionId)).toEqual([a.revisionId, b.revisionId]);
      // The source page changes after pinning.
      const upd = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${b.id}`, { headers: { "if-match": `"${b.revisionId}"` }, json: { title: "b2", markdown: "b changed" } });
      expect(upd.status).toBe(200);
      const hashOf = async (p: { id: string; revisionId: string }) => (await env.api(owner, "GET", `/workspaces/${ws}/pages/${p.id}`, { query: { revision: p.revisionId } })).json.revision.contentHash;
      const verified = [{ pageId: a.id, revisionId: a.revisionId, contentHash: await hashOf(a) }, { pageId: b.id, revisionId: b.revisionId, contentHash: await hashOf(b) }];
      const done = await commit(plan.operationId, { verified });
      expect(done.json.state).toBe("destination_committed_source_cleanup_pending");
      expect(done.json.items.map((i: { state: string; error?: string }) => [i.state, i.error])).toEqual([["committed", undefined], ["failed", "revision_conflict"]]);
      expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${a.id}`)).status).toBe(404);
      expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${b.id}`)).json.markdown).toBe("b changed");
      expect((await env.api(owner, "POST", `/transfers/${plan.operationId}/abort`)).json.code).toBe("invalid_transfer_state");
    });

    it("rejects verified entries that do not match the pin, a wrong hash, strangers, duplicates, and an incomplete move", async () => {
      const a = await createPage(env, owner, ws, { markdown: "a" });
      const b = await createPage(env, owner, ws, { markdown: "b" });
      const plan = fromPlan("move", [a.id]);
      await createTransfer(env, owner, ws, plan);
      const good = { pageId: a.id, revisionId: a.revisionId, contentHash: (await env.api(owner, "GET", `/workspaces/${ws}/pages/${a.id}`)).json.revision.contentHash };
      for (const [name, verified] of [
        ["wrong revision", [{ ...good, revisionId: "rev_other" }]],
        ["wrong hash", [{ ...good, contentHash: "0".repeat(64) }]],
        ["page not in transfer", [good, { pageId: b.id, revisionId: b.revisionId, contentHash: good.contentHash }]],
        ["duplicate", [good, good]],
        ["move without verification", []],
      ] as const) {
        const res = await commit(plan.operationId, { verified });
        expect([name, res.status, res.json.code]).toEqual([name, 400, "validation_failed"]);
      }
      expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${a.id}`)).status).toBe(200);
      expect((await env.api(owner, "GET", `/transfers/${plan.operationId}`)).json.state).toBe("stage");
    });

    it("copy leaves the source and needs no verification", async () => {
      const a = await createPage(env, owner, ws);
      const plan = fromPlan("copy", [a.id]);
      await createTransfer(env, owner, ws, plan);
      expect((await commit(plan.operationId)).json.state).toBe("done");
      expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${a.id}`)).status).toBe(200);
    });

    it("an unknown or deleted page is 404 and nothing is created", async () => {
      const plan = fromPlan("copy", [uuid()]);
      expect((await createTransfer(env, owner, ws, plan)).status).toBe(404);
      expect((await env.db.query("SELECT 1 FROM transfers WHERE operation_id = $1", [plan.operationId])).rowCount).toBe(0);
    });
  });
});
