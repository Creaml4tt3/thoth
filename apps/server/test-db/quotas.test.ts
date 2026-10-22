import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, createUser, createWorkspace } from "../src/admin.ts";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, createTransfer, toWorkspacePlan, uploadAttachment, uuid } from "./support.ts";

const countRows = async (env: TestEnv, sql: string, values: unknown[] = []) => Number((await env.db.query<{ n: string }>(sql, values)).rows[0]!.n);
const head = async (env: TestEnv, who: TestPrincipal, ws: string): Promise<string> => (await env.api(who, "GET", `/workspaces/${ws}/changes`)).json.cursor;

describe("page quota", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  beforeAll(async () => {
    env = await startTestEnv({ configure: (c) => void (c.maxPagesPerWorkspace = 3) });
    owner = await env.user("Owner");
  });
  afterAll(() => env.close());
  const workspace = () => env.workspace("W", { members: { [owner.userId]: "owner" } });

  it("limit - 1 and limit succeed, limit + 1 is 409 quota_exceeded with limit and current, and nothing is written", async () => {
    const ws = await workspace();
    await createPage(env, owner, ws);
    await createPage(env, owner, ws);
    await createPage(env, owner, ws); // exactly at the limit: allowed
    const before = { cursor: await head(env, owner, ws), revisions: await countRows(env, "SELECT count(*) AS n FROM page_revisions WHERE workspace_id = $1", [ws]) };
    const id = uuid();
    const res = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers: { "if-none-match": "*" }, json: { title: "One too many", markdown: "x" } });
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.json).toMatchObject({ code: "quota_exceeded", status: 409, quota: "pagesPerWorkspace", limit: 3, current: 3 });
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${id}`)).status).toBe(404);
    expect(await head(env, owner, ws)).toBe(before.cursor);
    expect(await countRows(env, "SELECT count(*) AS n FROM page_revisions WHERE workspace_id = $1", [ws])).toBe(before.revisions);
    expect(await countRows(env, "SELECT count(*) AS n FROM pages WHERE workspace_id = $1 AND id = $2", [ws, id])).toBe(0);
  });

  it("updates never count, deleted pages free their slot, and a rejected create is not remembered by its Idempotency-Key", async () => {
    const ws = await workspace();
    const a = await createPage(env, owner, ws);
    await createPage(env, owner, ws);
    await createPage(env, owner, ws);
    const update = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${a.id}`, { headers: { "if-match": `"${a.revisionId}"` }, json: { title: "edited", markdown: "edited" } });
    expect(update.status).toBe(200); // at the limit, an update is fine
    const id = uuid();
    const request = { headers: { "if-none-match": "*", "idempotency-key": `quota-${id}` }, json: { title: "T", markdown: "m" } };
    expect((await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, request)).json.code).toBe("quota_exceeded");
    const del = await env.api(owner, "DELETE", `/workspaces/${ws}/pages/${a.id}`, { headers: { "if-match": `"${update.json.revision.id}"` } });
    expect(del.status).toBe(204);
    const retried = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, request); // same key, same request
    expect(retried.status).toBe(201);
    expect(retried.headers.get("idempotent-replayed")).toBeNull();
  });

  it("concurrent creates at limit - 1: exactly one wins, in every round", async () => {
    for (let round = 0; round < 6; round++) {
      const ws = await workspace();
      await createPage(env, owner, ws);
      await createPage(env, owner, ws); // limit - 1
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => env.api(owner, "PUT", `/workspaces/${ws}/pages/${uuid()}`, { headers: { "if-none-match": "*" }, json: { title: `c${i}`, markdown: `c${i}` } })));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201), `round ${round}: ${statuses}`).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(7);
      expect(await countRows(env, "SELECT count(*) AS n FROM pages WHERE workspace_id = $1 AND deleted_at IS NULL", [ws])).toBe(3);
    }
  });

  it("a to_workspace transfer that would exceed the limit is refused whole: it publishes nothing and is retryable once there is room", async () => {
    const ws = await workspace();
    const keep = await createPage(env, owner, ws); // 1 of 3
    // Two pages fit (1 + 2 = 3): staging is accepted.
    const plan = { operationId: uuid(), direction: "to_workspace" as const, mode: "copy" as const, pages: [uuid(), uuid()].map((pageId, i) => ({ sourceId: `s${i}`, pageId, parentId: null, title: `T${i}`, markdown: `m${i}` })) };
    expect((await createTransfer(env, owner, ws, plan)).status).toBe(201);
    // The workspace then fills up before commit: 3 of 3.
    await createPage(env, owner, ws);
    await createPage(env, owner, ws);
    const cursor = await head(env, owner, ws);
    const commit = await env.api(owner, "POST", `/transfers/${plan.operationId}/commit`, { headers: { "idempotency-key": "commit-1" } });
    expect(commit.status).toBe(409);
    expect(commit.json).toMatchObject({ code: "quota_exceeded", quota: "pagesPerWorkspace", limit: 3, current: 3 });
    for (const p of plan.pages) expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${p.pageId}`)).status).toBe(404);
    expect(await head(env, owner, ws)).toBe(cursor);
    const state = await env.api(owner, "GET", `/transfers/${plan.operationId}`);
    expect(state.json.state).toBe("stage"); // not failed: nothing was consumed
    // Make room (delete two pages) and commit again with the same key: it runs and publishes both pages.
    const tree = (await env.api(owner, "GET", `/workspaces/${ws}/tree`)).json.items as { id: string; revisionId: string }[];
    for (const page of tree.filter((p) => p.id !== keep.id)) await env.api(owner, "DELETE", `/workspaces/${ws}/pages/${page.id}`, { headers: { "if-match": `"${page.revisionId}"` } });
    const retry = await env.api(owner, "POST", `/transfers/${plan.operationId}/commit`, { headers: { "idempotency-key": "commit-1" } });
    expect(retry.status).toBe(200);
    expect(retry.json.state).toBe("done");
    for (const p of plan.pages) expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${p.pageId}`)).status).toBe(200);
  });

  it("a transfer larger than the room is refused when it is created, writing no transfer row", async () => {
    const ws = await workspace();
    await createPage(env, owner, ws);
    await createPage(env, owner, ws); // 2 of 3
    const plan = { operationId: uuid(), direction: "to_workspace" as const, mode: "copy" as const, pages: [uuid(), uuid()].map((pageId, i) => ({ sourceId: `s${i}`, pageId, parentId: null, title: `T${i}`, markdown: "m" })) };
    const res = await createTransfer(env, owner, ws, plan);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "quota_exceeded", limit: 3, current: 2 });
    expect(await countRows(env, "SELECT count(*) AS n FROM transfers WHERE operation_id = $1", [plan.operationId])).toBe(0);
    // A single page does fit.
    expect((await createTransfer(env, owner, ws, toWorkspacePlan())).status).toBe(201);
  });
});

