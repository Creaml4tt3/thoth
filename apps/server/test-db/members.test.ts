/**
 * Workspace members (ADR-0024, capability `members`) against the real server and PostgreSQL: who sees the list, who
 * changes roles and removes, leaving, the one-owner rule (also under concurrency), the owned-workspace quota on a
 * promotion, removal ending access at once (tokens and share links), and the audit trail with the actor.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage } from "./support.ts";

const audits = async (env: TestEnv, ws: string, action: string) =>
  (await env.db.query<{ actor_id: string | null; detail: Record<string, unknown> }>("SELECT actor_id, detail FROM audit_events WHERE workspace_id = $1 AND action = $2 ORDER BY id", [ws, action])).rows;

const roleOf = async (env: TestEnv, ws: string, userId: string) =>
  (await env.db.query<{ role: string }>("SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2", [ws, userId])).rows[0]?.role ?? null;

describe("members: the list, roles, removing and leaving", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let editor: TestPrincipal;
  let viewer: TestPrincipal;
  let stranger: TestPrincipal;
  let ws: string;

  beforeAll(async () => {
    env = await startTestEnv();
    [owner, editor, viewer, stranger] = (await Promise.all(["Olive Owner", "Eddie Editor", "Vera Viewer", "Stan Stranger"].map((n) => env.user(n)))) as [TestPrincipal, TestPrincipal, TestPrincipal, TestPrincipal];
    for (const p of [owner, editor, viewer, stranger]) await env.db.query("UPDATE users SET email = $2 WHERE id = $1", [p.userId, `${p.userId}@example.org`]);
    ws = await env.workspace("Team", { members: { [owner.userId]: "owner", [editor.userId]: "editor", [viewer.userId]: "viewer" } });
  });
  afterAll(() => env.close());

  it("advertises members and invite-links by default", async () => {
    const caps = await env.api(null, "GET", "/capabilities");
    expect(caps.json.capabilities).toEqual(expect.arrayContaining(["members", "invite-links"]));
  });

  it("shows every member the list with names and roles, never an email; non-members get 404, no credential 401", async () => {
    for (const who of [owner, editor, viewer]) {
      const res = await env.api(who, "GET", `/workspaces/${ws}/members`);
      expect(res.status, res.text).toBe(200);
      expect(res.json.items).toEqual(
        expect.arrayContaining([
          { userId: owner.userId, displayName: "Olive Owner", role: "owner" },
          { userId: editor.userId, displayName: "Eddie Editor", role: "editor" },
          { userId: viewer.userId, displayName: "Vera Viewer", role: "viewer" },
        ]),
      );
      expect(res.json.items).toHaveLength(3);
      expect(res.text).not.toContain("@example.org");
      expect(res.text).not.toMatch(/"email"/);
    }
    const asStranger = await env.api(stranger, "GET", `/workspaces/${ws}/members`);
    expect([asStranger.status, asStranger.json.code]).toEqual([404, "not_found"]);
    expect((await env.api(null, "GET", `/workspaces/${ws}/members`)).status).toBe(401);
  });

  it("pages through the list in a stable order", async () => {
    const first = await env.api(owner, "GET", `/workspaces/${ws}/members`, { query: { limit: "2" } });
    expect(first.json.items).toHaveLength(2);
    expect(first.json.nextCursor).toEqual(expect.any(String));
    const rest = await env.api(owner, "GET", `/workspaces/${ws}/members`, { query: { limit: "2", cursor: first.json.nextCursor } });
    expect(rest.json.items).toHaveLength(1);
    expect(rest.json.nextCursor).toBeNull();
    const all = [...first.json.items, ...rest.json.items].map((m: { userId: string }) => m.userId);
    expect(all).toEqual([...all].sort());
    const bad = await env.api(owner, "GET", `/workspaces/${ws}/members`, { query: { cursor: "nonsense" } });
    expect(bad.json.code).toBe("cursor_invalid");
  });

  it("lets only owners change a role (403 for editors and viewers); unknown members and roles are refused", async () => {
    for (const who of [editor, viewer]) {
      const res = await env.api(who, "PUT", `/workspaces/${ws}/members/${viewer.userId}`, { json: { role: "editor" } });
      expect([res.status, res.json.code], who.userId).toEqual([403, "forbidden"]);
    }
    const asStranger = await env.api(stranger, "PUT", `/workspaces/${ws}/members/${viewer.userId}`, { json: { role: "editor" } });
    expect([asStranger.status, asStranger.json.code]).toEqual([404, "not_found"]);
    const notMember = await env.api(owner, "PUT", `/workspaces/${ws}/members/${stranger.userId}`, { json: { role: "editor" } });
    expect([notMember.status, notMember.json.code]).toEqual([404, "not_found"]);
    expect(await roleOf(env, ws, stranger.userId)).toBeNull();
    for (const bad of [{ role: "admin" }, {}, { role: null }]) {
      const res = await env.api(owner, "PUT", `/workspaces/${ws}/members/${viewer.userId}`, { json: bad });
      expect([res.status, res.json.code], JSON.stringify(bad)).toEqual([400, "validation_failed"]);
    }
  });

  it("changes a role and audits it with the owner as the actor; the same role again changes and audits nothing", async () => {
    const res = await env.api(owner, "PUT", `/workspaces/${ws}/members/${viewer.userId}`, { json: { role: "editor" } });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ userId: viewer.userId, displayName: "Vera Viewer", role: "editor" });
    expect(await roleOf(env, ws, viewer.userId)).toBe("editor");
    // The new role works at once: an editor can write.
    await createPage(env, viewer, ws, { title: "By the new editor" });
    expect(await audits(env, ws, "member.role_changed")).toEqual([{ actor_id: owner.userId, detail: { userId: viewer.userId, from: "viewer", to: "editor" } }]);
    const again = await env.api(owner, "PUT", `/workspaces/${ws}/members/${viewer.userId}`, { json: { role: "editor" } });
    expect(again.status).toBe(200);
    expect(await audits(env, ws, "member.role_changed")).toHaveLength(1);
    expect((await env.api(owner, "PUT", `/workspaces/${ws}/members/${viewer.userId}`, { json: { role: "viewer" } })).status).toBe(200);
  });

  it("removes a member: 204, their token no longer reaches the workspace, their share links stop, and it is audited", async () => {
    const leaver = await env.user("Ray Removed");
    await env.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'editor')", [ws, leaver.userId]);
    const page = await createPage(env, leaver, ws, { title: "Shared by Ray", markdown: "# Shared by Ray\n\nWords.\n" });
    const link = await env.api(leaver, "POST", `/workspaces/${ws}/pages/${page.id}/share-links`, { json: {} });
    expect(link.status).toBe(201);
    expect((await fetch(`${env.url}/s/${link.json.token}`)).status).toBe(200);
    expect((await env.api(leaver, "GET", "/workspaces")).json.items.map((w: { id: string }) => w.id)).toContain(ws);

    const asEditor = await env.api(editor, "DELETE", `/workspaces/${ws}/members/${leaver.userId}`);
    expect([asEditor.status, asEditor.json.code]).toEqual([403, "forbidden"]);
    const res = await env.api(owner, "DELETE", `/workspaces/${ws}/members/${leaver.userId}`);
    expect(res.status, res.text).toBe(204);

    for (const path of [`/workspaces/${ws}/tree`, `/workspaces/${ws}/pages/${page.id}`, `/workspaces/${ws}/members`, `/workspaces/${ws}/changes`]) {
      const after = await env.api(leaver, "GET", path);
      expect([after.status, after.json.code], path).toEqual([404, "not_found"]);
    }
    expect((await env.api(leaver, "GET", "/workspaces")).json.items.map((w: { id: string }) => w.id)).not.toContain(ws);
    expect((await fetch(`${env.url}/s/${link.json.token}`)).status).toBe(404);
    expect(await audits(env, ws, "member.removed")).toEqual([{ actor_id: owner.userId, detail: { userId: leaver.userId, role: "editor" } }]);
    const twice = await env.api(owner, "DELETE", `/workspaces/${ws}/members/${leaver.userId}`);
    expect([twice.status, twice.json.code]).toEqual([404, "not_found"]);
  });

  it("lets any member leave (204, audited as member.left); afterwards it is 404 for them", async () => {
    const goer = await env.user("Lee Leaver");
    await env.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')", [ws, goer.userId]);
    const res = await env.api(goer, "DELETE", `/workspaces/${ws}/members/${goer.userId}`);
    expect(res.status, res.text).toBe(204);
    expect(await roleOf(env, ws, goer.userId)).toBeNull();
    expect((await env.api(goer, "GET", `/workspaces/${ws}/members`)).status).toBe(404);
    expect(await audits(env, ws, "member.left")).toEqual([{ actor_id: goer.userId, detail: { userId: goer.userId, role: "viewer" } }]);
    // A viewer removing someone else is refused.
    const asViewer = await env.api(viewer, "DELETE", `/workspaces/${ws}/members/${editor.userId}`);
    expect([asViewer.status, asViewer.json.code]).toEqual([403, "forbidden"]);
  });
});

describe("members: a workspace always keeps one owner", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await startTestEnv();
  });
  afterAll(() => env.close());

  it("refuses to demote, remove or let leave the last owner (409 last_owner, with a clear message)", async () => {
    const solo = await env.user("Solo");
    const helper = await env.user("Helper");
    const ws = await env.workspace("Mine", { members: { [solo.userId]: "owner", [helper.userId]: "editor" } });
    for (const [method, init] of [
      ["PUT", { json: { role: "editor" } }],
      ["PUT", { json: { role: "viewer" } }],
      ["DELETE", {}],
    ] as const) {
      const res = await env.api(solo, method, `/workspaces/${ws}/members/${solo.userId}`, init);
      expect([res.status, res.json.code], `${method} ${JSON.stringify(init)}`).toEqual([409, "last_owner"]);
      expect(res.json.detail).toMatch(/owner/i);
    }
    expect(await roleOf(env, ws, solo.userId)).toBe("owner");
    // With a second owner, either one can step down, and then the other is the last.
    expect((await env.api(solo, "PUT", `/workspaces/${ws}/members/${helper.userId}`, { json: { role: "owner" } })).status).toBe(200);
    expect((await env.api(solo, "PUT", `/workspaces/${ws}/members/${solo.userId}`, { json: { role: "editor" } })).status).toBe(200);
    const now = await env.api(helper, "DELETE", `/workspaces/${ws}/members/${helper.userId}`);
    expect([now.status, now.json.code]).toEqual([409, "last_owner"]);
    expect((await env.api(helper, "DELETE", `/workspaces/${ws}/members/${solo.userId}`)).status).toBe(204);
  });

  it("two owners stepping down at the same moment: exactly one succeeds, the other is 409 last_owner", async () => {
    for (let round = 0; round < 6; round++) {
      const a = await env.user(`Sa${round}`);
      const b = await env.user(`Sb${round}`);
      const ws = await env.workspace(`Step down ${round}`, { members: { [a.userId]: "owner", [b.userId]: "owner" } });
      const [x, y] = await Promise.all([
        env.api(a, "PUT", `/workspaces/${ws}/members/${a.userId}`, { json: { role: "editor" } }),
        round % 2 ? env.api(b, "DELETE", `/workspaces/${ws}/members/${b.userId}`) : env.api(b, "PUT", `/workspaces/${ws}/members/${b.userId}`, { json: { role: "viewer" } }),
      ]);
      expect([x.status, y.status].filter((s) => s < 300), `${x.text} ${y.text}`).toHaveLength(1);
      expect([x, y].find((r) => r.status >= 300)!.json.code).toBe("last_owner");
      const owners = (await env.db.query<{ n: string }>("SELECT count(*) AS n FROM memberships WHERE workspace_id = $1 AND role = 'owner'", [ws])).rows[0]!.n;
      expect(Number(owners)).toBe(1);
    }
  });

  it("two owners demoting each other at the same moment: exactly one change lands", async () => {
    for (let round = 0; round < 5; round++) {
      const a = await env.user(`A${round}`);
      const b = await env.user(`B${round}`);
      const ws = await env.workspace(`Race ${round}`, { members: { [a.userId]: "owner", [b.userId]: "owner" } });
      const [x, y] = await Promise.all([
        env.api(a, "PUT", `/workspaces/${ws}/members/${b.userId}`, { json: { role: "editor" } }),
        env.api(b, "DELETE", `/workspaces/${ws}/members/${a.userId}`),
      ]);
      const statuses = [x.status, y.status].sort();
      // One lands; the other finds its caller no longer an owner (403) or no owner left to spare (409).
      expect(statuses[0], `${x.text} ${y.text}`).toBeLessThan(300);
      expect(statuses[1]).toBeGreaterThanOrEqual(400);
      const owners = (await env.db.query<{ n: string }>("SELECT count(*) AS n FROM memberships WHERE workspace_id = $1 AND role = 'owner'", [ws])).rows[0]!.n;
      expect(Number(owners)).toBe(1);
    }
  });

  it("a promotion to owner counts against the owned-workspace quota (MAX_WORKSPACES_PER_ACCOUNT)", async () => {
    const limited = await startTestEnv({ env: { MAX_WORKSPACES_PER_ACCOUNT: "1" } });
    try {
      const boss = await limited.user("Boss");
      const busy = await limited.user("Busy");
      await limited.workspace("Busy's own", { members: { [busy.userId]: "owner" } });
      const ws = await limited.workspace("Boss's", { members: { [boss.userId]: "owner", [busy.userId]: "editor" } });
      const res = await limited.api(boss, "PUT", `/workspaces/${ws}/members/${busy.userId}`, { json: { role: "owner" } });
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ code: "quota_exceeded", quota: "workspacesPerAccount", limit: 1, current: 1 });
      expect(await roleOf(limited, ws, busy.userId)).toBe("editor");
    } finally {
      await limited.close();
    }
  });
});
