import type { FastifyInstance } from "fastify";
import { API_BASE_PATH, OpaqueIdSchema, PageVisibilityWriteSchema, TEAMS_MAX, TeamWriteSchema, type PageKind } from "@thoth/workspace-protocol";
import { workspaceAccess } from "../access.ts";
import type { Queryable } from "../db.ts";
import type { Deps } from "../deps.ts";
import { ApiError, jsonReply, zodFailure } from "../errors.ts";
import { audit, mutate, parseJsonBody, principalOf, send } from "../http.ts";
import { opaqueId } from "../ids.ts";
import { loadPage, parsePageId } from "../pages.ts";
import { quotaExceeded } from "../quota.ts";
import { assertVisible, visibilityChanged } from "../visibility.ts";

const TEAM_SQL = `SELECT t.id, t.name, coalesce(array_agg(tm.user_id ORDER BY tm.user_id) FILTER (WHERE tm.user_id IS NOT NULL), '{}') AS member_ids
  FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id`;

const teamResource = (r: { id: string; name: string; member_ids: string[] }) => ({ id: r.id, name: r.name, memberIds: r.member_ids });

async function loadTeam(q: Queryable, workspaceId: string, teamId: string) {
  if (!OpaqueIdSchema.safeParse(teamId).success) return undefined;
  return (await q.query<{ id: string; name: string; member_ids: string[] }>(`${TEAM_SQL} WHERE t.workspace_id = $1 AND t.id = $2 GROUP BY t.id`, [workspaceId, teamId])).rows[0];
}

async function teamOr404(q: Queryable, workspaceId: string, teamId: string) {
  const team = await loadTeam(q, workspaceId, teamId);
  if (!team) throw new ApiError("not_found", "team not found");
  return team;
}

async function visibilityOf(q: Queryable, workspaceId: string, pageId: string) {
  const { rows } = await q.query<{ limited: boolean; team_ids: string[]; above: boolean }>(
    `WITH RECURSIVE up(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM pages WHERE workspace_id = $1 AND id = $2
       UNION
       SELECT p.id, p.parent_id, up.depth + 1 FROM pages p JOIN up ON p.id = up.parent_id WHERE p.workspace_id = $1 AND up.depth < 64
     )
     SELECT EXISTS (SELECT 1 FROM page_visibility WHERE workspace_id = $1 AND page_id = $2) AS limited,
            coalesce((SELECT array_agg(team_id ORDER BY team_id) FROM page_visibility_teams WHERE workspace_id = $1 AND page_id = $2), '{}') AS team_ids,
            EXISTS (SELECT 1 FROM up JOIN page_visibility v ON v.workspace_id = $1 AND v.page_id = up.id WHERE up.depth > 0) AS above`,
    [workspaceId, pageId],
  );
  const row = rows[0]!;
  return { pageId, teamIds: row.limited ? row.team_ids : null, limitedAbove: row.above };
}

/**
 * ADR-0042: teams (every member reads them; owners and managers change them) and who sees a page (owners and managers).
 * Every change takes the workspace row lock first, like every other write. A change to who sees what expires older
 * change cursors (`visibilityChanged`).
 */
