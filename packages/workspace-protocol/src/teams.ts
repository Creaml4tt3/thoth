import { z } from "zod";
import { OpaqueIdSchema } from "./common.ts";
import { PageIdSchema, PageKindSchema } from "./pages.ts";

/**
 * Teams and page visibility (ADR-0042, capability `teams`).
 *
 * - A team is a named group of members of one workspace. Every member reads the list; owners and managers create,
 *   rename and delete teams and add and remove their members.
 * - Owners and managers limit a page (usually a folder) to some teams. The limit applies to the page and every page
 *   below it. A member in none of those teams cannot see them: to that member they do not exist (404, absent from the
 *   tree, the change feed, search, revisions, transfers and share links). Owners and managers see every page
 *   (ADR-0043).
 * - A change to who sees what makes older change cursors expire (410 `cursor_expired`), so clients read the tree again.
 */

export const TEAM_NAME_MAX = 100;
/** Teams one workspace may have. */
export const TEAMS_MAX = 100;

export const TeamIdSchema = OpaqueIdSchema;
export const TeamNameSchema = z.string().trim().min(1).max(TEAM_NAME_MAX);

export const TeamSchema = z.object({
  id: TeamIdSchema,
  name: z.string(),
  /** Members of the team (user IDs), each also a member of the workspace. */
  memberIds: z.array(OpaqueIdSchema),
});
export type Team = z.infer<typeof TeamSchema>;

/** Every team of the workspace (at most `TEAMS_MAX`, so not paged), by name. */
export const TeamListSchema = z.object({ items: z.array(TeamSchema) });
export type TeamList = z.infer<typeof TeamListSchema>;

/** `createTeam` and `renameTeam`. */
export const TeamWriteSchema = z.object({ name: TeamNameSchema });
export type TeamWrite = z.infer<typeof TeamWriteSchema>;

/** Who sees a page. */
export const PageVisibilitySchema = z.object({
  pageId: PageIdSchema,
  /** The teams this page is limited to, or `null`: no limit on this page itself. */
  teamIds: z.array(TeamIdSchema).nullable(),
  /** A page above this one is limited, so this page is limited by that too. */
  limitedAbove: z.boolean(),
});
export type PageVisibility = z.infer<typeof PageVisibilitySchema>;

/** `setPageVisibility`: the teams that may see the page and everything below it, or `null` for everyone. */
export const PageVisibilityWriteSchema = z.object({
  teamIds: z.array(TeamIdSchema).min(1).max(TEAMS_MAX).nullable(),
});
export type PageVisibilityWrite = z.infer<typeof PageVisibilityWriteSchema>;

/** `listTeamPages`: the pages limited to a team, so deleting it can say what changes. */
export const TeamPageSchema = z.object({
  pageId: PageIdSchema,
  title: z.string(),
  kind: PageKindSchema.nullable(),
  /** This team is the only one: once it is deleted, owners and managers alone see the page. */
  onlyTeam: z.boolean(),
});
export const TeamPageListSchema = z.object({ items: z.array(TeamPageSchema) });
export type TeamPageList = z.infer<typeof TeamPageListSchema>;
