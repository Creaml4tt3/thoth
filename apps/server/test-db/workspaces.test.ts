/**
 * Several workspaces per account (ADR-0025, capability `workspace-management`) against the real server and PostgreSQL:
 * creating within and over the owned-workspace limit (also two creates racing for the last place), renaming and
 * deleting by role, a deleted workspace unreachable everywhere (pages, search, the change feed, events, attachments,
 * transfers, share links and invite links), "Recently deleted" and restore within 30 days, purging (by the owner and by
 * the daily maintenance) with its pages, revisions and attachments, and the quota after a delete.
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember } from "../src/admin.ts";
import { runMaintenance } from "../src/maintenance.ts";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, createTransfer, toWorkspacePlan, uploadAttachment, uuid } from "./support.ts";

const DAY_MS = 86_400_000;
const HTML = { accept: "text/html,application/xhtml+xml" };

const audits = async (env: TestEnv, ws: string, action: string) =>
  (await env.db.query<{ actor_id: string | null; detail: Record<string, unknown> }>("SELECT actor_id, detail FROM audit_events WHERE workspace_id = $1 AND action = $2 ORDER BY id", [ws, action])).rows;

const count = async (env: TestEnv, sql: string, values: unknown[] = []) => Number((await env.db.query<{ n: string }>(sql, values)).rows[0]!.n);

const listed = async (env: TestEnv, who: TestPrincipal) => ((await env.api(who, "GET", "/workspaces")).json.items as { id: string; name: string; role: string }[]).map((w) => w.id);

async function create(env: TestEnv, who: TestPrincipal, body: unknown = { name: "Design" }, headers: Record<string, string> = {}) {
  return env.api(who, "POST", "/workspaces", { json: body, headers });
}

async function created(env: TestEnv, who: TestPrincipal, name = "Design"): Promise<string> {
  const res = await create(env, who, { name });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${res.text}`);
  return res.json.id;
}

/** Moves a deletion back in time, as if it happened `days` ago. */
const deletedDaysAgo = (env: TestEnv, ws: string, days: number) => env.db.query("UPDATE workspaces SET deleted_at = now() - make_interval(secs => $2) WHERE id = $1", [ws, days * 86_400]);

async function view(env: TestEnv, path: string) {
  const res = await fetch(`${env.url}${path}`, { headers: HTML });
  return { status: res.status, text: await res.text() };
}

