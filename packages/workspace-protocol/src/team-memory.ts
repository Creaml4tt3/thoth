import { z } from "zod";
import { OpaqueIdSchema, PaginationQuerySchema, RevisionIdSchema, TimestampSchema, paginated } from "./common.ts";
import { PageIdSchema } from "./pages.ts";

/**
 * Team memory (ADR-0052 rule 8, capability `team-memory`): the memories the members' agents share in a workspace.
 *
 * - They are pages under the workspace's top-level folder titled `TEAM_MEMORY_FOLDER` (made the first time one is
 *   applied), each one memory, its fields in frontmatter as in a Private Space's memory folder.
 * - An agent's memory is a proposal kept by the server, so more than one person can see it. While the workspace setting
 *   "Agents' memories need review" is on (the default), the person whose agent wrote it applies or declines it, and so
 *   can the workspace's owners and managers, each with their own role and what they may see (ADR-0042). Off (owners and
 *   managers choose), a memory from an editor or above is applied at once.
 * - Every applied agent memory records the agent, the person whose agent wrote it, who applied it and when: owners and
 *   managers read that as the activity.
 * - A pending proposal expires after `TEAM_MEMORY_PROPOSAL_DAYS` days.
 */
export const TEAM_MEMORY_FOLDER = "Team memory";
export const TEAM_MEMORY_PROPOSAL_DAYS = 30;
/** The largest memory page, in bytes (its text and frontmatter). */
export const TEAM_MEMORY_MAX_BYTES = 16 * 1024;
/** The most pending proposals a workspace keeps; one more is 409 `quota_exceeded`. */
export const TEAM_MEMORY_MAX_PENDING = 500;

export const TeamMemoryProposalIdSchema = OpaqueIdSchema;

/** The workspace's setting, and its Team memory folder when there is one the caller sees. */
export const TeamMemorySettingsSchema = z.object({
  review: z.boolean(),
  folderId: PageIdSchema.nullable(),
});
export type TeamMemorySettings = z.infer<typeof TeamMemorySettingsSchema>;

export const TeamMemoryReviewWriteSchema = z.object({ review: z.boolean() }).strict();

/** An agent's memory: a new page in the folder, or (with `pageId` and `baseRevision`) a new text for one there. */
export const TeamMemoryProposeSchema = z
  .object({
    /** The agent's own name (self-reported, as the desktop app received it). */
    agent: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(200),
    markdown: z.string().min(1),
    pageId: PageIdSchema.optional(),
    /** The page's revision the new text was made from; required with `pageId`. */
    baseRevision: RevisionIdSchema.optional(),
  })
  .strict()
  .refine((p) => (p.pageId === undefined) === (p.baseRevision === undefined), { message: "give pageId and baseRevision together", path: ["baseRevision"] });
export type TeamMemoryPropose = z.infer<typeof TeamMemoryProposeSchema>;

export const TeamMemoryStatusSchema = z.enum(["pending", "applied", "declined", "expired"]);
export type TeamMemoryStatus = z.infer<typeof TeamMemoryStatusSchema>;

export const TeamMemoryProposalSchema = z.object({
  id: TeamMemoryProposalIdSchema,
  status: TeamMemoryStatusSchema,
  agent: z.string(),
  /** The person whose agent wrote it (`null` when that account no longer exists), and their name. */
  authorId: OpaqueIdSchema.nullable(),
  authorName: z.string().nullable(),
  title: z.string(),
  /** The page it changes; `null` for a new one until it is applied, then the page made. */
  pageId: PageIdSchema.nullable(),
  baseRevision: RevisionIdSchema.nullable(),
  createdAt: TimestampSchema,
  /** While it waits. */
  expiresAt: TimestampSchema.nullable(),
  settledAt: TimestampSchema.nullable(),
  /** Who applied or declined it (for an applied one with review off: the author). */
  settledBy: OpaqueIdSchema.nullable(),
  settledByName: z.string().nullable(),
  /** The revision an applied one wrote. */
  appliedRevision: RevisionIdSchema.nullable(),
});
export type TeamMemoryProposal = z.infer<typeof TeamMemoryProposalSchema>;

/** One proposal with its text while it waits (`null` once it is settled: the page has it). */
export const TeamMemoryProposalTextSchema = TeamMemoryProposalSchema.extend({ markdown: z.string().nullable() });
export type TeamMemoryProposalText = z.infer<typeof TeamMemoryProposalTextSchema>;

/** Newest first. */
export const TeamMemoryProposalListSchema = paginated(TeamMemoryProposalSchema);
export type TeamMemoryProposalList = z.infer<typeof TeamMemoryProposalListSchema>;

/** `listTeamMemoryProposals`: only those with `status` (all when left out). */
export const TeamMemoryListQuerySchema = PaginationQuerySchema.extend({ status: TeamMemoryStatusSchema.optional() });