describe("attachment quotas", () => {
  for (const store of ["fs", "postgres"] as const) {
    describe(`BLOB_STORE=${store}`, () => {
      let env: TestEnv;
      let owner: TestPrincipal;
      beforeAll(async () => {
        env = await startTestEnv({ env: { BLOB_STORE: store }, configure: (c) => void ((c.maxWorkspaceAttachmentBytes = 100), (c.maxTotalAttachmentBytes = 10_000)) });
        owner = await env.user("Owner");
      });
      afterAll(() => env.close());
      const upload = (ws: string, bytes: Buffer) => env.api(owner, "POST", `/workspaces/${ws}/attachments`, { headers: { "content-type": "application/octet-stream" }, body: bytes });
      const workspace = () => env.workspace("W", { members: { [owner.userId]: "owner" } });
      const storedBlobs = async () => (store === "postgres" ? countRows(env, "SELECT count(*) AS n FROM blobs") : null);

      it("per workspace: the sum of attachment sizes may reach the limit, one byte more is 409 quota_exceeded and writes nothing", async () => {
        const ws = await workspace();
        expect((await upload(ws, Buffer.alloc(60, 1))).status).toBe(201);
        expect((await upload(ws, Buffer.alloc(39, 2))).status).toBe(201); // 99
        expect((await upload(ws, Buffer.alloc(1, 3))).status).toBe(201); // exactly 100
        const blobs = await storedBlobs();
        const cursor = await head(env, owner, ws);
        const res = await upload(ws, Buffer.alloc(1, 4));
        expect(res.status).toBe(409);
        expect(res.json).toMatchObject({ code: "quota_exceeded", quota: "attachmentBytesPerWorkspace", limit: 100, current: 100 });
        expect(await countRows(env, "SELECT count(*) AS n FROM attachments WHERE workspace_id = $1", [ws])).toBe(3);
        expect(await head(env, owner, ws)).toBe(cursor);
        expect(await storedBlobs()).toBe(blobs); // not even the bytes
      });

      it("a deduplicated identical upload counts again for its workspace (what the workspace holds), not for the server", async () => {
        const ws = await workspace();
        const same = Buffer.alloc(60, 9);
        expect((await upload(ws, same)).status).toBe(201);
        const again = await upload(ws, same); // 120 > 100 although storage holds one blob
        expect(again.status).toBe(409);
        expect(again.json.quota).toBe("attachmentBytesPerWorkspace");
        // Another workspace uploading the same bytes: its own quota is fine, and the server stores nothing new.
        const other = await workspace();
        expect((await upload(other, same)).status).toBe(201);
        expect(await countRows(env, "SELECT count(DISTINCT hash) AS n FROM attachments WHERE hash = $1", [(await env.db.query<{ hash: string }>("SELECT hash FROM attachments WHERE workspace_id = $1", [other])).rows[0]!.hash])).toBe(1);
      });
    });
  }
});

