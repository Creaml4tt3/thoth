/**
 * Inactive accounts (ADR-0014, privacy notice "Inactive accounts") against the real server and PostgreSQL: maintenance
 * deletes an account with no sign-in and no use for INACTIVE_ACCOUNT_DAYS, with the workspaces it alone owns and their
 * attachments; keeps recent accounts, accounts in use and accounts made with the CLI that never signed in; skips an
 * account that alone owns a workspace with other members; keeps an anonymous row when shared history names it; and does
 * nothing when the setting is unset. A session refreshed every day is covered in signin.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMaintenance } from "../src/maintenance.ts";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, uploadAttachment } from "./support.ts";

const count = async (env: TestEnv, sql: string, values: unknown[] = []) => Number((await env.db.query<{ n: string }>(sql, values)).rows[0]!.n);

/** Waits for the best-effort `last_used_at` write of the user's last request, then moves both activity marks back. */
async function lastActive(env: TestEnv, who: TestPrincipal, days: number, options: { usedToken?: boolean } = {}) {
  if (options.usedToken) {
    for (let i = 0; i < 50 && (await count(env, "SELECT count(*) AS n FROM access_tokens WHERE id = $1 AND last_used_at IS NOT NULL", [who.tokenId])) === 0; i++) await new Promise((r) => setTimeout(r, 50));
  }
  await env.db.query("UPDATE users SET last_seen_at = now() - make_interval(days => $2) WHERE id = $1", [who.userId, days]);
  await env.db.query("UPDATE access_tokens SET last_used_at = CASE WHEN last_used_at IS NULL THEN NULL ELSE now() - make_interval(days => $2) END WHERE user_id = $1", [who.userId, days]);
}

const exists = (env: TestEnv, userId: string) => count(env, "SELECT count(*) AS n FROM users WHERE id = $1", [userId]);

