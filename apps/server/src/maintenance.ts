import { timingSafeEqual, createHash } from "node:crypto";
import type { Database } from "./db.ts";
import { purgeFeedback } from "./feedback.ts";
import { purgeIdempotencyRecords } from "./idempotency.ts";
import { purgePresence } from "./presence.ts";
import { purgeRateLimits } from "./ratelimit.ts";
import { purgeSignIn } from "./signin/sessions.ts";
import { releaseBlobs, type BlobStore } from "./blob.ts";
import { audit } from "./http.ts";
import { purgeExpiredWorkspaces, purgeWorkspaceIn } from "./workspaces.ts";
import { purgeExpiredTrash } from "./trash.ts";

export interface MaintenanceResult {
  revisionsPruned: number;
  idempotencyRecordsDeleted: number;
  rateLimitRowsDeleted: number;
  /** Expired auth requests, codes, refresh and session access tokens, finished sessions, old sign-up counters, expired invite join tickets. */
  signInRowsDeleted: number;
  /** Workspaces deleted more than 30 days ago, purged with their pages, revisions and attachments (ADR-0025). */
  workspacesPurged: number;
  /** Pages in a Trash for more than 30 days, removed with their revisions (ADR-0043). */
  trashPagesPurged: number;
  /** Feedback older than 90 days, with its app log (ADR-0040). */
  feedbackDeleted: number;
  /** Page presence heartbeats past their 45-second lifetime (ADR-0041). */
  presenceRowsDeleted: number;
  /** Accounts unused for INACTIVE_ACCOUNT_DAYS, deleted with the workspaces they alone own (ADR-0014). */
  inactiveAccountsDeleted: number;
  /** Inactive accounts kept because a workspace they alone own has other members; the operator decides. */
  inactiveAccountsSkipped: number;
}

/**
 * Deletes revisions that are not current, older than `retentionDays`, and not pinned by a live transfer.
 *
 * Protected, always:
 *  - the current revision of every page (deleted pages too: their last revision stays);
 *  - a revision pinned by a `from_workspace` transfer that is not terminal (`done`, `failed`, `aborted`).
 *    Terminal-state transfers keep their `revision_id` as history only; they never read the revision again
 *    except `destination_committed_source_cleanup_pending`, which is not terminal here.
 *
 * Runs in one transaction with `thoth.pruning = on`, the only way past the immutability trigger (migration
 * 006). Surviving revisions are not modified: a revision whose parent was pruned keeps its `parentId`, which
 * then names a revision that answers 404. The revision list shows only what remains.
 */
export async function pruneRevisions(db: Database, retentionDays: number): Promise<number> {
  return db.tx(async (tx) => {
    await tx.query("SELECT set_config('thoth.pruning', 'on', true)");
    const { rowCount } = await tx.query(
      `DELETE FROM page_revisions r
        WHERE r.created_at < now() - make_interval(days => $1)
          AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.workspace_id = r.workspace_id AND p.id = r.page_id AND p.current_revision_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM transfer_items i JOIN transfers t ON t.operation_id = i.operation_id
                           WHERE i.revision_id = r.id AND t.state NOT IN ('done', 'failed', 'aborted'))`,
      [retentionDays],
    );
    return rowCount ?? 0;
  });
}

/**
 * No sign-in or token refresh (`last_seen_at`, bumped at most hourly) and no personal access token used
 * (`last_used_at`) for `$1` days. Sign-in access tokens live at most an hour, so any use of a session refreshes it.
 * A NULL `last_seen_at` (an account made with the CLI that never signed in) never matches.
 */
const INACTIVE = `u.last_seen_at < now() - make_interval(days => $1)
  AND NOT EXISTS (SELECT 1 FROM access_tokens t WHERE t.user_id = u.id AND t.last_used_at >= now() - make_interval(days => $1))`;

/** The account is the only owner of a workspace that has other members. */
const ALONE_OWNS_SHARED = `EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.role = 'owner'
  AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.workspace_id = m.workspace_id AND o.user_id <> u.id AND o.role = 'owner')
  AND EXISTS (SELECT 1 FROM memberships x WHERE x.workspace_id = m.workspace_id AND x.user_id <> u.id))`;

/** Rows that belong to the account alone and go with it (most would cascade, but a kept anonymous row needs them gone too). */
const ACCOUNT_ROWS = ["identities", "sessions", "auth_codes", "access_tokens", "invite_tickets", "team_members", "page_presence", "memberships"];

