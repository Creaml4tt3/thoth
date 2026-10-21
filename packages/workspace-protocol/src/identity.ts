import { z } from "zod";
import { SpaceSchema } from "@thoth/domain";
import { OpaqueIdSchema, TimestampSchema, WorkspaceIdSchema, paginated } from "./common.ts";

/** MVP workspace roles (ADR-0009). */
export const RoleSchema = z.enum(["owner", "editor", "viewer"]);
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
  owner: ["read", "write", "administer"],
} as const satisfies Record<Role, readonly string[]>;

export function roleCan(role: Role, permission: "read" | "write" | "administer"): boolean {
  return (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
}
