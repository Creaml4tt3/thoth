import { z } from "zod";
import { StableIdSchema } from "@thoth/domain";
import { OpaqueIdSchema, RevisionIdSchema, Sha256HexSchema, TimestampSchema, WorkspaceIdSchema, paginated, PaginationQuerySchema } from "./common.ts";

/** Page IDs on the wire are UUIDv7 logical IDs chosen by the client (ADR-0003). */
export const PageIdSchema = StableIdSchema;
export type PageId = z.infer<typeof PageIdSchema>;

export const PAGE_TITLE_MAX = 500;

/** One immutable revision (ADR-0005). Revisions are never modified after creation. */
export const RevisionSummarySchema = z.object({
  id: RevisionIdSchema,
  pageId: PageIdSchema,
  /** The revision this one was written on top of; `null` for the first revision. */
  parentId: RevisionIdSchema.nullable().describe("The previous revision of the same page; null for the first revision."),
  createdAt: TimestampSchema,
  authorId: OpaqueIdSchema.nullable(),
  title: z.string(),
  /** UTF-8 byte length of `markdown`. */
  size: z.number().int().nonnegative(),
  /** SHA-256 of the UTF-8 bytes of `markdown`. */
  contentHash: Sha256HexSchema.describe("Lower-case hex SHA-256 of the UTF-8 bytes of the Markdown source."),
});
export type RevisionSummary = z.infer<typeof RevisionSummarySchema>;

export const PageMetadataSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  parentId: PageIdSchema.nullable(),
  title: z.string(),
  createdAt: TimestampSchema,
  createdBy: OpaqueIdSchema.nullable(),
  updatedAt: TimestampSchema,
  updatedBy: OpaqueIdSchema.nullable(),
});
export type PageMetadata = z.infer<typeof PageMetadataSchema>;

/** A page: Markdown source as wire content (ADR-0001), the revision it belongs to, and metadata. */
export const PageResourceSchema = z.object({
  id: PageIdSchema,
  /** Full Markdown source including any frontmatter. Opaque to the protocol. */
  markdown: z.string().describe("Full Markdown source of this revision, including any frontmatter, byte-for-byte."),
  revision: RevisionSummarySchema,
  metadata: PageMetadataSchema,
});
export type PageResource = z.infer<typeof PageResourceSchema>;

/** Body of `PUT .../pages/{pageId}` (create or update). */
export const PageWriteSchema = z.object({
  title: z.string().min(1).max(PAGE_TITLE_MAX),
  markdown: z.string(),
  /**
   * Parent page. On create: omitted means root. On update: omitted keeps the current
   * parent, `null` moves the page to the root.
   */
  parentId: PageIdSchema.nullable().optional(),
});
export type PageWrite = z.infer<typeof PageWriteSchema>;

export const GetPageQuerySchema = z.object({
  /** Return the page as of this revision instead of the current one. */
  revision: RevisionIdSchema.optional(),
});

export const RevisionListSchema = paginated(RevisionSummarySchema);
export type RevisionList = z.infer<typeof RevisionListSchema>;
export const RevisionListQuerySchema = PaginationQuerySchema;

/** Problem body for HTTP 412 `revision_conflict`. Carries the revision that is current on the server. */
export const RevisionConflictProblemSchema = z.looseObject({
  type: z.string().min(1),
  title: z.string(),
  status: z.literal(412),
  code: z.literal("revision_conflict"),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  currentRevision: RevisionSummarySchema.describe("The revision that was current when the conditional write was evaluated."),
});
export type RevisionConflictProblem = z.infer<typeof RevisionConflictProblemSchema>;
