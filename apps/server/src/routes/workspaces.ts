import type { FastifyInstance } from "fastify";
import { API_BASE_PATH, DELETED_WORKSPACE_RESTORE_DAYS, WorkspaceCreateRequestSchema, WorkspaceRenameSchema } from "@thoth/workspace-protocol";
import { workspaceAccess } from "../access.ts";
import { createWorkspaceIn } from "../admin.ts";
import { releaseBlobs } from "../blob.ts";
import { decodeCursor, encodeCursor } from "../cursor.ts";
import type { Deps } from "../deps.ts";
import { ApiError, jsonReply, zodFailure, type Reply } from "../errors.ts";
import { audit, bodyOf, headerOf, mutate, parseJsonBody, principalOf, send } from "../http.ts";
import { runMutation } from "../idempotency.ts";
import { limitFrom } from "../pages.ts";
import { RESTORABLE_OR_LIVE, quotaExceeded } from "../quota.ts";
import { hit } from "../ratelimit.ts";
import { lockDeleted, markDeleted, purgeWorkspaceIn, workspaceName, workspaceResource } from "../workspaces.ts";

const DAY_SECONDS = 86_400;

/**
 * Capability `workspace-management` (ADR-0025): create, rename and delete workspaces, list the deleted ones, restore
 * them within 30 days, or purge them at once. Every change runs through the idempotency machinery and takes the
 * workspace row lock (creating takes the per-account lock of the owned-workspace quota instead).
 */
