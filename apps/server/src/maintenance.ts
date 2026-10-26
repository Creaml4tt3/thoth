import { timingSafeEqual, createHash } from "node:crypto";
import type { Database } from "./db.ts";
import { purgeIdempotencyRecords } from "./idempotency.ts";
import { purgeRateLimits } from "./ratelimit.ts";
import { purgeSignIn } from "./signin/sessions.ts";
import type { BlobStore } from "./blob.ts";
import { purgeExpiredWorkspaces } from "./workspaces.ts";

export interface MaintenanceResult {
  revisionsPruned: number;
  idempotencyRecordsDeleted: number;
  rateLimitRowsDeleted: number;
  /** Expired auth requests, codes, refresh and session access tokens, finished sessions, old sign-up counters, expired invite join tickets. */
  signInRowsDeleted: number;
  /** Workspaces deleted more than 30 days ago, purged with their pages, revisions and attachments (ADR-0025). */
  workspacesPurged: number;
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

/** Everything periodic, safe to run on any instance at any time and to run concurrently. */
export async function runMaintenance(db: Database, options: { revisionRetentionDays: number | undefined; blobs: BlobStore }): Promise<MaintenanceResult> {
  return {
    // First, so the revisions of a purged workspace are not pruned one by one.
    workspacesPurged: await purgeExpiredWorkspaces(db, options.blobs),
    revisionsPruned: options.revisionRetentionDays === undefined ? 0 : await pruneRevisions(db, options.revisionRetentionDays),
    idempotencyRecordsDeleted: await purgeIdempotencyRecords(db),
    rateLimitRowsDeleted: await purgeRateLimits(db),
    signInRowsDeleted: await purgeSignIn(db),
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