describe("workspaces: creating one (ADR-0025)", () => {
  let env: TestEnv;
  let ada: TestPrincipal;

  beforeAll(async () => {
    env = await startTestEnv();
    ada = await env.user("Ada");
  });
  afterAll(() => env.close());

  it("advertises workspace-management by default", async () => {
    expect((await env.api(null, "GET", "/capabilities")).json.capabilities).toContain("workspace-management");
  });

  it("creates a workspace with the caller as its only member and owner; it is listed and audited with the actor", async () => {
    const res = await create(env, ada, { name: "  Design  " });
    expect(res.status, res.text).toBe(201);
    expect(res.json).toMatchObject({ kind: "workspace", name: "Design", role: "owner", exportRestricted: false, memberCount: 1, members: [{ userId: ada.userId, displayName: "Ada", role: "owner" }] });
    expect(Date.parse(res.json.createdAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(await listed(env, ada)).toContain(res.json.id);
    const tree = await env.api(ada, "GET", `/workspaces/${res.json.id}/tree`);
    expect([tree.status, tree.json.items]).toEqual([200, []]);
    expect(await audits(env, res.json.id, "workspace.created")).toEqual([{ actor_id: ada.userId, detail: { exportRestricted: false } }]);
  });

  it("keeps the export-restriction choice", async () => {
    const res = await create(env, ada, { name: "Locked", exportRestricted: true });
    expect([res.status, res.json.exportRestricted]).toEqual([201, true]);
  });

  it("refuses a bad name or body with 400 and writes nothing; without a credential 401", async () => {
    const before = await count(env, "SELECT count(*) AS n FROM workspaces");
    for (const bad of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(201) }, { name: 7 }, { name: "Ok", exportRestricted: "yes" }, { name: "Bad\u0000name" }, []]) {
      const res = await create(env, ada, bad);
      expect([res.status, res.json?.code], JSON.stringify(bad)).toEqual([400, "validation_failed"]);
    }
    expect((await env.api(ada, "POST", "/workspaces", { body: "{", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await create(env, ada, { name: "Thai ชื่อ".padEnd(200, "ก") })).status).toBe(201);
    expect((await env.api(null, "POST", "/workspaces", { json: { name: "Nope" } })).status).toBe(401);
    expect(await count(env, "SELECT count(*) AS n FROM workspaces")).toBe(before + 1);
  });

  it("replays a retry with the same Idempotency-Key (one workspace), and refuses the key with another body", async () => {
    const key = uuid();
    const first = await create(env, ada, { name: "Once" }, { "idempotency-key": key });
    const again = await create(env, ada, { name: "Once" }, { "idempotency-key": key });
    expect(first.status).toBe(201);
    expect([again.status, again.json.id, again.headers.get("idempotent-replayed")]).toEqual([201, first.json.id, "true"]);
    expect(await count(env, "SELECT count(*) AS n FROM workspaces WHERE name = 'Once'")).toBe(1);
    const other = await create(env, ada, { name: "Twice" }, { "idempotency-key": key });
    expect([other.status, other.json.code]).toEqual([422, "idempotency_key_reused"]);
  });
});

describe("workspaces: the owned-workspace limit and the daily creation guard", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await startTestEnv({ env: { THOTH_PROFILE: "trial", BLOB_STORE: "fs", RATE_LIMIT_PER_ACCOUNT: "unlimited", RATE_LIMIT_PER_IP: "unlimited" } });
  });
  afterAll(() => env.close());

  it("the trial lets an account own 3: the fourth is 409 quota_exceeded with the limit, and nothing is written", async () => {
    expect((await env.api(null, "GET", "/capabilities")).json.limits.maxWorkspacesPerAccount).toBe(3);
    const who = await env.user("Three");
    for (const name of ["One", "Two", "Three"]) expect((await create(env, who, { name })).status, name).toBe(201);
    const before = await count(env, "SELECT count(*) AS n FROM workspaces");
    const over = await create(env, who, { name: "Four" });
    expect(over.status, over.text).toBe(409);
    expect(over.json).toMatchObject({ code: "quota_exceeded", quota: "workspacesPerAccount", limit: 3, current: 3 });
    expect(over.json.detail).toMatch(/at most 3 workspaces/);
    expect(await count(env, "SELECT count(*) AS n FROM workspaces")).toBe(before);
  });

  it("membership through an invite does not count; only owned workspaces do", async () => {
    const owner = await env.user("Owner");
    const guest = await env.user("Guest");
    for (const name of ["A", "B", "C"]) {
      const ws = await created(env, owner, name);
      await addMember(env.db, { workspaceId: ws, userId: guest.userId, role: "editor" });
    }
    for (const name of ["G1", "G2", "G3"]) expect((await create(env, guest, { name })).status, name).toBe(201);
    expect((await create(env, guest, { name: "G4" })).json.quota).toBe("workspacesPerAccount");
  });

  it("two creates at the limit: exactly one wins (also with five at once)", async () => {
    for (const racers of [2, 5]) {
      const who = await env.user(`Racer ${racers}`);
      await created(env, who, "First");
      await created(env, who, "Second");
      const results = await Promise.all(Array.from({ length: racers }, (_, i) => create(env, who, { name: `Race ${i}` })));
      expect(results.map((r) => r.status).sort(), `${racers} racers`).toEqual([201, ...Array<number>(racers - 1).fill(409)]);
      expect(await count(env, "SELECT count(*) AS n FROM memberships WHERE user_id = $1 AND role = 'owner'", [who.userId])).toBe(3);
    }
  });

  it("a deleted workspace counts until it is purged (or its 30 days are over); purging frees the place at once", async () => {
    const who = await env.user("Churn");
    const ids = [await created(env, who, "One"), await created(env, who, "Two"), await created(env, who, "Three")];
    expect((await env.api(who, "DELETE", `/workspaces/${ids[0]}`)).status).toBe(204);
    const still = await create(env, who, { name: "Four" });
    expect([still.status, still.json.quota, still.json.current]).toEqual([409, "workspacesPerAccount", 3]);
    expect((await env.api(who, "DELETE", `/deleted-workspaces/${ids[0]}`)).status).toBe(204);
    expect((await create(env, who, { name: "Four" })).status).toBe(201);
    // Past its 30 days a deleted workspace no longer counts, even before the daily maintenance purges it.
    expect((await env.api(who, "DELETE", `/workspaces/${ids[1]}`)).status).toBe(204);
    expect((await create(env, who, { name: "Five" })).status).toBe(409);
    await deletedDaysAgo(env, ids[1]!, 30.01);
    expect((await create(env, who, { name: "Five" })).status).toBe(201);
  });

  it("at most 10 creations per account per day on the trial; a refused create uses none", async () => {
    const who = await env.user("Busy");
    let made = 0;
    let refused = 0;
    for (let i = 0; i < 12; i++) {
      const res = await create(env, who, { name: `W${i}` });
      if (res.status === 201) {
        made++;
        // Purge at once, so the owned limit never stands in the way.
        expect((await env.api(who, "DELETE", `/workspaces/${res.json.id}`)).status).toBe(204);
        expect((await env.api(who, "DELETE", `/deleted-workspaces/${res.json.id}`)).status).toBe(204);
        // A refused create (over the owned limit) in between spends nothing.
        continue;
      }
      expect(res.status, res.text).toBe(409);
      expect(res.json).toMatchObject({ code: "quota_exceeded", quota: "workspaceCreationsPerDay", limit: 10, current: 10 });
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      refused++;
    }
    expect([made, refused]).toEqual([10, 2]);
  });

  it("a refusal for the owned limit does not use one of the day's creations", async () => {
    const local = await startTestEnv({ configure: (c) => Object.assign(c, { maxWorkspacesPerAccount: 1, maxWorkspaceCreationsPerDay: 2 }) });
    try {
      const who = await local.user("Careful");
      const first = await created(local, who, "One");
      for (let i = 0; i < 3; i++) expect((await create(local, who, { name: "Over" })).json.quota).toBe("workspacesPerAccount");
      expect((await local.api(who, "DELETE", `/workspaces/${first}`)).status).toBe(204);
      expect((await local.api(who, "DELETE", `/deleted-workspaces/${first}`)).status).toBe(204);
      const second = await create(local, who, { name: "Two" });
      expect(second.status, second.text).toBe(201);
      expect((await local.api(who, "DELETE", `/workspaces/${second.json.id}`)).status).toBe(204);
      expect((await local.api(who, "DELETE", `/deleted-workspaces/${second.json.id}`)).status).toBe(204);
      expect((await create(local, who, { name: "Three" })).json.quota).toBe("workspaceCreationsPerDay");
    } finally {
      await local.close();
    }
  });
});

