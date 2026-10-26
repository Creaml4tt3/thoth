import type { Role } from "@thoth/workspace-protocol";
import type { Queryable } from "./db.ts";
import { ApiError } from "./errors.ts";
import { audit } from "./http.ts";
import { assertCanAddMember, type Quotas } from "./quota.ts";
import { SHARE_TOKEN_PATTERN, generateShareToken, hashShareToken, shareTokenMatches } from "./share/tokens.ts";

/**
 * Invite links (ADR-0024): what the API calls and the invite pages share. Tokens are made exactly like share-link
 * tokens (ADR-0023): 24 bytes from the CSPRNG, base64url, only the SHA-256 stored, compared in constant time.
 */
export const INVITE_TOKEN_PATTERN = SHARE_TOKEN_PATTERN;
export const generateInviteToken = generateShareToken;
export const hashInviteToken = hashShareToken;
export const inviteTokenMatches = shareTokenMatches;

/** The one detail of every "no such invite": unknown, malformed, expired, revoked, used up, or its creator no longer an owner. */
export const INVITE_NOT_FOUND = "no such invite";
export const inviteNotFound = () => new ApiError("not_found", INVITE_NOT_FOUND);

/**
 * When a link may be used: not revoked, not expired, not used up, and its creator still an owner of the workspace (a
 * link carries its creator's authority, like a share link; ADR-0023 rule 3). `l` is the invite_links row.
 */
export const INVITE_ACTIVE = `l.revoked_at IS NULL AND l.expires_at > now() AND l.uses < l.max_uses
  AND EXISTS (SELECT 1 FROM memberships c WHERE c.workspace_id = l.workspace_id AND c.user_id = l.created_by AND c.role = 'owner')`;

export interface ActiveInvite {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: Exclude<Role, "owner">;
  inviterName: string;
  tokenHash: string;
}

interface InviteRow {
  id: string;
  workspace_id: string;
  workspace_name: string;
  role: Exclude<Role, "owner">;
  inviter_name: string;
  token_hash: string;
}

const ACTIVE_INVITE_SQL = `SELECT l.id, l.workspace_id, w.name AS workspace_name, l.role, u.display_name AS inviter_name, l.token_hash
   FROM invite_links l JOIN workspaces w ON w.id = l.workspace_id JOIN users u ON u.id = l.created_by
  WHERE`;

const toInvite = (row: InviteRow | undefined): ActiveInvite | null =>
  row ? { id: row.id, workspaceId: row.workspace_id, workspaceName: row.workspace_name, role: row.role, inviterName: row.inviter_name, tokenHash: row.token_hash } : null;

/**
 * The active invite for a token, or null. One statement of one shape whatever the outcome, run for malformed tokens
 * too (their hash matches nothing), and the hash is then compared in constant time, so a dead token, an unknown one and
 * a malformed one cost the same.
 */
export async function resolveInvite(q: Queryable, token: string): Promise<ActiveInvite | null> {
  const tokenHash = hashInviteToken(token);
  const { rows } = await q.query<InviteRow>(`${ACTIVE_INVITE_SQL} l.token_hash = $1 AND ${INVITE_ACTIVE}`, [tokenHash]);
  const invite = toInvite(rows[0]);
  const matches = inviteTokenMatches(token, invite?.tokenHash ?? null);
  return invite && matches && INVITE_TOKEN_PATTERN.test(token) ? invite : null;
}

/** The active invite with this ID (the invite pages after sign-in know the ID, not the token). */
export async function activeInviteById(q: Queryable, id: string): Promise<ActiveInvite | null> {
  const { rows } = await q.query<InviteRow>(`${ACTIVE_INVITE_SQL} l.id = $1 AND ${INVITE_ACTIVE}`, [id]);
  return toInvite(rows[0]);
}

export interface Accepted {
  workspaceId: string;
  name: string;
  role: Role;
  joined: boolean;
}

/**
 * Joins `userId` to the invite's workspace, inside the caller's transaction. The workspace row is locked first (as
 * every membership change does), then the invite row, and the link is re-checked under those locks: two people
 * racing for the last use, or for the last member place, cannot both get in. Someone already a member keeps their role
 * and spends no use. Throws 404 `not_found` (the one answer for a dead link) or 409 `quota_exceeded`.
 */
export async function acceptInviteIn(tx: Queryable, inviteId: string, userId: string, quotas: Quotas): Promise<Accepted> {
  const { rows: found } = await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM invite_links WHERE id = $1", [inviteId]);
  const workspaceId = found[0]?.workspace_id;
  if (!workspaceId) throw inviteNotFound();
  const { rows: ws } = await tx.query<{ name: string }>("SELECT name FROM workspaces WHERE id = $1 FOR NO KEY UPDATE", [workspaceId]);
  if (!ws[0]) throw inviteNotFound();
  const { rows: live } = await tx.query<{ role: Exclude<Role, "owner"> }>(`SELECT l.role FROM invite_links l WHERE l.id = $1 AND ${INVITE_ACTIVE} FOR UPDATE OF l`, [inviteId]);
  const link = live[0];
  if (!link) throw inviteNotFound();
  const existing = (await tx.query<{ role: Role }>("SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId])).rows[0];
  if (existing) return { workspaceId, name: ws[0].name, role: existing.role, joined: false };
  await assertCanAddMember(tx, quotas, workspaceId);
  await tx.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)", [workspaceId, userId, link.role]);
  await tx.query("UPDATE invite_links SET uses = uses + 1 WHERE id = $1", [inviteId]);
  await audit(tx, { actorId: userId, workspaceId, action: "member.joined", detail: { userId, inviteId, role: link.role } });
  return { workspaceId, name: ws[0].name, role: link.role, joined: true };
}

/** Is `userId` a member of the workspace, and with which role? */
export async function memberRole(q: Queryable, workspaceId: string, userId: string): Promise<Role | null> {
  return (await q.query<{ role: Role }>("SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId])).rows[0]?.role ?? null;
}
