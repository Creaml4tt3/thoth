import { TRASH_RESTORE_DAYS } from "@thoth/workspace-protocol";
import { audit } from "./http.ts";
import { appendChange } from "./changes.ts";
import type { Database, Queryable } from "./db.ts";
import { HIDDEN, visibilityChanged } from "./visibility.ts";
import type { PageKind } from "@thoth/workspace-protocol";

/**
 * The Trash (ADR-0043). A deleted page whose folder is not deleted (or is gone) is one item of the Trash; the pages
 * deleted below it, through deleted pages only, belong to that item. `pages.updated_by` names who deleted a page.
 */

/** SQL: a deleted page `p` that is an item of the Trash (its folder is live, absent, or gone for good). */
export const TRASH_ROOT = `p.deleted_at IS NOT NULL
  AND (p.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM pages f WHERE f.workspace_id = p.workspace_id AND f.id = p.parent_id AND f.deleted_at IS NOT NULL))`;

/** Not yet past its 30 days (the purge runs daily, so an expired item may linger until then; it is not shown). */
export const IN_TRASH = `p.deleted_at > now() - make_interval(days => ${TRASH_RESTORE_DAYS})`;

interface TrashedRow {
  id: string;
  parent_id: string | null;
  title: string;
  position: string | null;
  kind: PageKind | null;
  current_revision_id: string;
  depth: number;
}

/**
 * The item `rootId` and the pages deleted below it, top-down. With `onlyDeletedBy`, a page deleted by someone else
 * (and what is below it) is left out, as is any page `viewer` may not see.
 */
async function trashedTree(q: Queryable, workspaceId: string, rootId: string, viewer: string, onlyDeletedBy: string | null): Promise<TrashedRow[]> {
  const { rows } = await q.query<TrashedRow>(
    `WITH RECURSIVE t(id, depth) AS (
       SELECT id, 0 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NOT NULL AND ($4::text IS NULL OR updated_by = $4)
       UNION
       SELECT p.id, t.depth + 1 FROM pages p JOIN t ON p.parent_id = t.id
        WHERE p.workspace_id = $1 AND p.deleted_at IS NOT NULL AND ($4::text IS NULL OR p.updated_by = $4) AND t.depth < 10000
     )
     SELECT p.id, p.parent_id, p.title, p.position, p.kind, p.current_revision_id, min(t.depth) AS depth
       FROM t JOIN pages p ON p.workspace_id = $1 AND p.id = t.id
      WHERE p.id NOT IN ${HIDDEN("$1", "$3")}
      GROUP BY p.workspace_id, p.id ORDER BY depth, p.id`,
    [workspaceId, rootId, viewer, onlyDeletedBy],
  );
  return rows;
}

/**
 * Brings back the item `rootId` and the pages deleted below it that `actorId` may restore (all, or with
 * `onlyDeletedBy` those that account deleted), as `page.created` each, parents first. The caller holds the workspace
 * row lock, has checked that `rootId` is an item `actorId` may restore, and has counted the quota with
 * `restorableCount`. Returns the restored page IDs.
 */
export async function restoreTrashed(tx: Queryable, workspaceId: string, rootId: string, actorId: string, onlyDeletedBy: string | null, now: Date): Promise<string[]> {
  const rows = await trashedTree(tx, workspaceId, rootId, actorId, onlyDeletedBy);
  for (const row of rows) {
    // The root's folder may have been deleted for good since: then it comes back at the top level.
    const parentId = row.id === rootId && row.parent_id !== null && ((await tx.query("SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2", [workspaceId, row.parent_id])).rowCount ?? 0) === 0 ? null : row.parent_id;
    await tx.query("UPDATE pages SET deleted_at = NULL, parent_id = $3, updated_at = $4, updated_by = $5 WHERE workspace_id = $1 AND id = $2", [workspaceId, row.id, parentId, now, actorId]);
    await appendChange(tx, workspaceId, { kind: "page.created", actorId, pageId: row.id, revisionId: row.current_revision_id, parentId, title: row.title, position: row.position, pageKind: row.kind }, now);
  }
  await audit(tx, { actorId, workspaceId, action: "page.restored", detail: { pageId: rootId, pages: rows.length } });
  return rows.map((r) => r.id);
}

export async function restorableCount(q: Queryable, workspaceId: string, rootId: string, actorId: string, onlyDeletedBy: string | null): Promise<number> {
  return (await trashedTree(q, workspaceId, rootId, actorId, onlyDeletedBy)).length;
}

/**
 * Removes the item `rootId` and every page deleted below it for good: their revisions, change-feed entries (titles
 * included) and share links. A live page below them (added after the folder was deleted) moves to where the item was
 * and takes the limits of the removed folders above it, so it is never seen by more people. The caller holds the
 * workspace row lock (or is the maintenance, which takes it).
 */
