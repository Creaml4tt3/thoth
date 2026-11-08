import type { FastifyInstance } from "fastify";
import { newStableId } from "@thoth/domain";
import {
  API_BASE_PATH,
  OpaqueIdSchema,
  TEAM_MEMORY_FOLDER,
  TEAM_MEMORY_MAX_BYTES,
  TEAM_MEMORY_MAX_PENDING,
  TEAM_MEMORY_PROPOSAL_DAYS,
  TeamMemoryProposeSchema,
  TeamMemoryReviewWriteSchema,
  TeamMemoryStatusSchema,
  roleCan,
  type TeamMemoryStatus,
} from "@thoth/workspace-protocol";
import { workspaceAccess, type WorkspaceAccess } from "../access.ts";
import { decodeCursor, encodeCursor } from "../cursor.ts";
import type { Queryable } from "../db.ts";
import type { Deps } from "../deps.ts";
import { ApiError, fieldError, jsonReply, zodFailure } from "../errors.ts";
import { audit, mutate, parseJsonBody, principalOf, send } from "../http.ts";
import { opaqueId } from "../ids.ts";
import { checkStorableText, limitFrom, loadCurrentRevision, loadPage, parsePageId, revisionSummary, writeRevision } from "../pages.ts";
import { assertCanCreatePages, quotaExceeded } from "../quota.ts";
import { HIDDEN, isHidden } from "../visibility.ts";

const DAY_MS = 86_400_000;
const KEEP_MS = TEAM_MEMORY_PROPOSAL_DAYS * DAY_MS;
/** The Team memory folder's page: a folder (ADR-0017) titled `TEAM_MEMORY_FOLDER`. */
const FOLDER_MARKDOWN = "---\nthoth_kind: folder\n---\n";

interface ProposalRow {
  id: string;
  author_id: string | null;
  author_name: string | null;
  agent: string;
  title: string;
  page_id: string | null;
  base_revision_id: string | null;
  markdown: string | null;
  status: "pending" | "applied" | "declined";
  created_at: Date;
  created_at_us: string;
  settled_at: Date | null;
  settled_by: string | null;
  settled_by_name: string | null;
  applied_revision_id: string | null;
}

const SELECT = `SELECT p.id, p.author_id, a.display_name AS author_name, p.agent, p.title, p.page_id, p.base_revision_id, p.markdown, p.status,
         p.created_at, (extract(epoch FROM p.created_at) * 1000000)::bigint::text AS created_at_us, p.settled_at, p.settled_by,
         s.display_name AS settled_by_name, p.applied_revision_id
    FROM memory_proposals p LEFT JOIN users a ON a.id = p.author_id LEFT JOIN users s ON s.id = p.settled_by`;

/** A pending one older than `TEAM_MEMORY_PROPOSAL_DAYS` days has expired. */
const statusOf = (row: Pick<ProposalRow, "status" | "created_at">, now: Date): TeamMemoryStatus =>
  row.status === "pending" && row.created_at.getTime() + KEEP_MS <= now.getTime() ? "expired" : row.status;

function resource(row: ProposalRow, now: Date) {
  const status = statusOf(row, now);
  return {
    id: row.id,
    status,
    agent: row.agent,
    authorId: row.author_id,
    authorName: row.author_name,
    title: row.title,
    pageId: row.page_id,
    baseRevision: row.base_revision_id,
    createdAt: row.created_at.toISOString(),
    expiresAt: status === "pending" ? new Date(row.created_at.getTime() + KEEP_MS).toISOString() : null,
    settledAt: row.settled_at?.toISOString() ?? null,
    settledBy: row.settled_by,
    settledByName: row.settled_by_name,
    appliedRevision: row.applied_revision_id,
  };
}

/** The Team memory folder: the oldest top-level page with that title, or undefined. */
async function folderOf(q: Queryable, workspaceId: string): Promise<string | undefined> {
  const { rows } = await q.query<{ id: string }>(
    "SELECT id FROM pages WHERE workspace_id = $1 AND parent_id IS NULL AND deleted_at IS NULL AND title = $2 ORDER BY created_at, id LIMIT 1",
    [workspaceId, TEAM_MEMORY_FOLDER],
  );
  return rows[0]?.id;
}

