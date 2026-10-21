import { z } from "zod";
import { CursorSchema, LimitSchema, RevisionIdSchema, paginated } from "./common.ts";
import { PageIdSchema } from "./pages.ts";

/** Body of `POST .../search`. Paging state travels in the body because the route is a POST. */
export const SearchRequestSchema = z.object({
  query: z.string().min(1).max(1000),
  limit: LimitSchema.optional(),
  cursor: CursorSchema.optional(),
  /** Restrict results to this page and its descendants. */
  withinPageId: PageIdSchema.optional(),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const SearchHitSchema = z.object({
  pageId: PageIdSchema,
  title: z.string(),
  revisionId: RevisionIdSchema,
  /** Plain-text excerpt around the match. Never contains content the caller may not read. */
  snippet: z.string().optional(),
  score: z.number().optional(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResponseSchema = paginated(SearchHitSchema);
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
