import { z } from "zod";
import { OpaqueIdSchema, TimestampSchema, paginated } from "./common.ts";
import { PageIdSchema, PageKindSchema } from "./pages.ts";

/**
 * The Trash of a workspace (ADR-0043, capability `trash`).
 *
 * - A deleted page stays in the Trash for `TRASH_RESTORE_DAYS` days, then the server removes it for good with its
 *   revisions. A folder is one item: the pages deleted with it come back with it.
 * - Owners and managers see the whole Trash, restore anything and delete anything for good. Editors see and restore
 *   only what they deleted. Viewers have no Trash (403).
 * - Restoring brings the page back where it was (at the top level when that folder is gone for good), with every page
 *   deleted below it that the caller may restore. The change feed reports each one as `page.created`.
 */
export const TRASH_RESTORE_DAYS = 30;

export const TrashItemSchema = z.object({
  pageId: PageIdSchema,
  title: z.string(),
  kind: PageKindSchema.nullable(),
  /** The folder it was in, or `null` (the top level, or a folder deleted for good since). */
  parentId: PageIdSchema.nullable(),
  /** Pages deleted below it, which come back with it. */
  pagesBelow: z.number().int().nonnegative(),
  deletedAt: TimestampSchema,
  /** Who deleted it, or `null` when that account no longer exists. */
  deletedBy: OpaqueIdSchema.nullable(),
  deletedByName: z.string().nullable(),
  /** After this the server removes it for good. */
  restorableUntil: TimestampSchema,
});
export type TrashItem = z.infer<typeof TrashItemSchema>;

/** Newest first. */
export const TrashListSchema = paginated(TrashItemSchema);
export type TrashList = z.infer<typeof TrashListSchema>;

/** `restoreTrashedPage`: every page that came back, the restored page first. */
export const TrashRestoredSchema = z.object({ pageIds: z.array(PageIdSchema).min(1) });
export type TrashRestored = z.infer<typeof TrashRestoredSchema>;
