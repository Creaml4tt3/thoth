import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, createTransfer, toWorkspacePlan, uuid } from "./support.ts";

describe("idempotency records live in the database", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let other: TestPrincipal;
  let ws: string;
  beforeAll(async () => {
    env = await startTestEnv();
    owner = await env.user("Owner");
    other = await env.user("Other");
    ws = await env.workspace("W", { members: { [owner.userId]: "owner", [other.userId]: "owner" } });
  });
  afterAll(() => env.close());

  it("replays the original response, and rejects key reuse with 422, across a server restart", async () => {
    const id = uuid();
    const key = `key-${uuid()}`;
    const json = { title: "Idempotent", markdown: "# once\n" };
    const headers = { "if-none-match": "*", "idempotency-key": key };
    const first = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers, json });
    expect(first.status).toBe(201);

    await env.restart();

    const replay = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers, json });
    expect(replay.status).toBe(201); // the original 201, not the 412 a fresh create would give
    expect(replay.json).toEqual(first.json);
    expect(replay.headers.get("etag")).toBe(first.headers.get("etag"));
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${id}/revisions`)).json.items).toHaveLength(1);

    const reuse = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers, json: { title: "Different", markdown: "# other\n" } });
    expect(reuse.status).toBe(422);
    expect(reuse.json.code).toBe("idempotency_key_reused");
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${id}`)).json.markdown).toBe("# once\n");
  });

  it("stores a rejected request's answer too (4xx), and the replay is the same 4xx", async () => {
    const key = `key-${uuid()}`;
    const headers = { "if-match": '"nope"', "idempotency-key": key };
    const a = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${uuid()}`, { headers, json: { title: "x", markdown: "x" } });
    expect(a.status).toBe(404);
    await env.restart();
    const stored = await env.db.query("SELECT status FROM idempotency_records WHERE key = $1", [key]);
    expect(stored.rows).toEqual([{ status: 404 }]);
  });

  it("scopes keys per principal", async () => {
    const key = `shared-${uuid()}`;
    const a = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${uuid()}`, { headers: { "if-none-match": "*", "idempotency-key": key }, json: { title: "A", markdown: "a" } });
    const b = await env.api(other, "PUT", `/workspaces/${ws}/pages/${uuid()}`, { headers: { "if-none-match": "*", "idempotency-key": key }, json: { title: "B", markdown: "b" } });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.headers.get("idempotent-replayed")).toBeNull();
  });

  it("does not store 401, 429-like or 5xx answers (only 2xx and request-specific 4xx)", async () => {
    const key = `key-${uuid()}`;
    const res = await env.api({ headers: { authorization: "Bearer thoth_pat_unknownunknownunknownunknown" } } as TestPrincipal, "PUT", `/workspaces/${ws}/pages/${uuid()}`, { headers: { "if-none-match": "*", "idempotency-key": key }, json: { title: "x", markdown: "x" } });
    expect(res.status).toBe(401);
    expect((await env.db.query("SELECT 1 FROM idempotency_records WHERE key = $1", [key])).rowCount).toBe(0);
  });

  it("a duplicate that arrives while the first is still executing runs once", async () => {
    const id = uuid();
    const key = `key-${uuid()}`;
    const headers = { "if-none-match": "*", "idempotency-key": key };
    const json = { title: "Race", markdown: "# race\n" };
    const results = await Promise.all(Array.from({ length: 8 }, () => env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers, json })));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
    expect(new Set(results.map((r) => r.json.revision.id)).size).toBe(1);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${id}/revisions`)).json.items).toHaveLength(1);
  });

  it("applies the 24 hour window: a record older than the window is treated as new", async () => {
    const id = uuid();
    const key = `key-${uuid()}`;
    const headers = { "if-none-match": "*", "idempotency-key": key };
    const json = { title: "Old", markdown: "old" };
    expect((await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers, json })).status).toBe(201);
    const young = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers, json });
    expect(young.status).toBe(201);
    expect(young.headers.get("idempotent-replayed")).toBe("true");
    await env.db.query("UPDATE idempotency_records SET created_at = now() - interval '25 hours' WHERE key = $1", [key]);
    const expired = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers, json });
    expect(expired.status).toBe(412); // new request: the page now exists
    expect(expired.headers.get("idempotent-replayed")).toBeNull();
    // ...and just inside the window it still replays.
    const key2 = `key-${uuid()}`;
    const id2 = uuid();
    const h2 = { "if-none-match": "*", "idempotency-key": key2 };
    await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id2}`, { headers: h2, json });
    await env.db.query("UPDATE idempotency_records SET created_at = now() - interval '23 hours' WHERE key = $1", [key2]);
    expect((await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id2}`, { headers: h2, json })).headers.get("idempotent-replayed")).toBe("true");
  });

  it("rejects an invalid Idempotency-Key with 400", async () => {
    const res = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${uuid()}`, { headers: { "if-none-match": "*", "idempotency-key": "has space" }, json: { title: "x", markdown: "x" } });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("validation_failed");
  });

  it("transfer creation and commit replay across a restart", async () => {
    const plan = toWorkspacePlan();
    const created = await createTransfer(env, owner, ws, plan);
    expect(created.status).toBe(201);
    await env.restart();
    const replay = await createTransfer(env, owner, ws, plan);
    expect(replay.status).toBe(201);
    expect(replay.json).toEqual(created.json);
    const changed = await createTransfer(env, owner, ws, { ...plan, pages: [{ ...plan.pages[0]!, markdown: "# different\n" }] });
    expect([changed.status, changed.json.code]).toEqual([422, "idempotency_key_reused"]);
    const commitKey = uuid();
    const commit = await env.api(owner, "POST", `/transfers/${plan.operationId}/commit`, { headers: { "idempotency-key": commitKey } });
    expect(commit.json.state).toBe("done");
    await env.restart();
    const again = await env.api(owner, "POST", `/transfers/${plan.operationId}/commit`, { headers: { "idempotency-key": commitKey } });
    expect(again.json).toEqual(commit.json);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${plan.pages[0]!.pageId}/revisions`)).json.items).toHaveLength(1);
  });

  it("an uploaded attachment replays to the same attachment across a restart", async () => {
    const key = uuid();
    const send = () => env.api(owner, "POST", `/workspaces/${ws}/attachments`, { headers: { "content-type": "text/plain", "idempotency-key": key }, body: "hello" });
    const first = await send();
    await env.restart();
    const replay = await send();
    expect(replay.json).toEqual(first.json);
    expect((await env.db.query("SELECT 1 FROM attachments WHERE workspace_id = $1", [ws])).rowCount).toBe(1);
  });

  it("a page created before the restart is still there with its revision chain", async () => {
    const { id } = await createPage(env, owner, ws);
    await env.restart();
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${id}`)).status).toBe(200);
  });
});
