import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { API_BASE_PATH, AttachmentIdSchema, PageIdSchema, SHARE_EXPIRY_DEFAULT_DAYS, ShareLinkCreateRequestSchema, problem } from "@thoth/workspace-protocol";
import { workspaceAccess } from "../access.ts";
import { decodeCursor, encodeCursor } from "../cursor.ts";
import type { Deps } from "../deps.ts";
import { ApiError, jsonReply, zodFailure } from "../errors.ts";
import { audit, mutate, parseJsonBody, principalOf, send } from "../http.ts";
import { opaqueId } from "../ids.ts";
import { limitFrom, loadPage, parsePageId } from "../pages.ts";
import { quotaExceeded } from "../quota.ts";
import { clientIp, hit } from "../ratelimit.ts";
import { shareAsset } from "../share/assets.ts";
import { contentDisposition, inlineImageType } from "../share/files.ts";
import { NOT_FOUND_HTML, SHARE_FILE_HEADERS, SHARE_HEADERS, TOO_MANY_HTML, sharedPageHtml } from "../share/html.ts";
import { renderShareMarkdown, type RenderContext } from "../share/render.ts";
import { pagesMentioning, resolveShareLink, sharedAttachments, sharedMarkdown, sharedSubtree, type ActiveShareLink, type SharedNode } from "../share/resolve.ts";
import { SHARE_TOKEN_PATTERN, generateShareToken, hashShareToken, shareTokenMatches } from "../share/tokens.ts";

interface LinkRow {
  id: string;
  workspace_id: string;
  page_id: string;
  created_at: Date;
  created_by: string | null;
  expires_at: Date | null;
}

const linkResource = (r: LinkRow) => ({
  id: r.id,
  workspaceId: r.workspace_id,
  pageId: r.page_id,
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by,
  expiresAt: r.expires_at === null ? null : r.expires_at.toISOString(),
});

const LINK_COLUMNS = "id, workspace_id, page_id, created_at, created_by, expires_at";
const ACTIVE = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())";

/**
 * ADR-0023: public read-only share links. Two surfaces:
 *
 * - the protocol calls (create, list, revoke) under /api/v1, authenticated like every other route, owners and
 *   editors only, gated on capability `public-share` by the app's capability table;
 * - the public pages under /s/<token> (and the stylesheet and fonts under /assets/share/), unauthenticated.
 *   Each request re-checks the link from scratch; every failure is the same 404.
 */
