import type { ServerConfig } from "./config.ts";
import type { Queryable } from "./db.ts";
import { ApiError } from "./errors.ts";

/** The quotas the shared creation functions enforce. Pass the `ServerConfig`; `{}` means unlimited. */
export type Quotas = Partial<Pick<ServerConfig, "maxWorkspacesPerAccount" | "maxMembersPerWorkspace" | "maxPagesPerWorkspace" | "maxWorkspaceAttachmentBytes" | "maxTotalAttachmentBytes" | "maxAccounts">>;

/** 409 `quota_exceeded`. `limit` and `current` are omitted when `disclose` is false (server-wide quotas). */
export function quotaExceeded(quota: string, detail: string, usage?: { limit: number; current: number }): ApiError {
  return new ApiError("quota_exceeded", detail, { quota, ...(usage ?? {}) });
}

/** Advisory-lock key space for the server-wide and per-account serialization points (distinct from migrations). */
const lock = (q: Queryable, name: string) => q.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [name]);

const countOf = async (q: Queryable, sql: string, values: unknown[]): Promise<number> => Number((await q.query<{ n: string | number }>(sql, values)).rows[0]!.n);

/**
 * Pages: live (not deleted) pages of the workspace plus `adding` must not exceed the limit. The caller
 * holds the workspace row lock (`workspaceAccess(..., { lock: true })`), which makes check-then-insert race-free.
 */
export async function assertCanCreatePages(q: Queryable, quotas: Quotas, workspaceId: string, adding: number): Promise<void> {
  const limit = quotas.maxPagesPerWorkspace;
  if (limit === undefined || adding < 1) return;
  const current = await countOf(q, "SELECT count(*) AS n FROM pages WHERE workspace_id = $1 AND deleted_at IS NULL", [workspaceId]);
  if (current + adding > limit) throw quotaExceeded("pagesPerWorkspace", `this workspace is limited to ${limit} pages (${current} in use${adding > 1 ? `, ${adding} requested` : ""}); delete pages to make room`, { limit, current });
}

/**
 * Attachments, checked before any byte is stored. Caller holds the workspace row lock.
 *
 * Per workspace: the sum of `size` over the workspace's attachment rows. Every upload is one attachment
 * row, so uploading identical bytes twice counts twice: the quota measures what the workspace holds, not
 * how the server deduplicates storage underneath.
 *
 * Server-wide: the sum over DISTINCT content hashes, because identical bytes are stored once. An upload
 * whose hash is already stored adds nothing. The check is serialized by an advisory lock; it is taken
 * after the workspace lock, and nothing takes them in the other order.
 */
export async function assertAttachmentFits(q: Queryable, quotas: Quotas, workspaceId: string, hash: string, size: number): Promise<void> {
  const perWorkspace = quotas.maxWorkspaceAttachmentBytes;
  if (perWorkspace !== undefined) {
    const current = await countOf(q, "SELECT coalesce(sum(size), 0) AS n FROM attachments WHERE workspace_id = $1", [workspaceId]);
    if (current + size > perWorkspace) throw quotaExceeded("attachmentBytesPerWorkspace", `this workspace is limited to ${perWorkspace} bytes of attachments (${current} in use); this upload needs ${size}`, { limit: perWorkspace, current });
  }
  const server = quotas.maxTotalAttachmentBytes;
  if (server !== undefined) {
    await lock(q, "attachment-total");
    const known = await q.query("SELECT 1 FROM attachments WHERE hash = $1 LIMIT 1", [hash]);
    if (known.rowCount === 0) {
      const current = await countOf(q, "SELECT coalesce(sum(size), 0) AS n FROM (SELECT DISTINCT ON (hash) size FROM attachments ORDER BY hash) s", []);
      if (current + size > server) throw quotaExceeded("serverAttachmentBytes", "this trial server has run out of attachment storage; it is full, and nothing is wrong with your account or request. Try again later or contact the operator");
    }
  }
}

/** Members: a new membership (not a role change) must not exceed the limit. Caller holds the workspace row lock. */
export async function assertCanAddMember(q: Queryable, quotas: Quotas, workspaceId: string): Promise<void> {
  const limit = quotas.maxMembersPerWorkspace;
  if (limit === undefined) return;
  const current = await countOf(q, "SELECT count(*) AS n FROM memberships WHERE workspace_id = $1", [workspaceId]);
  if (current + 1 > limit) throw quotaExceeded("membersPerWorkspace", `this workspace is limited to ${limit} members (${current} in use)`, { limit, current });
}

/** Workspaces an account owns (`owner` memberships). Serializes concurrent creations by the same account. */
export async function assertCanOwnAnotherWorkspace(q: Queryable, quotas: Quotas, userId: string): Promise<void> {
  const limit = quotas.maxWorkspacesPerAccount;
  if (limit === undefined) return;
  await lock(q, `owner:${userId}`);
  const current = await countOf(q, "SELECT count(*) AS n FROM memberships WHERE user_id = $1 AND role = 'owner'", [userId]);
  if (current + 1 > limit) throw quotaExceeded("workspacesPerAccount", `an account may own at most ${limit} workspace${limit === 1 ? "" : "s"} (${current} owned)`, { limit, current });
}

/**
 * Accounts: call inside the transaction that inserts the user, before the insert, in EVERY place that
 * creates users (admin CLI today, sign-in later). Serialized, so concurrent sign-ups cannot overshoot.
 * The quota is server-wide and not advertised, so the reply names no numbers.
 */
export async function assertCanCreateAccount(q: Queryable, quotas: Quotas): Promise<void> {
  const limit = quotas.maxAccounts;
  if (limit === undefined) return;
  await lock(q, "accounts");
  const current = await countOf(q, "SELECT count(*) AS n FROM users", []);
  if (current + 1 > limit) throw quotaExceeded("accounts", "this trial server is not accepting new accounts right now because it is full; nothing is wrong with your request");
}
