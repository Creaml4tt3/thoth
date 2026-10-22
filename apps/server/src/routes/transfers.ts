import type { FastifyInstance } from "fastify";
import { API_BASE_PATH, TransferCommitRequestSchema, TransferCreateRequestSchema, TransferOperationIdSchema, type ErrorCode, type TransferCreateRequest } from "@thoth/workspace-protocol";
import { requireRole, workspaceAccess, type WorkspaceAccess } from "../access.ts";
import type { Deps } from "../deps.ts";
import type { Queryable, Tx } from "../db.ts";
import { ApiError, fieldError, jsonReply, problemReply, zodFailure, type Reply } from "../errors.ts";
import { audit, mutate, parseJsonBody, principalOf, send } from "../http.ts";
import { checkStorableText, deletePage, loadPage, writeRevision } from "../pages.ts";

interface TransferRow {
  operation_id: string;
  workspace_id: string;
  user_id: string;
  direction: "to_workspace" | "from_workspace";
  mode: "copy" | "move";
  state: string;
  fingerprint: string;
  error_code: string | null;
  error_detail: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ItemRow {
  position: number;
  page_id: string;
  source_id: string | null;
  revision_id: string | null;
  state: string;
  error_code: string | null;
  parent_id: string | null;
  title: string | null;
  markdown: string | null;
}

const MAX_TRANSFER_PAGES = 5000;

async function resourceOf(q: Queryable, row: TransferRow) {
  const { rows } = await q.query<Pick<ItemRow, "page_id" | "source_id" | "revision_id" | "state" | "error_code">>("SELECT page_id, source_id, revision_id, state, error_code FROM transfer_items WHERE operation_id = $1 ORDER BY position", [row.operation_id]);
  return {
    operationId: row.operation_id,
    workspaceId: row.workspace_id,
    direction: row.direction,
    mode: row.mode,
    state: row.state,
    items: rows.map((i) => ({ pageId: i.page_id, ...(i.source_id === null ? {} : { sourceId: i.source_id }), revisionId: i.revision_id, state: i.state, ...(i.error_code === null ? {} : { error: i.error_code }) })),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    error: row.error_code === null ? null : { code: row.error_code, ...(row.error_detail === null ? {} : { detail: row.error_detail }) },
  };
}

function parseOperationId(raw: string): string {
  const parsed = TransferOperationIdSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError("validation_failed", "operationId must be a UUIDv7", fieldError("path:operationId", "expected UUIDv7"));
  return parsed.data;
}

/**
 * Loads a transfer the principal may see. A transfer of a workspace the principal is not a member of
 * is 404, exactly like one that does not exist. With `lock`, the workspace row and then the transfer row
 * are locked (always in that order, so concurrent commits cannot deadlock) and the transfer is re-read.
 */
async function transferFor(q: Queryable, operationId: string, userId: string, need: "read" | "write", options: { lock?: boolean } = {}): Promise<{ transfer: TransferRow; access: WorkspaceAccess }> {
  const first = (await q.query<TransferRow>("SELECT * FROM transfers WHERE operation_id = $1", [operationId])).rows[0];
  if (!first) throw new ApiError("not_found", "transfer not found");
  // Membership first (404), then the role the action needs (403). A non-member must not be able to tell a real
  // transfer from an unknown ID, so the 404 is word for word the same.
  const access = await workspaceAccess(q, first.workspace_id, userId, "read", { lock: options.lock === true }).catch((error: unknown) => {
    throw error instanceof ApiError && error.code === "not_found" ? new ApiError("not_found", "transfer not found") : error;
  });
  if (need === "write") requireRole(access, "write");
  const transfer = options.lock ? (await q.query<TransferRow>("SELECT * FROM transfers WHERE operation_id = $1 FOR UPDATE", [operationId])).rows[0]! : first;
  return { transfer, access };
}

/** Pages of a to_workspace plan must not form a parent cycle among themselves (their parents are staged or already in the workspace). */
function checkStagedTree(pages: { pageId: string; parentId: string | null }[]): void {
  const parentOf = new Map(pages.map((p) => [p.pageId, p.parentId]));
  for (const { pageId } of pages) {
    const seen = new Set<string>([pageId]);
    for (let at = parentOf.get(pageId) ?? null; at !== null; at = parentOf.get(at) ?? null) {
      if (seen.has(at)) throw new ApiError("validation_failed", "the staged pages contain a parent cycle", fieldError("/pages", "parent cycle"));
      seen.add(at);
    }
  }
}

export function registerTransferRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config } = deps;

  app.post<{ Params: { workspaceId: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/transfers`, { bodyLimit: config.maxTransferBytes }, (request, reply) =>
    mutate(deps, request, reply, async (tx, info, now) => {
      const me = principalOf(request);
      // Membership is checked before anything about the body is inspected.
      let ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "read");
      const parsed = TransferCreateRequestSchema.safeParse(parseJsonBody(request));
      if (!parsed.success) throw zodFailure(parsed.error);
      const plan: TransferCreateRequest = parsed.data;
      if (request.headers["idempotency-key"] !== plan.operationId) throw new ApiError("validation_failed", "Idempotency-Key is required and must equal the body operationId", fieldError("header:Idempotency-Key", "must equal operationId"));
      const needed = plan.direction === "to_workspace" || plan.mode === "move" ? "write" : "read";
      requireRole(ws, needed);
      if (needed === "write") ws = await workspaceAccess(tx, ws.id, me.id, "write", { lock: true });

      // The operationId is global (GET /transfers/{id} has no workspace). One that exists is the same request only
      // for the same principal, workspace and request; for anyone else it answers 422 without saying more.
      const existing = (await tx.query<TransferRow>("SELECT * FROM transfers WHERE operation_id = $1", [plan.operationId])).rows[0];
      if (existing) {
        if (existing.user_id !== me.id || existing.workspace_id !== ws.id || existing.fingerprint !== info.fingerprint) throw new ApiError("idempotency_key_reused", "operationId was already used");
        return jsonReply(201, await resourceOf(tx, existing), { location: `${API_BASE_PATH}/transfers/${plan.operationId}` });
      }

      let items: { pageId: string; sourceId: string | null; revisionId: string | null; parentId: string | null; title: string | null; markdown: string | null }[];
      if (plan.direction === "to_workspace") {
        if (plan.pages.length > MAX_TRANSFER_PAGES) throw new ApiError("payload_too_large", `a transfer carries at most ${MAX_TRANSFER_PAGES} pages`);
        const ids = plan.pages.map((p) => p.pageId);
        if (new Set(ids).size !== ids.length) throw new ApiError("validation_failed", "pageId values must be unique", fieldError("/pages", "duplicate pageId"));
        for (const [i, p] of plan.pages.entries()) {
          if (p.parentId === p.pageId) throw new ApiError("validation_failed", "a page cannot be its own parent", fieldError(`/pages/${i}/parentId`, "self parent"));
          if (Buffer.byteLength(p.markdown, "utf8") > config.maxMarkdownBytes) throw new ApiError("payload_too_large", `markdown of pages[${i}] exceeds ${config.maxMarkdownBytes} bytes`);
          checkStorableText(p.title, `/pages/${i}/title`);
          checkStorableText(p.markdown, `/pages/${i}/markdown`);
          checkStorableText(p.sourceId, `/pages/${i}/sourceId`);
        }
        checkStagedTree(plan.pages);
        const taken = await tx.query("SELECT 1 FROM pages WHERE workspace_id = $1 AND id = ANY($2::uuid[]) LIMIT 1", [ws.id, ids]);
        if ((taken.rowCount ?? 0) > 0) throw new ApiError("validation_failed", "pageId values must be new in the workspace", fieldError("/pages", "a pageId already exists"));
        if (plan.attachmentIds?.length) {
          const known = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM attachments WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [ws.id, [...new Set(plan.attachmentIds)]]);
          if (known.rows[0]!.n !== new Set(plan.attachmentIds).size) throw new ApiError("validation_failed", "attachmentIds must name attachments uploaded to this workspace", fieldError("/attachmentIds", "unknown attachment"));
        }
        items = plan.pages.map((p) => ({ pageId: p.pageId, sourceId: p.sourceId, revisionId: null, parentId: p.parentId, title: p.title, markdown: p.markdown }));
      } else {
        if (plan.pages.length > MAX_TRANSFER_PAGES) throw new ApiError("payload_too_large", `a transfer carries at most ${MAX_TRANSFER_PAGES} pages`);
        const ids = plan.pages.map((p) => p.pageId);
        if (new Set(ids).size !== ids.length) throw new ApiError("validation_failed", "pageId values must be unique", fieldError("/pages", "duplicate pageId"));
        if (ws.exportRestricted) {
          // Recorded outside the transaction: the rejection rolls the transaction back, the audit event must survive (ADR-0009).
          await audit(db, { actorId: me.id, workspaceId: ws.id, action: "export.refused", detail: { operationId: plan.operationId, mode: plan.mode } }).catch(() => undefined);
          throw new ApiError("export_restricted", "this workspace forbids exporting content");
        }
        const pinned = await tx.query<{ id: string; current_revision_id: string }>("SELECT id, current_revision_id FROM pages WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL", [ws.id, ids]);
        const byId = new Map(pinned.rows.map((r) => [r.id, r.current_revision_id]));
        items = ids.map((id) => {
          const revisionId = byId.get(id);
          if (!revisionId) throw new ApiError("not_found", `page ${id} not found`);
          return { pageId: id, sourceId: null, revisionId, parentId: null, title: null, markdown: null };
        });
      }

      await tx.query(
        `INSERT INTO transfers (operation_id, workspace_id, user_id, direction, mode, state, fingerprint, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'stage', $6, $7, $7)`,
        [plan.operationId, ws.id, me.id, plan.direction, plan.mode, info.fingerprint, now],
      );
      for (const [position, item] of items.entries()) {
        await tx.query("INSERT INTO transfer_items (operation_id, position, page_id, source_id, revision_id, state, parent_id, title, markdown) VALUES ($1, $2, $3, $4, $5, 'staged', $6, $7, $8)", [plan.operationId, position, item.pageId, item.sourceId, item.revisionId, item.parentId, item.title, item.markdown]);
      }
      await audit(tx, { actorId: me.id, workspaceId: ws.id, action: "transfer.created", detail: { operationId: plan.operationId, direction: plan.direction, mode: plan.mode, pages: items.length } });
      const row = (await tx.query<TransferRow>("SELECT * FROM transfers WHERE operation_id = $1", [plan.operationId])).rows[0]!;
      return jsonReply(201, await resourceOf(tx, row), { location: `${API_BASE_PATH}/transfers/${plan.operationId}` });
    }),
  );

  app.get<{ Params: { operationId: string } }>(`${API_BASE_PATH}/transfers/:operationId`, async (request, reply) => {
    const me = principalOf(request);
    const { transfer } = await transferFor(db, parseOperationId(request.params.operationId), me.id, "read");
    return send(reply, jsonReply(200, await resourceOf(db, transfer)));
  });

  app.post<{ Params: { operationId: string } }>(`${API_BASE_PATH}/transfers/:operationId/commit`, (request, reply) =>
    mutate(deps, request, reply, async (tx, _info, now) => {
      const me = principalOf(request);
      const operationId = parseOperationId(request.params.operationId);
      const peek = await transferFor(tx, operationId, me.id, "read");
      const needed = peek.transfer.direction === "to_workspace" || peek.transfer.mode === "move" ? "write" : "read";
      const { transfer, access } = await transferFor(tx, operationId, me.id, needed, { lock: true });
      if (transfer.state === "aborted" || transfer.state === "failed") throw new ApiError("invalid_transfer_state", `transfer is ${transfer.state}`);
      if (transfer.state === "done" || transfer.state === "destination_committed_source_cleanup_pending") return jsonReply(200, await resourceOf(tx, transfer));
      const body = TransferCommitRequestSchema.safeParse(parseJsonBody(request, { optional: true }));
      if (!body.success) throw zodFailure(body.error);
      const items = (await tx.query<ItemRow>("SELECT * FROM transfer_items WHERE operation_id = $1 ORDER BY position", [operationId])).rows;
      const setItem = (position: number, state: string, revisionId: string | null, errorCode: ErrorCode | null) =>
        tx.query("UPDATE transfer_items SET state = $3, revision_id = $4, error_code = $5, markdown = CASE WHEN $3 = 'committed' THEN NULL ELSE markdown END WHERE operation_id = $1 AND position = $2", [operationId, position, state, revisionId, errorCode]);
      const finish = async (state: string, error?: { code: ErrorCode; detail: string }) => {
        await tx.query("UPDATE transfers SET state = $2, updated_at = $3, error_code = $4, error_detail = $5 WHERE operation_id = $1", [operationId, state, now, error?.code ?? null, error?.detail ?? null]);
        return (await tx.query<TransferRow>("SELECT * FROM transfers WHERE operation_id = $1", [operationId])).rows[0]!;
      };

      if (transfer.direction === "to_workspace") {
        // COMMIT_DESTINATION: all pages or none, in this one transaction, under the workspace lock.
        const taken = await tx.query<{ id: string }>("SELECT id FROM pages WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [access.id, items.map((i) => i.page_id)]);
        if (taken.rows.length > 0) {
          for (const item of items) await setItem(item.position, "failed", null, "validation_failed");
          await tx.query("UPDATE transfer_items SET markdown = NULL WHERE operation_id = $1", [operationId]);
          await finish("failed", { code: "validation_failed", detail: "a pageId was taken in the workspace after the transfer was staged" });
          await audit(tx, { actorId: me.id, workspaceId: access.id, action: "transfer.failed", detail: { operationId, reason: "destination_collision" } });
          // The failure is recorded (this reply commits the transaction) and reported as a conflict.
          return problemReply(new ApiError("invalid_transfer_state", "a pageId was taken in the workspace after the transfer was staged; the transfer failed and nothing was published"), request.id);
        }
        for (const item of items) {
          const { revision } = await writeRevision(tx, { workspaceId: access.id, pageId: item.page_id, input: { title: item.title!, markdown: item.markdown!, parentId: item.parent_id }, userId: transfer.user_id, existing: undefined, now });
          await setItem(item.position, "committed", revision.id, null);
        }
        await audit(tx, { actorId: me.id, workspaceId: access.id, action: "transfer.committed", detail: { operationId, direction: "to_workspace", pages: items.length } });
        return jsonReply(200, await resourceOf(tx, await finish("done")));
      }

      // from_workspace: the client has committed and verified the destination. Nothing is deleted before this.
      const verified = body.data.verified ?? [];
      const pinned = new Map(items.map((i) => [i.page_id, i.revision_id]));
      const seen = new Set<string>();
      for (const [i, v] of verified.entries()) {
        const bad = (detail: string) => new ApiError("validation_failed", detail, fieldError(`/verified/${i}`, detail));
        if (!pinned.has(v.pageId)) throw bad(`page ${v.pageId} is not part of this transfer`);
        if (seen.has(v.pageId)) throw bad(`page ${v.pageId} is verified twice`);
        seen.add(v.pageId);
        if (pinned.get(v.pageId) !== v.revisionId) throw bad(`verified revision of ${v.pageId} does not match the pinned revision`);
        const hash = await tx.query<{ content_hash: string }>("SELECT content_hash FROM page_revisions WHERE workspace_id = $1 AND page_id = $2 AND id = $3", [access.id, v.pageId, v.revisionId]);
        if (hash.rows[0]?.content_hash !== v.contentHash) throw bad(`verified contentHash of ${v.pageId} does not match the pinned revision`);
      }
      if (transfer.mode === "copy") {
        for (const item of items) await setItem(item.position, "committed", item.revision_id, null);
        await audit(tx, { actorId: me.id, workspaceId: access.id, action: "export.committed", detail: { operationId, mode: "copy", pages: items.length } });
        return jsonReply(200, await resourceOf(tx, await finish("done")));
      }
      if (items.some((i) => !seen.has(i.page_id))) throw new ApiError("validation_failed", "a move commit must verify every item", fieldError("/verified", "every item must be verified"));
      let cleanupFailed = false;
      for (const item of items) {
        // FINALIZE_SOURCE: delete only the exact revision the client verified.
        const page = await loadPage(tx, access.id, item.page_id, { forUpdate: true });
        if (page && !page.deleted_at && page.current_revision_id === item.revision_id) {
          await deletePage(tx, access.id, item.page_id, me.id, now);
          await setItem(item.position, "committed", item.revision_id, null);
        } else {
          await setItem(item.position, "failed", item.revision_id, "revision_conflict");
          cleanupFailed = true;
        }
      }
      await audit(tx, { actorId: me.id, workspaceId: access.id, action: "export.committed", detail: { operationId, mode: "move", pages: items.length, cleanupPending: cleanupFailed } });
      return jsonReply(200, await resourceOf(tx, await finish(cleanupFailed ? "destination_committed_source_cleanup_pending" : "done")));
    }),
  );

  app.post<{ Params: { operationId: string } }>(`${API_BASE_PATH}/transfers/:operationId/abort`, (request, reply) =>
    mutate(deps, request, reply, async (tx: Tx, _info, now): Promise<Reply> => {
      const me = principalOf(request);
      const operationId = parseOperationId(request.params.operationId);
      const peek = await transferFor(tx, operationId, me.id, "read");
      const needed = peek.transfer.direction === "to_workspace" || peek.transfer.mode === "move" ? "write" : "read";
      const { transfer, access } = await transferFor(tx, operationId, me.id, needed, { lock: true });
      if (transfer.state === "aborted") return jsonReply(200, await resourceOf(tx, transfer));
      if (transfer.state === "done" || transfer.state === "destination_committed_source_cleanup_pending") throw new ApiError("invalid_transfer_state", "a committed transfer cannot be aborted");
      // Discard staged content, keep the record.
      await tx.query("UPDATE transfer_items SET state = 'skipped', markdown = NULL, title = NULL WHERE operation_id = $1", [operationId]);
      await tx.query("UPDATE transfers SET state = 'aborted', updated_at = $2 WHERE operation_id = $1", [operationId, now]);
      await audit(tx, { actorId: me.id, workspaceId: access.id, action: "transfer.aborted", detail: { operationId } });
      const row = (await tx.query<TransferRow>("SELECT * FROM transfers WHERE operation_id = $1", [operationId])).rows[0]!;
      return jsonReply(200, await resourceOf(tx, row));
    }),
  );
}
