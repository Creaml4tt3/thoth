/**
 * Invite links (ADR-0024, capability `invite-links`) against the real server and PostgreSQL. Every security rule of
 * the ADR has a test here: the token and its storage, owners only, the one 404 for every dead token, uses counted
 * atomically with the member quota, the rate limits, the invite page (no script, what it shows and what it does not),
 * joining through the sign-in broker with a single-use, CSRF-protected form, and the audit trail.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestEnv, type ApiResult, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { startFakeIssuer, type FakeIssuer } from "./fakes.ts";

const HTML = { accept: "text/html,application/xhtml+xml" };
const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
const DAY = 86_400_000;

interface Invite {
  id: string;
  token: string;
  url: string;
  role: string;
  maxUses: number;
  usesLeft: number;
  expiresAt: string;
}

async function invite(env: TestEnv, who: TestPrincipal, ws: string, body: Record<string, unknown> = { role: "viewer" }): Promise<Invite> {
  const res = await env.api(who, "POST", `/workspaces/${ws}/invite-links`, { json: body });
  if (res.status !== 201) throw new Error(`invite failed: ${res.status} ${res.text}`);
  return res.json;
}

const accept = (env: TestEnv, who: TestPrincipal | null, token: string, headers: Record<string, string> = {}) => env.api(who, "POST", "/invites/accept", { json: { token }, headers });

async function page(env: TestEnv, path: string, headers: Record<string, string> = HTML) {
  const res = await fetch(`${env.url}${path}`, { headers, redirect: "manual" });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

/** What a 404 looks like from outside: status, body and the headers that could tell two answers apart. */
const fingerprint = (r: Awaited<ReturnType<typeof page>>) => ({
  status: r.status,
  body: r.text,
  headers: ["content-type", "content-length", "content-security-policy", "x-robots-tag", "cache-control", "referrer-policy", "set-cookie"].map((h) => `${h}: ${r.headers.get(h)}`),
});

/** A problem body without its per-request ID. */
const problemOf = (r: ApiResult) => {
  const { requestId: _id, ...rest } = r.json as Record<string, unknown>;
  return { status: r.status, ...rest };
};

const membership = async (env: TestEnv, ws: string, userId: string) => (await env.db.query<{ role: string }>("SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2", [ws, userId])).rows[0]?.role ?? null;
const usesOf = async (env: TestEnv, id: string) => (await env.db.query<{ uses: number }>("SELECT uses FROM invite_links WHERE id = $1", [id])).rows[0]!.uses;

