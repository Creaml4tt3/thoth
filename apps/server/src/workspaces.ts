import { DELETED_WORKSPACE_RESTORE_DAYS, WORKSPACE_NAME_MAX, type Role } from "@thoth/workspace-protocol";
import { releaseBlobs, type BlobStore } from "./blob.ts";
import type { Database, Queryable } from "./db.ts";
import { ApiError, fieldError } from "./errors.ts";
import { audit } from "./http.ts";
import { checkStorableText } from "./pages.ts";
import { RESTORABLE_OR_LIVE } from "./quota.ts";

/**
 * Several workspaces per account (ADR-0025): what the API routes and the maintenance job share. A deleted workspace is
 * its `workspaces` row with `deleted_at` set; `workspaceAccess` and every lookup by token leave such rows out, so it is
 * 404 everywhere. Purging removes the row and everything that names it.
 */

/** A workspace name: trimmed, 1 to 200 characters (code points, as the database counts), no control characters. */
export function workspaceName(raw: string, pointer = "/name"): string {
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > WORKSPACE_NAME_MAX) throw new ApiError("validation_failed", `the name must be 1 to ${WORKSPACE_NAME_MAX} characters`, fieldError(pointer, "1 to 200 characters"));
  checkStorableText(name, pointer);
  if (/\p{Cc}/u.test(name)) throw new ApiError("validation_failed", "the name cannot contain control characters", fieldError(pointer, "control character"));
  return name;
}

interface WorkspaceRow {
  id: string;
  name: string;
  export_restricted: boolean;
  created_at: Date;
  role: Role;
  member_count: number;
  members: { userId: string; displayName: string; role: Role }[];
}

/** The same columns and member preview as `listWorkspaces`, for one workspace the caller is in. */
const WORKSPACE_SQL = `SELECT w.id, w.name, w.export_restricted, w.created_at, m.role,
        (SELECT count(*) FROM memberships x WHERE x.workspace_id = w.id) AS member_count,
        (SELECT coalesce(json_agg(json_build_object('userId', u.id, 'displayName', u.display_name, 'role', mm.role) ORDER BY mm.user_id), '[]'::json)
           FROM (SELECT user_id, role FROM memberships WHERE workspace_id = w.id ORDER BY user_id LIMIT 50) mm JOIN users u ON u.id = mm.user_id) AS members
   FROM workspaces w JOIN memberships m ON m.workspace_id = w.id AND m.user_id = $2
  WHERE w.id = $1`;

/** A workspace as the caller sees it in `listWorkspaces` (protocol `Workspace`). */
export async function workspaceResource(q: Queryable, workspaceId: string, userId: string) {
  const row = (await q.query<WorkspaceRow>(WORKSPACE_SQL, [workspaceId, userId])).rows[0];
  if (!row) throw new ApiError("not_found", "workspace not found");
  return { id: row.id, kind: "workspace" as const, name: row.name, role: row.role, exportRestricted: row.export_restricted, memberCount: row.member_count, members: row.members, createdAt: row.created_at.toISOString() };
}

/**
 * A deleted workspace that can still be restored, locked for the rest of the transaction, and the caller's role in it.
 * 404 when there is none (live, past its days, unknown, or the caller is not a member); 403 for a member who is not an
 * owner. Restore and purge both start here.
 */
export async function lockDeleted(tx: Queryable, workspaceId: string, userId: string): Promise<{ id: string }> {
  const { rows } = await tx.query<{ id: string; role: Role }>(
    `SELECT w.id, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id AND m.user_id = $2
      WHERE w.id = $1 AND w.deleted_at IS NOT NULL AND ${RESTORABLE_OR_LIVE}
      FOR UPDATE OF w`,
    [workspaceId, userId],
  );
  const row = rows[0];
  if (!row) throw new ApiError("not_found", "no such deleted workspace");
  if (row.role !== "owner") throw new ApiError("forbidden", "only owners of this workspace may do this");
  return { id: row.id };
}

/**
 * Marks a workspace deleted (the caller holds its row lock and is an owner). Its active share and invite links are
 * revoked in the same transaction, so they stop at once and stay stopped after a restore.
 */
export async function markDeleted(tx: Queryable, workspaceId: string, actorId: string): Promise<void> {
  await tx.query("UPDATE workspaces SET deleted_at = now(), deleted_by = $2 WHERE id = $1", [workspaceId, actorId]);
  await tx.query("UPDATE share_links SET revoked_at = now() WHERE workspace_id = $1 AND revoked_at IS NULL", [workspaceId]);
  await tx.query("UPDATE invite_links SET revoked_at = now() WHERE workspace_id = $1 AND revoked_at IS NULL", [workspaceId]);
  await audit(tx, { actorId, workspaceId, action: "workspace.deleted" });
}

/**
 * Removes a workspace and everything that names it, inside the caller's transaction (which holds the row lock). The
 * audit trail is kept (it names the workspace by ID only). Returns the attachment hashes it held, for `releaseBlobs`
 * once the transaction has committed.
 */
export async function purgeWorkspaceIn(tx: Queryable, workspaceId: string, actorId: string | null): Promise<string[]> {
  const hashes = (await tx.query<{ hash: string }>("DELETE FROM attachments WHERE workspace_id = $1 RETURNING hash", [workspaceId])).rows.map((r) => r.hash);
  await tx.query("DELETE FROM share_links WHERE workspace_id = $1", [workspaceId]);
  // Cascades to invite_tickets and to auth_requests started from these links.
  await tx.query("DELETE FROM invite_links WHERE workspace_id = $1", [workspaceId]);
  // Cascades to transfer_items (staged pages and pinned revisions).
  await tx.query("DELETE FROM transfers WHERE workspace_id = $1", [workspaceId]);
  await tx.query("DELETE FROM changes WHERE workspace_id = $1", [workspaceId]);
  // The one other way past the immutability trigger besides revision pruning (migration 006), for this transaction only.
  await tx.query("SELECT set_config('thoth.pruning', 'on', true)");
  await tx.query("DELETE FROM page_revisions WHERE workspace_id = $1", [workspaceId]);
  await tx.query("SELECT set_config('thoth.pruning', 'off', true)");
  await tx.query("DELETE FROM pages WHERE workspace_id = $1", [workspaceId]);
  await tx.query("DELETE FROM memberships WHERE workspace_id = $1", [workspaceId]);
  await tx.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  await audit(tx, { actorId, workspaceId, action: "workspace.purged" });
  return hashes;
}

/**
 * The daily maintenance: purges every workspace deleted more than `DELETED_WORKSPACE_RESTORE_DAYS` days ago, one
 * transaction each (re-checked under its row lock, so a restore that won the race keeps it), then removes the bytes
 * nothing else uses. Safe to run concurrently. Returns how many were purged.
 */
export async function purgeExpiredWorkspaces(db: Database, blobs: BlobStore): Promise<number> {
  const expired = `deleted_at IS NOT NULL AND deleted_at <= now() - make_interval(days => ${DELETED_WORKSPACE_RESTORE_DAYS})`;
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM workspaces WHERE ${expired} ORDER BY deleted_at LIMIT 100`);
  let purged = 0;
  for (const { id } of rows) {
    const hashes = await db.tx(async (tx) => {
      const locked = await tx.query(`SELECT 1 FROM workspaces WHERE id = $1 AND ${expired} FOR UPDATE SKIP LOCKED`, [id]);
      if (locked.rowCount === 0) return null;
      return purgeWorkspaceIn(tx, id, null);
    });
    if (hashes === null) continue;
    purged++;
    await releaseBlobs(db, blobs, hashes);
  }
  return purged;
}
