import { createHash } from "node:crypto";
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, PageIdSchema, type PageWrite } from "@thoth/workspace-protocol";
import { ApiError, fieldError } from "./errors.ts";
import { appendChange } from "./changes.ts";
import type { Queryable } from "./db.ts";
import { opaqueId } from "./ids.ts";

export interface PageRow {
  workspace_id: string;
  id: string;
  parent_id: string | null;
  title: string;
  /** Sibling sort key (capability `page-order`); lives on the page row only, never in a revision. */
  position: string | null;
  current_revision_id: string;
  revision_count: number;
  created_at: Date;
  created_by: string | null;
  updated_at: Date;
  updated_by: string | null;
  deleted_at: Date | null;
}

export interface RevisionRow {
  id: string;
  page_id: string;
  rev_no: number;
  parent_revision_id: string | null;
  created_at: Date;
  author_id: string | null;
  title: string;
  markdown: string;
  page_parent_id: string | null;
  size: number;
  content_hash: string;
}

export const REVISION_COLUMNS = "id, page_id, rev_no, parent_revision_id, created_at, author_id, title, size, content_hash, page_parent_id";
export const REVISION_COLUMNS_WITH_BODY = `${REVISION_COLUMNS}, markdown`;

export const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

export function revisionSummary(rev: Omit<RevisionRow, "markdown">) {
  return {
    id: rev.id,
    pageId: rev.page_id,
    parentId: rev.parent_revision_id,
    createdAt: rev.created_at.toISOString(),
    authorId: rev.author_id,
    title: rev.title,
    size: rev.size,
    contentHash: rev.content_hash,
  };
}

/**
 * The page as of `rev`. For the current revision, parent and position come from the page row: a move
 * (`movePage`) changes them there without creating a revision. A historical revision shows where the page was
 * when that revision was written, and no position.
 */
export function pageResource(page: PageRow, rev: RevisionRow) {
  const current = rev.id === page.current_revision_id;
  return {
    id: page.id,
    markdown: rev.markdown,
    revision: revisionSummary(rev),
    metadata: {
      workspaceId: page.workspace_id,
      parentId: current ? page.parent_id : rev.page_parent_id,
      title: rev.title,
      position: current ? page.position : null,
      createdAt: page.created_at.toISOString(),
      createdBy: page.created_by,
      updatedAt: rev.created_at.toISOString(),
      updatedBy: rev.author_id,
    },
  };
}

export function parsePageId(raw: string | undefined): string {
  const parsed = PageIdSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError("validation_failed", "pageId must be a UUIDv7", fieldError("path:pageId", "expected UUIDv7"));
  return parsed.data;
}

export function limitFrom(raw: unknown): number {
  if (raw === undefined) return PAGE_SIZE_DEFAULT;
  const n = typeof raw === "string" && /^\d{1,4}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > PAGE_SIZE_MAX) throw new ApiError("validation_failed", `limit must be an integer between 1 and ${PAGE_SIZE_MAX}`, fieldError("query:limit", "out of range"));
  return n;
}

/** Text PostgreSQL can store and return byte-for-byte: no NUL, and no lone surrogates (which UTF-8 cannot represent). */
export function checkStorableText(value: string, pointer: string): void {
  if (value.includes("\u0000") || !value.isWellFormed()) throw new ApiError("validation_failed", `${pointer} contains characters that cannot be stored (NUL or an unpaired surrogate)`, fieldError(pointer, "not storable as UTF-8 text"));
}

export async function loadPage(q: Queryable, workspaceId: string, pageId: string, options: { forUpdate?: boolean } = {}): Promise<PageRow | undefined> {
  const { rows } = await q.query<PageRow>(`SELECT * FROM pages WHERE workspace_id = $1 AND id = $2 ${options.forUpdate ? "FOR UPDATE" : ""}`, [workspaceId, pageId]);
  return rows[0];
}

export async function loadRevision(q: Queryable, workspaceId: string, pageId: string, revisionId: string): Promise<RevisionRow | undefined> {
  const { rows } = await q.query<RevisionRow>(`SELECT ${REVISION_COLUMNS_WITH_BODY} FROM page_revisions WHERE workspace_id = $1 AND page_id = $2 AND id = $3`, [workspaceId, pageId, revisionId]);
  return rows[0];
}

export async function loadCurrentRevision(q: Queryable, page: PageRow): Promise<RevisionRow> {
  const rev = await loadRevision(q, page.workspace_id, page.id, page.current_revision_id);
  if (!rev) throw new Error(`page ${page.id} points at a missing revision`);
  return rev;
}

/**
 * Rejects a parent that is the page itself or would make the page its own ancestor. A parent that
 * does not exist (yet) is accepted: the tree is an adjacency list and clients may sync a child
 * before its parent (protocol open question 6).
 */
export async function checkParent(q: Queryable, workspaceId: string, pageId: string, parentId: string | null | undefined): Promise<void> {
  if (parentId === null || parentId === undefined) return;
  const bad = (detail: string) => new ApiError("validation_failed", detail, fieldError("/parentId", detail));
  if (parentId === pageId) throw bad("a page cannot be its own parent");
  const cycle = await q.query(
    `WITH RECURSIVE up(id, parent_id) AS (
       SELECT id, parent_id FROM pages WHERE workspace_id = $1 AND id = $2
       UNION
       SELECT p.id, p.parent_id FROM pages p JOIN up ON p.id = up.parent_id WHERE p.workspace_id = $1
     ) SELECT 1 FROM up WHERE id = $3 LIMIT 1`,
    [workspaceId, parentId, pageId],
  );
  if ((cycle.rowCount ?? 0) > 0) throw bad("parentId would make the page its own ancestor");
}

