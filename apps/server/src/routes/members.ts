import type { FastifyInstance } from "fastify";
import { API_BASE_PATH, INVITE_EXPIRY_DEFAULT_DAYS, INVITE_USES_DEFAULT, InviteAcceptRequestSchema, InviteLinkCreateRequestSchema, MemberRoleChangeSchema, OpaqueIdSchema, type Role } from "@thoth/workspace-protocol";
import { requireRole, workspaceAccess, type Need, type WorkspaceAccess } from "../access.ts";
import type { Queryable } from "../db.ts";
import { decodeCursor, encodeCursor } from "../cursor.ts";
import type { Deps } from "../deps.ts";
import { ApiError, jsonReply, zodFailure } from "../errors.ts";
import { audit, mutate, parseJsonBody, principalOf, send } from "../http.ts";
import { opaqueId } from "../ids.ts";
import { INVITE_ACTIVE, acceptInviteIn, generateInviteToken, hashInviteToken, inviteNotFound, resolveInvite } from "../invites.ts";
import { limitFrom } from "../pages.ts";
import { assertCanOwnAnotherWorkspace, quotaExceeded } from "../quota.ts";
import { clientIp, hit } from "../ratelimit.ts";

interface InviteRow {
  id: string;
  workspace_id: string;
  role: "editor" | "viewer";
  max_uses: number;
  uses: number;
  created_at: Date;
  created_by: string;
  created_by_name: string;
  expires_at: Date;
}

const inviteResource = (r: InviteRow) => ({
  id: r.id,
  workspaceId: r.workspace_id,
  role: r.role,
  maxUses: r.max_uses,
  usesLeft: Math.max(0, r.max_uses - r.uses),
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by,
  createdByName: r.created_by_name,
  expiresAt: r.expires_at.toISOString(),
});

const INVITE_COLUMNS = "l.id, l.workspace_id, l.role, l.max_uses, l.uses, l.created_at, l.created_by, u.display_name AS created_by_name, l.expires_at";

/** Owners left in the workspace (the caller holds the workspace row lock). */
const ownerCount = async (q: Queryable, workspaceId: string) =>
  Number((await q.query<{ n: string }>("SELECT count(*) AS n FROM memberships WHERE workspace_id = $1 AND role = 'owner'", [workspaceId])).rows[0]!.n);

/**
 * `workspaceAccess` with the workspace row locked, then the caller's role read again by a fresh statement. The locking
 * statement may have waited for another membership change to commit; the role it joined is from before that wait. A
 * member whose role changed meanwhile is judged by the new role.
 */
async function lockedAccess(tx: Queryable, workspaceId: string, userId: string, need: Need): Promise<WorkspaceAccess> {
  const ws = await workspaceAccess(tx, workspaceId, userId, "read", { lock: true });
  const role = (await tx.query<{ role: Role }>("SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2", [ws.id, userId])).rows[0]?.role;
  if (!role) throw new ApiError("not_found", "workspace not found");
  const fresh = { ...ws, role };
  requireRole(fresh, need);
  return fresh;
}

const lastOwner = () => new ApiError("last_owner", "a workspace keeps at least one owner: make another member an owner first");

/**
 * ADR-0024: members (capability `members`) and invite links (capability `invite-links`) under /api/v1. Authenticated
 * like every other route and gated on the capabilities by the app's capability table. Every membership change takes
 * the workspace row lock first, so the one-owner rule and the member quota hold under concurrency.
 */