/** Whether `pageId` is below `folderId` (at any depth). */
async function inFolder(q: Queryable, workspaceId: string, pageId: string, folderId: string): Promise<boolean> {
  const { rowCount } = await q.query(
    `WITH RECURSIVE up(id, parent_id) AS (
       SELECT id, parent_id FROM pages WHERE workspace_id = $1 AND id = $2
       UNION
       SELECT p.id, p.parent_id FROM pages p JOIN up ON p.id = up.parent_id WHERE p.workspace_id = $1
     ) SELECT 1 FROM up WHERE parent_id = $3 LIMIT 1`,
    [workspaceId, pageId, folderId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The memory page `pageId` as `userId` may change it: not deleted, visible to them, in the Team memory folder, and
 * still at `baseRevision` (412 otherwise). The caller holds the workspace lock; the page row is locked.
 */
async function memoryPage(q: Queryable, ws: WorkspaceAccess, userId: string, pageId: string, baseRevision: string) {
  const notFound = () => new ApiError("not_found", "no such page in Team memory");
  const page = await loadPage(q, ws.id, pageId, { forUpdate: true });
  if (!page || page.deleted_at || (await isHidden(q, ws.id, userId, pageId))) throw notFound();
  const folder = await folderOf(q, ws.id);
  if (!folder || !(await inFolder(q, ws.id, pageId, folder))) throw notFound();
  if (page.current_revision_id !== baseRevision) {
    throw new ApiError("revision_conflict", "the memory changed since baseRevision", { currentRevision: revisionSummary(await loadCurrentRevision(q, page)) });
  }
  return page;
}

/** Writes a proposal as `userId` (their role was checked) and marks it applied. Returns the revision written. */
async function apply(q: Queryable, deps: Deps, ws: WorkspaceAccess, userId: string, row: Pick<ProposalRow, "id" | "title" | "page_id" | "base_revision_id" | "markdown">, now: Date): Promise<{ pageId: string; revisionId: string }> {
  const markdown = row.markdown!;
  let written: { pageId: string; revisionId: string };
  if (row.page_id !== null) {
    const page = await memoryPage(q, ws, userId, row.page_id, row.base_revision_id!);
    const { revision } = await writeRevision(q, { workspaceId: ws.id, pageId: page.id, input: { title: page.title, markdown }, userId, existing: page, now });
    written = { pageId: page.id, revisionId: revision.id };
  } else {
    let folder = await folderOf(q, ws.id);
    if (folder && (await isHidden(q, ws.id, userId, folder))) throw new ApiError("not_found", "the Team memory folder is not visible to you");
    await assertCanCreatePages(q, deps.config, ws.id, folder ? 1 : 2);
    if (!folder) {
      folder = newStableId(now.getTime());
      await writeRevision(q, { workspaceId: ws.id, pageId: folder, input: { title: TEAM_MEMORY_FOLDER, markdown: FOLDER_MARKDOWN, parentId: null }, userId, existing: undefined, now });
    }
    const pageId = newStableId(now.getTime());
    const { revision } = await writeRevision(q, { workspaceId: ws.id, pageId, input: { title: row.title, markdown, parentId: folder }, userId, existing: undefined, now });
    written = { pageId, revisionId: revision.id };
  }
  await q.query(
    "UPDATE memory_proposals SET status = 'applied', markdown = NULL, page_id = $2, settled_at = $3, settled_by = $4, applied_revision_id = $5 WHERE id = $1",
    [row.id, written.pageId, now, userId, written.revisionId],
  );
  return written;
}

/** A proposal the caller may see: their own (owners and managers: anyone's), about nothing hidden from them. */
async function visibleProposal(q: Queryable, ws: WorkspaceAccess, userId: string, id: string, options: { lock?: boolean } = {}): Promise<ProposalRow> {
  if (!OpaqueIdSchema.safeParse(id).success) throw new ApiError("not_found", "proposal not found");
  const { rows } = await q.query<ProposalRow>(`${SELECT} WHERE p.workspace_id = $1 AND p.id = $2 ${options.lock ? "FOR UPDATE OF p" : ""}`, [ws.id, id]);
  const row = rows[0];
  const mine = row?.author_id === userId;
  if (!row || (!mine && !roleCan(ws.role, "manage"))) throw new ApiError("not_found", "proposal not found");
  // Owners and managers see every page (ADR-0042); others see only their own proposals. A change names its page, which
  // stays hidden from whoever cannot see it. A new memory names no page: applying it into a hidden folder is 404.
  if (row.page_id && (await isHidden(q, ws.id, userId, row.page_id))) throw new ApiError("not_found", "proposal not found");
  return row;
}

/** Only a proposal that still waits can be applied or declined. */
function waiting(row: ProposalRow, now: Date): void {
  if (statusOf(row, now) !== "pending") throw new ApiError("not_found", "no such proposal waits for review");
}

async function reviewOf(q: Queryable, workspaceId: string): Promise<boolean> {
  return (await q.query<{ memory_review: boolean }>("SELECT memory_review FROM workspaces WHERE id = $1", [workspaceId])).rows[0]!.memory_review;
}

async function settings(q: Queryable, ws: WorkspaceAccess, userId: string) {
  const folder = await folderOf(q, ws.id);
  const visible = folder !== undefined && !(await isHidden(q, ws.id, userId, folder));
  return { review: await reviewOf(q, ws.id), folderId: visible ? folder : null };
}

/**
 * Capability `team-memory` (ADR-0052 rule 8): the setting, agents' memories as proposals the server keeps, and applying
 * or declining them. Writes take the workspace row lock like every write; applying is a page write by the caller.
 */
export function registerTeamMemoryRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config } = deps;
  const base = `${API_BASE_PATH}/workspaces/:workspaceId/team-memory`;
  type Ws = { workspaceId: string };
  type One = Ws & { proposalId: string };

  app.get<{ Params: Ws }>(base, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "read");
    return send(reply, jsonReply(200, await settings(db, ws, me.id)));
  });

  app.put<{ Params: Ws }>(`${base}/review`, (request, reply) =>
    mutate(deps, request, reply, async (tx) => {
      const me = principalOf(request);
      const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "manage", { lock: true });
      const parsed = TeamMemoryReviewWriteSchema.safeParse(parseJsonBody(request));
      if (!parsed.success) throw zodFailure(parsed.error);
      if (parsed.data.review !== (await reviewOf(tx, ws.id))) {
        await tx.query("UPDATE workspaces SET memory_review = $2 WHERE id = $1", [ws.id, parsed.data.review]);
        await audit(tx, { actorId: me.id, workspaceId: ws.id, action: "team_memory.review_changed", detail: { review: parsed.data.review } });
      }
      return jsonReply(200, await settings(tx, ws, me.id));
    }),
  );

  app.post<{ Params: Ws }>(
    `${base}/proposals`,
    { bodyLimit: TEAM_MEMORY_MAX_BYTES * 6 + 8192 },
    (request, reply) =>
      mutate(deps, request, reply, async (tx, _info, now) => {
        const me = principalOf(request);
        const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "write", { lock: true });
        const parsed = TeamMemoryProposeSchema.safeParse(parseJsonBody(request));
        if (!parsed.success) throw zodFailure(parsed.error);
        const input = parsed.data;
        const max = Math.min(TEAM_MEMORY_MAX_BYTES, config.maxMarkdownBytes);
        if (Buffer.byteLength(input.markdown, "utf8") > max) throw new ApiError("payload_too_large", `a memory is at most ${max} bytes`);
        checkStorableText(input.title, "/title");
        checkStorableText(input.markdown, "/markdown");
        // Checked now as well as when applied: a page outside Team memory or a stale version never waits for review.
        if (input.pageId !== undefined) await memoryPage(tx, ws, me.id, parsePageId(input.pageId), input.baseRevision!);
        const pending = (
          await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM memory_proposals WHERE workspace_id = $1 AND status = 'pending' AND created_at > $2", [ws.id, new Date(now.getTime() - KEEP_MS)])
        ).rows[0]!.n;
        if (pending >= TEAM_MEMORY_MAX_PENDING) throw quotaExceeded("teamMemoryPending", `${TEAM_MEMORY_MAX_PENDING} agents' memories already wait for review here: review some first`, { limit: TEAM_MEMORY_MAX_PENDING, current: pending });
        const id = opaqueId("mem");
        const row = { id, title: input.title, page_id: input.pageId ?? null, base_revision_id: input.baseRevision ?? null, markdown: input.markdown };
        await tx.query(
          "INSERT INTO memory_proposals (id, workspace_id, author_id, agent, title, page_id, base_revision_id, markdown, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)",
          [id, ws.id, me.id, input.agent, input.title, row.page_id, row.base_revision_id, row.markdown, now],
        );
        const review = await reviewOf(tx, ws.id);
        if (!review) await apply(tx, deps, ws, me.id, row, now);
        const saved = (await tx.query<ProposalRow>(`${SELECT} WHERE p.id = $1`, [id])).rows[0]!;
        return jsonReply(review ? 201 : 200, resource(saved, now));
      }),
  );

  app.get<{ Params: Ws; Querystring: { status?: string; cursor?: string; limit?: string } }>(`${base}/proposals`, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "write");
    const now = new Date();
    const limit = limitFrom(request.query.limit);
    const status = request.query.status;
    if (status !== undefined && !TeamMemoryStatusSchema.safeParse(status).success) throw new ApiError("validation_failed", "status must be pending, applied, declined or expired", fieldError("query:status", "invalid"));
    let after: [string, string] | null = null;
    if (request.query.cursor !== undefined) {
      const value = decodeCursor("m", ws.id, request.query.cursor);
      const at = value.indexOf(":");
      if (at < 1 || !/^\d{1,20}$/.test(value.slice(0, at))) throw new ApiError("cursor_invalid", "cursor does not decode");
      after = [value.slice(0, at), value.slice(at + 1)];
    }
    const cutoff = new Date(now.getTime() - KEEP_MS);
    const { rows } = await db.query<ProposalRow>(
      `${SELECT}
        WHERE p.workspace_id = $1 AND ($2::text IS NULL OR p.author_id = $2)
          AND (p.page_id IS NULL OR p.page_id NOT IN ${HIDDEN("$1", "$3")})
          AND ($4::text IS NULL
               OR ($4 = 'pending' AND p.status = 'pending' AND p.created_at > $5)
               OR ($4 = 'expired' AND p.status = 'pending' AND p.created_at <= $5)
               OR ($4 IN ('applied', 'declined') AND p.status = $4))
          AND ($6::bigint IS NULL OR (extract(epoch FROM p.created_at) * 1000000)::bigint < $6::bigint
               OR ((extract(epoch FROM p.created_at) * 1000000)::bigint = $6::bigint AND p.id < $7))
        ORDER BY p.created_at DESC, p.id DESC LIMIT $8`,
      [ws.id, roleCan(ws.role, "manage") ? null : me.id, me.id, status ?? null, cutoff, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
    );
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return send(reply, jsonReply(200, { items: items.map((r) => resource(r, now)), nextCursor: rows.length > limit && last ? encodeCursor("m", ws.id, `${last.created_at_us}:${last.id}`) : null }));
  });

  app.get<{ Params: One }>(`${base}/proposals/:proposalId`, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "read");
    const row = await visibleProposal(db, ws, me.id, request.params.proposalId);
    const now = new Date();
    return send(reply, jsonReply(200, { ...resource(row, now), markdown: statusOf(row, now) === "pending" ? row.markdown : null }));
  });

  app.post<{ Params: One }>(`${base}/proposals/:proposalId/apply`, (request, reply) =>
    mutate(deps, request, reply, async (tx, _info, now) => {
      const me = principalOf(request);
      // Applying is a page write: the author needs write still, as owners and managers have.
      const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "write", { lock: true });
      const row = await visibleProposal(tx, ws, me.id, request.params.proposalId, { lock: true });
      waiting(row, now);
      await apply(tx, deps, ws, me.id, row, now);
      return jsonReply(200, resource((await tx.query<ProposalRow>(`${SELECT} WHERE p.id = $1`, [row.id])).rows[0]!, now));
    }),
  );

  app.post<{ Params: One }>(`${base}/proposals/:proposalId/decline`, (request, reply) =>
    mutate(deps, request, reply, async (tx, _info, now) => {
      const me = principalOf(request);
      const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "read", { lock: true });
      const row = await visibleProposal(tx, ws, me.id, request.params.proposalId, { lock: true });
      waiting(row, now);
      await tx.query("UPDATE memory_proposals SET status = 'declined', markdown = NULL, settled_at = $2, settled_by = $3 WHERE id = $1", [row.id, now, me.id]);
      return jsonReply(200, resource((await tx.query<ProposalRow>(`${SELECT} WHERE p.id = $1`, [row.id])).rows[0]!, now));
    }),
  );
}
