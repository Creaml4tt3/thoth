import { z } from "zod";

/**
 * Error-code registry. Errors are RFC 9457 `application/problem+json` documents whose
 * `code` member is one of these stable identifiers (or an `x-` vendor code). The HTTP
 * status of a code is fixed by the registry.
 */
export const ERROR_CODES = {
  validation_failed: { status: 400, title: "Validation failed", description: "The request is malformed or a field, header, or query parameter is invalid." },
  cursor_invalid: { status: 400, title: "Cursor invalid", description: "The cursor is malformed, was not issued by this server for this collection, or does not decode." },
  unauthenticated: { status: 401, title: "Authentication required", description: "Credentials are missing, malformed, expired, or revoked." },
  forbidden: { status: 403, title: "Forbidden", description: "The principal can see the resource but its role does not allow the action." },
  export_restricted: { status: 403, title: "Export restricted", description: "The workspace forbids exporting content out of it (ADR-0009)." },
  not_found: { status: 404, title: "Not found", description: "The route or resource does not exist, or the principal may not know that it exists." },
  method_not_allowed: { status: 405, title: "Method not allowed", description: "The route exists but not for this method." },
  invalid_transfer_state: { status: 409, title: "Invalid transfer state", description: "The transfer is in a state that does not allow the requested action." },
  last_owner: { status: 409, title: "Last owner", description: "The change would leave the workspace without an owner (ADR-0024). Make another member an owner first." },
  quota_exceeded: { status: 409, title: "Quota exceeded", description: "The request is valid and permitted, but would exceed a quota of the workspace, the account or the server. Freeing space or waiting can make the same request succeed. The body may carry `quota`, `limit` and `current`." },
  cursor_expired: { status: 410, title: "Cursor expired", description: "The cursor points before the retained change history; the client must resynchronize from the tree." },
  revision_conflict: { status: 412, title: "Revision conflict", description: "A conditional write did not match the current revision. The body carries `currentRevision`." },
  payload_too_large: { status: 413, title: "Payload too large", description: "The request body exceeds a server limit advertised in `limits`." },
  unsupported_media_type: { status: 415, title: "Unsupported media type", description: "The request content type is not accepted." },
  idempotency_key_reused: { status: 422, title: "Idempotency key reused", description: "The Idempotency-Key was already used with a different request." },
  precondition_required: { status: 428, title: "Precondition required", description: "The write must carry If-Match or If-None-Match." },
  rate_limited: { status: 429, title: "Rate limited", description: "Too many requests. Honor the Retry-After header." },
  internal_error: { status: 500, title: "Internal error", description: "Unexpected server failure." },
  capability_not_supported: { status: 501, title: "Capability not supported", description: "The route belongs to a capability this server does not list." },
  service_unavailable: { status: 503, title: "Service unavailable", description: "The server is temporarily unable to handle the request." },
} as const satisfies Record<string, { status: number; title: string; description: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ERROR_CODE_LIST = Object.keys(ERROR_CODES) as ErrorCode[];

export const ErrorCodeSchema = z.enum(ERROR_CODE_LIST as [ErrorCode, ...ErrorCode[]]);

export const VENDOR_ERROR_CODE_PATTERN = /^x-[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** A registered error code, or a vendor code prefixed `x-`. */
export const ProblemCodeSchema = z.union([ErrorCodeSchema, z.string().regex(VENDOR_ERROR_CODE_PATTERN)]);

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_CODES, value);
}

export function statusForCode(code: ErrorCode): number {
  return ERROR_CODES[code].status;
}

/** Field-level detail for `validation_failed`. */
export const ProblemFieldErrorSchema = z.object({
  /** JSON Pointer into the body, or `header:<Name>` / `query:<name>` / `path:<name>`. */
  pointer: z.string().optional(),
  detail: z.string(),
});

/**
 * RFC 9457 problem details. Extension members are permitted (loose object); unknown
 * members MUST be ignored by clients.
 */
export const ProblemDetailsSchema = z.looseObject({
  type: z.string().min(1),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: ProblemCodeSchema,
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.array(ProblemFieldErrorSchema).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

/** Names the quota a `quota_exceeded` problem refers to. Open set: clients ignore values they do not know. */
export const QUOTA_NAMES = ["pagesPerWorkspace", "attachmentBytesPerWorkspace", "membersPerWorkspace", "workspacesPerAccount", "serverAttachmentBytes", "accounts", "shareLinksPerWorkspace", "inviteLinksPerWorkspace", "workspaceCreationsPerDay"] as const;

/**
 * Problem body for HTTP 409 `quota_exceeded`. `limit` and `current` are omitted for server-wide quotas
 * (they would disclose how full the whole server is to every user).
 */
export const QuotaExceededProblemSchema = z.looseObject({
  type: z.string().min(1),
  title: z.string(),
  status: z.literal(409),
  code: z.literal("quota_exceeded"),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  quota: z.string().optional().describe("Which quota was hit, for example `pagesPerWorkspace`. Open set."),
  limit: z.number().int().nonnegative().optional().describe("The quota, in the unit of the quota (pages, bytes, members, workspaces)."),
  current: z.number().int().nonnegative().optional().describe("Usage before the rejected request."),
});
export type QuotaExceededProblem = z.infer<typeof QuotaExceededProblemSchema>;

export const PROBLEM_CONTENT_TYPE = "application/problem+json" as const;

export function problemTypeFor(code: ErrorCode): string {
  return `https://thoth.invalid/problems/${code}`;
}

/** Builds a problem document for a registered code. */
export function problem(code: ErrorCode, init: { detail?: string; instance?: string; requestId?: string; errors?: z.infer<typeof ProblemFieldErrorSchema>[] } = {}): ProblemDetails {
  const entry = ERROR_CODES[code];
  return {
    type: problemTypeFor(code),
    title: entry.title,
    status: entry.status,
    code,
    ...(init.detail === undefined ? {} : { detail: init.detail }),
    ...(init.instance === undefined ? {} : { instance: init.instance }),
    ...(init.requestId === undefined ? {} : { requestId: init.requestId }),
    ...(init.errors === undefined ? {} : { errors: init.errors }),
  };
}

/**
 * Cross-field rule the JSON Schema cannot express: for a registered code the body
 * `status` MUST equal the registry status. Returns a list of problems (empty = valid).
 */
export function checkProblemConsistency(p: ProblemDetails, httpStatus: number): string[] {
  const issues: string[] = [];
  if (p.status !== httpStatus) issues.push(`body status ${p.status} differs from HTTP status ${httpStatus}`);
  if (isErrorCode(p.code)) {
    const expected = ERROR_CODES[p.code].status;
    if (expected !== httpStatus) issues.push(`code ${p.code} must use HTTP ${expected}, got ${httpStatus}`);
  }
  return issues;
}