describe("workspaces: renaming and deleting by role", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let coOwner: TestPrincipal;
  let editor: TestPrincipal;
  let viewer: TestPrincipal;
  let stranger: TestPrincipal;
  let ws: string;

  beforeAll(async () => {
    env = await startTestEnv();
    [owner, coOwner, editor, viewer, stranger] = (await Promise.all(["Olive", "Otto", "Eddie", "Vera", "Stan"].map((n) => env.user(n)))) as [TestPrincipal, TestPrincipal, TestPrincipal, TestPrincipal, TestPrincipal];
    ws = await env.workspace("Team", { members: { [owner.userId]: "owner", [coOwner.userId]: "owner", [editor.userId]: "editor", [viewer.userId]: "viewer" } });
  });
  afterAll(() => env.close());

  it("lets only owners rename: 403 for editors and viewers, 404 for strangers; trimmed, listed, audited", async () => {
    for (const who of [editor, viewer]) {
      const res = await env.api(who, "PUT", `/workspaces/${ws}/name`, { json: { name: "Mine now" } });
      expect([res.status, res.json.code]).toEqual([403, "forbidden"]);
    }
    const asStranger = await env.api(stranger, "PUT", `/workspaces/${ws}/name`, { json: { name: "Mine now" } });
    expect([asStranger.status, asStranger.json.code]).toEqual([404, "not_found"]);
    const res = await env.api(owner, "PUT", `/workspaces/${ws}/name`, { json: { name: "  Team notes " } });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ id: ws, name: "Team notes", role: "owner", memberCount: 4 });
    const seen = (await env.api(viewer, "GET", "/workspaces")).json.items.find((w: { id: string }) => w.id === ws);
    expect(seen).toMatchObject({ name: "Team notes", role: "viewer" });
    expect(await audits(env, ws, "workspace.renamed")).toEqual([{ actor_id: owner.userId, detail: {} }]);
    // The same name again changes nothing and is not audited twice.
    expect((await env.api(owner, "PUT", `/workspaces/${ws}/name`, { json: { name: "Team notes" } })).status).toBe(200);
    expect(await audits(env, ws, "workspace.renamed")).toHaveLength(1);
    for (const bad of [{}, { name: "" }, { name: " " }, { name: "x".repeat(201) }]) expect((await env.api(owner, "PUT", `/workspaces/${ws}/name`, { json: bad })).status, JSON.stringify(bad)).toBe(400);
  });

  it("lets only owners delete: 403 for editors and viewers, 404 for strangers, and the workspace stays", async () => {
    for (const who of [editor, viewer]) {
      const res = await env.api(who, "DELETE", `/workspaces/${ws}`);
      expect([res.status, res.json.code]).toEqual([403, "forbidden"]);
    }
    expect((await env.api(stranger, "DELETE", `/workspaces/${ws}`)).status).toBe(404);
    expect((await env.api(null, "DELETE", `/workspaces/${ws}`)).status).toBe(401);
    expect((await env.api(owner, "DELETE", "/workspaces/not-an-id!")).status).toBe(404);
    for (const who of [owner, coOwner, editor, viewer]) expect(await listed(env, who)).toContain(ws);
  });

  it("deletes for an owner: no longer listed for any member, audited with the actor; deleting again is 404", async () => {
    const res = await env.api(coOwner, "DELETE", `/workspaces/${ws}`);
    expect(res.status, res.text).toBe(204);
    for (const who of [owner, coOwner, editor, viewer]) expect(await listed(env, who)).not.toContain(ws);
    expect(await audits(env, ws, "workspace.deleted")).toEqual([{ actor_id: coOwner.userId, detail: {} }]);
    expect((await env.api(owner, "DELETE", `/workspaces/${ws}`)).status).toBe(404);
    expect((await env.api(owner, "PUT", `/workspaces/${ws}/name`, { json: { name: "Back?" } })).status).toBe(404);
  });
});

