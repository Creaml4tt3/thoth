import { z } from "zod";
import { CursorSchema, LimitSchema, OpaqueIdSchema, RevisionIdSchema, TimestampSchema, WorkspaceIdSchema } from "./common.ts";
import { PageIdSchema } from "./pages.ts";
import { AttachmentIdSchema } from "./attachments.ts";

export const KNOWN_CHANGE_KINDS = ["page.created", "page.updated", "page.deleted", "attachment.created"] as const;
export type KnownChangeKind = (typeof KNOWN_CHANGE_KINDS)[number];

/** A registered change kind, or a vendor kind prefixed `x-`. Clients MUST ignore kinds they do not know. */
export const ChangeKindSchema = z.union([z.enum(KNOWN_CHANGE_KINDS), z.string().regex(/^x-[a-z0-9]+(?:[._-][a-z0-9]+)*$/)]);

/**
 * One entry of the change feed. Entries identify what changed; clients fetch the
 * resource to read content. Per kind:
 *
 * - `page.created`, `page.updated`: `pageId` and `revisionId` (the new revision) are present.
 * - `page.deleted`: `pageId` is present; `revisionId` is absent.
 * - `attachment.created`: `attachmentId` is present.
 */
export const ChangeEntrySchema = z
  .object({
    /** Unique within the workspace for the lifetime of the feed. */
    id: OpaqueIdSchema,
    kind: ChangeKindSchema,
    occurredAt: TimestampSchema,
    actorId: OpaqueIdSchema.nullable(),
    pageId: PageIdSchema.optional(),
    revisionId: RevisionIdSchema.optional(),
    parentId: PageIdSchema.nullable().optional(),
    title: z.string().optional(),
    attachmentId: AttachmentIdSchema.optional(),
  })
  .superRefine((entry, ctx) => {
    const need = (field: "pageId" | "revisionId" | "attachmentId") => {
      if (entry[field] === undefined) ctx.addIssue({ code: "custom", path: [field], message: `${entry.kind} requires ${field}` });
    };
    if (entry.kind === "page.created" || entry.kind === "page.updated") {
      need("pageId");
      need("revisionId");
    } else if (entry.kind === "page.deleted") need("pageId");
    else if (entry.kind === "attachment.created") need("attachmentId");
  });
export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;

export const ChangesQuerySchema = z.object({
  /** Omitted: start at the beginning of the retained feed. */
  cursor: CursorSchema.optional(),
  limit: LimitSchema.optional(),
});

/**
 * One page of the change feed. `cursor` is the position after the last returned entry
 * (or the request cursor when no entries were returned); pass it back to continue.
 * `hasMore` is true when more entries are available right now.
 */
export const ChangesResponseSchema = z.object({
  entries: z.array(ChangeEntrySchema).describe("Changes after the request cursor, oldest first."),
  cursor: CursorSchema.describe("Opaque position after the last returned entry. Pass it back as `cursor` to continue."),
  hasMore: z.boolean().describe("True when more entries are available now; read until false."),
});
export type ChangesResponse = z.infer<typeof ChangesResponseSchema>;

/** SSE `event:` name used by `GET .../events`. */
export const SSE_EVENT_NAME = "changes" as const;

/**
 * Payload of the SSE `data:` line. It is only a hint that changes exist: it carries no
 * page content and no entries. Clients MUST fetch `GET .../changes` from their own
 * stored cursor. `cursor`, if present, is the feed head when the event was emitted.
 */
export const ChangeHintEventSchema = z.object({
  type: z.literal("changes.available"),
  workspaceId: WorkspaceIdSchema,
  cursor: CursorSchema.optional(),
});
export type ChangeHintEvent = z.infer<typeof ChangeHintEventSchema>;