/**
 * Deletes accounts inactive for `days` days (ADR-0014, privacy notice "Inactive accounts"), one transaction each,
 * re-checked under the account's row lock: a sign-in or refresh in flight holds a lock on it and wins. The workspaces
 * the account alone owns are purged with their attachments. An account that alone owns a workspace with other members
 * is skipped: handing that workspace over is the operator's call. When revisions or other history in workspaces that
 * stay still name the account, its row is kept as "Deleted account" without name, email, sign-in or tokens.
 */
export async function deleteInactiveAccounts(db: Database, blobs: BlobStore, days: number): Promise<{ deleted: number; skipped: number }> {
  let skipped = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM users u WHERE ${INACTIVE} AND ${ALONE_OWNS_SHARED}`, [days])).rows[0]?.n ?? 0);
  const { rows } = await db.query<{ id: string }>(`SELECT u.id FROM users u WHERE ${INACTIVE} AND NOT ${ALONE_OWNS_SHARED} ORDER BY u.last_seen_at LIMIT 100`, [days]);
  let deleted = 0;
  for (const { id } of rows) {
    const hashes = await db.tx(async (tx) => {
      const locked = await tx.query(`SELECT 1 FROM users u WHERE u.id = $2 AND ${INACTIVE} FOR UPDATE SKIP LOCKED`, [days, id]);
      if (locked.rowCount === 0) return null;
      const owned = await tx.query<{ id: string }>(
        `SELECT w.id FROM workspaces w JOIN memberships m ON m.workspace_id = w.id AND m.user_id = $1 AND m.role = 'owner'
          WHERE NOT EXISTS (SELECT 1 FROM memberships o WHERE o.workspace_id = w.id AND o.user_id <> $1 AND o.role = 'owner')
          ORDER BY w.id FOR UPDATE OF w`,
        [id],
      );
      const alone = owned.rows.map((r) => r.id);
      // Checked again now that the workspace rows are locked: joining one locks it first.
      const others = await tx.query("SELECT 1 FROM memberships WHERE workspace_id = ANY($1) AND user_id <> $2 LIMIT 1", [alone, id]);
      if ((others.rowCount ?? 0) > 0) {
        skipped++;
        return null;
      }
      const hashes: string[] = [];
      for (const ws of alone) hashes.push(...(await purgeWorkspaceIn(tx, ws, null)));
      for (const table of ACCOUNT_ROWS) await tx.query(`DELETE FROM ${table} WHERE user_id = $1`, [id]);
      await tx.query("SAVEPOINT account_row");
      try {
        await tx.query("DELETE FROM users WHERE id = $1", [id]);
      } catch (error) {
        if ((error as { code?: string }).code !== "23503") throw error;
        // Immutable revisions (ADR-0005) and other history in shared workspaces reference it: keep an anonymous row.
        await tx.query("ROLLBACK TO SAVEPOINT account_row");
        await tx.query("UPDATE users SET display_name = 'Deleted account', email = NULL, last_seen_at = NULL WHERE id = $1", [id]);
      }
      await audit(tx, { actorId: null, action: "account.deleted", detail: { userId: id, reason: "inactive", workspacesPurged: alone.length } });
      return hashes;
    });
    if (hashes === null) continue;
    deleted++;
    await releaseBlobs(db, blobs, hashes);
  }
  return { deleted, skipped };
}

/** Everything periodic, safe to run on any instance at any time and to run concurrently. */
export async function runMaintenance(db: Database, options: { revisionRetentionDays: number | undefined; inactiveAccountDays?: number | undefined; blobs: BlobStore }): Promise<MaintenanceResult> {
  // First, so the revisions of a purged workspace are not pruned one by one.
  const workspacesPurged = await purgeExpiredWorkspaces(db, options.blobs);
  const accounts = options.inactiveAccountDays === undefined ? { deleted: 0, skipped: 0 } : await deleteInactiveAccounts(db, options.blobs, options.inactiveAccountDays);
  return {
    workspacesPurged,
    inactiveAccountsDeleted: accounts.deleted,
    inactiveAccountsSkipped: accounts.skipped,
    trashPagesPurged: await purgeExpiredTrash(db),
    revisionsPruned: options.revisionRetentionDays === undefined ? 0 : await pruneRevisions(db, options.revisionRetentionDays),
    idempotencyRecordsDeleted: await purgeIdempotencyRecords(db),
    rateLimitRowsDeleted: await purgeRateLimits(db),
    signInRowsDeleted: await purgeSignIn(db),
    feedbackDeleted: await purgeFeedback(db),
    presenceRowsDeleted: await purgePresence(db),
  };
}

/** Constant-time comparison of `Authorization: Bearer <secret>` against the configured secret (compares fixed-size digests). */
export function bearerMatches(header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== "string") return false;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  if (!match) return false;
  const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(match[1]!), digest(secret));
}
