import { z } from "zod";
import { SpaceSchema } from "@thoth/domain";
import { OpaqueIdSchema, TimestampSchema, WorkspaceIdSchema, paginated } from "./common.ts";

/** Workspace roles (ADR-0009), highest first. `manager` (ADR-0042): an editor who also manages teams and who sees which pages. */
export const RoleSchema = z.enum(["owner", "manager", "editor", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;

export const MemberSchema = z.object({
  userId: OpaqueIdSchema,
  displayName: z.string(),
  role: RoleSchema,
});
export type Member = z.infer<typeof MemberSchema>;

/** The authenticated principal. */
export const MeSchema = z.object({
  id: OpaqueIdSchema,
  displayName: z.string(),
  email: z.string().optional(),
});
export type Me = z.infer<typeof MeSchema>;

/** A workspace as seen by the calling principal. Extends the domain `Space`. */
export const WorkspaceSchema = SpaceSchema.extend({
  id: WorkspaceIdSchema,
  kind: z.literal("workspace"),
  /** The caller's role. */
  role: RoleSchema,
  /** When true the server refuses Workspace to Private transfers and copies (ADR-0009). */
  exportRestricted: z.boolean().describe("When true the server refuses Workspace to Private transfers and copies with 403 export_restricted."),
  memberCount: z.number().int().nonnegative(),
  /** Optional preview of members. Absent when the server does not disclose members to the caller. */
  members: z.array(MemberSchema).optional(),
  createdAt: TimestampSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const WorkspaceListSchema = paginated(WorkspaceSchema);
export type WorkspaceList = z.infer<typeof WorkspaceListSchema>;

/** Which roles may do what. Normative for authorization expectations (ADR-0009). */
export const ROLE_PERMISSIONS = {
  viewer: ["read"],
  editor: ["read", "write"],
  manager: ["read", "write", "manage"],
  owner: ["read", "write", "manage", "administer"],
} as const satisfies Record<Role, readonly string[]>;

/**
 * `manage` (ADR-0042, ADR-0043): teams, page visibility, every page (limited ones too), the whole Trash, invite links,
 * and members who are not owners (their roles up to manager, and removing them). `administer` (owners): making,
 * demoting or removing owners, and renaming or deleting the workspace.
 */
export type Permission = "read" | "write" | "manage" | "administer";

export function roleCan(role: Role, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
}
