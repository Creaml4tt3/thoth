import { z } from "zod";
import { AttachmentSchema } from "@thoth/domain";
import { OpaqueIdSchema, Sha256HexSchema, TimestampSchema, WorkspaceIdSchema } from "./common.ts";
import { PageIdSchema } from "./pages.ts";

/** Attachment IDs are server-assigned UUIDv7 values. */
export const AttachmentIdSchema = PageIdSchema;

/**
 * An uploaded attachment. Derives from the domain `Attachment` (hash, size, mimeType);
 * the local-only vault `path` is replaced by a server `id` and optional `fileName`.
 */
export const AttachmentResourceSchema = AttachmentSchema.omit({ path: true }).extend({
  id: AttachmentIdSchema,
  workspaceId: WorkspaceIdSchema,
  /** SHA-256 of the uploaded bytes. */
  hash: Sha256HexSchema,
  fileName: z.string().optional(),
  createdAt: TimestampSchema,
  createdBy: OpaqueIdSchema.nullable(),
});
export type AttachmentResource = z.infer<typeof AttachmentResourceSchema>;

/** Query of the upload route. The body is the raw bytes; `Content-Type` is the MIME type. */
export const UploadAttachmentQuerySchema = z.object({
  fileName: z.string().min(1).max(255).optional(),
});
