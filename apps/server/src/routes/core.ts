import type { FastifyInstance } from "fastify";
import {
  API_BASE_PATH,
  PAGE_SIZE_MAX,
  PROTOCOL_VERSION,
  PageWriteSchema,
  RevisionIdSchema,
  formatEtag,
  parseEtag,
  type Role,
} from "@thoth/workspace-protocol";
import { workspaceAccess } from "../access.ts";
import { changeCursorOf, changeEntryOf, type ChangeRow } from "../changes.ts";
import { decodeCursor, decodeIntCursor, encodeCursor } from "../cursor.ts";
import type { Deps } from "../deps.ts";
import { IDEMPOTENCY_WINDOW_SECONDS } from "../idempotency.ts";
import { assertCanCreatePages } from "../quota.ts";
import { ApiError, fieldError, jsonReply, zodFailure } from "../errors.ts";
import { mutate, parseJsonBody, principalOf, send } from "../http.ts";
import {
  REVISION_COLUMNS,
  checkParent,
  checkStorableText,
  deletePage,
  limitFrom,
  loadCurrentRevision,
  loadPage,
  loadRevision,
  pageResource,
  parsePageId,
  revisionSummary,
  writeRevision,
  type RevisionRow,
} from "../pages.ts";
import pkg from "../../package.json" with { type: "json" };