export function registerMemberRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config } = deps;

  // ------------------------------------------------------------------ members

  app.get<{ Params: { workspaceId: string }; Querystring: { cursor?: string; limit?: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/members`, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "read");
    const limit = limitFrom(request.query.limit);
    const after = request.query.cursor === undefined ? null : decodeCursor("m", ws.id, request.query.cursor);
    // Names and roles only: the email column is never read here.
    const { rows } = await db.query<{ user_id: string; display_name: string; role: Role }>(
      `SELECT m.user_id, u.display_name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1 AND ($2::text IS NULL OR m.user_id > $2) ORDER BY m.user_id LIMIT $3`,
      [ws.id, after, limit + 1],
    );
    const items = rows.slice(0, limit);
    return send(
      reply,
      jsonReply(200, {
        items: items.map((r) => ({ userId: r.user_id, displayName: r.display_name, role: r.role })),
        nextCursor: rows.length > limit ? encodeCursor("m", ws.id, items.at(-1)!.user_id) : null,
      }),
    );
  });

  app.put<{ Params: { workspaceId: string; userId: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/members/:userId`, (request, reply) =>
    mutate(deps, request, reply, async (tx) => {
      const me = principalOf(request);
      const ws = await lockedAccess(tx, request.params.workspaceId, me.id, "administer");
      const parsed = MemberRoleChangeSchema.safeParse(parseJsonBody(request));
      if (!parsed.success) throw zodFailure(parsed.error);
      const userId = request.params.userId;
      const target = OpaqueIdSchema.safeParse(userId).success
        ? (await tx.query<{ role: Role; display_name: string }>("SELECT m.role, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.user_id = $2 FOR UPDATE OF m", [ws.id, userId])).rows[0]
        : undefined;
      if (!target) throw new ApiError("not_found", "no such member");
      const next = parsed.data.role;
      if (target.role !== next) {
        if (target.role === "owner" && (await ownerCount(tx, ws.id)) <= 1) throw lastOwner();
        if (next === "owner") await assertCanOwnAnotherWorkspace(tx, config, userId);
        await tx.query("UPDATE memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2", [ws.id, userId, next]);
        await audit(tx, { actorId: me.id, workspaceId: ws.id, action: "member.role_changed", detail: { userId, from: target.role, to: next } });
      }
      return jsonReply(200, { userId, displayName: target.display_name, role: next });
    }),
  );

  app.delete<{ Params: { workspaceId: string; userId: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/members/:userId`, (request, reply) =>
    mutate(deps, request, reply, async (tx) => {
      const me = principalOf(request);
      const userId = request.params.userId;
      const leaving = userId === me.id;
      // Anyone may leave; only owners remove someone else.
      const ws = await lockedAccess(tx, request.params.workspaceId, me.id, leaving ? "read" : "administer");
      const target = OpaqueIdSchema.safeParse(userId).success ? (await tx.query<{ role: Role }>("SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE", [ws.id, userId])).rows[0] : undefined;
      if (!target) throw new ApiError("not_found", "no such member");
      if (target.role === "owner" && (await ownerCount(tx, ws.id)) <= 1) throw lastOwner();
      await tx.query("DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2", [ws.id, userId]);
      await audit(tx, { actorId: me.id, workspaceId: ws.id, action: leaving ? "member.left" : "member.removed", detail: { userId, role: target.role } });
      return { status: 204, headers: {} };
    }),
  );

  // ------------------------------------------------------------------ invite links

  app.post<{ Params: { workspaceId: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/invite-links`, async (request, reply) => {
    const me = principalOf(request);
    // Not through the idempotency machinery on purpose: a stored replay would keep the token in the database.
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "administer");
    const parsed = InviteLinkCreateRequestSchema.safeParse(parseJsonBody(request));
    if (!parsed.success) throw zodFailure(parsed.error);
    const days = parsed.data.expiresInDays ?? INVITE_EXPIRY_DEFAULT_DAYS;
    const maxUses = parsed.data.maxUses ?? INVITE_USES_DEFAULT;
    const token = generateInviteToken();
    const row = await db.tx(async (tx) => {
      const locked = await lockedAccess(tx, ws.id, me.id, "administer");
      const limit = config.invite.maxLinksPerWorkspace;
      if (limit !== undefined) {
        const current = Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM invite_links l WHERE l.workspace_id = $1 AND l.revoked_at IS NULL AND l.expires_at > now() AND l.uses < l.max_uses`, [locked.id])).rows[0]!.n);
        if (current >= limit) throw quotaExceeded("inviteLinksPerWorkspace", `this workspace may have ${limit} active invite links (${current} in use); revoke one to make room`, { limit, current });
      }
      const members = config.maxMembersPerWorkspace;
      if (members !== undefined) {
        const current = Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM memberships WHERE workspace_id = $1", [locked.id])).rows[0]!.n);
        const room = members - current;
        if (maxUses > room) {
          throw quotaExceeded(
            "membersPerWorkspace",
            room <= 0 ? `this workspace is full: it is limited to ${members} members (${current} in use)` : `this workspace is limited to ${members} members (${current} in use), so a link can let in at most ${room} more`,
            { limit: members, current },
          );
        }
      }
      const id = opaqueId("inv");
      const { rows } = await tx.query<InviteRow>(
        `WITH l AS (
           INSERT INTO invite_links (id, workspace_id, token_hash, role, max_uses, created_by, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, date_trunc('milliseconds', now()), date_trunc('milliseconds', now()) + make_interval(days => $7::int))
           RETURNING *)
         SELECT ${INVITE_COLUMNS} FROM l JOIN users u ON u.id = l.created_by`,
        [id, locked.id, hashInviteToken(token), parsed.data.role, maxUses, me.id, days],
      );
      await audit(tx, { actorId: me.id, workspaceId: locked.id, action: "invite.created", detail: { inviteId: id, role: parsed.data.role, maxUses, expiresInDays: days } });
      return rows[0]!;
    });
    const origin = config.publicUrl ?? `${request.protocol}://${request.host}`;
    return send(reply, jsonReply(201, { ...inviteResource(row), token, url: `${origin}/i/${token}` }));
  });

  app.get<{ Params: { workspaceId: string }; Querystring: { cursor?: string; limit?: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/invite-links`, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "administer");
    const limit = limitFrom(request.query.limit);
    let after: { at: Date; id: string } | null = null;
    if (request.query.cursor !== undefined) {
      const value = decodeCursor("i", ws.id, request.query.cursor);
      const bar = value.indexOf("|");
      const at = new Date(value.slice(0, bar));
      if (bar < 0 || Number.isNaN(at.getTime())) throw new ApiError("cursor_invalid", "cursor does not decode");
      after = { at, id: value.slice(bar + 1) };
    }
    const { rows } = await db.query<InviteRow>(
      `SELECT ${INVITE_COLUMNS} FROM invite_links l JOIN users u ON u.id = l.created_by
        WHERE l.workspace_id = $1 AND ${INVITE_ACTIVE} AND ($2::timestamptz IS NULL OR (l.created_at, l.id) < ($2::timestamptz, $3::text))
        ORDER BY l.created_at DESC, l.id DESC LIMIT $4`,
      [ws.id, after?.at ?? null, after?.id ?? null, limit + 1],
    );
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return send(reply, jsonReply(200, { items: items.map(inviteResource), nextCursor: rows.length > limit && last ? encodeCursor("i", ws.id, `${last.created_at.toISOString()}|${last.id}`) : null }));
  });

  app.delete<{ Params: { workspaceId: string; inviteId: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/invite-links/:inviteId`, (request, reply) =>
    mutate(deps, request, reply, async (tx) => {
      const me = principalOf(request);
      const ws = await lockedAccess(tx, request.params.workspaceId, me.id, "administer");
      const { rows } = await tx.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM invite_links WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [ws.id, request.params.inviteId]);
      const link = rows[0];
      if (!link) throw new ApiError("not_found", "invite link not found");
      if (link.revoked_at === null) {
        await tx.query("UPDATE invite_links SET revoked_at = now() WHERE workspace_id = $1 AND id = $2", [ws.id, request.params.inviteId]);
        await audit(tx, { actorId: me.id, workspaceId: ws.id, action: "invite.revoked", detail: { inviteId: request.params.inviteId } });
      }
      return { status: 204, headers: {} };
    }),
  );

  app.post(`${API_BASE_PATH}/invites/accept`, async (request, reply) => {
    const me = principalOf(request);
    // Before the token is looked at, so a refusal says nothing about whether it exists.
    const perIp = config.invite.acceptsPerIp;
    if (perIp !== undefined) {
      const decision = await hit(db, `invite-accept-ip:${clientIp(request.headers, request.socket.remoteAddress, config.trustProxy)}`, perIp, config.rateLimit.windowSeconds);
      if (!decision.allowed) throw new ApiError("rate_limited", "too many requests; retry after the time in the Retry-After header", {}, { "retry-after": String(decision.retryAfterSeconds) });
    }
    const parsed = InviteAcceptRequestSchema.safeParse(parseJsonBody(request));
    if (!parsed.success) throw zodFailure(parsed.error);
    const invite = await resolveInvite(db, parsed.data.token);
    if (!invite) throw inviteNotFound();
    const accepted = await db.tx((tx) => acceptInviteIn(tx, invite.id, me.id, config));
    return send(reply, jsonReply(200, accepted));
  });
}