describe("server-wide attachment quota", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  beforeAll(async () => {
    env = await startTestEnv({ env: { BLOB_STORE: "postgres" }, configure: (c) => void (c.maxTotalAttachmentBytes = 100) });
    owner = await env.user("Owner");
  });
  afterAll(() => env.close());
  const upload = (ws: string, bytes: Buffer) => env.api(owner, "POST", `/workspaces/${ws}/attachments`, { headers: { "content-type": "application/octet-stream" }, body: bytes });
  const workspace = () => env.workspace("W", { members: { [owner.userId]: "owner" } });

  it("counts each distinct blob once: exactly the limit fits, one byte more says the server is full, and shows no numbers", async () => {
    const a = await workspace();
    const b = await workspace();
    const first = Buffer.alloc(60, 1);
    expect((await upload(a, first)).status).toBe(201);
    expect((await upload(b, first)).status).toBe(201); // identical bytes: stored once, adds nothing
    expect((await upload(b, Buffer.alloc(40, 2))).status).toBe(201); // 60 + 40 = 100, exactly full
    const blobs = await countRows(env, "SELECT count(*) AS n FROM blobs");
    const res = await upload(a, Buffer.alloc(1, 3));
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("quota_exceeded");
    expect(res.json.quota).toBe("serverAttachmentBytes");
    expect(res.json.detail).toMatch(/server .*full/i);
    expect(res.json.detail).toMatch(/nothing is wrong/i);
    expect(res.json).not.toHaveProperty("limit");
    expect(res.json).not.toHaveProperty("current");
    expect(await countRows(env, "SELECT count(*) AS n FROM blobs")).toBe(blobs);
    expect((await upload(a, first)).status).toBe(201); // a known blob still fits: it adds no storage
  });

  it("concurrent uploads of different bytes from different workspaces at limit - 50: exactly one wins, in every round", async () => {
    for (let round = 0; round < 4; round++) {
      const e2 = await startTestEnv({ env: { BLOB_STORE: "postgres" }, configure: (c) => void (c.maxTotalAttachmentBytes = 100) });
      try {
        const who = await e2.user("O");
        const ws = await Promise.all(Array.from({ length: 6 }, () => e2.workspace("W", { members: { [who.userId]: "owner" } })));
        const first = await e2.api(who, "POST", `/workspaces/${ws[0]!}/attachments`, { headers: { "content-type": "text/plain" }, body: Buffer.alloc(50, 1) });
        expect(first.status).toBe(201);
        const results = await Promise.all(ws.map((w, i) => e2.api(who, "POST", `/workspaces/${w}/attachments`, { headers: { "content-type": "text/plain" }, body: Buffer.alloc(50, 10 + i) })));
        const statuses = results.map((r) => r.status).sort();
        expect(statuses.filter((s) => s === 201), `round ${round}: ${statuses}`).toHaveLength(1);
        expect(statuses.filter((s) => s === 409)).toHaveLength(5);
        expect(Number((await e2.db.query<{ n: string }>("SELECT coalesce(sum(size),0) AS n FROM blobs")).rows[0]!.n)).toBe(100);
      } finally {
        await e2.close();
      }
    }
  });
});