export async function purgeTrashed(tx: Queryable, workspaceId: string, rootId: string, actorId: string | null, now: Date): Promise<number> {
  const { rows: gone } = await tx.query<{ id: string }>(
    `WITH RECURSIVE t(id) AS (
       SELECT id FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NOT NULL
       UNION
       SELECT p.id FROM pages p JOIN t ON p.parent_id = t.id WHERE p.workspace_id = $1 AND p.deleted_at IS NOT NULL
     ) SELECT id FROM t`,
    [workspaceId, rootId],
  );
  if (gone.length === 0) return 0;
  const ids = gone.map((r) => r.id);
  const root = (await tx.query<{ parent_id: string | null }>("SELECT parent_id FROM pages WHERE workspace_id = $1 AND id = $2", [workspaceId, rootId])).rows[0]!;

  const { rows: strays } = await tx.query<{ id: string; parent_id: string; title: string; position: string | null; kind: PageKind | null; current_revision_id: string }>(
    "SELECT id, parent_id, title, position, kind, current_revision_id FROM pages WHERE workspace_id = $1 AND deleted_at IS NULL AND parent_id = ANY($2::uuid[])",
    [workspaceId, ids],
  );
  let limitsMoved = false;
  for (const stray of strays) {
    // The teams of every removed, limited folder between the item and this page: it keeps only those in all of them.
    const { rows: limits } = await tx.query<{ team_ids: string[] }>(
      `WITH RECURSIVE up(id, parent_id) AS (
         SELECT id, parent_id FROM pages WHERE workspace_id = $1 AND id = $2
         UNION
         SELECT p.id, p.parent_id FROM pages p JOIN up ON p.id = up.parent_id WHERE p.workspace_id = $1 AND p.id = ANY($3::uuid[])
       )
       SELECT coalesce(array_agg(t.team_id) FILTER (WHERE t.team_id IS NOT NULL), '{}') AS team_ids
         FROM up JOIN page_visibility v ON v.workspace_id = $1 AND v.page_id = up.id
         LEFT JOIN page_visibility_teams t ON t.workspace_id = $1 AND t.page_id = v.page_id
        WHERE up.id = ANY($3::uuid[]) OR up.id = $2
        GROUP BY up.id`,
      [workspaceId, stray.id, ids],
    );
    if (limits.length > 0) {
      const teams = limits.map((l) => new Set(l.team_ids)).reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
      await tx.query("DELETE FROM page_visibility WHERE workspace_id = $1 AND page_id = $2", [workspaceId, stray.id]);
      await tx.query("INSERT INTO page_visibility (workspace_id, page_id) VALUES ($1, $2)", [workspaceId, stray.id]);
      if (teams.size > 0) await tx.query("INSERT INTO page_visibility_teams (workspace_id, page_id, team_id) SELECT $1, $2, unnest($3::text[])", [workspaceId, stray.id, [...teams]]);
      limitsMoved = true;
    }
    await tx.query("UPDATE pages SET parent_id = $3, updated_at = $4, updated_by = $5 WHERE workspace_id = $1 AND id = $2", [workspaceId, stray.id, root.parent_id, now, actorId]);
    await appendChange(tx, workspaceId, { kind: "page.updated", actorId, pageId: stray.id, revisionId: stray.current_revision_id, parentId: root.parent_id, title: stray.title, position: stray.position, pageKind: stray.kind }, now);
  }

  await tx.query("DELETE FROM share_links WHERE workspace_id = $1 AND page_id = ANY($2::uuid[])", [workspaceId, ids]);
  await tx.query("DELETE FROM changes WHERE workspace_id = $1 AND page_id = ANY($2::uuid[])", [workspaceId, ids]);
  // The pages first point at no revision that is going (the pointer is checked at commit), then the revisions go,
  // past the immutability trigger for this transaction only (as revision pruning and the workspace purge do).
  await tx.query("SELECT set_config('thoth.pruning', 'on', true)");
  await tx.query("DELETE FROM page_revisions WHERE workspace_id = $1 AND page_id = ANY($2::uuid[])", [workspaceId, ids]);
  await tx.query("SELECT set_config('thoth.pruning', 'off', true)");
  // Cascades to page_visibility and page_visibility_teams.
  await tx.query("DELETE FROM pages WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [workspaceId, ids]);
  if (limitsMoved) await visibilityChanged(tx, workspaceId, actorId, now);
  await audit(tx, { actorId, workspaceId, action: "page.purged", detail: { pageId: rootId, pages: ids.length } });
  return ids.length;
}

/** The daily maintenance: removes every item of the Trash past its 30 days, one workspace per transaction. Returns how many pages went. */
export async function purgeExpiredTrash(db: Database): Promise<number> {
  const expired = `p.deleted_at <= now() - make_interval(days => ${TRASH_RESTORE_DAYS})`;
  const { rows } = await db.query<{ workspace_id: string }>(`SELECT DISTINCT p.workspace_id FROM pages p WHERE ${TRASH_ROOT} AND ${expired} LIMIT 100`);
  let purged = 0;
  for (const { workspace_id: workspaceId } of rows) {
    purged += await db.tx(async (tx) => {
      // The workspace row lock every write takes, so a restore that won the race keeps its pages.
      const locked = await tx.query("SELECT 1 FROM workspaces WHERE id = $1 FOR NO KEY UPDATE", [workspaceId]);
      if (locked.rowCount === 0) return 0;
      const { rows: roots } = await tx.query<{ id: string }>(`SELECT p.id FROM pages p WHERE p.workspace_id = $1 AND ${TRASH_ROOT} AND ${expired} LIMIT 1000`, [workspaceId]);
      let n = 0;
      const now = new Date();
      for (const { id } of roots) n += await purgeTrashed(tx, workspaceId, id, null, now);
      return n;
    });
  }
  return purged;
}