describe("workspaces: a deleted workspace is unreachable everywhere", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let editor: TestPrincipal;
  let ws: string;
  let pageId: string;
  let revisionId: string;
  let attachmentId: string;
  let shareToken: string;
  let inviteToken: string;
  let transferId: string;

  beforeAll(async () => {
    env = await startTestEnv();
    owner = await env.user("Owner");
    editor = await env.user("Editor");
    ws = await env.workspace("Doomed", { members: { [owner.userId]: "owner", [editor.userId]: "editor" } });
    const page = await createPage(env, owner, ws, { title: "Secret plan", markdown: "# Secret plan\nneedle\n" });
    pageId = page.id;
    revisionId = page.revisionId;
    attachmentId = await uploadAttachment(env, owner, ws, Buffer.from("doomed bytes"));
    shareToken = (await env.api(owner, "POST", `/workspaces/${ws}/pages/${pageId}/share-links`, { json: {} })).json.token;
    inviteToken = (await env.api(owner, "POST", `/workspaces/${ws}/invite-links`, { json: { role: "viewer", maxUses: 5 } })).json.token;
    const plan = toWorkspacePlan();
    transferId = plan.operationId;
    expect((await createTransfer(env, owner, ws, plan)).status).toBe(201);
    expect((await view(env, `/s/${shareToken}`)).status).toBe(200);
    expect((await view(env, `/i/${inviteToken}`)).status).toBe(200);
    expect((await env.api(owner, "DELETE", `/workspaces/${ws}`)).status).toBe(204);
  });
  afterAll(() => env.close());

  it("answers 404 not_found to every member on every route of the workspace", async () => {
    const routes: [string, string, Record<string, unknown>?][] = [
      ["GET", `/workspaces/${ws}/tree`],
      ["GET", `/workspaces/${ws}/pages/${pageId}`],
      ["GET", `/workspaces/${ws}/pages/${pageId}/revisions`],
      ["GET", `/workspaces/${ws}/changes`],
      ["POST", `/workspaces/${ws}/search`, { json: { query: "needle" } }],
      ["GET", `/workspaces/${ws}/attachments/${attachmentId}`],
      ["GET", `/workspaces/${ws}/members`],
      ["GET", `/workspaces/${ws}/invite-links`],
      ["GET", `/workspaces/${ws}/pages/${pageId}/share-links`],
      ["PUT", `/workspaces/${ws}/pages/${uuid()}`, { headers: { "if-none-match": "*" }, json: { title: "New", markdown: "# New\n" } }],
      ["POST", `/workspaces/${ws}/attachments`, { headers: { "content-type": "text/plain" }, body: "more" }],
      ["GET", `/transfers/${transferId}`],
      ["POST", `/transfers/${transferId}/abort`],
    ];
    for (const who of [owner, editor]) {
      for (const [method, path, init] of routes) {
        const res = await env.api(who, method, path, init as never);
        expect([res.status, res.json?.code], `${method} ${path}`).toEqual([404, "not_found"]);
      }
      const events = await fetch(`${env.url}/api/v1/workspaces/${ws}/events`, { headers: { ...who.headers, accept: "text/event-stream" } });
      expect(events.status).toBe(404);
      await events.body?.cancel();
    }
    expect(JSON.stringify((await env.api(owner, "GET", `/workspaces/${ws}/pages/${pageId}`, { query: { revision: revisionId } })).json)).not.toContain("Secret");
  });

  it("stops its share links and invite links at once, for good (they are revoked)", async () => {
    const shared = await view(env, `/s/${shareToken}`);
    expect(shared.status).toBe(404);
    expect(shared.text).not.toContain("Secret");
    const invite = await view(env, `/i/${inviteToken}`);
    expect(invite.status).toBe(404);
    expect(invite.text).not.toContain("Doomed");
    const stranger = await env.user("Stranger");
    const accept = await env.api(stranger, "POST", "/invites/accept", { json: { token: inviteToken } });
    expect([accept.status, accept.json.code]).toEqual([404, "not_found"]);
    expect(await count(env, "SELECT count(*) AS n FROM memberships WHERE workspace_id = $1 AND user_id = $2", [ws, stranger.userId])).toBe(0);
    expect(await count(env, "SELECT count(*) AS n FROM share_links WHERE workspace_id = $1 AND revoked_at IS NULL", [ws])).toBe(0);
    expect(await count(env, "SELECT count(*) AS n FROM invite_links WHERE workspace_id = $1 AND revoked_at IS NULL", [ws])).toBe(0);
  });

  it("would refuse the links even if they had not been revoked: the lookups leave deleted workspaces out", async () => {
    await env.db.query("UPDATE share_links SET revoked_at = NULL WHERE workspace_id = $1", [ws]);
    await env.db.query("UPDATE invite_links SET revoked_at = NULL WHERE workspace_id = $1", [ws]);
    try {
      expect((await view(env, `/s/${shareToken}`)).status).toBe(404);
      expect((await view(env, `/i/${inviteToken}`)).status).toBe(404);
      const stranger = await env.user("Stranger 2");
      expect((await env.api(stranger, "POST", "/invites/accept", { json: { token: inviteToken } })).status).toBe(404);
    } finally {
      await env.db.query("UPDATE share_links SET revoked_at = now() WHERE workspace_id = $1", [ws]);
      await env.db.query("UPDATE invite_links SET revoked_at = now() WHERE workspace_id = $1", [ws]);
    }
  });

  it("the admin CLI cannot add a member to it either", async () => {
    const late = await env.user("Late");
    await expect(addMember(env.db, { workspaceId: ws, userId: late.userId, role: "viewer" })).rejects.toThrow(/no such workspace/);
  });
});

