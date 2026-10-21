import { z } from "zod";

/**
 * Shared primitives for the Thoth workspace protocol (ADR-0004).
 *
 * The protocol is REST over HTTPS. Every route lives under `API_BASE_PATH`.
 */
export const API_BASE_PATH = "/api/v1" as const;

/** `MAJOR.MINOR`. The major version is also the `/api/v1` path segment. */
export const PROTOCOL_VERSION = "1.0" as const;

/**
 * Opaque, server-assigned identifier (workspace, user, change entry).
 * Restricted to URL-unreserved characters so it needs no percent-encoding.
 */
export const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.~-]+$/, "Expected 1-128 URL-unreserved characters");
export type OpaqueId = z.infer<typeof OpaqueIdSchema>;

export const WorkspaceIdSchema = OpaqueIdSchema;
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;

/** Revision identifiers are opaque. They are exposed as the entity tag `"<id>"`. */
export const RevisionIdSchema = OpaqueIdSchema;
export type RevisionId = z.infer<typeof RevisionIdSchema>;

/** RFC 3339 timestamp (`Z` or numeric offset). */
export const TimestampSchema = z.iso.datetime({ offset: true });

/** Lower-case hexadecimal SHA-256 digest. */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "Expected lower-case hex SHA-256");

/**
 * Opaque pagination or change-feed cursor. Servers MUST emit only URL-unreserved
 * characters so cursors can be used in query strings without escaping; clients MUST
 * treat them as opaque.
 */
export const CursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_.~-]+$/, "Expected URL-unreserved characters")
  .describe("Opaque cursor. Clients must not parse or construct it.");
export type Cursor = z.infer<typeof CursorSchema>;

export const PAGE_SIZE_MAX = 200;
export const PAGE_SIZE_DEFAULT = 50;

export const LimitSchema = z.number().int().min(1).max(PAGE_SIZE_MAX);

/** Query parameters shared by every paginated GET. */
export const PaginationQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: LimitSchema.optional(),
});

/**
 * Pagination envelope. `nextCursor` is `null` on the last page. Items never repeat
 * across pages of one traversal when the underlying collection is unchanged.
 */
export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: CursorSchema.nullable(),
  });
}

/** Entity tags carry revision IDs: `"<revisionId>"`. Weak validators are not used. */
export function formatEtag(revisionId: string): string {
  return `"${revisionId}"`;
}

/** Parses a single strong entity tag. Returns `null` for weak, wildcard, list, or malformed values. */
export function parseEtag(header: string | null | undefined): string | null {
  if (header === null || header === undefined) return null;
  const match = /^"([A-Za-z0-9_.~-]{1,128})"$/.exec(header.trim());
  return match ? match[1]! : null;
}

/** `Idempotency-Key` header value: 1 to 255 visible ASCII characters. */
export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, "Expected visible ASCII characters");

/** `If-Match` header value: one strong entity tag. */
export const IfMatchSchema = z.string().regex(/^"[A-Za-z0-9_.~-]{1,128}"$/, "Expected one strong entity tag");

/** `If-None-Match` header value on writes: only `*`. */
export const IfNoneMatchSchema = z.literal("*");

/** Minimum time a server retains idempotency records. */
export const IDEMPOTENCY_MIN_WINDOW_SECONDS = 86_400;
