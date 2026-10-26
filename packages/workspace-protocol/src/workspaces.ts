import { z } from "zod";
import { OpaqueIdSchema, TimestampSchema, WorkspaceIdSchema, paginated } from "./common.ts";

/**
 * Several workspaces per account (ADR-0025, capability `workspace-management`).
 *
 * - Any signed-in account creates a workspace and becomes its owner, within the server's `maxWorkspacesPerAccount`
 *   (owned workspaces; a membership through an invite does not count).
 * - Owners rename it and delete it. A deleted workspace is unreachable for everyone at once (its pages, search, change
 *   feed, share links and invite links), is kept for `DELETED_WORKSPACE_RESTORE_DAYS` days for its owners to restore,
 *   and is then purged by the server with its pages, revisions and attachments. Owners may also purge it earlier.
 * - A deleted workspace keeps counting toward its owners' `maxWorkspacesPerAccount` until it is purged, so creating
 *   and deleting cannot pile up data on the server.
 */

/** How long a deleted workspace can be restored, in days. After that the server purges it. */
export const DELETED_WORKSPACE_RESTORE_DAYS = 30;

/** A workspace name: 1 to 200 characters after trimming, the same rule as the server's database. */
export const WORKSPACE_NAME_MAX = 200;
export const WorkspaceNameSchema = z.string().min(1).max(WORKSPACE_NAME_MAX);

/** `createWorkspace`: the name and the export-restriction choice (ADR-0009). */
export const WorkspaceCreateRequestSchema = z.object({
  name: WorkspaceNameSchema,
  /** When true the server refuses Workspace to Private transfers and copies out of it. Absent means false. */
  exportRestricted: z.boolean().optional(),
});
export type WorkspaceCreateRequest = z.infer<typeof WorkspaceCreateRequestSchema>;

/** `renameWorkspace`: the new name. */
export const WorkspaceRenameSchema = z.object({ name: WorkspaceNameSchema });
export type WorkspaceRename = z.infer<typeof WorkspaceRenameSchema>;

/** A deleted workspace as its owners see it in "Recently deleted". */
export const DeletedWorkspaceSchema = z.object({
  id: WorkspaceIdSchema,
  name: z.string(),
  exportRestricted: z.boolean(),
  memberCount: z.number().int().nonnegative(),
  deletedAt: TimestampSchema,
  /** The owner who deleted it; `null` when that account no longer exists. */
  deletedBy: OpaqueIdSchema.nullable(),
  /** After this moment it can no longer be restored, and the server purges it. */
  restorableUntil: TimestampSchema,
});
export type DeletedWorkspace = z.infer<typeof DeletedWorkspaceSchema>;

/** The caller's deleted workspaces that can still be restored (where the caller is an owner), newest first. */
export const DeletedWorkspaceListSchema = paginated(DeletedWorkspaceSchema);
export type DeletedWorkspaceList = z.infer<typeof DeletedWorkspaceListSchema>;
