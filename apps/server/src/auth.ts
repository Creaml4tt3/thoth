import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "./db.ts";

/** The authenticated caller, whatever credential type proved it. */
export interface Principal {
  id: string;
  displayName: string;
  email?: string;
  /** Opaque identifier of the credential that was presented (a token ID), for revalidation. Never the secret. */
  credentialId?: string;
}

/** The part of an HTTP request an authenticator may look at. */
export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Authentication seam. Phase 2a ships personal access tokens; OIDC (phase 2b) is another
 * implementation of this interface. Authorization (roles) is separate and lives in the database.
 */
export interface Authenticator {
  /** Resolves the request's credential to a principal, or `null` when it is missing, malformed, unknown, expired or revoked. */
  authenticate(req: AuthRequest): Promise<Principal | null>;
  /** Long-lived connections (SSE) call this periodically; `false` closes them. Optional. */
  revalidate?(principal: Principal): Promise<boolean>;
}

export const TOKEN_PREFIX = "thoth_pat_";

/** A fresh random token: 256 bits, URL-safe. Shown once to its owner, stored only as a hash. */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** SHA-256 hex. Tokens are high-entropy, so a fast unsalted hash is appropriate and allows indexed lookup. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const BEARER = /^Bearer +([A-Za-z0-9._~+/=-]{16,512})$/i;

/** Extracts the credential from `Authorization: Bearer <token>`; `null` for anything else. */
export function bearerToken(headers: AuthRequest["headers"]): string | null {
  const raw = headers.authorization;
  if (typeof raw !== "string") return null;
  const match = BEARER.exec(raw.trim());
  return match ? match[1]! : null;
}

interface PrincipalRow {
  token_id: string;
  id: string;
  display_name: string;
  email: string | null;
}

const toPrincipal = (row: PrincipalRow): Principal => ({ id: row.id, displayName: row.display_name, ...(row.email ? { email: row.email } : {}), credentialId: row.token_id });

/** A sign-in access token (`session_id` set) is valid only while its session is neither revoked nor past its maximum age. */
const LIVE_SESSION = "(t.session_id IS NULL OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = t.session_id AND s.revoked_at IS NULL AND s.expires_at > now()))";

/** Personal access tokens and sign-in access tokens, looked up by hash. Revocation and expiry take effect on the next request. */
export class PatAuthenticator implements Authenticator {
  readonly #db: Queryable;
  constructor(db: Queryable) {
    this.#db = db;
  }

  async authenticate(req: AuthRequest): Promise<Principal | null> {
    const token = bearerToken(req.headers);
    if (token === null) return null;
    const { rows } = await this.#db.query<PrincipalRow>(
      `SELECT t.id AS token_id, u.id, u.display_name, u.email
         FROM access_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND ${LIVE_SESSION}`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) return null;
    // Best effort and rate limited to one write per token per minute; never blocks the request.
    void this.#db.query("UPDATE access_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [row.token_id]).catch(() => undefined);
    return toPrincipal(row);
  }

  async revalidate(principal: Principal): Promise<boolean> {
    if (!principal.credentialId) return false;
    const { rowCount } = await this.#db.query(`SELECT 1 FROM access_tokens t WHERE t.id = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND ${LIVE_SESSION}`, [principal.credentialId]);
    return (rowCount ?? 0) > 0;
  }
}