describe("inactive accounts: INACTIVE_ACCOUNT_DAYS=90", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await startTestEnv({ env: { BLOB_STORE: "postgres", INACTIVE_ACCOUNT_DAYS: "90" } });
  });
  afterAll(() => env.close());

  const maintenance = () => runMaintenance(env.db, { revisionRetentionDays: undefined, inactiveAccountDays: env.config.inactiveAccountDays, blobs: env.server.deps.blobs });

  it("advertises limits.inactiveAccountDays so the apps can warn", async () => {
    expect((await env.api(null, "GET", "/capabilities")).json.limits.inactiveAccountDays).toBe(90);
  });

  it("deletes an old unused account with its sign-ins, tokens, memberships and the workspace it alone owns, with its blobs", async () => {
    const old = await env.user("Old");
    const keeper = await env.user("Keeper");
    const own = await env.workspace("Own", { members: { [old.userId]: "owner" } });
    const theirs = await env.workspace("Theirs", { members: { [keeper.userId]: "owner", [old.userId]: "viewer" } });
    await createPage(env, old, own, { title: "Mine", markdown: "# Mine\n" });
    await uploadAttachment(env, old, own, Buffer.from("only the old account's bytes"));
    const hash = (await env.db.query<{ hash: string }>("SELECT hash FROM attachments WHERE workspace_id = $1", [own])).rows[0]!.hash;
    await env.db.query("INSERT INTO identities (provider, subject, user_id) VALUES ('google', 'old-sub', $1)", [old.userId]);
    await env.db.query("INSERT INTO sessions (id, user_id, client_id, provider, expires_at) VALUES ('ses_inactive', $1, 'thoth-desktop', 'google', now() + interval '1 day')", [old.userId]);
    await lastActive(env, old, 91, { usedToken: true });
    await lastActive(env, keeper, 1);

    const result = await maintenance();
    expect(result.inactiveAccountsDeleted).toBe(1);
    expect(result.inactiveAccountsSkipped).toBe(0);
    expect(await exists(env, old.userId)).toBe(0);
    for (const table of ["access_tokens", "identities", "sessions", "memberships"]) expect(await count(env, `SELECT count(*) AS n FROM ${table} WHERE user_id = $1`, [old.userId]), table).toBe(0);
    expect(await count(env, "SELECT count(*) AS n FROM workspaces WHERE id = $1", [own])).toBe(0);
    expect(await count(env, "SELECT count(*) AS n FROM pages WHERE workspace_id = $1", [own])).toBe(0);
    expect(await count(env, "SELECT count(*) AS n FROM blobs WHERE hash = $1", [hash])).toBe(0);
    // Someone else's workspace stays; only the membership went.
    expect(await count(env, "SELECT count(*) AS n FROM memberships WHERE workspace_id = $1", [theirs])).toBe(1);
    expect((await env.api(old, "GET", "/me")).status).toBe(401);
    expect(await count(env, "SELECT count(*) AS n FROM audit_events WHERE action = 'account.deleted' AND detail->>'userId' = $1", [old.userId])).toBe(1);
    expect(await count(env, "SELECT count(*) AS n FROM audit_events WHERE action = 'workspace.purged' AND workspace_id = $1", [own])).toBe(1);
    expect(await exists(env, keeper.userId)).toBe(1);
  });

  it("keeps an account seen within the limit, one whose token was used today, and one made with the CLI that never signed in", async () => {
    const recent = await env.user("Recent");
    const daily = await env.user("Daily");
    const cli = await env.user("CLI");
    for (const who of [recent, daily]) await env.workspace("Kept", { members: { [who.userId]: "owner" } });
    await lastActive(env, recent, 89);
    await lastActive(env, daily, 200);
    // Real use with a personal access token counts even when the last sign-in is old.
    expect((await env.api(daily, "GET", "/workspaces")).status).toBe(200);
    for (let i = 0; i < 50 && (await count(env, "SELECT count(*) AS n FROM access_tokens WHERE id = $1 AND last_used_at > now() - interval '1 minute'", [daily.tokenId])) === 0; i++) await new Promise((r) => setTimeout(r, 50));
    await env.db.query("UPDATE users SET created_at = now() - interval '1 year' WHERE id = $1", [cli.userId]);

    const result = await maintenance();
    expect(result.inactiveAccountsDeleted).toBe(0);
    for (const who of [recent, daily, cli]) expect(await exists(env, who.userId)).toBe(1);
  });

  it("skips an account that alone owns a workspace with other members, and counts it", async () => {
    const sharer = await env.user("Sharer");
    const member = await env.user("Member");
    const ws = await env.workspace("Shared", { members: { [sharer.userId]: "owner", [member.userId]: "editor" } });
    await lastActive(env, sharer, 100);
    await lastActive(env, member, 1);

    const result = await maintenance();
    expect([result.inactiveAccountsDeleted, result.inactiveAccountsSkipped]).toEqual([0, 1]);
    expect(await exists(env, sharer.userId)).toBe(1);
    expect(await count(env, "SELECT count(*) AS n FROM memberships WHERE workspace_id = $1", [ws])).toBe(2);

    // A co-owner makes it no longer the account's alone: it is deleted and the workspace stays.
    await env.db.query("UPDATE memberships SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2", [ws, member.userId]);
    const next = await maintenance();
    expect([next.inactiveAccountsDeleted, next.inactiveAccountsSkipped]).toEqual([1, 0]);
    expect(await exists(env, sharer.userId)).toBe(0);
    expect(await count(env, "SELECT count(*) AS n FROM memberships WHERE workspace_id = $1", [ws])).toBe(1);
  });

  it("keeps an anonymous row when its revisions stay in a workspace someone else owns", async () => {
    const writer = await env.user("Writer");
    const owner = await env.user("Owner");
    const ws = await env.workspace("Team", { members: { [owner.userId]: "owner", [writer.userId]: "editor" } });
    const page = await createPage(env, writer, ws, { title: "Notes", markdown: "# Notes\n" });
    await env.db.query("UPDATE users SET email = 'writer@example.org' WHERE id = $1", [writer.userId]);
    await lastActive(env, writer, 120, { usedToken: true });
    await lastActive(env, owner, 1);

    expect((await maintenance()).inactiveAccountsDeleted).toBe(1);
    const row = (await env.db.query<{ display_name: string; email: string | null; last_seen_at: Date | null }>("SELECT display_name, email, last_seen_at FROM users WHERE id = $1", [writer.userId])).rows[0];
    expect(row).toEqual({ display_name: "Deleted account", email: null, last_seen_at: null });
    for (const table of ["access_tokens", "memberships"]) expect(await count(env, `SELECT count(*) AS n FROM ${table} WHERE user_id = $1`, [writer.userId]), table).toBe(0);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${page.id}`)).status).toBe(200);
    // Not picked up again.
    expect((await maintenance()).inactiveAccountsDeleted).toBe(0);
  });
});

describe("inactive accounts: off when INACTIVE_ACCOUNT_DAYS is unset", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await startTestEnv();
  });
  afterAll(() => env.close());

  it("is not advertised and deletes nothing", async () => {
    expect(env.config.inactiveAccountDays).toBeUndefined();
    expect((await env.api(null, "GET", "/capabilities")).json.limits.inactiveAccountDays).toBeUndefined();
    const old = await env.user("Old");
    await env.workspace("Own", { members: { [old.userId]: "owner" } });
    await lastActive(env, old, 1000);
    const result = await runMaintenance(env.db, { revisionRetentionDays: undefined, inactiveAccountDays: env.config.inactiveAccountDays, blobs: env.server.deps.blobs });
    expect([result.inactiveAccountsDeleted, result.inactiveAccountsSkipped]).toEqual([0, 0]);
    expect(await exists(env, old.userId)).toBe(1);
  });
});
