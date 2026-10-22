import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { API_BASE_PATH, SearchRequestSchema } from "@thoth/workspace-protocol";
import { workspaceAccess } from "../access.ts";
import { decodeIntCursor, encodeCursor } from "../cursor.ts";
import type { Deps } from "../deps.ts";
import { ApiError, jsonReply, zodFailure } from "../errors.ts";
import { parseJsonBody, principalOf, send } from "../http.ts";
import { checkStorableText, limitFrom } from "../pages.ts";

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

interface HitRow {
  id: string;
  title: string;
  revision_id: string;
  snippet: string;
  title_hit: boolean;
}

/**
 * Case-insensitive substring search over the title and Markdown of current revisions, accelerated by
 * pg_trgm GIN indexes. Not PostgreSQL full-text search: that cannot segment Thai (see README). Results
 * come only from pages of this workspace that are not deleted; the workspace gate is the same one every
 * other route uses, so a non-member gets 404 and cannot probe for hits.
 */
export function registerSearchRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  app.post<{ Params: { workspaceId: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/search`, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "read");
    const parsed = SearchRequestSchema.safeParse(parseJsonBody(request));
    if (!parsed.success) throw zodFailure(parsed.error);
    const { query, withinPageId } = parsed.data;
    checkStorableText(query, "/query");
    const limit = limitFrom(parsed.data.limit === undefined ? undefined : String(parsed.data.limit));
    const scope = `${ws.id}/${createHash("sha256").update(`${query}\u0000${withinPageId ?? ""}`).digest("hex").slice(0, 24)}`;
    let offset = 0;
    if (parsed.data.cursor !== undefined) offset = decodeIntCursor("s", scope, parsed.data.cursor);
    if (offset > 10_000) throw new ApiError("cursor_invalid", "cursor is out of range");

    const pattern = `%${escapeLike(query)}%`;
    const { rows } = await db.query<HitRow>(
      `WITH RECURSIVE subtree(id) AS (
         SELECT $4::uuid WHERE $4::uuid IS NOT NULL
         UNION
         SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id WHERE p.workspace_id = $1 AND p.deleted_at IS NULL
       )
       SELECT p.id, r.title, r.id AS revision_id,
              substring(r.markdown FROM greatest(strpos(lower(r.markdown), lower($3)) - 60, 1) FOR 200) AS snippet,
              (r.title ILIKE $2 ESCAPE '\\') AS title_hit
         FROM pages p JOIN page_revisions r ON r.id = p.current_revision_id
        WHERE p.workspace_id = $1 AND p.deleted_at IS NULL
          AND (r.title ILIKE $2 ESCAPE '\\' OR r.markdown ILIKE $2 ESCAPE '\\')
          AND ($4::uuid IS NULL OR p.id IN (SELECT id FROM subtree))
        ORDER BY (r.title ILIKE $2 ESCAPE '\\') DESC, p.updated_at DESC, p.id
        OFFSET $5 LIMIT $6`,
      [ws.id, pattern, query, withinPageId ?? null, offset, limit + 1],
    );
    const page = rows.slice(0, limit);
    return send(
      reply,
      jsonReply(200, {
        items: page.map((h) => ({ pageId: h.id, title: h.title, revisionId: h.revision_id, snippet: h.snippet.replace(/\s+/g, " ").trim(), score: h.title_hit ? 1 : 0.5 })),
        nextCursor: rows.length > limit ? encodeCursor("s", scope, String(offset + limit)) : null,
      }),
    );
  });
}