export function registerShareRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config, blobs } = deps;
  const enabled = config.capabilities.includes("public-share");
  const window = config.rateLimit.windowSeconds;

  // ------------------------------------------------------------------ protocol calls

  app.post<{ Params: { workspaceId: string; pageId: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/pages/:pageId/share-links`, async (request, reply) => {
    const me = principalOf(request);
    // Not through the idempotency machinery on purpose: a stored replay would keep the token in the database.
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "write");
    const pageId = parsePageId(request.params.pageId);
    const parsed = ShareLinkCreateRequestSchema.safeParse(parseJsonBody(request, { optional: true }));
    if (!parsed.success) throw zodFailure(parsed.error);
    const days = parsed.data.expiresInDays === undefined ? SHARE_EXPIRY_DEFAULT_DAYS : parsed.data.expiresInDays;
    const token = generateShareToken();
    const row = await db.tx(async (tx) => {
      const locked = await workspaceAccess(tx, ws.id, me.id, "write", { lock: true });
      if (locked.exportRestricted) throw new ApiError("export_restricted", "this workspace forbids exporting content, so its pages cannot be shared publicly");
      const page = await loadPage(tx, locked.id, pageId);
      if (!page || page.deleted_at) throw new ApiError("not_found", "page not found");
      const limit = config.share.maxLinksPerWorkspace;
      if (limit !== undefined) {
        const current = Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM share_links WHERE workspace_id = $1 AND ${ACTIVE}`, [locked.id])).rows[0]!.n);
        if (current >= limit) throw quotaExceeded("shareLinksPerWorkspace", `this workspace may have ${limit} active share links (${current} in use); revoke one to make room`, { limit, current });
      }
      const id = opaqueId("shl");
      const { rows } = await tx.query<LinkRow>(
        `INSERT INTO share_links (id, workspace_id, page_id, token_hash, created_by, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, date_trunc('milliseconds', now()), CASE WHEN $6::int IS NULL THEN NULL ELSE date_trunc('milliseconds', now()) + make_interval(days => $6::int) END)
         RETURNING ${LINK_COLUMNS}`,
        [id, locked.id, pageId, hashShareToken(token), me.id, days],
      );
      await audit(tx, { actorId: me.id, workspaceId: locked.id, action: "share_link.created", detail: { linkId: id, pageId, expiresInDays: days } });
      return rows[0]!;
    });
    const origin = config.publicUrl ?? `${request.protocol}://${request.host}`;
    return send(reply, jsonReply(201, { ...linkResource(row), token, url: `${origin}/s/${token}` }));
  });

  app.get<{ Params: { workspaceId: string; pageId: string }; Querystring: { cursor?: string; limit?: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/pages/:pageId/share-links`, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "write");
    const pageId = parsePageId(request.params.pageId);
    const page = await loadPage(db, ws.id, pageId);
    if (!page || page.deleted_at) throw new ApiError("not_found", "page not found");
    const limit = limitFrom(request.query.limit);
    const scope = `${ws.id}/${pageId}`;
    let after: { at: Date; id: string } | null = null;
    if (request.query.cursor !== undefined) {
      const value = decodeCursor("l", scope, request.query.cursor);
      const bar = value.indexOf("|");
      const at = new Date(value.slice(0, bar));
      if (bar < 0 || Number.isNaN(at.getTime())) throw new ApiError("cursor_invalid", "cursor does not decode");
      after = { at, id: value.slice(bar + 1) };
    }
    const { rows } = await db.query<LinkRow>(
      `SELECT ${LINK_COLUMNS} FROM share_links
        WHERE workspace_id = $1 AND page_id = $2 AND ${ACTIVE} AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::text))
        ORDER BY created_at DESC, id DESC LIMIT $5`,
      [ws.id, pageId, after?.at ?? null, after?.id ?? null, limit + 1],
    );
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return send(reply, jsonReply(200, { items: items.map(linkResource), nextCursor: rows.length > limit && last ? encodeCursor("l", scope, `${last.created_at.toISOString()}|${last.id}`) : null }));
  });

  app.delete<{ Params: { workspaceId: string; linkId: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/share-links/:linkId`, (request, reply) =>
    mutate(deps, request, reply, async (tx) => {
      const me = principalOf(request);
      const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "write", { lock: true });
      const { rows } = await tx.query<{ revoked_at: Date | null; page_id: string }>("SELECT revoked_at, page_id FROM share_links WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [ws.id, request.params.linkId]);
      const link = rows[0];
      if (!link) throw new ApiError("not_found", "share link not found");
      if (link.revoked_at === null) {
        await tx.query("UPDATE share_links SET revoked_at = now() WHERE workspace_id = $1 AND id = $2", [ws.id, request.params.linkId]);
        await audit(tx, { actorId: me.id, workspaceId: ws.id, action: "share_link.revoked", detail: { linkId: request.params.linkId, pageId: link.page_id } });
      }
      return { status: 204, headers: {} };
    }),
  );

  // ------------------------------------------------------------------ the public pages

  /** Same status, body and headers for every failure; JSON only for a client that does not ask for HTML. */
  const notFound = (request: FastifyRequest, reply: FastifyReply) => answer(request, reply, 404, NOT_FOUND_HTML, problem("not_found", { detail: "no such shared page" }));

  function answer(request: FastifyRequest, reply: FastifyReply, status: number, html: string, json: object, extra: Record<string, string> = {}): FastifyReply {
    reply.code(status);
    for (const [name, value] of Object.entries({ ...SHARE_HEADERS, ...extra })) reply.header(name, value);
    if (wantsHtml(request)) return reply.header("content-type", "text/html; charset=utf-8").send(html);
    return reply.header("content-type", "application/problem+json").send(JSON.stringify(json));
  }

  /**
   * The link behind a token, or null once the 404 or 429 has been sent. Rate limits come first and count the token as
   * given (its hash), known or not, so a refusal says nothing about whether the token exists. (Null, not the reply: a
   * Fastify reply is a thenable, so an async function returning one resolves to undefined.)
   */
  async function linkFor(request: FastifyRequest, reply: FastifyReply, token: string): Promise<ActiveShareLink | null> {
    const refuse = (sent: unknown): null => (void sent, null);
    if (!enabled) return refuse(notFound(request, reply));
    const tokenHash = hashShareToken(token);
    const limits: [string, number | undefined][] = [
      [`share-ip:${clientIp(request.headers, request.socket.remoteAddress, config.trustProxy)}`, config.share.viewsPerIp],
      [`share-tok:${tokenHash}`, config.share.viewsPerLink],
    ];
    for (const [key, limit] of limits) {
      if (limit === undefined) continue;
      const decision = await hit(db, key, limit, window);
      if (!decision.allowed) return refuse(answer(request, reply, 429, TOO_MANY_HTML, problem("rate_limited", { detail: "too many requests; retry after the time in the Retry-After header" }), { "retry-after": String(decision.retryAfterSeconds) }));
    }
    const link = SHARE_TOKEN_PATTERN.test(token) ? await resolveShareLink(db, tokenHash) : null;
    // Constant-time comparison whether or not a row came back.
    const matches = shareTokenMatches(token, link?.tokenHash ?? null);
    return link && matches ? link : refuse(notFound(request, reply));
  }

  const hrefOf = (token: string, link: ActiveShareLink, id: string) => (id === link.pageId ? `/s/${token}` : `/s/${token}/p/${id}`);

  async function servePage(request: FastifyRequest, reply: FastifyReply, token: string, pageId: string | null): Promise<FastifyReply> {
    const link = await linkFor(request, reply, token);
    if (!link) return reply;
    const target = pageId ?? link.pageId;
    if (!PageIdSchema.safeParse(target).success) return notFound(request, reply);
    const tree = await sharedSubtree(db, link);
    const node = tree.get(target);
    const content = node ? await sharedMarkdown(db, link, target) : null;
    if (!node || !content) return notFound(request, reply);
    const page = (id: string) => {
      const n = tree.get(id);
      return n ? { href: hrefOf(token, link, id), title: n.title.trim() || "Untitled" } : null;
    };
    // First pass: which attachments the page uses; second pass: render with what they are.
    const used = renderShareMarkdown(content.markdown, { page, attachment: () => null }).attachmentIds;
    const files = await sharedAttachments(db, link, [...used]);
    const ctx: RenderContext = {
      page,
      attachment: (id) => {
        const row = files.get(id);
        return row ? { href: `/s/${token}/a/${id}`, inline: inlineImageType(row.mime_type), name: row.file_name ?? "attachment" } : null;
      },
    };
    const rendered = renderShareMarkdown(content.markdown, ctx);
    const crumbs: { href: string; title: string }[] = [];
    for (let at = node.parentId; at !== null && crumbs.length < 64; ) {
      const up = tree.get(at);
      if (!up) break;
      crumbs.unshift({ href: hrefOf(token, link, up.id), title: up.title });
      at = up.id === link.pageId ? null : up.parentId;
    }
    const children = [...tree.values()].filter((n) => n.parentId === target && n.id !== link.pageId).sort(byOrder);
    const html = sharedPageHtml({
      title: node.title,
      home: `/s/${token}`,
      crumbs,
      body: rendered.html,
      opensWithTitle: rendered.opensWithTitle,
      updatedAt: content.updatedAt,
      children: children.map((c) => ({ href: hrefOf(token, link, c.id), title: c.title })),
    });
    reply.code(200);
    for (const [name, value] of Object.entries(SHARE_HEADERS)) reply.header(name, value);
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  }

  app.get<{ Params: { token: string } }>("/s/:token", (request, reply) => servePage(request, reply, request.params.token, null));
  app.get<{ Params: { token: string; pageId: string } }>("/s/:token/p/:pageId", (request, reply) => servePage(request, reply, request.params.token, request.params.pageId));

  app.get<{ Params: { token: string; attachmentId: string } }>("/s/:token/a/:attachmentId", async (request, reply) => {
    const link = await linkFor(request, reply, request.params.token);
    if (!link) return reply;
    const id = request.params.attachmentId;
    if (!AttachmentIdSchema.safeParse(id).success) return notFound(request, reply);
    // Served only when a page of the shared subtree uses it now (not merely mentions it, as in code).
    const tree = await sharedSubtree(db, link);
    const candidates = await pagesMentioning(db, link, [...tree.keys()], id);
    const used = candidates.some((c) => renderShareMarkdown(c.markdown, { page: () => null, attachment: () => null }).attachmentIds.has(id));
    const row = used ? (await sharedAttachments(db, link, [id])).get(id) : undefined;
    const blob = row ? await blobs.open(row.hash) : null;
    if (!row || !blob) return notFound(request, reply);
    reply.code(200);
    for (const [name, value] of Object.entries(SHARE_FILE_HEADERS)) reply.header(name, value);
    reply
      .header("content-type", row.mime_type)
      .header("content-length", String(blob.size))
      .header("content-disposition", contentDisposition(inlineImageType(row.mime_type) ? "inline" : "attachment", row.file_name));
    return reply.send(blob.stream);
  });

  // Anything else under /s/ is the same 404 as an unknown token.
  app.get("/s/*", (request, reply) => notFound(request, reply));

  app.get<{ Params: { name: string } }>("/assets/share/:name", async (request, reply) => {
    const asset = shareAsset(request.params.name);
    if (!asset) throw new ApiError("not_found", "no such file");
    return reply.code(200).header("content-type", asset.type).header("cache-control", "public, max-age=86400").header("x-content-type-options", "nosniff").header("cross-origin-resource-policy", "same-origin").send(asset.bytes);
  });
}

/** Sub-pages in their sibling order (capability `page-order`), then by title. */
function byOrder(a: SharedNode, b: SharedNode): number {
  if (a.position !== null && b.position !== null && a.position !== b.position) return a.position < b.position ? -1 : 1;
  if (a.position !== null && b.position === null) return -1;
  if (a.position === null && b.position !== null) return 1;
  return a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1);
}

/** A browser navigation (Accept names text/html) gets the HTML page; an API client gets a problem document. */
function wantsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  return typeof accept === "string" && /\btext\/html\b/i.test(accept);
}