export function registerTeamRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  const base = `${API_BASE_PATH}/workspaces/:workspaceId`;

  app.get<{ Params: { workspaceId: string } }>(`${base}/teams`, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "read");
    const { rows } = await db.query<{ id: string; name: string; member_ids: string[] }>(`${TEAM_SQL} WHERE t.workspace_id = $1 GROUP BY t.id ORDER BY t.name, t.id`, [ws.id]);
    return send(reply, jsonReply(200, { items: rows.map(teamResource) }));
  });

  app.post<{ Params: { workspaceId: string } }>(`${base}/teams`, (request, reply) =>
    mutate(deps, request, reply, async (tx) => {
      const me = principalOf(request);
      const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "manage", { lock: true });
      const parsed = TeamWriteSchema.safeParse(parseJsonBody(request));
      if (!parsed.success) throw zodFailure(parsed.error);
      const current = Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM teams WHERE workspace_id = $1", [ws.id])).rows[0]!.n);
      if (current >= TEAMS_MAX) throw quotaExceeded("teamsPerWorkspace", `a workspace may have ${TEAMS_MAX} teams; delete one to make room`, { limit: TEAMS_MAX, current });
      const id = opaqueId("team");
      await tx.query("INSERT INTO teams (id, workspace_id, name) VALUES ($1, $2, $3)", [id, ws.id, parsed.data.name]);
      await audit(tx, { actorId: me.id, workspaceId: ws.id, action: "team.created", detail: { teamId: id } });
      return jsonReply(201, { id, name: parsed.data.name, memberIds: [] });
    }),
  );

  app.put<{ Params: { workspaceId: string; teamId: string } }>(`${base}/teams/:teamId`, (request, reply) =>
    mutate(deps, request, reply, async (tx) => {
      const me = principalOf(request);
      const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "manage", { lock: true });
      const parsed = TeamWriteSchema.safeParse(parseJsonBody(request));
      if (!parsed.success) throw zodFailure(parsed.error);
      const team = await teamOr404(tx, ws.id, request.params.teamId);
      await tx.query("UPDATE teams SET name = $3 WHERE workspace_id = $1 AND id = $2", [ws.id, team.id, parsed.data.name]);
      await audit(tx, { actorId: me.id, workspaceId: ws.id, action: "team.renamed", detail: { teamId: team.id } });
      return jsonReply(200, teamResource({ ...team, name: parsed.data.name }));
    }),
  );

  app.delete<{ Params: { workspaceId: string; teamId: string } }>(`${base}/teams/:teamId`, (request, reply) =>
    mutate(deps, request, reply, async (tx) => {
      const me = principalOf(request);
      const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "manage", { lock: true });
      const team = await teamOr404(tx, ws.id, request.params.teamId);
      // Cascades to team_members and page_visibility_teams; a page left with no team stays limited (owners and managers only).
      await tx.query("DELETE FROM teams WHERE workspace_id = $1 AND id = $2", [ws.id, team.id]);
      await visibilityChanged(tx, ws.id, me.id);
      await audit(tx, { actorId: me.id, workspaceId: ws.id, action: "team.deleted", detail: { teamId: team.id } });
      return { status: 204, headers: {} };
    }),
  );

  // ADR-0043: what deleting a team changes. Owners and managers see every page, so nothing is filtered.
  app.get<{ Params: { workspaceId: string; teamId: string } }>(`${base}/teams/:teamId/pages`, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "manage");
    const team = await teamOr404(db, ws.id, request.params.teamId);
    const { rows } = await db.query<{ id: string; title: string; kind: PageKind | null; only_team: boolean }>(
      `SELECT p.id, p.title, p.kind,
              NOT EXISTS (SELECT 1 FROM page_visibility_teams o WHERE o.workspace_id = $1 AND o.page_id = p.id AND o.team_id <> $2) AS only_team
         FROM page_visibility_teams t JOIN pages p ON p.workspace_id = t.workspace_id AND p.id = t.page_id
        WHERE t.workspace_id = $1 AND t.team_id = $2 AND p.deleted_at IS NULL
        ORDER BY p.title, p.id`,
      [ws.id, team.id],
    );
    return send(reply, jsonReply(200, { items: rows.map((r) => ({ pageId: r.id, title: r.title, kind: r.kind, onlyTeam: r.only_team })) }));
  });

  const membership = (add: boolean) => (request: { params: { workspaceId: string; teamId: string; userId: string } }, tx: Queryable, actorId: string) =>
    (async () => {
      const ws = await workspaceAccess(tx, request.params.workspaceId, actorId, "manage", { lock: true });
      const team = await teamOr404(tx, ws.id, request.params.teamId);
      const userId = request.params.userId;
      const member = OpaqueIdSchema.safeParse(userId).success && ((await tx.query("SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2", [ws.id, userId])).rowCount ?? 0) > 0;
      if (!member) throw new ApiError("not_found", "no such member");
      const changed = add
        ? ((await tx.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [team.id, userId])).rowCount ?? 0) > 0
        : ((await tx.query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", [team.id, userId])).rowCount ?? 0) > 0;
      if (changed) {
        await visibilityChanged(tx, ws.id, actorId);
        await audit(tx, { actorId, workspaceId: ws.id, action: add ? "team.member_added" : "team.member_removed", detail: { teamId: team.id, userId } });
      }
      return jsonReply(200, teamResource((await loadTeam(tx, ws.id, team.id))!));
    })();

  type MemberParams = { Params: { workspaceId: string; teamId: string; userId: string } };
  app.put<MemberParams>(`${base}/teams/:teamId/members/:userId`, (request, reply) => mutate(deps, request, reply, (tx) => membership(true)(request, tx, principalOf(request).id)));
  app.delete<MemberParams>(`${base}/teams/:teamId/members/:userId`, (request, reply) => mutate(deps, request, reply, (tx) => membership(false)(request, tx, principalOf(request).id)));

  app.get<{ Params: { workspaceId: string; pageId: string } }>(`${base}/pages/:pageId/visibility`, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "manage");
    const pageId = parsePageId(request.params.pageId);
    const page = await loadPage(db, ws.id, pageId);
    if (!page || page.deleted_at) throw new ApiError("not_found", "page not found");
    await assertVisible(db, ws.id, me.id, pageId);
    return send(reply, jsonReply(200, await visibilityOf(db, ws.id, pageId)));
  });

  app.put<{ Params: { workspaceId: string; pageId: string } }>(`${base}/pages/:pageId/visibility`, (request, reply) =>
    mutate(deps, request, reply, async (tx) => {
      const me = principalOf(request);
      const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "manage", { lock: true });
      const pageId = parsePageId(request.params.pageId);
      const parsed = PageVisibilityWriteSchema.safeParse(parseJsonBody(request));
      if (!parsed.success) throw zodFailure(parsed.error);
      const page = await loadPage(tx, ws.id, pageId);
      if (!page || page.deleted_at) throw new ApiError("not_found", "page not found");
      await assertVisible(tx, ws.id, me.id, pageId);
      const teamIds = parsed.data.teamIds === null ? null : [...new Set(parsed.data.teamIds)];
      if (teamIds) {
        const known = Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM teams WHERE workspace_id = $1 AND id = ANY($2::text[])", [ws.id, teamIds])).rows[0]!.n);
        if (known !== teamIds.length) throw new ApiError("validation_failed", "teamIds must name teams of this workspace", { errors: [{ pointer: "/teamIds", detail: "unknown team" }] });
      }
      await tx.query("DELETE FROM page_visibility WHERE workspace_id = $1 AND page_id = $2", [ws.id, pageId]);
      if (teamIds) {
        await tx.query("INSERT INTO page_visibility (workspace_id, page_id) VALUES ($1, $2)", [ws.id, pageId]);
        await tx.query("INSERT INTO page_visibility_teams (workspace_id, page_id, team_id) SELECT $1, $2, unnest($3::text[])", [ws.id, pageId, teamIds]);
      }
      await visibilityChanged(tx, ws.id, me.id);
      await audit(tx, { actorId: me.id, workspaceId: ws.id, action: "page.visibility_set", detail: { pageId, teamIds } });
      return jsonReply(200, await visibilityOf(tx, ws.id, pageId));
    }),
  );
}
