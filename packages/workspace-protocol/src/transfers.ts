import { z } from "zod";
import { ImportItemStateSchema, TransferStateSchema } from "@thoth/domain";
import { RevisionIdSchema, Sha256HexSchema, TimestampSchema, WorkspaceIdSchema } from "./common.ts";
import { ProblemCodeSchema } from "./errors.ts";
import { AttachmentIdSchema } from "./attachments.ts";
import { PAGE_TITLE_MAX, PageIdSchema } from "./pages.ts";

export const TransferDirectionSchema = z.enum(["to_workspace", "from_workspace"]);
export type TransferDirection = z.infer<typeof TransferDirectionSchema>;

export const TransferModeSchema = z.enum(["copy", "move"]);
export type TransferMode = z.infer<typeof TransferModeSchema>;

/** Page content staged by the client for a Private to Workspace transfer. */
export const TransferStagedPageSchema = z.object({
  /** Identifier of the page on the client side (for example its vault page ID); echoed back in the mapping. */
  sourceId: z.string().min(1),
  /** Logical ID the page receives in the workspace. Copy: fresh UUIDv7. Move: the preserved ID. */
  pageId: PageIdSchema,
  parentId: PageIdSchema.nullable(),
  title: z.string().min(1).max(PAGE_TITLE_MAX),
  markdown: z.string(),
});

const OperationIdSchema = PageIdSchema;
export const TransferOperationIdSchema = OperationIdSchema;

/** Body of `POST /workspaces/{workspaceId}/transfers`. The workspace is the destination or the source depending on `direction`. */
export const TransferCreateRequestSchema = z.discriminatedUnion("direction", [
  z.object({
    /** Client-generated UUIDv7. MUST equal the Idempotency-Key header (ADR-0006). */
    operationId: OperationIdSchema.describe("Client-generated UUIDv7. Must equal the Idempotency-Key header."),
    direction: z.literal("to_workspace"),
    mode: TransferModeSchema,
    pages: z.array(TransferStagedPageSchema).min(1),
    /** Attachments already uploaded to this workspace that belong to the transfer. */
    attachmentIds: z.array(AttachmentIdSchema).optional(),
  }),
  z.object({
    operationId: OperationIdSchema,
    direction: z.literal("from_workspace"),
    mode: TransferModeSchema,
    pages: z.array(z.object({ pageId: PageIdSchema })).min(1),
  }),
]);
export type TransferCreateRequest = z.infer<typeof TransferCreateRequestSchema>;

/** What the client verified at the destination (from_workspace). Required to finalize a move. */
export const TransferVerifiedItemSchema = z.object({
  pageId: PageIdSchema,
  revisionId: RevisionIdSchema,
  contentHash: Sha256HexSchema,
});

/** Optional body of `POST /transfers/{operationId}/commit`. */
export const TransferCommitRequestSchema = z.object({
  verified: z.array(TransferVerifiedItemSchema).optional(),
});
export type TransferCommitRequest = z.infer<typeof TransferCommitRequestSchema>;

export const TransferItemSchema = z.object({
  pageId: PageIdSchema,
  /** to_workspace: the client `sourceId`. */
  sourceId: z.string().optional(),
  /** from_workspace: the pinned source revision. to_workspace: the created revision once committed. */
  revisionId: RevisionIdSchema.nullable(),
  state: ImportItemStateSchema,
  error: ProblemCodeSchema.optional(),
});
export type TransferItem = z.infer<typeof TransferItemSchema>;

/**
 * A transfer as recorded by the server. Only these states are reported by servers:
 * `stage`, `commit_destination`, `finalize_source`, `done`,
 * `destination_committed_source_cleanup_pending`, `failed`, `aborted`.
 * The earlier client-side states (`plan`, `validate`, `transfer`, `verify`) exist in
 * `TransferStateSchema` for the client journal (ADR-0006).
 */
export const TransferResourceSchema = z.object({
  operationId: OperationIdSchema,
  workspaceId: WorkspaceIdSchema,
  direction: TransferDirectionSchema,
  mode: TransferModeSchema,
  state: TransferStateSchema,
  items: z.array(TransferItemSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  error: z.object({ code: ProblemCodeSchema, detail: z.string().optional() }).nullable(),
});
export type TransferResource = z.infer<typeof TransferResourceSchema>;

export const SERVER_TRANSFER_STATES = [
  "stage",
  "commit_destination",
  "finalize_source",
  "done",
  "destination_committed_source_cleanup_pending",
  "failed",
  "aborted",
] as const;
