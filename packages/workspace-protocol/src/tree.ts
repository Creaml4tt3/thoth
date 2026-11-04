import { z } from "zod";
import { CursorSchema, RevisionIdSchema, TimestampSchema, WorkspaceIdSchema, paginated } from "./common.ts";
import { PageIdSchema, PageKindSchema, PagePositionSchema } from "./pages.ts";

/** One page in the workspace hierarchy (adjacency list; parents may appear on later pages). */
export const TreeNodeSchema = z.object({
  id: PageIdSchema,
  parentId: PageIdSchema.nullable(),
  title: z.string(),
  /** Sibling sort key (capability `page-order`); absent or null when the page has none. */
  position: PagePositionSchema.nullable().optional(),
  /** Page kind (capability `page-kind`, ADR-0017); absent or null when the server does not know it. Clients treat unknown as a page. */
  kind: PageKindSchema.nullable().optional(),
  /**
   * The page's tags (capability `page-tags`, ADR-0051): frontmatter `tags`/`tag` and inline `#tags` outside code, by the
   * rules of `parsePage`. Absent or null when the server has not derived them (a page written before the capability).
   */
  tags: z.array(z.string()).nullable().optional(),
  /** Frontmatter `date` as `YYYY-MM-DD` when it is a valid date (capability `page-tags`, ADR-0051); absent or null otherwise. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  revisionId: RevisionIdSchema,
  updatedAt: TimestampSchema,
});
export type TreeNode = z.infer<typeof TreeNodeSchema>;

/**
 * A page of the tree. `changeCursor` is a change-feed cursor taken no later than the
 * start of the traversal: applying `GET /changes?cursor=<changeCursor>` after reading
 * every tree page yields a consistent view. All pages of one traversal carry the same value.
 */
export const TreePageSchema = paginated(TreeNodeSchema).extend({
  workspaceId: WorkspaceIdSchema,
  changeCursor: CursorSchema.describe("Change-feed cursor taken no later than the start of the traversal; follow GET /changes from it after reading all pages."),
});
export type TreePage = z.infer<typeof TreePageSchema>;
