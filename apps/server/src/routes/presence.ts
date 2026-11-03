import type { FastifyInstance } from "fastify";
import { API_BASE_PATH } from "@thoth/workspace-protocol";
import { workspaceAccess } from "../access.ts";
import type { Deps } from "../deps.ts";
import { ApiError, jsonReply } from "../errors.ts";
import { principalOf, send } from "../http.ts";
import { loadPage, parsePageId } from "../pages.ts";
import { heartbeat, leave } from "../presence.ts";
import { assertVisible } from "../visibility.ts";

interface PageParams {
  workspaceId: string;
  pageId: string;
}

/**
 * ADR-0041: who else has a page open (capability `presence`, gated by the app's capability table). Any member who can
 * read the workspace may send a heartbeat and read the list; a non-member gets 404 like every other workspace route.
 */
export function registerPresenceRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  const path = `${API_BASE_PATH}/workspaces/:workspaceId/pages/:pageId/presence`;

  app.put<{ Params: PageParams }>(path, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "read");
    const pageId = parsePageId(request.params.pageId);
    const page = await loadPage(db, ws.id, pageId);
    if (!page || page.deleted_at) throw new ApiError("not_found", "page not found");
    // ADR-0042: a page hidden from the caller is a 404, and nobody on it is shown.
    await assertVisible(db, ws.id, me.id, pageId);
    return send(reply, jsonReply(200, { items: await heartbeat(db, ws.id, pageId, me.id) }));
  });

  app.delete<{ Params: PageParams }>(path, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "read");
    await leave(db, ws.id, parsePageId(request.params.pageId), me.id);
    return reply.code(204).send();
  });
}
