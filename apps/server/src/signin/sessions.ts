import type { SignInConfig } from "../config.ts";
import type { Database, Queryable, Tx } from "../db.ts";
import { audit } from "../http.ts";
import { opaqueId } from "../ids.ts";
import type { ClientId } from "./clients.ts";
import { ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX, pkceMatches, randomSecret, sha256Hex } from "./secrets.ts";

/** What a successful grant hands back. `refreshToken` goes to the body (desktop) or a cookie (web), never both. */
export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
}

export type GrantResult = { ok: true; tokens: IssuedTokens } | { ok: false; reason: string };

/** Last activity, for the inactivity rule; at most one write per account per hour. */
export async function touchUser(q: Queryable, userId: string): Promise<void> {
  await q.query("UPDATE users SET last_seen_at = now() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 hour')", [userId]);
}

/** Revokes a session and every access token of it. Refresh tokens die with it (they are checked against the session). */
export async function revokeSession(q: Queryable, sessionId: string, reason: string): Promise<boolean> {
  const { rows } = await q.query<{ user_id: string }>("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING user_id", [sessionId]);
  await q.query("UPDATE access_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL", [sessionId]);
  const row = rows[0];
  if (row) await audit(q, { actorId: row.user_id, action: "auth.session_revoked", detail: { sessionId, reason } });
  return row !== undefined;
}

/** A new access token and refresh token for a session. Neither outlives the session. Only their hashes are stored. */
async function issueTokens(tx: Tx, config: SignInConfig, session: { id: string; userId: string; clientId: string }): Promise<IssuedTokens> {
  const accessToken = ACCESS_TOKEN_PREFIX + randomSecret();
  const refreshToken = REFRESH_TOKEN_PREFIX + randomSecret();
  const { rows } = await tx.query<{ access_in: number; refresh_in: number }>(
    `WITH s AS (SELECT expires_at FROM sessions WHERE id = $1),
          a AS (INSERT INTO access_tokens (id, user_id, token_hash, label, expires_at, session_id)
                SELECT $2, $3, $4, $5, least(now() + make_interval(secs => $6), s.expires_at), $1 FROM s
                RETURNING expires_at),
          r AS (INSERT INTO refresh_tokens (token_hash, session_id, expires_at)
                SELECT $7, $1, least(now() + make_interval(days => $8), s.expires_at) FROM s
                RETURNING expires_at)
     SELECT ceil(extract(epoch FROM a.expires_at - now()))::int AS access_in, ceil(extract(epoch FROM r.expires_at - now()))::int AS refresh_in FROM a, r`,
    [session.id, opaqueId("tok"), session.userId, sha256Hex(accessToken), `sign-in ${session.clientId}`, config.accessTokenTtlSeconds, sha256Hex(refreshToken), config.refreshTokenTtlDays],
  );
  const row = rows[0];
  if (!row) throw new Error("session vanished while issuing tokens");
  return { accessToken, expiresIn: Math.max(1, row.access_in), refreshToken, refreshExpiresIn: Math.max(1, row.refresh_in) };
}

/**
 * `grant_type=authorization_code`. The code row is locked and burned on every attempt, success or not. A code that
 * was already used is a replay: the session its first use created is revoked (RFC 6749 section 4.1.2).
 */
export async function redeemCode(db: Database, config: SignInConfig, input: { code: string; clientId: ClientId; redirectUri: string; verifier: string | undefined }): Promise<GrantResult> {
  return db.tx(async (tx) => {
    const { rows } = await tx.query<{ user_id: string; client_id: string; redirect_uri: string; code_challenge: string; provider: string; used: boolean; live: boolean; session_id: string | null }>(
      "SELECT user_id, client_id, redirect_uri, code_challenge, provider, used_at IS NOT NULL AS used, expires_at > now() AS live, session_id FROM auth_codes WHERE code_hash = $1 FOR UPDATE",
      [sha256Hex(input.code)],
    );
    const code = rows[0];
    if (!code) return { ok: false, reason: "unknown code" };
    if (code.used) {
      if (code.session_id !== null) await revokeSession(tx, code.session_id, "code_replay");
      await audit(tx, { actorId: code.user_id, action: "auth.code_replay", detail: { clientId: code.client_id, ...(code.session_id ? { sessionId: code.session_id } : {}) } });
      return { ok: false, reason: "code replayed" };
    }
    await tx.query("UPDATE auth_codes SET used_at = now() WHERE code_hash = $1", [sha256Hex(input.code)]);
    if (!code.live) return { ok: false, reason: "code expired" };
    if (code.client_id !== input.clientId) return { ok: false, reason: "client mismatch" };
    if (code.redirect_uri !== input.redirectUri) return { ok: false, reason: "redirect_uri mismatch" };
    if (!pkceMatches(input.verifier, code.code_challenge)) return { ok: false, reason: "PKCE mismatch" };

    const sessionId = opaqueId("ses");
    await tx.query("INSERT INTO sessions (id, user_id, client_id, provider, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))", [sessionId, code.user_id, code.client_id, code.provider, config.sessionMaxDays]);
    await tx.query("UPDATE auth_codes SET session_id = $2 WHERE code_hash = $1", [sha256Hex(input.code), sessionId]);
    const tokens = await issueTokens(tx, config, { id: sessionId, userId: code.user_id, clientId: code.client_id });
    await touchUser(tx, code.user_id);
    await audit(tx, { actorId: code.user_id, action: "auth.session_created", detail: { sessionId, clientId: code.client_id, provider: code.provider } });
    return { ok: true, tokens };
  });
}