export interface WrittenRevision {
  page: PageRow;
  revision: RevisionRow;
  created: boolean;
}

/**
 * Creates the next revision of a page (or the page and its first revision) and the change entry,
 * inside the caller's transaction. The caller holds the workspace lock and has already checked the
 * precondition against `existing` (the page row, locked).
 */
export async function writeRevision(
  tx: Queryable,
  args: { workspaceId: string; pageId: string; input: PageWrite; userId: string | null; existing: PageRow | undefined; now: Date },
): Promise<WrittenRevision> {
  const { workspaceId, pageId, input, userId, existing, now } = args;
  const created = existing === undefined;
  const previous = existing ? await loadCurrentRevision(tx, existing) : undefined;
  // Unchanged parent and position come from the page row, which a metadata-only move may have changed since the last revision.
  const pageParentId = input.parentId === undefined ? (existing?.parent_id ?? null) : input.parentId;
  const position = input.position === undefined ? (existing?.position ?? null) : input.position;
  const revisionId = opaqueId("rev");
  const revNo = (existing?.revision_count ?? 0) + 1;
  const size = Buffer.byteLength(input.markdown, "utf8");
  const contentHash = sha256Hex(input.markdown);

  if (created) {
    // The pages -> page_revisions pointer is deferred, so the page row may precede its first revision.
    await tx.query(
      `INSERT INTO pages (workspace_id, id, parent_id, title, position, current_revision_id, revision_count, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $7, $8)`,
      [workspaceId, pageId, pageParentId, input.title, position, revisionId, now, userId],
    );
  }
  await tx.query(
    `INSERT INTO page_revisions (id, workspace_id, page_id, rev_no, parent_revision_id, created_at, author_id, title, markdown, page_parent_id, size, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [revisionId, workspaceId, pageId, revNo, previous?.id ?? null, now, userId, input.title, input.markdown, pageParentId, size, contentHash],
  );
  if (!created) {
    await tx.query("UPDATE pages SET parent_id = $3, title = $4, position = $5, current_revision_id = $6, revision_count = $7, updated_at = $8, updated_by = $9 WHERE workspace_id = $1 AND id = $2", [workspaceId, pageId, pageParentId, input.title, position, revisionId, revNo, now, userId]);
  }
  await appendChange(tx, workspaceId, { kind: created ? "page.created" : "page.updated", actorId: userId, pageId, revisionId, parentId: pageParentId, title: input.title, position }, now);

  const revision: RevisionRow = { id: revisionId, page_id: pageId, rev_no: revNo, parent_revision_id: previous?.id ?? null, created_at: now, author_id: userId, title: input.title, markdown: input.markdown, page_parent_id: pageParentId, size, content_hash: contentHash };
  const page: PageRow = {
    workspace_id: workspaceId,
    id: pageId,
    parent_id: pageParentId,
    title: input.title,
    position,
    current_revision_id: revisionId,
    revision_count: revNo,
    created_at: existing?.created_at ?? now,
    created_by: existing ? existing.created_by : userId,
    updated_at: now,
    updated_by: userId,
    deleted_at: null,
  };
  return { page, revision, created };
}

/**
 * Metadata-only move (capability `page-order`): a new parent and/or position on the page row, no new revision.
 * The caller holds the workspace lock, has checked `If-Match` against `page` (locked) and the parent. The
 * change feed records `page.updated` naming the unchanged current revision.
 */
export async function movePage(tx: Queryable, args: { page: PageRow; parentId: string | null | undefined; position: string | null | undefined; userId: string | null; now: Date }): Promise<PageRow> {
  const { page, userId, now } = args;
  const parentId = args.parentId === undefined ? page.parent_id : args.parentId;
  const position = args.position === undefined ? page.position : args.position;
  await tx.query("UPDATE pages SET parent_id = $3, position = $4, updated_at = $5, updated_by = $6 WHERE workspace_id = $1 AND id = $2", [page.workspace_id, page.id, parentId, position, now, userId]);
  await appendChange(tx, page.workspace_id, { kind: "page.updated", actorId: userId, pageId: page.id, revisionId: page.current_revision_id, parentId, title: page.title, position }, now);
  return { ...page, parent_id: parentId, position, updated_at: now, updated_by: userId };
}

/** The tree node of a page row (`getWorkspaceTree`, `movePage`). */
export function treeNode(p: Pick<PageRow, "id" | "parent_id" | "title" | "position" | "current_revision_id" | "updated_at">) {
  return { id: p.id, parentId: p.parent_id, title: p.title, position: p.position, revisionId: p.current_revision_id, updatedAt: p.updated_at.toISOString() };
}

/** Marks a page deleted and records `page.deleted`. Revisions are kept. */
export async function deletePage(tx: Queryable, workspaceId: string, pageId: string, userId: string | null, now: Date): Promise<void> {
  await tx.query("UPDATE pages SET deleted_at = $3, updated_at = $3, updated_by = $4 WHERE workspace_id = $1 AND id = $2", [workspaceId, pageId, now, userId]);
  await appendChange(tx, workspaceId, { kind: "page.deleted", actorId: userId, pageId }, now);
}
