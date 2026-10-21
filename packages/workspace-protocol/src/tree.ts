import { z } from "zod";
import { CursorSchema, RevisionIdSchema, TimestampSchema, WorkspaceIdSchema, paginated } from "./common.ts";
import { PageIdSchema } from "./pages.ts";

/** One page in the workspace hierarchy (adjacency list; parents may appear on later pages). */
export const TreeNodeSchema = z.object({
  id: PageIdSchema,
  parentId: PageIdSchema.nullable(),
  title: z.string(),
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