describe("workspace, member and account quotas (shared admin functions)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await startTestEnv();
  });
  afterAll(() => env.close());
  const user = async (n = "u") => (await createUser(env.db, { name: n })).id;
  const quotaError = (quota: string) => expect.objectContaining({ code: "quota_exceeded", extra: expect.objectContaining({ quota }) });

  it("workspaces per account: the first owned workspace is allowed, the second is refused, nothing is written", async () => {
    const quotas = { maxWorkspacesPerAccount: 1 };
    const u = await user();
    const first = await createWorkspace(env.db, { name: "One", exportRestricted: false, ownerId: u }, quotas);
    expect((await env.db.query("SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2", [first.id, u])).rows[0]).toEqual({ role: "owner" });
    const before = await countRows(env, "SELECT count(*) AS n FROM workspaces");
    await expect(createWorkspace(env.db, { name: "Two", exportRestricted: false, ownerId: u }, quotas)).rejects.toThrow(quotaError("workspacesPerAccount"));
    expect(await countRows(env, "SELECT count(*) AS n FROM workspaces")).toBe(before);
    // Another account is unaffected; being a non-owner member elsewhere does not count.
    const v = await user();
    await createWorkspace(env.db, { name: "V", exportRestricted: false, ownerId: v }, quotas);
    await addMember(env.db, { workspaceId: first.id, userId: v, role: "editor" }, quotas);
    // Becoming owner of a second workspace through add-member is the same quota.
    await expect(addMember(env.db, { workspaceId: first.id, userId: v, role: "owner" }, quotas)).rejects.toThrow(quotaError("workspacesPerAccount"));
  });

  it("concurrent workspace creation by one account at limit - 1: exactly one wins", async () => {
    for (let round = 0; round < 4; round++) {
      const u = await user();
      const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => createWorkspace(env.db, { name: `W${i}`, exportRestricted: false, ownerId: u }, { maxWorkspacesPerAccount: 1 })));
      expect(results.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
      expect(await countRows(env, "SELECT count(*) AS n FROM memberships WHERE user_id = $1 AND role = 'owner'", [u])).toBe(1);
    }
  });

  it("members per workspace: limit - 1 and limit are allowed, one more is refused; a role change is not a new member", async () => {
    const quotas = { maxMembersPerWorkspace: 3 };
    const { id: ws } = await createWorkspace(env.db, { name: "M", exportRestricted: false });
    const [a, b, c, d] = [await user(), await user(), await user(), await user()] as [string, string, string, string];
    await addMember(env.db, { workspaceId: ws, userId: a, role: "owner" }, quotas);
    await addMember(env.db, { workspaceId: ws, userId: b, role: "editor" }, quotas); // 2 = limit - 1
    await addMember(env.db, { workspaceId: ws, userId: c, role: "viewer" }, quotas); // 3 = limit
    await expect(addMember(env.db, { workspaceId: ws, userId: d, role: "viewer" }, quotas)).rejects.toThrow(quotaError("membersPerWorkspace"));
    expect(await countRows(env, "SELECT count(*) AS n FROM memberships WHERE workspace_id = $1", [ws])).toBe(3);
    await addMember(env.db, { workspaceId: ws, userId: c, role: "editor" }, quotas); // role change at the limit: fine
    expect((await env.db.query("SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2", [ws, c])).rows[0]).toEqual({ role: "editor" });
  });

  it("concurrent member additions at limit - 1: exactly one wins", async () => {
    for (let round = 0; round < 4; round++) {
      const { id: ws } = await createWorkspace(env.db, { name: "C", exportRestricted: false });
      await addMember(env.db, { workspaceId: ws, userId: await user(), role: "owner" }, {});
      const users = await Promise.all(Array.from({ length: 6 }, () => user()));
      const results = await Promise.allSettled(users.map((userId) => addMember(env.db, { workspaceId: ws, userId, role: "viewer" }, { maxMembersPerWorkspace: 2 })));
      expect(results.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
      expect(await countRows(env, "SELECT count(*) AS n FROM memberships WHERE workspace_id = $1", [ws])).toBe(2);
    }
  });

  it("accounts: the server-wide MAX_ACCOUNTS is enforced in createUser, at the boundary, without disclosing numbers", async () => {
    const base = await countRows(env, "SELECT count(*) AS n FROM users");
    const quotas = { maxAccounts: base + 2 };
    await createUser(env.db, { name: "limit-1" }, quotas);
    await createUser(env.db, { name: "limit" }, quotas);
    const error = await createUser(env.db, { name: "over" }, quotas).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "quota_exceeded", extra: { quota: "accounts" } });
    expect((error as Error).message).toMatch(/full/);
    expect((error as { extra: object }).extra).not.toHaveProperty("limit");
    expect(await countRows(env, "SELECT count(*) AS n FROM users")).toBe(base + 2);
    expect(await countRows(env, "SELECT count(*) AS n FROM users WHERE display_name = 'over'")).toBe(0);
  });

  it("concurrent sign-ups at limit - 1: exactly one wins", async () => {
    const quotas = { maxAccounts: (await countRows(env, "SELECT count(*) AS n FROM users")) + 1 };
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => createUser(env.db, { name: `race ${i}` }, quotas)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("limits are advertised", () => {
  it("/capabilities lists every configured advertised limit and omits unset ones and the server-wide quotas", async () => {
    const env = await startTestEnv({
      configure: (c) => {
        c.maxPagesPerWorkspace = 200;
        c.maxWorkspaceAttachmentBytes = 20 * 1_048_576;
        c.maxMembersPerWorkspace = 10;
        c.maxWorkspacesPerAccount = 1;
        c.revisionRetentionDays = 30;
        c.maxTotalAttachmentBytes = 600 * 1_048_576;
        c.maxAccounts = 50;
      },
    });
    try {
      const { limits } = (await env.api(null, "GET", "/capabilities")).json;
      expect(limits).toMatchObject({ maxPagesPerWorkspace: 200, maxWorkspaceAttachmentBytes: 20 * 1_048_576, maxMembersPerWorkspace: 10, maxWorkspacesPerAccount: 1, revisionRetentionDays: 30 });
      expect(JSON.stringify(limits)).not.toMatch(/maxAccounts|maxTotal/);
    } finally {
      await env.close();
    }
    const plain = await startTestEnv();
    try {
      const { limits } = (await plain.api(null, "GET", "/capabilities")).json;
      expect(Object.keys(limits).sort()).toEqual(["idempotencyWindowSeconds", "maxAttachmentBytes", "maxMarkdownBytes", "maxPageSize"]);
    } finally {
      await plain.close();
    }
  });

  it("the trial profile applies the owner's numbers end to end (4 MiB attachments, Postgres blobs)", async () => {
    const env = await startTestEnv({ env: { THOTH_PROFILE: "trial" } });
    try {
      const { limits, capabilities } = (await env.api(null, "GET", "/capabilities")).json;
      expect(limits).toMatchObject({ maxPagesPerWorkspace: 200, maxWorkspaceAttachmentBytes: 20 * 1_048_576, maxMembersPerWorkspace: 10, maxWorkspacesPerAccount: 1, revisionRetentionDays: 30, maxAttachmentBytes: 4 * 1_048_576, maxMarkdownBytes: 256 * 1024 });
      expect(capabilities).toContain("attachments");
      const who = await env.user("T");
      const ws = await env.workspace("W", { members: { [who.userId]: "owner" } });
      const post = (n: number) => env.api(who, "POST", `/workspaces/${ws}/attachments`, { headers: { "content-type": "application/octet-stream" }, body: Buffer.alloc(n, 7) });
      expect((await post(4 * 1_048_576)).status).toBe(201); // exactly 4 MiB
      const big = await post(4 * 1_048_576 + 1);
      expect([big.status, big.json.code]).toEqual([413, "payload_too_large"]); // our clear 413, not the platform's
      expect(await countRows(env, "SELECT count(*) AS n FROM blobs")).toBe(1);
      expect(await uploadAttachment(env, who, ws, Buffer.from("small"))).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await env.close();
    }
  });
});
