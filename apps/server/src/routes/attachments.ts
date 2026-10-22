import type { FastifyInstance } from "fastify";
import { newStableId } from "@thoth/domain";
import { API_BASE_PATH, AttachmentIdSchema, UploadAttachmentQuerySchema } from "@thoth/workspace-protocol";
import { workspaceAccess } from "../access.ts";
import { appendChange } from "../changes.ts";
import type { Deps } from "../deps.ts";
import { ApiError, fieldError, jsonReply, zodFailure } from "../errors.ts";
import { bodyOf, headerOf, mutate, principalOf } from "../http.ts";
import { checkStorableText, sha256Hex } from "../pages.ts";
import { assertAttachmentFits } from "../quota.ts";

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

interface AttachmentRow {
  id: string;
  workspace_id: string;
  hash: string;
  size: number;
  mime_type: string;
  file_name: string | null;
  created_at: Date;
  created_by: string | null;
}

export const attachmentResource = (row: AttachmentRow) => ({
  id: row.id,
  workspaceId: row.workspace_id,
  hash: row.hash,
  size: row.size,
  mimeType: row.mime_type,
  ...(row.file_name === null ? {} : { fileName: row.file_name }),
  createdAt: row.created_at.toISOString(),
  createdBy: row.created_by,
});

export function registerAttachmentRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, blobs, config } = deps;

  app.post<{ Params: { workspaceId: string }; Querystring: Record<string, string> }>(
    `${API_BASE_PATH}/workspaces/:workspaceId/attachments`,
    { bodyLimit: config.maxAttachmentBytes },
    (request, reply) =>
      mutate(deps, request, reply, async (tx, _info, now) => {
        const me = principalOf(request);
        const ws = await workspaceAccess(tx, request.params.workspaceId, me.id, "write", { lock: true });
        const query = UploadAttachmentQuerySchema.safeParse(request.query);
        if (!query.success) throw zodFailure(query.error, "query");
        const declared = headerOf(request, "content-type");
        const mime = declared?.split(";")[0]?.trim().toLowerCase();
        if (!mime || !MIME.test(mime)) throw new ApiError("unsupported_media_type", "Content-Type must be a valid media type; it is stored as the attachment MIME type");
        const bytes = bodyOf(request);
        if (bytes.length === 0) throw new ApiError("validation_failed", "an attachment cannot be empty", fieldError("body", "empty upload"));
        if (bytes.length > config.maxAttachmentBytes) throw new ApiError("payload_too_large", `attachment exceeds ${config.maxAttachmentBytes} bytes`);
        if (query.data.fileName !== undefined) checkStorableText(query.data.fileName, "query:fileName");
        // Quotas are checked before any byte is stored, under the workspace lock, so a rejected upload writes nothing.
        await assertAttachmentFits(tx, config, ws.id, sha256Hex(bytes), bytes.length);
        // Content-addressed and idempotent. The Postgres store joins `tx` (rollback removes the blob too); if the
        // transaction rolls back the filesystem store leaves an unreferenced, harmless blob (README, deviation 8).
        const stored = await blobs.put(bytes, tx);
        const id = newStableId();
        const { rows } = await tx.query<AttachmentRow>(
          `INSERT INTO attachments (workspace_id, id, hash, size, mime_type, file_name, created_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [ws.id, id, stored.hash, stored.size, mime, query.data.fileName ?? null, now, me.id],
        );
        await appendChange(tx, ws.id, { kind: "attachment.created", actorId: me.id, attachmentId: id }, now);
        return jsonReply(201, attachmentResource(rows[0]!), { location: `${API_BASE_PATH}/workspaces/${ws.id}/attachments/${id}` });
      }),
  );

  app.get<{ Params: { workspaceId: string; attachmentId: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/attachments/:attachmentId`, async (request, reply) => {
    const me = principalOf(request);
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "read");
    if (!AttachmentIdSchema.safeParse(request.params.attachmentId).success) throw new ApiError("validation_failed", "attachmentId must be a UUIDv7", fieldError("path:attachmentId", "expected UUIDv7"));
    // Keyed by (workspace, id): an attachment of another workspace is simply not found here.
    const { rows } = await db.query<AttachmentRow>("SELECT * FROM attachments WHERE workspace_id = $1 AND id = $2", [ws.id, request.params.attachmentId]);
    const row = rows[0];
    const blob = row ? await blobs.open(row.hash) : null;
    if (!row || !blob) throw new ApiError("not_found", "attachment not found");
    // User-supplied bytes are served from the API origin: never let a browser render or sniff them as a page.
    reply
      .code(200)
      .header("content-type", row.mime_type)
      .header("content-length", String(blob.size))
      .header("content-disposition", "attachment")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'");
    return reply.send(blob.stream);
  });
}
