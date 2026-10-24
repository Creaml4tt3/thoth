import { z } from "zod";
import { StableIdSchema } from "@thoth/domain";
import { OpaqueIdSchema, RevisionIdSchema, Sha256HexSchema, TimestampSchema, WorkspaceIdSchema, paginated, PaginationQuerySchema } from "./common.ts";

/** Page IDs on the wire are UUIDv7 logical IDs chosen by the client (ADR-0003). */
export const PageIdSchema = StableIdSchema;
export type PageId = z.infer<typeof PageIdSchema>;

export const PAGE_TITLE_MAX = 500;

/**
 * Sibling sort key (capability `page-order`): an opaque fractional index chosen by the client. Siblings are
 * ordered by comparing keys as byte strings (ASCII order, never locale order). Pages without a position come
 * after the positioned ones, A-Z by title; ties fall back to title, then id.
 */
export const PagePositionSchema = z
  .string()
  .regex(/^[0-9A-Za-z]{1,128}$/, "Expected 1-128 characters from [0-9A-Za-z]")
  .describe("Opaque fractional-index sort key among siblings, compared as a byte string (capability page-order).");
export type PagePosition = z.infer<typeof PagePositionSchema>;

/**
 * Page kind (capability `page-kind`, ADR-0017): `folder` for a page whose frontmatter says `thoth_kind: folder`
 * (ADR-0016 rule 3), `page` for any other. Servers derive it from the Markdown on every write; clients never send
 * it. Absent or `null` means unknown, which clients treat as a page.
 */
export const PAGE_KINDS = ["page", "folder"] as const;
export const PageKindSchema = z.enum(PAGE_KINDS).describe("Kind of page (capability page-kind): a folder page or an ordinary page. Absent or null means unknown, treated as a page.");
export type PageKind = z.infer<typeof PageKindSchema>;

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
  /** Sibling sort key; absent or null when the page has none (or the server does not support `page-order`). */
  position: PagePositionSchema.nullable().optional(),
  /** Kind of the revision returned, derived by the server from frontmatter `thoth_kind` (capability `page-kind`); absent or null when unknown. */
  kind: PageKindSchema.nullable().optional(),
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
  /**
   * Sibling sort key (capability `page-order`). On create: omitted means none. On update: omitted keeps the
   * current position, `null` clears it. A server without `page-order` ignores it.
   */
  position: PagePositionSchema.nullable().optional(),
});
export type PageWrite = z.infer<typeof PageWriteSchema>;

/**
 * Body of `POST .../pages/{pageId}/move` (capability `page-order`): a metadata-only change of parent and/or
 * position. No new revision is created. Omitted members are unchanged; `null` moves to the root or clears the
 * position. At least one member is required.
 */
export const PageMoveSchema = z
  .object({
    parentId: PageIdSchema.nullable().optional(),
    position: PagePositionSchema.nullable().optional(),
  })
  .refine((m) => m.parentId !== undefined || m.position !== undefined, { message: "parentId or position is required" });
export type PageMove = z.infer<typeof PageMoveSchema>;

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