describe("invite links: create, list, revoke (owners only)", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let editor: TestPrincipal;
  let viewer: TestPrincipal;
  let stranger: TestPrincipal;
  let ws: string;

  beforeAll(async () => {
    env = await startTestEnv();
    [owner, editor, viewer, stranger] = (await Promise.all(["Olive Owner", "Eddie Editor", "Vera Viewer", "Stan Stranger"].map((n) => env.user(n)))) as [TestPrincipal, TestPrincipal, TestPrincipal, TestPrincipal];
    ws = await env.workspace("Team", { members: { [owner.userId]: "owner", [editor.userId]: "editor", [viewer.userId]: "viewer" } });
  });
  afterAll(() => env.close());

  it("lets an owner create a link: 201, 7 days and 1 use by default, the address /i/<token>, audited", async () => {
    const before = Date.now();
    const res = await env.api(owner, "POST", `/workspaces/${ws}/invite-links`, { json: { role: "editor" } });
    expect(res.status, res.text).toBe(201);
    expect(res.json).toMatchObject({ workspaceId: ws, role: "editor", maxUses: 1, usesLeft: 1, createdBy: owner.userId, createdByName: "Olive Owner" });
    expect(res.json.url).toBe(`${env.url}/i/${res.json.token}`);
    const days = (Date.parse(res.json.expiresAt) - before) / DAY;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    const audit = await env.db.query<{ actor_id: string; detail: Record<string, unknown> }>("SELECT actor_id, detail FROM audit_events WHERE workspace_id = $1 AND action = 'invite.created'", [ws]);
    expect(audit.rows).toEqual([{ actor_id: owner.userId, detail: { inviteId: res.json.id, role: "editor", maxUses: 1, expiresInDays: 7 } }]);
  });

  it("refuses editors and viewers (403), non-members (404) and callers without a credential (401)", async () => {
    for (const who of [editor, viewer]) {
      for (const [method, path] of [
        ["POST", `/workspaces/${ws}/invite-links`],
        ["GET", `/workspaces/${ws}/invite-links`],
        ["DELETE", `/workspaces/${ws}/invite-links/inv_x`],
      ] as const) {
        const res = await env.api(who, method, path, method === "POST" ? { json: { role: "viewer" } } : {});
        expect([res.status, res.json.code], `${who.userId} ${method}`).toEqual([403, "forbidden"]);
      }
    }
    const asStranger = await env.api(stranger, "POST", `/workspaces/${ws}/invite-links`, { json: { role: "viewer" } });
    expect([asStranger.status, asStranger.json.code]).toEqual([404, "not_found"]);
    expect((await env.api(null, "POST", `/workspaces/${ws}/invite-links`, { json: { role: "viewer" } })).status).toBe(401);
  });

  it("takes editor or viewer, 1, 7 or 30 days and 1, 5 or 10 uses, and nothing else", async () => {
    const a = await invite(env, owner, ws, { role: "viewer", expiresInDays: 1, maxUses: 5 });
    expect([a.role, a.maxUses, a.usesLeft, Math.round((Date.parse(a.expiresAt) - Date.now()) / DAY)]).toEqual(["viewer", 5, 5, 1]);
    const b = await invite(env, owner, ws, { role: "editor", expiresInDays: 30, maxUses: 10 });
    expect([b.maxUses, Math.round((Date.parse(b.expiresAt) - Date.now()) / DAY)]).toEqual([10, 30]);
    for (const bad of [{ role: "owner" }, { role: "admin" }, {}, { role: "viewer", expiresInDays: 2 }, { role: "viewer", expiresInDays: null }, { role: "viewer", maxUses: 3 }, { role: "viewer", maxUses: 0 }]) {
      const res = await env.api(owner, "POST", `/workspaces/${ws}/invite-links`, { json: bad });
      expect([res.status, res.json.code], JSON.stringify(bad)).toEqual([400, "validation_failed"]);
    }
  });

  it("stores only a SHA-256 of a 192-bit CSPRNG token: not in the link row, the idempotency records or the audit log", async () => {
    const res = await env.api(owner, "POST", `/workspaces/${ws}/invite-links`, { headers: { "idempotency-key": "k-invite-1" }, json: { role: "viewer" } });
    expect(res.status).toBe(201);
    const { token, id } = res.json;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(Buffer.from(token, "base64url").length).toBeGreaterThanOrEqual(16);
    expect((await env.db.query<{ token_hash: string }>("SELECT token_hash FROM invite_links WHERE id = $1", [id])).rows[0]!.token_hash).toBe(sha256Hex(token));
    for (const table of ["invite_links", "idempotency_records", "audit_events"]) {
      const dump = await env.db.query(`SELECT t::text AS row FROM ${table} t`);
      expect(dump.rows.map((r: any) => r.row).join("\n"), table).not.toContain(token);
    }
    // Not replayed from an idempotency record: the same key makes a second link with a new token.
    const again = await env.api(owner, "POST", `/workspaces/${ws}/invite-links`, { headers: { "idempotency-key": "k-invite-1" }, json: { role: "viewer" } });
    expect(again.status).toBe(201);
    expect(again.json.token).not.toBe(token);
    const tokens = await Promise.all(Array.from({ length: 8 }, () => invite(env, owner, ws).then((l) => l.token)));
    expect(new Set(tokens).size).toBe(8);
  });

  it("lists the active links newest first with uses left and the creator's name, never a token; revoked, expired and used-up links are kept but not listed", async () => {
    const other = await env.workspace("Listed", { members: { [owner.userId]: "owner" } });
    const a = await invite(env, owner, other, { role: "viewer", maxUses: 5 });
    const b = await invite(env, owner, other, { role: "editor" });
    const c = await invite(env, owner, other);
    const d = await invite(env, owner, other);
    const e = await invite(env, owner, other);
    await env.db.query("UPDATE invite_links SET expires_at = now() - interval '1 second' WHERE id = $1", [c.id]);
    await env.db.query("UPDATE invite_links SET uses = max_uses WHERE id = $1", [d.id]);
    expect((await env.api(owner, "DELETE", `/workspaces/${other}/invite-links/${e.id}`)).status).toBe(204);
    await env.db.query("UPDATE invite_links SET uses = 2 WHERE id = $1", [a.id]);
    const list = await env.api(owner, "GET", `/workspaces/${other}/invite-links`);
    expect(list.status).toBe(200);
    expect(list.json.items.map((l: { id: string }) => l.id)).toEqual([b.id, a.id]);
    expect(list.json.items[1]).toEqual({ id: a.id, workspaceId: other, role: "viewer", maxUses: 5, usesLeft: 3, createdAt: expect.any(String), createdBy: owner.userId, createdByName: "Olive Owner", expiresAt: a.expiresAt });
    for (const l of [a, b]) expect(list.text).not.toContain(l.token);
    expect(Number((await env.db.query<{ n: string }>("SELECT count(*) AS n FROM invite_links WHERE workspace_id = $1", [other])).rows[0]!.n)).toBe(5);
    const paged = await env.api(owner, "GET", `/workspaces/${other}/invite-links`, { query: { limit: "1" } });
    expect(paged.json.items.map((l: { id: string }) => l.id)).toEqual([b.id]);
    const rest = await env.api(owner, "GET", `/workspaces/${other}/invite-links`, { query: { limit: "1", cursor: paged.json.nextCursor } });
    expect(rest.json.items.map((l: { id: string }) => l.id)).toEqual([a.id]);
  });

  it("revokes: 204, repeatable, audited once; another workspace's link is 404", async () => {
    const link = await invite(env, owner, ws);
    const elsewhere = await env.workspace("Elsewhere", { members: { [stranger.userId]: "owner" } });
    const wrong = await env.api(stranger, "DELETE", `/workspaces/${elsewhere}/invite-links/${link.id}`);
    expect([wrong.status, wrong.json.code]).toEqual([404, "not_found"]);
    expect((await env.api(owner, "DELETE", `/workspaces/${ws}/invite-links/${link.id}`)).status).toBe(204);
    expect((await env.api(owner, "DELETE", `/workspaces/${ws}/invite-links/${link.id}`)).status).toBe(204);
    expect((await env.api(owner, "DELETE", `/workspaces/${ws}/invite-links/inv_unknown`)).status).toBe(404);
    const audit = await env.db.query<{ actor_id: string }>("SELECT actor_id FROM audit_events WHERE action = 'invite.revoked' AND detail->>'inviteId' = $1", [link.id]);
    expect(audit.rows).toEqual([{ actor_id: owner.userId }]);
    expect((await accept(env, stranger, link.token)).status).toBe(404);
  });
});

