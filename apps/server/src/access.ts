import { OpaqueIdSchema, roleCan, type Role } from "@thoth/workspace-protocol";
import { ApiError } from "./errors.ts";
import type { Queryable } from "./db.ts";

export interface WorkspaceAccess {
  id: string;
  name: string;
  exportRestricted: boolean;
  role: Role;
}

/**
 * The single authorization gate for everything inside a workspace (ADR-0009).
 *
 * - Not a member (or no such workspace, a deleted one (ADR-0025), or a malformed ID): 404 `not_found`, so existence is
 *   not leaked.
 * - A member whose role lacks `need`: 403 `forbidden`. `administer` is the owners' permission (ADR-0024: members and
 *   invite links).
 *
 * With `lock`, the workspace row is locked `FOR NO KEY UPDATE` for the rest of the transaction.
 * Every write takes that lock first, which serializes writers per workspace: change-feed sequence
 * numbers are gap-free and commit in order, and an `If-Match` check cannot be raced past.
 */
export type Need = "read" | "write" | "administer";

export async function workspaceAccess(q: Queryable, workspaceId: string, userId: string, need: Need, options: { lock?: boolean } = {}): Promise<WorkspaceAccess> {
  if (!OpaqueIdSchema.safeParse(workspaceId).success) throw new ApiError("not_found", "workspace not found");
  const { rows } = await q.query<{ id: string; name: string; export_restricted: boolean; role: Role }>(
    `SELECT w.id, w.name, w.export_restricted, m.role
       FROM workspaces w JOIN memberships m ON m.workspace_id = w.id AND m.user_id = $2
      WHERE w.id = $1 AND w.deleted_at IS NULL ${options.lock ? "FOR NO KEY UPDATE OF w" : ""}`,
    [workspaceId, userId],
  );
  const row = rows[0];
  if (!row) throw new ApiError("not_found", "workspace not found");
  const access: WorkspaceAccess = { id: row.id, name: row.name, exportRestricted: row.export_restricted, role: row.role };
  requireRole(access, need);
  return access;
}

export function requireRole(access: WorkspaceAccess, need: Need): void {
  if (!roleCan(access.role, need)) throw new ApiError("forbidden", need === "administer" ? "only owners of this workspace may do this" : `role ${access.role} may not ${need} in this workspace`);
}