describe("workspaces: recently deleted and restore", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let coOwner: TestPrincipal;
  let editor: TestPrincipal;
  let stranger: TestPrincipal;
  let ws: string;
  let pageId: string;
  let shareToken: string;

  beforeAll(async () => {
    env = await startTestEnv();
    [owner, coOwner, editor, stranger] = (await Promise.all(["Olive", "Otto", "Eddie", "Stan"].map((n) => env.user(n)))) as [TestPrincipal, TestPrincipal, TestPrincipal, TestPrincipal];
    ws = await env.workspace("Archive", { members: { [owner.userId]: "owner", [coOwner.userId]: "owner", [editor.userId]: "editor" } });
    pageId = (await createPage(env, editor, ws, { title: "Keep me", markdown: "# Keep me\n" })).id;
    shareToken = (await env.api(owner, "POST", `/workspaces/${ws}/pages/${pageId}/share-links`, { json: {} })).json.token;
  });
  afterAll(() => env.close());

  it("lists a deleted workspace for its owners only, with who deleted it and until when it can be restored", async () => {
    expect((await env.api(owner, "GET", "/deleted-workspaces")).json).toEqual({ items: [], nextCursor: null });
    expect((await env.api(owner, "DELETE", `/workspaces/${ws}`)).status).toBe(204);
    for (const who of [owner, coOwner]) {
      const res = await env.api(who, "GET", "/deleted-workspaces");
      expect(res.status, res.text).toBe(200);
      expect(res.json.items).toHaveLength(1);
      const [item] = res.json.items;
      expect(item).toMatchObject({ id: ws, name: "Archive", exportRestricted: false, memberCount: 3, deletedBy: owner.userId });
      expect(Date.parse(item.restorableUntil) - Date.parse(item.deletedAt)).toBe(30 * DAY_MS);
    }
    for (const who of [editor, stranger]) expect((await env.api(who, "GET", "/deleted-workspaces")).json.items).toEqual([]);
    expect((await env.api(null, "GET", "/deleted-workspaces")).status).toBe(401);
  });

  it("refuses a restore to editors (403), strangers and live workspaces (404)", async () => {
    expect((await env.api(editor, "POST", `/deleted-workspaces/${ws}/restore`)).json.code).toBe("forbidden");
    expect((await env.api(stranger, "POST", `/deleted-workspaces/${ws}/restore`)).json.code).toBe("not_found");
    const live = await env.workspace("Live", { members: { [owner.userId]: "owner" } });
    expect((await env.api(owner, "POST", `/deleted-workspaces/${live}/restore`)).json.code).toBe("not_found");
    expect((await env.api(owner, "DELETE", `/deleted-workspaces/${live}`)).json.code).toBe("not_found");
    expect(await listed(env, owner)).toContain(live);
  });

  it("restores for an owner: pages, members and roles come back; share links stay stopped; audited", async () => {
    const res = await env.api(coOwner, "POST", `/deleted-workspaces/${ws}/restore`);
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ id: ws, name: "Archive", role: "owner", memberCount: 3 });
    for (const who of [owner, coOwner, editor]) expect(await listed(env, who)).toContain(ws);
    const page = await env.api(editor, "GET", `/workspaces/${ws}/pages/${pageId}`);
    expect([page.status, page.json.revision.title]).toEqual([200, "Keep me"]);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/members`)).json.items.map((m: { role: string }) => m.role).sort()).toEqual(["editor", "owner", "owner"]);
    expect((await view(env, `/s/${shareToken}`)).status).toBe(404);
    expect((await env.api(owner, "GET", "/deleted-workspaces")).json.items).toEqual([]);
    expect(await audits(env, ws, "workspace.restored")).toEqual([{ actor_id: coOwner.userId, detail: {} }]);
    // Restoring again: it is not deleted any more.
    expect((await env.api(owner, "POST", `/deleted-workspaces/${ws}/restore`)).status).toBe(404);
  });

  it("cannot restore once its 30 days are over: not listed, 404", async () => {
    expect((await env.api(owner, "DELETE", `/workspaces/${ws}`)).status).toBe(204);
    await deletedDaysAgo(env, ws, 29.9);
    expect((await env.api(owner, "GET", "/deleted-workspaces")).json.items.map((w: { id: string }) => w.id)).toEqual([ws]);
    await deletedDaysAgo(env, ws, 30.01);
    expect((await env.api(owner, "GET", "/deleted-workspaces")).json.items).toEqual([]);
    expect((await env.api(owner, "POST", `/deleted-workspaces/${ws}/restore`)).json.code).toBe("not_found");
    expect(await listed(env, owner)).not.toContain(ws);
  });
});

describe("workspaces: purging with its pages, revisions and attachments", () => {
  for (const store of ["postgres", "fs"] as const) {
    describe(`BLOB_STORE=${store}`, () => {
      let env: TestEnv;
      let owner: TestPrincipal;
      let editor: TestPrincipal;

      beforeAll(async () => {
        env = await startTestEnv({ env: { BLOB_STORE: store } });
        owner = await env.user("Owner");
        editor = await env.user("Editor");
      });
      afterAll(() => env.close());

      const blobExists = async (hash: string) =>
        store === "postgres"
          ? (await count(env, "SELECT count(*) AS n FROM blobs WHERE hash = $1", [hash])) === 1
          : await access(join(env.blobDir, hash.slice(0, 2), hash.slice(2, 4), hash)).then(
              () => true,
              () => false,
            );

      async function filled(name: string, shared: Buffer) {
        const ws = await env.workspace(name, { members: { [owner.userId]: "owner", [editor.userId]: "editor" } });
        const page = await createPage(env, owner, ws, { title: "P", markdown: "# P\n" });
        await env.api(owner, "PUT", `/workspaces/${ws}/pages/${page.id}`, { headers: { "if-match": `"${page.revisionId}"` }, json: { title: "P2", markdown: "# P2\n" } });
        await uploadAttachment(env, owner, ws, Buffer.from(`only in ${name}`));
        await uploadAttachment(env, owner, ws, shared);
        await env.api(owner, "POST", `/workspaces/${ws}/pages/${page.id}/share-links`, { json: {} });
        await env.api(owner, "POST", `/workspaces/${ws}/invite-links`, { json: { role: "viewer" } });
        await createTransfer(env, owner, ws, toWorkspacePlan());
        const hashes = (await env.db.query<{ hash: string }>("SELECT hash FROM attachments WHERE workspace_id = $1 ORDER BY hash", [ws])).rows.map((r) => r.hash);
        return { ws, hashes };
      }

      const leftovers = async (ws: string) => {
        const tables = ["pages", "page_revisions", "attachments", "changes", "memberships", "share_links", "invite_links", "transfers"];
        const out: Record<string, number> = {};
        for (const t of tables) out[t] = await count(env, `SELECT count(*) AS n FROM ${t} WHERE workspace_id = $1`, [ws]);
        out.workspaces = await count(env, "SELECT count(*) AS n FROM workspaces WHERE id = $1", [ws]);
        return out;
      };
      const none = { pages: 0, page_revisions: 0, attachments: 0, changes: 0, memberships: 0, share_links: 0, invite_links: 0, transfers: 0, workspaces: 0 };

      it("an owner purges a deleted workspace at once; a blob another workspace still uses is kept", async () => {
        const shared = Buffer.from(`shared bytes ${store}`);
        const keep = await filled("Keep", shared);
        const gone = await filled("Gone", shared);
        expect((await env.api(owner, "DELETE", `/deleted-workspaces/${gone.ws}`)).status).toBe(404); // not deleted yet
        expect((await env.api(owner, "DELETE", `/workspaces/${gone.ws}`)).status).toBe(204);
        expect((await env.api(editor, "DELETE", `/deleted-workspaces/${gone.ws}`)).json.code).toBe("forbidden");
        const res = await env.api(owner, "DELETE", `/deleted-workspaces/${gone.ws}`);
        expect(res.status, res.text).toBe(204);
        expect(await leftovers(gone.ws)).toEqual(none);
        const sharedHash = keep.hashes.find((h) => gone.hashes.includes(h))!;
        const onlyGone = gone.hashes.find((h) => h !== sharedHash)!;
        expect(await blobExists(onlyGone)).toBe(false);
        expect(await blobExists(sharedHash)).toBe(true);
        expect((await leftovers(keep.ws)).attachments).toBe(2);
        expect(await audits(env, gone.ws, "workspace.purged")).toEqual([{ actor_id: owner.userId, detail: {} }]);
        expect((await env.api(owner, "GET", "/deleted-workspaces")).json.items).toEqual([]);
        expect((await env.api(owner, "DELETE", `/deleted-workspaces/${gone.ws}`)).status).toBe(404);
      });

      it("the daily maintenance purges workspaces deleted more than 30 days ago, and only those", async () => {
        const old = await filled("Old", Buffer.from(`old ${store}`));
        const recent = await filled("Recent", Buffer.from(`recent ${store}`));
        for (const { ws } of [old, recent]) expect((await env.api(owner, "DELETE", `/workspaces/${ws}`)).status).toBe(204);
        await deletedDaysAgo(env, old.ws, 30.01);
        await deletedDaysAgo(env, recent.ws, 29.9);
        const result = await runMaintenance(env.db, { revisionRetentionDays: undefined, blobs: env.server.deps.blobs });
        expect(result.workspacesPurged).toBe(1);
        expect(await leftovers(old.ws)).toEqual(none);
        for (const hash of old.hashes) expect(await blobExists(hash)).toBe(false);
        expect((await leftovers(recent.ws)).pages).toBe(1);
        for (const hash of recent.hashes) expect(await blobExists(hash)).toBe(true);
        expect(await audits(env, old.ws, "workspace.purged")).toEqual([{ actor_id: null, detail: {} }]);
        expect((await runMaintenance(env.db, { revisionRetentionDays: undefined, blobs: env.server.deps.blobs })).workspacesPurged).toBe(0);
      });
    });
  }
});

describe("workspaces: switched off", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let ws: string;

  beforeAll(async () => {
    env = await startTestEnv({ env: { WORKSPACE_MANAGEMENT: "off" } });
    owner = await env.user("Owner");
    ws = await env.workspace("Fixed", { members: { [owner.userId]: "owner" } });
  });
  afterAll(() => env.close());

  it("WORKSPACE_MANAGEMENT=off: not advertised, and every workspace-management call is 501 capability_not_supported", async () => {
    expect((await env.api(null, "GET", "/capabilities")).json.capabilities).not.toContain("workspace-management");
    const calls: [string, string, unknown?][] = [
      ["POST", "/workspaces", { name: "New" }],
      ["PUT", `/workspaces/${ws}/name`, { name: "Renamed" }],
      ["DELETE", `/workspaces/${ws}`],
      ["GET", "/deleted-workspaces"],
      ["POST", `/deleted-workspaces/${ws}/restore`],
      ["DELETE", `/deleted-workspaces/${ws}`],
    ];
    for (const [method, path, json] of calls) {
      const res = await env.api(owner, method, path, json === undefined ? {} : { json });
      expect([res.status, res.json.code], `${method} ${path}`).toEqual([501, "capability_not_supported"]);
    }
    expect(await listed(env, owner)).toEqual([ws]);
  });
});