describe("invite links: joining through the API", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let ws: string;

  beforeAll(async () => {
    // The per-IP join limit is tested on its own below; here every request comes from 127.0.0.1.
    env = await startTestEnv({ env: { INVITE_ACCEPTS_PER_IP: "unlimited" } });
    owner = await env.user("Olive Owner");
    ws = await env.workspace("Team", { members: { [owner.userId]: "owner" } });
  });
  afterAll(() => env.close());

  it("an existing account joins with the link's role: 200 joined, a use is spent, the workspace is listed, audited with the actor", async () => {
    const link = await invite(env, owner, ws, { role: "viewer", maxUses: 5 });
    const joiner = await env.user("Jo Joiner");
    const res = await accept(env, joiner, link.token);
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ workspaceId: ws, name: "Team", role: "viewer", joined: true });
    expect(await membership(env, ws, joiner.userId)).toBe("viewer");
    expect(await usesOf(env, link.id)).toBe(1);
    expect((await env.api(joiner, "GET", "/workspaces")).json.items.map((w: { id: string }) => w.id)).toContain(ws);
    expect((await env.api(joiner, "GET", `/workspaces/${ws}/tree`)).status).toBe(200);
    const audit = await env.db.query<{ actor_id: string; detail: Record<string, unknown> }>("SELECT actor_id, detail FROM audit_events WHERE workspace_id = $1 AND action = 'member.joined'", [ws]);
    expect(audit.rows).toEqual([{ actor_id: joiner.userId, detail: { userId: joiner.userId, inviteId: link.id, role: "viewer" } }]);
  });

  it("someone already a member keeps their role (never downgraded) and spends no use", async () => {
    const editor = await env.user("Ed Already");
    await env.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'editor')", [ws, editor.userId]);
    const link = await invite(env, owner, ws, { role: "viewer" });
    for (const who of [editor, owner]) {
      const res = await accept(env, who, link.token);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ workspaceId: ws, name: "Team", role: who === owner ? "owner" : "editor", joined: false });
    }
    expect(await membership(env, ws, editor.userId)).toBe("editor");
    expect(await usesOf(env, link.id)).toBe(0);
  });

  it("answers the same 404 for unknown, malformed, expired, revoked, used-up and orphaned tokens, and for a token of another server", async () => {
    const someone = await env.user("Someone");
    const expired = await invite(env, owner, ws);
    await env.db.query("UPDATE invite_links SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
    const revoked = await invite(env, owner, ws);
    await env.api(owner, "DELETE", `/workspaces/${ws}/invite-links/${revoked.id}`);
    const used = await invite(env, owner, ws);
    expect((await accept(env, await env.user("First"), used.token)).status).toBe(200);
    // A link whose creator is no longer an owner stops, like a share link whose creator lost the role.
    const coOwner = await env.user("Co Owner");
    await env.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [ws, coOwner.userId]);
    const orphan = await invite(env, coOwner, ws);
    await env.db.query("UPDATE memberships SET role = 'editor' WHERE workspace_id = $1 AND user_id = $2", [ws, coOwner.userId]);
    const other = await startTestEnv();
    let foreign: string;
    try {
      const o = await other.user("Other owner");
      const ows = await other.workspace("Other", { members: { [o.userId]: "owner" } });
      foreign = (await invite(other, o, ows)).token;
    } finally {
      await other.close();
    }
    const reference = problemOf(await accept(env, someone, "Q".repeat(32)));
    expect(reference).toMatchObject({ status: 404, code: "not_found" });
    for (const token of ["x", "!".repeat(32), "Q".repeat(31), expired.token, revoked.token, used.token, orphan.token, foreign]) {
      expect(problemOf(await accept(env, someone, token)), token).toEqual(reference);
    }
    expect(await membership(env, ws, someone.userId)).toBeNull();
    for (const bad of [{}, { token: 5 }, { token: "" }]) {
      const res = await env.api(someone, "POST", "/invites/accept", { json: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await accept(env, null, used.token)).status).toBe(401);
  });

  it("two people joining with the last use at the same moment: exactly one gets in", async () => {
    for (let round = 0; round < 5; round++) {
      const link = await invite(env, owner, ws, { role: "editor", maxUses: 1 });
      const [a, b] = await Promise.all([env.user(`Racer A${round}`), env.user(`Racer B${round}`)]);
      const [x, y] = await Promise.all([accept(env, a, link.token), accept(env, b, link.token)]);
      expect([x.status, y.status].sort(), `${x.text} ${y.text}`).toEqual([200, 404]);
      expect(await usesOf(env, link.id)).toBe(1);
      const joined = [await membership(env, ws, a.userId), await membership(env, ws, b.userId)].filter(Boolean);
      expect(joined).toEqual(["editor"]);
    }
  });

  it("checks the member quota under the workspace lock: a full workspace is a clear 409, two racing for the last place get one in", async () => {
    const limited = await startTestEnv({ env: { MAX_MEMBERS_PER_WORKSPACE: "3" } });
    try {
      const boss = await limited.user("Boss");
      const lws = await limited.workspace("Small", { members: { [boss.userId]: "owner" } });
      // Room for two: a link for 5 people is refused up front, with the room left.
      const tooMany = await limited.api(boss, "POST", `/workspaces/${lws}/invite-links`, { json: { role: "viewer", maxUses: 5 } });
      expect(tooMany.status).toBe(409);
      expect(tooMany.json).toMatchObject({ code: "quota_exceeded", quota: "membersPerWorkspace", limit: 3, current: 1 });
      const link = await invite(limited, boss, lws, { role: "viewer", maxUses: 1 });
      const link2 = await invite(limited, boss, lws, { role: "viewer", maxUses: 1 });
      const filler = await limited.user("Filler");
      await limited.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')", [lws, filler.userId]);
      const [p, q] = await Promise.all([limited.user("P"), limited.user("Q")]);
      const [x, y] = await Promise.all([accept(limited, p, link.token), accept(limited, q, link2.token)]);
      const codes = [x, y].map((r) => (r.status === 200 ? "ok" : r.json.code)).sort();
      expect(codes).toEqual(["ok", "quota_exceeded"]);
      const full = [x, y].find((r) => r.status === 409)!;
      expect(full.json).toMatchObject({ quota: "membersPerWorkspace", limit: 3, current: 3 });
      expect(Number((await limited.db.query<{ n: string }>("SELECT count(*) AS n FROM memberships WHERE workspace_id = $1", [lws])).rows[0]!.n)).toBe(3);
      // The refused link spent nothing.
      const refusedLink = x.status === 409 ? link : link2;
      expect(await usesOf(limited, refusedLink.id)).toBe(0);
      // A full workspace cannot make any link.
      const none = await limited.api(boss, "POST", `/workspaces/${lws}/invite-links`, { json: { role: "viewer" } });
      expect(none.json).toMatchObject({ code: "quota_exceeded", quota: "membersPerWorkspace" });
    } finally {
      await limited.close();
    }
  });
});

