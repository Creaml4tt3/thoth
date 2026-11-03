import type { FastifyInstance } from "fastify";
import { API_BASE_PATH, TRASH_RESTORE_DAYS, roleCan, type PageKind } from "@thoth/workspace-protocol";
import { workspaceAccess, type WorkspaceAccess } from "../access.ts";
import { decodeCursor, encodeCursor } from "../cursor.ts";
import type { Queryable } from "../db.ts";
import type { Deps } from "../deps.ts";
import { ApiError, jsonReply } from "../errors.ts";
import { mutate, principalOf, send } from "../http.ts";
import { limitFrom, parsePageId } from "../pages.ts";
import { assertCanCreatePages } from "../quota.ts";
import { IN_TRASH, TRASH_ROOT, purgeTrashed, restorableCount, restoreTrashed } from "../trash.ts";
import { HIDDEN } from "../visibility.ts";

const DAY_MS = 86_400_000;

/** Owners and managers see the whole Trash; an editor only what they deleted (`null`: everything). */
const deletedByFilter = (ws: WorkspaceAccess, userId: string): string | null => (roleCan(ws.role, "manage") ? null : userId);

/** 404 unless `pageId` is an item of the Trash that this caller sees. */
async function itemOr404(q: Queryable, ws: WorkspaceAccess, userId: string, pageId: string): Promise<void> {
  const { rowCount } = await q.query(
    `SELECT 1 FROM pages p WHERE p.workspace_id = $1 AND p.id = $2 AND ${TRASH_ROOT} AND ${IN_TRASH}
        AND ($4::text IS NULL OR p.updated_by = $4) AND p.id NOT IN ${HIDDEN("$1", "$3")}`,
    [ws.id, pageId, userId, deletedByFilter(ws, userId)],
  );
  if ((rowCount ?? 0) === 0) throw new ApiError("not_found", "page not found in the Trash");
}

/**
 * Capability `trash` (ADR-0043): list the Trash (editors and up), restore an item (owners and managers any, editors
 * their own), delete one for good (owners and managers). Changes take the workspace row lock like every write.
 */
export function registerTrashRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config } = deps;
  const base = `${API_BASE_PATH}/workspaces/:workspaceId/trash`;

  app.get<{ Params: { workspaceId: string }; Querystring: { cursor?: string; limit?: string } }>(base, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "write");
    const limit = limitFrom(request.query.limit);
    let after: [string, string] | null = null;
    if (request.query.cursor !== undefined) {
      const value = decodeCursor("x", ws.id, request.query.cursor);
      const at = value.indexOf(":");
      if (at < 1 || !/^\d{1,20}$/.test(value.slice(0, at))) throw new ApiError("cursor_invalid", "cursor does not decode");
      after = [value.slice(0, at), value.slice(at + 1)];
    }
    const { rows } = await db.query<{ id: string; parent_id: string | null; title: string; kind: PageKind | null; deleted_at: Date; deleted_at_us: string; updated_by: string | null; display_name: string | null; below: number }>(
      `SELECT p.id, p.parent_id, p.title, p.kind, p.deleted_at, p.updated_by, u.display_name,
              (extract(epoch FROM p.deleted_at) * 1000000)::bigint::text AS deleted_at_us,
              (WITH RECURSIVE t(id) AS (
                 SELECT c.id FROM pages c WHERE c.workspace_id = p.workspace_id AND c.parent_id = p.id AND c.deleted_at IS NOT NULL
                 UNION
                 SELECT c.id FROM pages c JOIN t ON c.parent_id = t.id WHERE c.workspace_id = p.workspace_id AND c.deleted_at IS NOT NULL
               ) SELECT count(*)::int FROM t WHERE t.id NOT IN ${HIDDEN("$1", "$2")}) AS below
         FROM pages p LEFT JOIN users u ON u.id = p.updated_by
        WHERE p.workspace_id = $1 AND ${TRASH_ROOT} AND ${IN_TRASH}
          AND ($3::text IS NULL OR p.updated_by = $3) AND p.id NOT IN ${HIDDEN("$1", "$2")}
          AND ($4::bigint IS NULL OR (extract(epoch FROM p.deleted_at) * 1000000)::bigint < $4::bigint
               OR ((extract(epoch FROM p.deleted_at) * 1000000)::bigint = $4::bigint AND p.id::text < $5))
        ORDER BY p.deleted_at DESC, p.id DESC LIMIT $6`,
      [ws.id, me.id, deletedByFilter(ws, me.id), after?.[0] ?? null, after?.[1] ?? null, limit + 1],
    );
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return send(
      reply,
      jsonReply(200, {
        items: items.map((p) => ({
          pageId: p.id,
          title: p.title,
          kind: p.kind,
          parentId: p.parent_id,
          pagesBelow: p.below,
          deletedAt: p.deleted_at.toISOString(),
          deletedBy: p.updated_by,
          deletedByName: p.display_name,
          restorableUntil: new Date(p.deleted_at.getTime() + TRASH_RESTORE_DAYS * DAY_MS).toISOString(),
        })),
        nextCursor: rows.length > limit && last ? encodeCursor("x", ws.id, `${last.deleted_at_us}:${last.id}`) : null,
      }),
    );
  });

  app.post<{ Params: { workspaceId: string; pageId: string } }>(`${base}/:pageId/restore`, (request, reply) =>
    mutate(deps, request, reply, async (tx, _info, now) => {
      const me = principalOf(request);
      const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "write", { lock: true });
      const pageId = parsePageId(request.params.pageId);
      await itemOr404(tx, ws, me.id, pageId);
      const only = deletedByFilter(ws, me.id);
      await assertCanCreatePages(tx, config, ws.id, await restorableCount(tx, ws.id, pageId, me.id, only));
      const pageIds = await restoreTrashed(tx, ws.id, pageId, me.id, only, now);
      return jsonReply(200, { pageIds });
    }),
  );

  app.delete<{ Params: { workspaceId: string; pageId: string } }>(`${base}/:pageId`, (request, reply) =>
    mutate(deps, request, reply, async (tx, _info, now) => {
      const me = principalOf(request);
      const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "manage", { lock: true });
      const pageId = parsePageId(request.params.pageId);
      await itemOr404(tx, ws, me.id, pageId);
      await purgeTrashed(tx, ws.id, pageId, me.id, now);
      return { status: 204, headers: {} };
    }),
  );
}
