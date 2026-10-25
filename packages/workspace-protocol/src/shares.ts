import { z } from "zod";
import { OpaqueIdSchema, TimestampSchema, WorkspaceIdSchema, paginated } from "./common.ts";
import { PageIdSchema } from "./pages.ts";

/**
 * Public read-only share links (ADR-0023, capability `public-share`). A link shares one workspace page and its
 * sub-pages, read-only, at `<server origin>/s/<token>`, to anyone who has the address. The token is shown once, in
 * the create response; the server keeps only its hash, so a listed link cannot be copied again (create a new one).
 */

/** Server-assigned link ID (not the token): used to list and revoke a link. */
export const ShareLinkIdSchema = OpaqueIdSchema;

/** The expiry choices, in days. `null` is "never". */
export const SHARE_EXPIRY_DAYS = [7, 30, 90] as const;
export const SHARE_EXPIRY_DEFAULT_DAYS = 30;

export const ShareExpirySchema = z.union([z.literal(7), z.literal(30), z.literal(90), z.null()]);
export type ShareExpiry = z.infer<typeof ShareExpirySchema>;

export const ShareLinkCreateRequestSchema = z.object({
  /** Days until the link stops working: 7, 30 or 90, or `null` for never. Absent means 30. */
  expiresInDays: ShareExpirySchema.optional(),
});
export type ShareLinkCreateRequest = z.infer<typeof ShareLinkCreateRequestSchema>;

/** A share link as members see it. Never carries the token. */
export const ShareLinkSchema = z.object({
  id: ShareLinkIdSchema,
  workspaceId: WorkspaceIdSchema,
  /** The shared page: the root of what the link shows. */
  pageId: PageIdSchema,
  createdAt: TimestampSchema,
  createdBy: OpaqueIdSchema.nullable(),
  /** When the link stops working; `null` = never. */
  expiresAt: TimestampSchema.nullable(),
});
export type ShareLink = z.infer<typeof ShareLinkSchema>;

/** The create response: the link plus its token and address, returned this once and never again. */
export const ShareLinkCreatedSchema = ShareLinkSchema.extend({
  /** URL-safe secret of at least 128 bits. Only its hash is stored. */
  token: z.string().regex(/^[A-Za-z0-9_-]{22,}$/),
  /** Absolute address of the shared page: `<origin>/s/<token>`. */
  url: z.url(),
});
export type ShareLinkCreated = z.infer<typeof ShareLinkCreatedSchema>;

/** The active (not revoked, not expired) links of a page, newest first. */
export const ShareLinkListSchema = paginated(ShareLinkSchema);
export type ShareLinkList = z.infer<typeof ShareLinkListSchema>;

/** Path of the shared page relative to the server origin. Viewers' paths stay under it. */
export const sharePath = (token: string): string => `/s/${token}`;