interface WsParams {
  workspaceId: string;
}
interface PageParams extends WsParams {
  pageId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function registerCoreRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config } = deps;

  app.get(`${API_BASE_PATH}/capabilities`, { config: { public: true } }, async (_request, reply) =>
    send(
      reply,
      jsonReply(200, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: config.capabilities,
        limits: {
          maxMarkdownBytes: config.maxMarkdownBytes,
          maxAttachmentBytes: config.maxAttachmentBytes,
          maxPageSize: PAGE_SIZE_MAX,
          idempotencyWindowSeconds: IDEMPOTENCY_WINDOW_SECONDS,
          // Configured quotas only: an unset limit is simply absent.
          ...(config.maxPagesPerWorkspace === undefined ? {} : { maxPagesPerWorkspace: config.maxPagesPerWorkspace }),
          ...(config.maxWorkspaceAttachmentBytes === undefined ? {} : { maxWorkspaceAttachmentBytes: config.maxWorkspaceAttachmentBytes }),
          ...(config.maxMembersPerWorkspace === undefined ? {} : { maxMembersPerWorkspace: config.maxMembersPerWorkspace }),
          ...(config.maxWorkspacesPerAccount === undefined ? {} : { maxWorkspacesPerAccount: config.maxWorkspacesPerAccount }),
          ...(config.revisionRetentionDays === undefined ? {} : { revisionRetentionDays: config.revisionRetentionDays }),
        },
        server: { name: "thoth-server", version: pkg.version },
      }),
    ),
  );

  app.get(`${API_BASE_PATH}/me`, async (request, reply) => {
    const me = principalOf(request);
    return send(reply, jsonReply(200, { id: me.id, displayName: me.displayName, ...(me.email ? { email: me.email } : {}) }));
  });

  app.get<{ Querystring: { cursor?: string; limit?: string } }>(`${API_BASE_PATH}/workspaces`, async (request, reply) => {
    const me = principalOf(request);
    const limit = limitFrom(request.query.limit);
    const after = request.query.cursor === undefined ? null : decodeCursor("w", "workspaces", request.query.cursor);
    const { rows } = await db.query<{ id: string; name: string; export_restricted: boolean; created_at: Date; role: Role; member_count: number; members: { userId: string; displayName: string; role: Role }[] }>(
      `SELECT w.id, w.name, w.export_restricted, w.created_at, m.role,
              (SELECT count(*) FROM memberships x WHERE x.workspace_id = w.id) AS member_count,
              (SELECT coalesce(json_agg(json_build_object('userId', u.id, 'displayName', u.display_name, 'role', mm.role) ORDER BY mm.user_id), '[]'::json)
                 FROM (SELECT user_id, role FROM memberships WHERE workspace_id = w.id ORDER BY user_id LIMIT 50) mm JOIN users u ON u.id = mm.user_id) AS members
         FROM workspaces w JOIN memberships m ON m.workspace_id = w.id AND m.user_id = $1
        WHERE ($2::text IS NULL OR w.id > $2)
        ORDER BY w.id LIMIT $3`,
      [me.id, after, limit + 1],
    );
    const page = rows.slice(0, limit);
    return send(
      reply,
      jsonReply(200, {
        items: page.map((w) => ({ id: w.id, kind: "workspace", name: w.name, role: w.role, exportRestricted: w.export_restricted, memberCount: w.member_count, members: w.members, createdAt: w.created_at.toISOString() })),
        nextCursor: rows.length > limit ? encodeCursor("w", "workspaces", page[page.length - 1]!.id) : null,
      }),
    );
  });

  app.get<{ Params: WsParams; Querystring: { cursor?: string; limit?: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/tree`, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "read");
    const limit = limitFrom(request.query.limit);
    let afterId: string | null = null;
    let head: number;
    if (request.query.cursor === undefined) {
      // Read the head before the pages: applying the feed from it afterwards can only re-apply, never miss.
      head = (await db.query<{ change_seq: number }>("SELECT change_seq FROM workspaces WHERE id = $1", [ws.id])).rows[0]!.change_seq;
    } else {
      const [id, seq, ...rest] = decodeCursor("t", ws.id, request.query.cursor).split(":");
      if (rest.length > 0 || !id || !UUID.test(id) || !seq || !/^\d{1,15}$/.test(seq)) throw new ApiError("cursor_invalid", "cursor does not decode");
      afterId = id;
      head = Number(seq);
    }
    const { rows } = await db.query<{ id: string; parent_id: string | null; title: string; current_revision_id: string; updated_at: Date }>(
      `SELECT id, parent_id, title, current_revision_id, updated_at FROM pages
        WHERE workspace_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id > $2)
        ORDER BY id LIMIT $3`,
      [ws.id, afterId, limit + 1],
    );
    const page = rows.slice(0, limit);
    return send(
      reply,
      jsonReply(200, {
        workspaceId: ws.id,
        items: page.map((p) => ({ id: p.id, parentId: p.parent_id, title: p.title, revisionId: p.current_revision_id, updatedAt: p.updated_at.toISOString() })),
        nextCursor: rows.length > limit ? encodeCursor("t", ws.id, `${page[page.length - 1]!.id}:${head}`) : null,
        changeCursor: changeCursorOf(ws.id, head),
      }),
    );
  });

  app.get<{ Params: PageParams; Querystring: { revision?: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/pages/:pageId`, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "read");
    const pageId = parsePageId(request.params.pageId);
    const wanted = request.query.revision;
    if (wanted !== undefined && !RevisionIdSchema.safeParse(wanted).success) throw new ApiError("validation_failed", "revision is not a valid revision ID", fieldError("query:revision", "invalid"));
    const page = await loadPage(db, ws.id, pageId);
    if (!page || page.deleted_at) throw new ApiError("not_found", "page not found");
    const rev = wanted === undefined ? await loadCurrentRevision(db, page) : await loadRevision(db, ws.id, pageId, wanted);
    if (!rev) throw new ApiError("not_found", "revision not found");
    return send(reply, jsonReply(200, pageResource(page, rev), { etag: formatEtag(rev.id) }));
  });

  app.put<{ Params: PageParams }>(
    `${API_BASE_PATH}/workspaces/:workspaceId/pages/:pageId`,
    // JSON escaping can inflate Markdown up to 6x (\u00XX); the exact limit is checked on the decoded text.
    { bodyLimit: config.maxMarkdownBytes * 6 + 8192 },
    (request, reply) =>
      mutate(deps, request, reply, async (tx, _info, now) => {
        const me = principalOf(request);
        const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "write", { lock: true });
        const pageId = parsePageId(request.params.pageId);
        const ifMatch = request.headers["if-match"];
        const ifNoneMatch = request.headers["if-none-match"];
        if (ifMatch !== undefined && ifNoneMatch !== undefined) throw new ApiError("validation_failed", "send either If-Match or If-None-Match, not both", fieldError("header:If-Match", "conflicts with If-None-Match"));
        if (ifMatch === undefined && ifNoneMatch === undefined) throw new ApiError("precondition_required", "writes require If-Match or If-None-Match");
        if (ifNoneMatch !== undefined && ifNoneMatch !== "*") throw new ApiError("validation_failed", "If-None-Match must be *", fieldError("header:If-None-Match", "only * is accepted"));
        const expected = ifMatch === undefined ? null : parseEtag(Array.isArray(ifMatch) ? ifMatch.join(", ") : ifMatch);
        if (ifMatch !== undefined && expected === null) throw new ApiError("validation_failed", "If-Match must be one strong entity tag", fieldError("header:If-Match", "expected one strong entity tag"));
        const parsed = PageWriteSchema.safeParse(parseJsonBody(request));
        if (!parsed.success) throw zodFailure(parsed.error);
        if (Buffer.byteLength(parsed.data.markdown, "utf8") > config.maxMarkdownBytes) throw new ApiError("payload_too_large", `markdown exceeds ${config.maxMarkdownBytes} bytes`);
        checkStorableText(parsed.data.title, "/title");
        checkStorableText(parsed.data.markdown, "/markdown");

        const existing = await loadPage(tx, ws.id, pageId, { forUpdate: true });
        const conflict = async (detail: string) => new ApiError("revision_conflict", detail, { currentRevision: revisionSummary(await loadCurrentRevision(tx, existing!)) });
        if (ifNoneMatch !== undefined) {
          // A deleted page still occupies its ID: recreating over it is a conflict (protocol open question 5).
          if (existing) throw await conflict("the page already exists");
        } else {
          if (!existing || existing.deleted_at) throw new ApiError("not_found", "page not found");
          if (expected !== existing.current_revision_id) throw await conflict("If-Match does not match the current revision");
        }
        await checkParent(tx, ws.id, pageId, parsed.data.parentId);
        // Under the workspace lock taken above, so concurrent creates cannot both pass at limit - 1. Updates never count.
        if (!existing) await assertCanCreatePages(tx, config, ws.id, 1);
        const { page, revision, created } = await writeRevision(tx, { workspaceId: ws.id, pageId, input: parsed.data, userId: me.id, existing, now });
        return jsonReply(created ? 201 : 200, pageResource(page, revision), { etag: formatEtag(revision.id) });
      }),
  );

  app.delete<{ Params: PageParams }>(`${API_BASE_PATH}/workspaces/:workspaceId/pages/:pageId`, (request, reply) =>
    mutate(deps, request, reply, async (tx, _info, now) => {
      const me = principalOf(request);
      const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "write", { lock: true });
      const pageId = parsePageId(request.params.pageId);
      const ifMatch = request.headers["if-match"];
      if (ifMatch === undefined) throw new ApiError("precondition_required", "DELETE requires If-Match");
      const expected = parseEtag(Array.isArray(ifMatch) ? ifMatch.join(", ") : ifMatch);
      if (expected === null) throw new ApiError("validation_failed", "If-Match must be one strong entity tag", fieldError("header:If-Match", "expected one strong entity tag"));
      const page = await loadPage(tx, ws.id, pageId, { forUpdate: true });
      if (!page || page.deleted_at) throw new ApiError("not_found", "page not found");
      if (expected !== page.current_revision_id) throw new ApiError("revision_conflict", "If-Match does not match the current revision", { currentRevision: revisionSummary(await loadCurrentRevision(tx, page)) });
      await deletePage(tx, ws.id, pageId, me.id, now);
      return { status: 204, headers: {} };
    }),
  );

  app.get<{ Params: PageParams; Querystring: { cursor?: string; limit?: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/pages/:pageId/revisions`, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "read");
    const pageId = parsePageId(request.params.pageId);
    const page = await loadPage(db, ws.id, pageId);
    if (!page || page.deleted_at) throw new ApiError("not_found", "page not found");
    const limit = limitFrom(request.query.limit);
    const before = request.query.cursor === undefined ? null : decodeIntCursor("r", `${ws.id}/${pageId}`, request.query.cursor);
    const { rows } = await db.query<Omit<RevisionRow, "markdown">>(
      `SELECT ${REVISION_COLUMNS} FROM page_revisions WHERE workspace_id = $1 AND page_id = $2 AND ($3::int IS NULL OR rev_no < $3) ORDER BY rev_no DESC LIMIT $4`,
      [ws.id, pageId, before, limit + 1],
    );
    const items = rows.slice(0, limit);
    return send(reply, jsonReply(200, { items: items.map(revisionSummary), nextCursor: rows.length > limit ? encodeCursor("r", `${ws.id}/${pageId}`, String(items[items.length - 1]!.rev_no)) : null }));
  });

  app.get<{ Params: WsParams; Querystring: { cursor?: string; limit?: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/changes`, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "read");
    const limit = limitFrom(request.query.limit);
    const position = request.query.cursor === undefined ? 0 : decodeIntCursor("c", ws.id, request.query.cursor);
    const head = (await db.query<{ change_seq: number }>("SELECT change_seq FROM workspaces WHERE id = $1", [ws.id])).rows[0]!.change_seq;
    if (position > head) throw new ApiError("cursor_invalid", "cursor is ahead of the feed");
    // Entries are read after the head, and an entry at seq <= head is always fully committed
    // (writers hold the workspace lock until commit), so no entry can appear below a cursor we hand out.
    const { rows } = await db.query<ChangeRow>(
      `SELECT seq, kind, occurred_at, actor_id, page_id, revision_id, parent_id, title, attachment_id
         FROM changes WHERE workspace_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq LIMIT $4`,
      [ws.id, position, head, limit],
    );
    const next = rows.length ? rows[rows.length - 1]!.seq : position;
    return send(reply, jsonReply(200, { entries: rows.map(changeEntryOf), cursor: changeCursorOf(ws.id, next), hasMore: next < head }));
  });
}
