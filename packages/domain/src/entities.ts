import { z } from "zod";
import { PageIdSchema } from "./ids.ts";

/** Core entities (spec §6.1). Schemas are the runtime-validated contract. */

export const SpaceKindSchema = z.enum(["private", "workspace"]);

export const SpaceSchema = z.object({
  id: z.string(),
  kind: SpaceKindSchema,
  name: z.string(),
});
export type Space = z.infer<typeof SpaceSchema>;

/** Provenance stored in frontmatter key `thoth_source` (ADR-003). */
export const ProvenanceSchema = z.object({
  system: z.enum(["notion", "obsidian", "workspace", "thoth"]),
  sourcePath: z.string().optional(),
  sourceId: z.string().optional(),
  importJobId: z.string().optional(),
  transferOperationId: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const ReferenceKindSchema = z.enum(["markdown-link", "image", "wikilink", "embed"]);
export type ReferenceKind = z.infer<typeof ReferenceKindSchema>;

export const ResolutionStateSchema = z.enum(["resolved", "unresolved", "ambiguous", "external"]);
export type ResolutionState = z.infer<typeof ResolutionStateSchema>;

export const ContentReferenceSchema = z.object({
  sourcePageId: PageIdSchema,
  kind: ReferenceKindSchema,
  /** The raw target text as written (wikilink target or URL-decoded link). */
  target: z.string(),
  fragment: z.string().optional(),
  resolution: ResolutionStateSchema,
  /** Resolved vault path when resolution is `resolved`. */
  targetPath: z.string().optional(),
  targetPageId: PageIdSchema.optional(),
  line: z.number().int().positive(),
});
export type ContentReference = z.infer<typeof ContentReferenceSchema>;

export const PageSummarySchema = z.object({
  id: PageIdSchema,
  path: z.string(),
  title: z.string(),
  contentHash: z.string(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  aliases: z.array(z.string()),
  tags: z.array(z.string()),
});
export type PageSummary = z.infer<typeof PageSummarySchema>;

export const AttachmentSchema = z.object({
  path: z.string(),
  hash: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/** Reserved for P3 (ADR-006); declared now so the journal schema is stable. */
export const TransferStateSchema = z.enum([
  "plan",
  "validate",
  "stage",
  "transfer",
  "verify",
  "commit_destination",
  "finalize_source",
  "done",
  "destination_committed_source_cleanup_pending",
  "failed",
  "aborted",
]);
export type TransferState = z.infer<typeof TransferStateSchema>;

export const ImportSourceKindSchema = z.enum(["notion-zip", "notion-folder", "obsidian-vault", "obsidian-zip"]);
export type ImportSourceKind = z.infer<typeof ImportSourceKindSchema>;

export const ImportJobStateSchema = z.enum([
  "scanned",
  "planned",
  "staging",
  "staged",
  "committing",
  "completed",
  "failed",
  "cancelled",
]);
export type ImportJobState = z.infer<typeof ImportJobStateSchema>;

export const ImportItemStateSchema = z.enum(["pending", "staged", "committed", "skipped", "failed"]);
export type ImportItemState = z.infer<typeof ImportItemStateSchema>;

export const WarningSeveritySchema = z.enum(["info", "warning", "error"]);

export const ImportWarningSchema = z.object({
  code: z.string(),
  severity: WarningSeveritySchema,
  message: z.string(),
  sourcePath: z.string().optional(),
  line: z.number().int().positive().optional(),
});
export type ImportWarning = z.infer<typeof ImportWarningSchema>;
