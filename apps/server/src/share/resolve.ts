import type { Queryable } from "../db.ts";

/**
 * What a share request may reach, re-checked on every request (ADR-0023). Every query here is scoped by the link row:
 * the workspace and the root page come from the link, never from the URL. An ID in the URL (a sub-page, an
 * attachment) is only ever compared against what the link reaches.
 */
export interface ActiveShareLink {
  id: string;
  workspaceId: string;
  pageId: string;
  tokenHash: string;
}

/**
 * The link for a token hash, if it may be served now: not revoked, not expired, its page not deleted (a page moved
 * out of the workspace is deleted there), its creator still an owner or editor, and the workspace neither export
 * restricted nor deleted (ADR-0025). One statement of one shape whatever the outcome, so an unknown token and a dead one cost the same.
 */
export async function resolveShareLink(q: Queryable, tokenHash: string): Promise<ActiveShareLink | null> {
  const { rows } = await q.query<{ id: string; workspace_id: string; page_id: string; token_hash: string }>(
    `SELECT l.id, l.workspace_id, l.page_id, l.token_hash
       FROM share_links l
       JOIN workspaces w ON w.id = l.workspace_id AND NOT w.export_restricted AND w.deleted_at IS NULL
       JOIN memberships m ON m.workspace_id = l.workspace_id AND m.user_id = l.created_by AND m.role IN ('owner', 'editor')
       JOIN pages p ON p.workspace_id = l.workspace_id AND p.id = l.page_id AND p.deleted_at IS NULL
      WHERE l.token_hash = $1 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())`,
    [tokenHash],
  );
  const row = rows[0];
  return row ? { id: row.id, workspaceId: row.workspace_id, pageId: row.page_id, tokenHash: row.token_hash } : null;
}

export interface SharedNode {
  id: string;
  parentId: string | null;
  title: string;
  position: string | null;
}

/** Deeper than any real page tree; bounds the walk if the data ever held a cycle. */
const MAX_DEPTH = 64;

/**
 * The shared subtree: the link's page and every live page below it, through live pages only (a deleted page cuts
 * its branch off). The root's own parent is reported as `null`: nothing above the shared page is ever named.
 */
export async function sharedSubtree(q: Queryable, link: ActiveShareLink): Promise<Map<string, SharedNode>> {
  const { rows } = await q.query<{ id: string; parent_id: string | null; title: string; position: string | null }>(
    `WITH RECURSIVE tree(id, parent_id, depth) AS (
       SELECT p.id, NULL::uuid, 0 FROM pages p WHERE p.workspace_id = $1 AND p.id = $2 AND p.deleted_at IS NULL
       UNION
       SELECT c.id, c.parent_id, t.depth + 1 FROM pages c JOIN tree t ON c.parent_id = t.id
        WHERE c.workspace_id = $1 AND c.deleted_at IS NULL AND c.id <> $2 AND t.depth < ${MAX_DEPTH}
     )
     SELECT DISTINCT ON (t.id) t.id, t.parent_id, r.title, p.position
       FROM tree t
       JOIN pages p ON p.workspace_id = $1 AND p.id = t.id
       JOIN page_revisions r ON r.id = p.current_revision_id
      ORDER BY t.id, t.depth`,
    [link.workspaceId, link.pageId],
  );
  return new Map(rows.map((r) => [r.id, { id: r.id, parentId: r.parent_id, title: r.title, position: r.position }]));
}

/** The current Markdown of a page of the subtree (the caller has checked membership in the subtree). */
export async function sharedMarkdown(q: Queryable, link: ActiveShareLink, pageId: string): Promise<{ markdown: string; updatedAt: Date } | null> {
  const { rows } = await q.query<{ markdown: string; updated_at: Date }>(
    `SELECT r.markdown, p.updated_at FROM pages p JOIN page_revisions r ON r.id = p.current_revision_id
      WHERE p.workspace_id = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
    [link.workspaceId, pageId],
  );
  const row = rows[0];
  return row ? { markdown: row.markdown, updatedAt: row.updated_at } : null;
}

export interface SharedAttachmentRow {
  id: string;
  hash: string;
  size: number;
  mime_type: string;
  file_name: string | null;
}

/** Attachments of the link's workspace among `ids` (the IDs a shared page refers to). */
export async function sharedAttachments(q: Queryable, link: ActiveShareLink, ids: readonly string[]): Promise<Map<string, SharedAttachmentRow>> {
  if (ids.length === 0) return new Map();
  const { rows } = await q.query<SharedAttachmentRow>("SELECT id, hash, size, mime_type, file_name FROM attachments WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [link.workspaceId, ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Pages of the subtree whose current Markdown mentions an attachment: the candidates the caller then parses to see
 * whether one really uses it (a mention inside code does not count).
 */
export async function pagesMentioning(q: Queryable, link: ActiveShareLink, pageIds: readonly string[], attachmentId: string): Promise<{ id: string; markdown: string }[]> {
  const { rows } = await q.query<{ id: string; markdown: string }>(
    `SELECT p.id, r.markdown FROM pages p JOIN page_revisions r ON r.id = p.current_revision_id
      WHERE p.workspace_id = $1 AND p.id = ANY($2::uuid[]) AND p.deleted_at IS NULL AND strpos(lower(r.markdown), $3) > 0
      LIMIT 50`,
    [link.workspaceId, pageIds, `thoth:attachment/${attachmentId}`],
  );
  return rows;
}