describe("invite links: limits, rate limits and switching off", () => {
  it("the trial allows 20 active links per workspace, a clear 409 past it, and turns both capabilities on", async () => {
    const env = await startTestEnv({ env: { THOTH_PROFILE: "trial", RATE_LIMIT_PER_ACCOUNT: "unlimited", RATE_LIMIT_PER_IP: "unlimited" } });
    try {
      expect(env.config.invite).toMatchObject({ maxLinksPerWorkspace: 20 });
      expect((await env.api(null, "GET", "/capabilities")).json.capabilities).toEqual(expect.arrayContaining(["members", "invite-links"]));
      const owner = await env.user("Owner");
      const ws = await env.workspace("W", { members: { [owner.userId]: "owner" } });
      const links: Invite[] = [];
      for (let i = 0; i < 20; i++) links.push(await invite(env, owner, ws));
      const over = await env.api(owner, "POST", `/workspaces/${ws}/invite-links`, { json: { role: "viewer" } });
      expect(over.status).toBe(409);
      expect(over.json).toMatchObject({ code: "quota_exceeded", quota: "inviteLinksPerWorkspace", limit: 20, current: 20 });
      expect(over.json.detail).toContain("20");
      await env.api(owner, "DELETE", `/workspaces/${ws}/invite-links/${links[0]!.id}`);
      expect((await env.api(owner, "POST", `/workspaces/${ws}/invite-links`, { json: { role: "viewer" } })).status).toBe(201);
      await env.db.query("UPDATE invite_links SET uses = max_uses WHERE id = $1", [links[1]!.id]);
      expect((await env.api(owner, "POST", `/workspaces/${ws}/invite-links`, { json: { role: "viewer" } })).status).toBe(201);
    } finally {
      await env.close();
    }
  });

  it("limits accepts per IP before the token is looked up: a known and an unknown token hit it at the same count", async () => {
    const env = await startTestEnv({ env: { INVITE_ACCEPTS_PER_IP: "3", RATE_LIMIT_WINDOW_SECONDS: "3600" } });
    try {
      const owner = await env.user("Owner");
      const ws = await env.workspace("W", { members: { [owner.userId]: "owner" } });
      const link = await invite(env, owner, ws, { role: "viewer", maxUses: 10 });
      const someone = await env.user("Someone");
      for (let i = 0; i < 3; i++) expect((await accept(env, someone, "U".repeat(32))).status).toBe(404);
      const known = await accept(env, someone, link.token);
      expect([known.status, known.json.code]).toEqual([429, "rate_limited"]);
      expect(Number(known.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await membership(env, ws, someone.userId)).toBeNull();
    } finally {
      await env.close();
    }
  });

  it("limits opening invite pages per IP, known token or not, with a 429 page", async () => {
    const env = await startTestEnv({ env: { INVITE_OPENS_PER_IP: "2", RATE_LIMIT_WINDOW_SECONDS: "3600" } });
    try {
      const owner = await env.user("Owner");
      const ws = await env.workspace("Wombat Works", { members: { [owner.userId]: "owner" } });
      const link = await invite(env, owner, ws);
      expect((await page(env, `/i/${"a".repeat(32)}`)).status).toBe(404);
      expect((await page(env, `/i/${link.token}`)).status).toBe(200);
      const refused = await page(env, `/i/${link.token}`);
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(refused.text).not.toContain("Wombat");
      expect((await page(env, `/i/${"b".repeat(32)}`)).status).toBe(429);
    } finally {
      await env.close();
    }
  });

  it("has per-IP limits for opening and accepting by default", async () => {
    const env = await startTestEnv();
    try {
      expect(env.config.invite).toEqual({ maxLinksPerWorkspace: undefined, opensPerIp: 60, acceptsPerIp: 20 });
    } finally {
      await env.close();
    }
  });

  it("INVITE_LINKS=off drops only invite-links: the calls are 501 and an existing link's page is the same 404", async () => {
    const env = await startTestEnv();
    try {
      const owner = await env.user("Owner");
      const ws = await env.workspace("W", { members: { [owner.userId]: "owner" } });
      const link = await invite(env, owner, ws);
      const unknown = fingerprint(await page(env, `/i/${"Z".repeat(32)}`));
      const saved = env.config.capabilities;
      env.config.capabilities = saved.filter((c) => c !== "invite-links");
      await env.restart();
      try {
        const caps = (await env.api(null, "GET", "/capabilities")).json.capabilities;
        expect(caps).toContain("members");
        expect(caps).not.toContain("invite-links");
        expect(fingerprint(await page(env, `/i/${link.token}`))).toEqual(unknown);
        for (const [method, path, json] of [
          ["POST", `/workspaces/${ws}/invite-links`, { role: "viewer" }],
          ["GET", `/workspaces/${ws}/invite-links`, undefined],
          ["POST", "/invites/accept", { token: link.token }],
        ] as const) {
          const res = await env.api(owner, method, path, json === undefined ? {} : { json });
          expect([res.status, res.json.code], `${method} ${path}`).toEqual([501, "capability_not_supported"]);
        }
        expect((await env.api(owner, "GET", `/workspaces/${ws}/members`)).status).toBe(200);
      } finally {
        env.config.capabilities = saved;
        await env.restart();
      }
    } finally {
      await env.close();
    }
    const off = await startTestEnv({ env: { INVITE_LINKS: "off" } });
    try {
      expect((await off.api(null, "GET", "/capabilities")).json.capabilities).not.toContain("invite-links");
    } finally {
      await off.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------- the invite page

const PUBLIC_URL = "https://api.thoth.test";
const WEB_REDIRECT = "https://app.thoth.test/app/callback";

interface Res {
  status: number;
  headers: Headers;
  text: string;
  location: string | undefined;
  setCookies: string[];
}

/** A browser that maps PUBLIC_URL onto the server's real address and keeps a cookie jar for it. */
class Browser {
  readonly cookies = new Map<string, string>();
  private readonly env: () => TestEnv;
  constructor(env: () => TestEnv) {
    this.env = env;
  }
  private target(url: string): string {
    const base = this.env().url;
    return url.startsWith(PUBLIC_URL) ? base + url.slice(PUBLIC_URL.length) : url.startsWith("/") ? base + url : url;
  }
  async request(method: string, url: string, init: { headers?: Record<string, string>; form?: Record<string, string> } = {}): Promise<Res> {
    const target = this.target(url);
    const ours = target.startsWith(this.env().url);
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(target, {
      method,
      redirect: "manual",
      headers: { ...HTML, ...(cookie && ours ? { cookie } : {}), ...(init.form ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(init.headers ?? {}) },
      ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
    });
    const setCookies = res.headers.getSetCookie();
    if (ours) {
      for (const line of setCookies) {
        const [pair] = line.split(";");
        const at = pair!.indexOf("=");
        const name = pair!.slice(0, at);
        const value = pair!.slice(at + 1);
        if (/Max-Age=0/i.test(line) || value === "") this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
    }
    return { status: res.status, headers: res.headers, text: await res.text(), location: res.headers.get("location") ?? undefined, setCookies };
  }
  get(url: string, headers: Record<string, string> = {}) {
    return this.request("GET", url, { headers });
  }
  post(url: string, form: Record<string, string>, headers: Record<string, string> = { origin: PUBLIC_URL }) {
    return this.request("POST", url, { form, headers });
  }
}

const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];

describe("the invite page and joining from a browser", () => {
  let env: TestEnv;
  let issuer: FakeIssuer;
  let owner: TestPrincipal;
  let ws: string;
  const logLines: string[] = [];

  beforeAll(async () => {
    issuer = await startFakeIssuer();
    env = await startTestEnv({
      startOptions: { logStream: { write: (line: string) => void logLines.push(line) } },
      env: { THOTH_PROFILE: "trial", RATE_LIMIT_PER_IP: "unlimited", RATE_LIMIT_PER_ACCOUNT: "unlimited", SIGNUP_LIMIT_PER_IP: "unlimited", INVITE_OPENS_PER_IP: "unlimited", INVITE_ACCEPTS_PER_IP: "unlimited", PUBLIC_URL, OIDC_GOOGLE_CLIENT_ID: issuer.clientId, OIDC_GOOGLE_CLIENT_SECRET: issuer.clientSecret, WEB_REDIRECT_URIS: WEB_REDIRECT, CORS_ORIGINS: "https://app.thoth.test" },
      configure: (c) => {
        c.logLevel = "info";
        for (const p of c.signIn!.providers) if (p.kind === "oidc") p.issuer = issuer.url;
      },
    });
    owner = await env.user("Olive Owner");
    await env.db.query("UPDATE users SET email = 'olive@example.org' WHERE id = $1", [owner.userId]);
    ws = await env.workspace("Field <Team> & Co", { members: { [owner.userId]: "owner" } });
    const other = await env.user("Hidden Member");
    await env.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'editor')", [ws, other.userId]);
  });
  afterAll(async () => {
    await env?.close();
    await issuer?.close();
  });
  beforeEach(() => issuer.reset());

  /** /i/<token> -> "Sign in with Google" -> provider -> callback -> /i/accept. Returns the browser on the join page. */
  async function signInFromInvite(link: Invite, browser = new Browser(() => env)): Promise<{ browser: Browser; ready: Res }> {
    const start = await browser.get(`/i/${link.token}/sign-in?provider=google`);
    expect(start.status, start.text).toBe(302);
    const atProvider = await browser.get(start.location!);
    expect(atProvider.status).toBe(302);
    expect(atProvider.location!.startsWith(`${PUBLIC_URL}/auth/callback/google`)).toBe(true);
    const back = await browser.get(atProvider.location!);
    expect(back.status, back.text).toBe(302);
    expect(back.location).toBe(`${PUBLIC_URL}/i/accept`);
    const ready = await browser.get(back.location!);
    return { browser, ready };
  }

  it("shows a signed-out visitor the workspace name, the inviter and the role, with no script, strict headers and nothing else", async () => {
    const link = await invite(env, owner, ws, { role: "editor" });
    const res = await page(env, `/i/${link.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.text).not.toMatch(/<script/i);
    expect(res.text).toContain("Field &lt;Team&gt; &amp; Co");
    expect(res.text).not.toContain("Field <Team>");
    expect(res.text).toContain("Olive Owner");
    expect(res.text).toMatch(/as an editor/);
    expect(res.text).toContain(`href="/i/${link.token}/sign-in?provider=google"`);
    expect(res.text).toContain("Sign in with Google to join");
    for (const secret of [ws, owner.userId, "olive@example.org", "Hidden Member", link.id]) expect(res.text, secret).not.toContain(secret);
  });

  it("speaks Thai to a browser that asks for it", async () => {
    const link = await invite(env, owner, ws);
    const res = await page(env, `/i/${link.token}`, { ...HTML, "accept-language": "th-TH,th;q=0.9,en;q=0.5" });
    expect(res.text).toContain('<html lang="th">');
    expect(res.text).toContain("Olive Owner");
    expect((await page(env, `/i/${link.token}`, { ...HTML, "accept-language": "en-GB,en;q=0.9" })).text).toContain('<html lang="en">');
  });

  it("gives every dead or unknown token, and anything else under /i/, the same 404", async () => {
    const reference = fingerprint(await page(env, `/i/${"Q".repeat(32)}`));
    expect(reference.status).toBe(404);
    const expired = await invite(env, owner, ws);
    await env.db.query("UPDATE invite_links SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
    const revoked = await invite(env, owner, ws);
    await env.api(owner, "DELETE", `/workspaces/${ws}/invite-links/${revoked.id}`);
    const used = await invite(env, owner, ws);
    await env.db.query("UPDATE invite_links SET uses = max_uses WHERE id = $1", [used.id]);
    for (const path of [`/i/${expired.token}`, `/i/${revoked.token}`, `/i/${used.token}`, "/i/short", `/i/${"Q".repeat(32)}/other`, `/i/${expired.token}/sign-in?provider=google`, "/i/accept", "/i/"]) {
      expect(fingerprint(await page(env, path)), path).toEqual(reference);
    }
  });

  it("a new account: signs in through the broker, comes back to the invite, joins with a POST, and gets its own first workspace too", async () => {
    const link = await invite(env, owner, ws, { role: "viewer", maxUses: 5 });
    issuer.reset({ sub: "sub-new-joiner", name: "Nina New", email: "nina@example.org" });
    const { browser, ready } = await signInFromInvite(link);
    expect(ready.status, ready.text).toBe(200);
    expect(ready.text).toContain("Nina New");
    expect(ready.text).toContain("Field &lt;Team&gt; &amp; Co");
    expect(ready.text).toMatch(/<form method="post" action="\/i\/accept">/);
    expect(ready.text).not.toMatch(/<script/i);
    expect([...browser.cookies.keys()]).toContain("__Host-thoth_join");
    const userId = (await env.db.query<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = 'google' AND subject = 'sub-new-joiner'")).rows[0]!.user_id;
    // Signing in and seeing the form changed nothing: no GET side effect.
    expect(await membership(env, ws, userId)).toBeNull();
    // The trial's normal sign-up rules: the new account owns its own first workspace.
    expect(Number((await env.db.query<{ n: string }>("SELECT count(*) AS n FROM memberships WHERE user_id = $1 AND role = 'owner'", [userId])).rows[0]!.n)).toBe(1);
    // The invite sign-in hands out no OAuth code, session or token to the browser.
    expect(Number((await env.db.query<{ n: string }>("SELECT count(*) AS n FROM sessions WHERE user_id = $1", [userId])).rows[0]!.n)).toBe(0);
    expect(Number((await env.db.query<{ n: string }>("SELECT count(*) AS n FROM auth_codes WHERE user_id = $1", [userId])).rows[0]!.n)).toBe(0);

    const joined = await browser.post("/i/accept", { csrf: csrfOf(ready.text)! });
    expect(joined.status, joined.text).toBe(200);
    expect(joined.text).toContain("You joined");
    expect(joined.text).toContain('href="https://app.thoth.test/app/"');
    expect(joined.text).toContain("Settings");
    expect(await membership(env, ws, userId)).toBe("viewer");
    expect(await usesOf(env, link.id)).toBe(1);
    // The form is single use.
    const replay = await browser.post("/i/accept", { csrf: csrfOf(ready.text)! });
    expect(replay.status).toBe(404);
    expect(await usesOf(env, link.id)).toBe(1);
    const audit = await env.db.query<{ actor_id: string }>("SELECT actor_id FROM audit_events WHERE workspace_id = $1 AND action = 'member.joined' AND detail->>'userId' = $2", [ws, userId]);
    expect(audit.rows).toEqual([{ actor_id: userId }]);
  });

  it("an existing member who opens the link is told so, and nothing changes", async () => {
    const link = await invite(env, owner, ws, { role: "viewer" });
    issuer.reset({ sub: "sub-old-editor", name: "Edna Existing" });
    // First sign-in creates the account; make it an editor of the workspace.
    const first = await signInFromInvite(link);
    const userId = (await env.db.query<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = 'google' AND subject = 'sub-old-editor'")).rows[0]!.user_id;
    await env.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'editor')", [ws, userId]);
    expect(first.ready.status).toBe(200);
    const again = await first.browser.get("/i/accept");
    expect(again.status).toBe(200);
    expect(again.text).toContain("already a member");
    expect(again.text).not.toMatch(/<form/);
    expect(await membership(env, ws, userId)).toBe("editor");
    expect(await usesOf(env, link.id)).toBe(0);
  });

  it("refuses a join POST without the form's CSRF value, from another origin, or without the sign-in cookie", async () => {
    const link = await invite(env, owner, ws, { role: "viewer" });
    issuer.reset({ sub: "sub-csrf", name: "Cass Csrf" });
    const { browser, ready } = await signInFromInvite(link);
    const csrf = csrfOf(ready.text)!;
    const userId = (await env.db.query<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = 'google' AND subject = 'sub-csrf'")).rows[0]!.user_id;
    const noCsrf = await browser.post("/i/accept", {});
    expect(noCsrf.status).toBe(403);
    const wrongCsrf = await browser.post("/i/accept", { csrf: csrf.replace(/^./, (c) => (c === "a" ? "b" : "a")) });
    expect(wrongCsrf.status).toBe(403);
    const crossSite = await browser.post("/i/accept", { csrf }, { origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    const noOrigin = await browser.post("/i/accept", { csrf }, {});
    expect(noOrigin.status).toBe(403);
    // A browser that sends `Origin: null` is judged by Fetch Metadata, which a page on another site cannot fake.
    expect((await browser.post("/i/accept", { csrf }, { origin: "null", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await browser.post("/i/accept", { csrf }, { "sec-fetch-site": "same-site" })).status).toBe(403);
    // The join form's page lets the browser name this origin on its POST (no token is in its address).
    expect(ready.headers.get("referrer-policy")).toBe("same-origin");
    expect(ready.text).toContain('<meta name="referrer" content="same-origin">');
    const stranger = new Browser(() => env);
    expect((await stranger.post("/i/accept", { csrf })).status).toBe(404);
    expect(await membership(env, ws, userId)).toBeNull();
    // The real form still works afterwards, also from a browser that sends Origin: null with Sec-Fetch-Site: same-origin.
    expect((await browser.post("/i/accept", { csrf }, { origin: "null", "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect(await membership(env, ws, userId)).toBe("viewer");
  });

  it("sets the join cookie HttpOnly, Secure, SameSite=Lax and short-lived, and keeps the token out of every log line", async () => {
    const link = await invite(env, owner, ws, { role: "viewer" });
    issuer.reset({ sub: "sub-cookie", name: "Coco Cookie" });
    const browser = new Browser(() => env);
    const start = await browser.get(`/i/${link.token}/sign-in?provider=google`);
    const atProvider = await browser.get(start.location!);
    const back = await browser.get(atProvider.location!);
    const join = back.setCookies.find((c) => c.startsWith("__Host-thoth_join="))!;
    expect(join).toMatch(/HttpOnly/);
    expect(join).toMatch(/Secure/);
    expect(join).toMatch(/SameSite=Lax/);
    expect(join).toMatch(/Path=\//);
    expect(Number(/Max-Age=(\d+)/.exec(join)![1])).toBeLessThanOrEqual(900);
    const value = /^__Host-thoth_join=([^;]+)/.exec(join)![1]!;
    expect((await env.db.query("SELECT 1 FROM invite_tickets WHERE ticket_hash = $1", [sha256Hex(value)])).rowCount).toBe(1);
    const logs = logLines.join("\n");
    expect(logs).toContain("/i/[token]");
    expect(logs).not.toContain(link.token);
    expect(logs).not.toContain(value);
  });

  it("the sign-in start for an unknown invite or provider is the same 404 and starts nothing", async () => {
    const before = Number((await env.db.query<{ n: string }>("SELECT count(*) AS n FROM auth_requests")).rows[0]!.n);
    const link = await invite(env, owner, ws);
    const reference = fingerprint(await page(env, `/i/${"Q".repeat(32)}`));
    expect(fingerprint(await page(env, `/i/${"Q".repeat(32)}/sign-in?provider=google`))).toEqual(reference);
    expect(fingerprint(await page(env, `/i/${link.token}/sign-in?provider=nope`))).toEqual(reference);
    expect(Number((await env.db.query<{ n: string }>("SELECT count(*) AS n FROM auth_requests")).rows[0]!.n)).toBe(before);
  });

  it("a workspace that filled up between sign-in and the POST answers a clear page, and the form can be sent again later", async () => {
    const small = await startTestEnv({ env: { MAX_MEMBERS_PER_WORKSPACE: "2", PUBLIC_URL, OIDC_GOOGLE_CLIENT_ID: issuer.clientId, OIDC_GOOGLE_CLIENT_SECRET: issuer.clientSecret }, configure: (c) => void c.signIn!.providers.forEach((p) => p.kind === "oidc" && (p.issuer = issuer.url)) });
    try {
      const boss = await small.user("Boss");
      const sws = await small.workspace("Tiny", { members: { [boss.userId]: "owner" } });
      const link = await invite(small, boss, sws, { role: "viewer" });
      issuer.reset({ sub: "sub-full", name: "Fran Full" });
      const browser = new Browser(() => small);
      const start = await browser.get(`/i/${link.token}/sign-in?provider=google`);
      const back = await browser.get((await browser.get(start.location!)).location!);
      const ready = await browser.get(back.location!);
      const filler = await small.user("Filler");
      await small.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')", [sws, filler.userId]);
      const full = await browser.post("/i/accept", { csrf: csrfOf(ready.text)! });
      expect(full.status).toBe(409);
      expect(full.text).toContain("full");
      await small.db.query("DELETE FROM memberships WHERE user_id = $1", [filler.userId]);
      expect((await browser.post("/i/accept", { csrf: csrfOf(ready.text)! })).status).toBe(200);
    } finally {
      await small.close();
    }
  });
});

describe("the invite page on a server without web sign-in", () => {
  it("explains how to join from the desktop app instead of offering a sign-in", async () => {
    const env = await startTestEnv();
    try {
      const owner = await env.user("Owner");
      const ws = await env.workspace("Plain", { members: { [owner.userId]: "owner" } });
      const link = await invite(env, owner, ws);
      const res = await page(env, `/i/${link.token}`);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain("/sign-in?provider=");
      expect(res.text).toContain("Join with an invite link");
      expect(fingerprint(await page(env, `/i/${link.token}/sign-in?provider=google`))).toEqual(fingerprint(await page(env, `/i/${"Q".repeat(32)}`)));
    } finally {
      await env.close();
    }
  });
});
