import { PRESENCE_TTL_SECONDS, type PresenceEntry } from "@thoth/workspace-protocol";
import type { Queryable } from "./db.ts";

/**
 * Presence (ADR-0041): one row per member per open page, refreshed by each heartbeat. Rows older than the TTL no longer
 * count; the next heartbeat on the page and `maintenance` delete them. Only names and IDs are read back, never emails.
 */
export async function heartbeat(db: Queryable, workspaceId: string, pageId: string, userId: string): Promise<PresenceEntry[]> {
  await db.query(
    `INSERT INTO page_presence (workspace_id, page_id, user_id) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, page_id, user_id) DO UPDATE SET seen_at = now()`,
    [workspaceId, pageId, userId],
  );
  await db.query("DELETE FROM page_presence WHERE workspace_id = $1 AND page_id = $2 AND seen_at < now() - make_interval(secs => $3)", [workspaceId, pageId, PRESENCE_TTL_SECONDS]);
  // Only current members: someone removed from the workspace stops showing at once, before their row expires.
  const { rows } = await db.query<{ user_id: string; display_name: string }>(
    `SELECT p.user_id, u.display_name FROM page_presence p
       JOIN users u ON u.id = p.user_id
       JOIN memberships m ON m.workspace_id = p.workspace_id AND m.user_id = p.user_id
      WHERE p.workspace_id = $1 AND p.page_id = $2 AND p.user_id <> $3 AND p.seen_at >= now() - make_interval(secs => $4)
      ORDER BY u.display_name, p.user_id LIMIT 50`,
    [workspaceId, pageId, userId, PRESENCE_TTL_SECONDS],
  );
  return rows.map((r) => ({ userId: r.user_id, displayName: r.display_name }));
}

export async function leave(db: Queryable, workspaceId: string, pageId: string, userId: string): Promise<void> {
  await db.query("DELETE FROM page_presence WHERE workspace_id = $1 AND page_id = $2 AND user_id = $3", [workspaceId, pageId, userId]);
}

export async function purgePresence(db: Queryable): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM page_presence WHERE seen_at < now() - make_interval(secs => $1)", [PRESENCE_TTL_SECONDS]);
  return rowCount ?? 0;
}