/**
 * `grant_type=refresh_token`. The token row and its session are locked. A token presented a second time is reuse:
 * the whole session (every refresh and access token of the family) is revoked and `auth.refresh_reuse` audited.
 * Two refreshes racing with one token therefore revoke the session; clients refresh one at a time.
 */
export async function refreshSession(db: Database, config: SignInConfig, input: { refreshToken: string; clientId: ClientId }): Promise<GrantResult> {
  return db.tx(async (tx) => {
    const hash = sha256Hex(input.refreshToken);
    const { rows } = await tx.query<{ session_id: string; user_id: string; client_id: string; used: boolean; token_live: boolean; session_live: boolean }>(
      `SELECT r.session_id, s.user_id, s.client_id, r.used_at IS NOT NULL AS used, r.expires_at > now() AS token_live,
              (s.revoked_at IS NULL AND s.expires_at > now()) AS session_live
         FROM refresh_tokens r JOIN sessions s ON s.id = r.session_id
        WHERE r.token_hash = $1
          FOR UPDATE OF r, s`,
      [hash],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: "unknown refresh token" };
    if (row.client_id !== input.clientId) return { ok: false, reason: "client mismatch" };
    if (row.used) {
      await revokeSession(tx, row.session_id, "refresh_reuse");
      await audit(tx, { actorId: row.user_id, action: "auth.refresh_reuse", detail: { sessionId: row.session_id, clientId: row.client_id } });
      return { ok: false, reason: "refresh token reused" };
    }
    if (!row.session_live) return { ok: false, reason: "session revoked or expired" };
    if (!row.token_live) return { ok: false, reason: "refresh token expired" };
    await tx.query("UPDATE refresh_tokens SET used_at = now() WHERE token_hash = $1", [hash]);
    const tokens = await issueTokens(tx, config, { id: row.session_id, userId: row.user_id, clientId: row.client_id });
    await touchUser(tx, row.user_id);
    return { ok: true, tokens };
  });
}

/**
 * RFC 7009. The token may be a refresh token or a session access token; its session is revoked when it was
 * issued to `clientId`. Unknown tokens, personal access tokens and other clients' tokens change nothing.
 */
export async function revokeByToken(db: Database, input: { token: string; clientId: ClientId }): Promise<void> {
  const hash = sha256Hex(input.token);
  await db.tx(async (tx) => {
    const { rows } = await tx.query<{ session_id: string; client_id: string }>(
      `SELECT s.id AS session_id, s.client_id FROM refresh_tokens r JOIN sessions s ON s.id = r.session_id WHERE r.token_hash = $1
       UNION ALL
       SELECT s.id, s.client_id FROM access_tokens t JOIN sessions s ON s.id = t.session_id WHERE t.token_hash = $1`,
      [hash],
    );
    const row = rows[0];
    if (row && row.client_id === input.clientId) await revokeSession(tx, row.session_id, "sign_out");
  });
}

/** Removes what has expired (sign-in.md section 8). Returns the number of rows deleted. */
export async function purgeSignIn(db: Queryable): Promise<number> {
  let total = 0;
  for (const sql of [
    "DELETE FROM auth_requests WHERE expires_at <= now()",
    "DELETE FROM auth_codes WHERE expires_at <= now()",
    "DELETE FROM refresh_tokens WHERE expires_at <= now() - interval '1 day'",
    "DELETE FROM access_tokens WHERE session_id IS NOT NULL AND expires_at <= now() - interval '1 day'",
    // Cascades to the session's remaining refresh and access tokens.
    "DELETE FROM sessions WHERE revoked_at IS NOT NULL OR expires_at <= now()",
    "DELETE FROM sign_ups WHERE created_at <= now() - interval '1 day'",
    // ADR-0024: join tickets of invite pages, once expired (used or not).
    "DELETE FROM invite_tickets WHERE expires_at <= now()",
  ]) total += (await db.query(sql)).rowCount ?? 0;
  return total;
}
