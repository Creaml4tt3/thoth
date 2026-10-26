import { z } from "zod";
import { OpaqueIdSchema, TimestampSchema, WorkspaceIdSchema, paginated } from "./common.ts";
import { MemberSchema, RoleSchema } from "./identity.ts";

/**
 * Workspace members and invite links (ADR-0024).
 *
 * - Capability `members`: every member reads the member list (display names and roles, never emails); owners change
 *   roles and remove members; any member leaves (removes themself). A workspace always keeps at least one owner:
 *   a change that would leave none is 409 `last_owner`.
 * - Capability `invite-links`: owners make links `<server origin>/i/<token>` that let whoever opens them join with a
 *   role (editor or viewer), for 1, 7 or 30 days, for 1, 5 or 10 people. The token is shown once, in the create
 *   response; the server keeps only its hash. Anyone signed in to the server accepts a link with `acceptInvite`.
 */

/** A page of the workspace's members, in a stable order (by user ID). */
export const MemberListSchema = paginated(MemberSchema);
export type MemberList = z.infer<typeof MemberListSchema>;

/** `setMemberRole`: the member's new role. */
export const MemberRoleChangeSchema = z.object({ role: RoleSchema });
export type MemberRoleChange = z.infer<typeof MemberRoleChangeSchema>;

/** Server-assigned invite-link ID (not the token): used to list and revoke a link. */
export const InviteLinkIdSchema = OpaqueIdSchema;

/** The roles a link can give. Owner only by promoting someone who is already a member. */
export const INVITE_ROLES = ["editor", "viewer"] as const;
export const InviteRoleSchema = z.enum(INVITE_ROLES);
export type InviteRole = z.infer<typeof InviteRoleSchema>;

/** Expiry choices in days, and how many people may join with one link. */
export const INVITE_EXPIRY_DAYS = [1, 7, 30] as const;
export const INVITE_EXPIRY_DEFAULT_DAYS = 7;
export const INVITE_USES = [1, 5, 10] as const;
export const INVITE_USES_DEFAULT = 1;

export const InviteExpirySchema = z.union([z.literal(1), z.literal(7), z.literal(30)]);
export type InviteExpiry = z.infer<typeof InviteExpirySchema>;
export const InviteUsesSchema = z.union([z.literal(1), z.literal(5), z.literal(10)]);
export type InviteUses = z.infer<typeof InviteUsesSchema>;

export const InviteLinkCreateRequestSchema = z.object({
  role: InviteRoleSchema,
  /** Days until the link stops working: 1, 7 or 30. Absent means 7. */
  expiresInDays: InviteExpirySchema.optional(),
  /** How many people may join with it: 1, 5 or 10, never more than the member quota leaves room for. Absent means 1. */
  maxUses: InviteUsesSchema.optional(),
});
export type InviteLinkCreateRequest = z.infer<typeof InviteLinkCreateRequestSchema>;

/** An invite link as owners see it. Never carries the token. */
export const InviteLinkSchema = z.object({
  id: InviteLinkIdSchema,
  workspaceId: WorkspaceIdSchema,
  role: InviteRoleSchema,
  maxUses: z.number().int().positive(),
  /** People who can still join with it. */
  usesLeft: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  createdBy: OpaqueIdSchema.nullable(),
  /** The creator's display name, for "created by". */
  createdByName: z.string(),
  expiresAt: TimestampSchema,
});
export type InviteLink = z.infer<typeof InviteLinkSchema>;

/** The create response: the link plus its token and address, returned this once and never again. */
export const InviteLinkCreatedSchema = InviteLinkSchema.extend({
  /** URL-safe secret of at least 128 bits. Only its hash is stored. */
  token: z.string().regex(/^[A-Za-z0-9_-]{22,}$/),
  /** Absolute address of the invite page: `<origin>/i/<token>`. */
  url: z.url(),
});
export type InviteLinkCreated = z.infer<typeof InviteLinkCreatedSchema>;

/** The workspace's active links (not revoked, not expired, not used up), newest first. */
export const InviteLinkListSchema = paginated(InviteLinkSchema);
export type InviteLinkList = z.infer<typeof InviteLinkListSchema>;

/** `acceptInvite`: the token from the link (the last path segment of `/i/<token>`). */
export const InviteAcceptRequestSchema = z.object({ token: z.string().min(1).max(512) });
export type InviteAcceptRequest = z.infer<typeof InviteAcceptRequestSchema>;

/** What joining did. `joined: false` means the caller was already a member: nothing changed, the role is theirs. */
export const InviteAcceptedSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  name: z.string(),
  role: RoleSchema,
  joined: z.boolean(),
});
export type InviteAccepted = z.infer<typeof InviteAcceptedSchema>;

/** Path of an invite page relative to the server origin. */
export const invitePath = (token: string): string => `/i/${token}`;

/**
 * The server origin and token of an invite address `https://<server>/i/<token>`, or `null` when the text is not one.
 * Surrounding spaces are ignored; a query or fragment is not accepted.
 */
export function parseInviteUrl(text: string): { origin: string; token: string } | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  const match = /^\/i\/([A-Za-z0-9_-]{22,512})\/?$/.exec(url.pathname);
  return match ? { origin: url.origin, token: match[1]! } : null;
}
