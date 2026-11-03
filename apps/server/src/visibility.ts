import { ApiError } from "./errors.ts";
import { appendChange } from "./changes.ts";
import type { Queryable } from "./db.ts";

/**
 * ADR-0042: pages limited to some teams. `thoth_hidden_pages(ws, user)` (migration 015) is every page of the workspace
 * the account may not see: limited pages whose teams do not include it, and everything below them. Every route that
 * returns or touches a page filters with it; a hidden page is a 404, exactly like a page that does not exist.
 *
 * `HIDDEN(ws, user)` is the SQL subquery, for `id NOT IN (...)`; the arguments are placeholders such as `$1`.
 */
export const HIDDEN = (ws: string, user: string): string => `(SELECT id FROM thoth_hidden_pages(${ws}, ${user}))`;

export async function isHidden(q: Queryable, workspaceId: string, userId: string, pageId: string): Promise<boolean> {
  const { rowCount } = await q.query(`SELECT 1 FROM thoth_hidden_pages($1, $2) WHERE id = $3`, [workspaceId, userId, pageId]);
  return (rowCount ?? 0) > 0;
}

/** 404 for a page the account may not see, word for word the 404 of a page that does not exist. */
export async function assertVisible(q: Queryable, workspaceId: string, userId: string, pageId: string): Promise<void> {
  if (await isHidden(q, workspaceId, userId, pageId)) throw new ApiError("not_found", "page not found");
}

/** A new parent the writer cannot see is refused: nobody puts pages into a folder they cannot see. */
export async function assertVisibleParent(q: Queryable, workspaceId: string, userId: string, parentId: string | null | undefined): Promise<void> {
  if (parentId && (await isHidden(q, workspaceId, userId, parentId))) throw new ApiError("not_found", "parent page not found");
}

/**
 * Who sees what changed (a limit, a team, a role, or a page moved where a limit applies): records an entry clients
 * ignore (`x-thoth.visibility`) and makes every change cursor before it expire, so clients read the tree again. The
 * caller holds the workspace row lock.
 */
export async function visibilityChanged(tx: Queryable, workspaceId: string, actorId: string | null, now = new Date()): Promise<void> {
  const seq = await appendChange(tx, workspaceId, { kind: "x-thoth.visibility", actorId }, now);
  await tx.query("UPDATE workspaces SET visibility_seq = $2 WHERE id = $1", [workspaceId, seq]);
}

/** A move changes who sees the page only where limits exist; most workspaces have none, and skip the reload. */
export async function hasLimits(q: Queryable, workspaceId: string): Promise<boolean> {
  return ((await q.query("SELECT 1 FROM page_visibility WHERE workspace_id = $1 LIMIT 1", [workspaceId])).rowCount ?? 0) > 0;
}