export function registerWorkspaceRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config, blobs } = deps;

  app.post(`${API_BASE_PATH}/workspaces`, (request, reply) =>
    mutate(deps, request, reply, async (tx) => {
      const me = principalOf(request);
      const parsed = WorkspaceCreateRequestSchema.safeParse(parseJsonBody(request));
      if (!parsed.success) throw zodFailure(parsed.error);
      const name = workspaceName(parsed.data.name);
      const exportRestricted = parsed.data.exportRestricted ?? false;
      // The owned-workspace quota first (it serializes this account's creations), then the day's creations. Both
      // refusals roll the transaction back, so a refused create spends nothing.
      const { id } = await createWorkspaceIn(tx, { name, exportRestricted, ownerId: me.id }, config, { actorId: me.id });
      const perDay = config.maxWorkspaceCreationsPerDay;
      if (perDay !== undefined) {
        const decision = await hit(tx, `wscreate:${me.id}`, perDay, DAY_SECONDS);
        if (!decision.allowed) {
          const usage = quotaExceeded("workspaceCreationsPerDay", `an account may create at most ${perDay} workspace${perDay === 1 ? "" : "s"} a day; try again tomorrow`, { limit: perDay, current: perDay });
          throw new ApiError(usage.code, usage.message, usage.extra, { "retry-after": String(decision.retryAfterSeconds) });
        }
      }
      return jsonReply(201, await workspaceResource(tx, id, me.id));
    }),
  );

  app.put<{ Params: { workspaceId: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/name`, (request, reply) =>
    mutate(deps, request, reply, async (tx) => {
      const me = principalOf(request);
      const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "administer", { lock: true });
      const parsed = WorkspaceRenameSchema.safeParse(parseJsonBody(request));
      if (!parsed.success) throw zodFailure(parsed.error);
      const name = workspaceName(parsed.data.name);
      if (name !== ws.name) {
        await tx.query("UPDATE workspaces SET name = $2 WHERE id = $1", [ws.id, name]);
        // Names are what members chose to call a workspace; the audit trail records that it changed, not the words.
        await audit(tx, { actorId: me.id, workspaceId: ws.id, action: "workspace.renamed" });
      }
      return jsonReply(200, await workspaceResource(tx, ws.id, me.id));
    }),
  );

  app.delete<{ Params: { workspaceId: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId`, (request, reply) =>
    mutate(deps, request, reply, async (tx) => {
      const me = principalOf(request);
      const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "administer", { lock: true });
      await markDeleted(tx, ws.id, me.id);
      return { status: 204, headers: {} };
    }),
  );

  app.get<{ Querystring: { cursor?: string; limit?: string } }>(`${API_BASE_PATH}/deleted-workspaces`, async (request, reply) => {
    const me = principalOf(request);
    const limit = limitFrom(request.query.limit);
    const after = request.query.cursor === undefined ? null : decodeCursor("d", "deleted-workspaces", request.query.cursor);
    const [afterAt, afterId] = after === null ? [null, null] : splitCursor(after);
    const { rows } = await db.query<{ id: string; name: string; export_restricted: boolean; member_count: number; deleted_at: Date; deleted_by: string | null; deleted_at_us: string }>(
      `SELECT w.id, w.name, w.export_restricted, w.deleted_at, w.deleted_by,
              (extract(epoch FROM w.deleted_at) * 1000000)::bigint::text AS deleted_at_us,
              (SELECT count(*) FROM memberships x WHERE x.workspace_id = w.id) AS member_count
         FROM workspaces w JOIN memberships m ON m.workspace_id = w.id AND m.user_id = $1 AND m.role = 'owner'
        WHERE w.deleted_at IS NOT NULL AND ${RESTORABLE_OR_LIVE}
          AND ($2::bigint IS NULL OR (extract(epoch FROM w.deleted_at) * 1000000)::bigint < $2::bigint
               OR ((extract(epoch FROM w.deleted_at) * 1000000)::bigint = $2::bigint AND w.id < $3))
        ORDER BY w.deleted_at DESC, w.id DESC LIMIT $4`,
      [me.id, afterAt, afterId, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return send(
      reply,
      jsonReply(200, {
        items: page.map((w) => ({
          id: w.id,
          name: w.name,
          exportRestricted: w.export_restricted,
          memberCount: w.member_count,
          deletedAt: w.deleted_at.toISOString(),
          deletedBy: w.deleted_by,
          restorableUntil: new Date(w.deleted_at.getTime() + DELETED_WORKSPACE_RESTORE_DAYS * DAY_SECONDS * 1000).toISOString(),
        })),
        nextCursor: rows.length > limit && last ? encodeCursor("d", "deleted-workspaces", `${last.deleted_at_us}:${last.id}`) : null,
      }),
    );
  });

  app.post<{ Params: { workspaceId: string } }>(`${API_BASE_PATH}/deleted-workspaces/:workspaceId/restore`, (request, reply) =>
    mutate(deps, request, reply, async (tx) => {
      const me = principalOf(request);
      const ws = await lockDeleted(tx, request.params.workspaceId, me.id);
      await tx.query("UPDATE workspaces SET deleted_at = NULL, deleted_by = NULL WHERE id = $1", [ws.id]);
      await audit(tx, { actorId: me.id, workspaceId: ws.id, action: "workspace.restored" });
      return jsonReply(200, await workspaceResource(tx, ws.id, me.id));
    }),
  );

  app.delete<{ Params: { workspaceId: string } }>(`${API_BASE_PATH}/deleted-workspaces/:workspaceId`, async (request, reply) => {
    const me = principalOf(request);
    // Not `mutate`: the bytes nothing else uses are removed after the purge has committed and before the reply.
    let hashes: string[] = [];
    const result: Reply = await runMutation(
      db,
      { method: request.method, target: request.url, idempotencyKey: headerOf(request, "idempotency-key"), ifMatch: headerOf(request, "if-match"), ifNoneMatch: headerOf(request, "if-none-match"), body: bodyOf(request), principalId: me.id, requestId: request.id },
      async (tx) => {
        const ws = await lockDeleted(tx, request.params.workspaceId, me.id);
        hashes = await purgeWorkspaceIn(tx, ws.id, me.id);
        return { status: 204, headers: {} };
      },
    );
    await releaseBlobs(db, blobs, hashes);
    return send(reply, result);
  });
}

/** `<deleted_at in microseconds>:<workspace id>` of the last item of a page. */
function splitCursor(value: string): [string, string] {
  const at = value.indexOf(":");
  const micros = value.slice(0, at);
  if (at < 1 || !/^\d{1,20}$/.test(micros)) throw new ApiError("cursor_invalid", "cursor does not decode");
  return [micros, value.slice(at + 1)];
}
