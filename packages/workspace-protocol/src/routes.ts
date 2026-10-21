import { z } from "zod";
import { API_BASE_PATH, PaginationQuerySchema, WorkspaceIdSchema } from "./common.ts";
import { CapabilitiesSchema, type CapabilityId } from "./capabilities.ts";
import { ERROR_CODES, ProblemDetailsSchema, type ErrorCode } from "./errors.ts";
import { MeSchema, WorkspaceListSchema } from "./identity.ts";
import { GetPageQuerySchema, PageIdSchema, PageResourceSchema, PageWriteSchema, RevisionConflictProblemSchema, RevisionListSchema } from "./pages.ts";
import { TreePageSchema } from "./tree.ts";
import { SearchRequestSchema, SearchResponseSchema } from "./search.ts";
import { AttachmentIdSchema, AttachmentResourceSchema, UploadAttachmentQuerySchema } from "./attachments.ts";
import { ChangesQuerySchema, ChangesResponseSchema } from "./changes.ts";
import { TransferCommitRequestSchema, TransferCreateRequestSchema, TransferOperationIdSchema, TransferResourceSchema } from "./transfers.ts";

/**
 * Route registry: the single typed table the OpenAPI document, the conformance suite
 * and the response validators are generated from. Paths are relative to `API_BASE_PATH`.
 */
export type HttpMethod = "get" | "post" | "put" | "delete";

export type RequestHeaderName = "If-Match" | "If-None-Match" | "Idempotency-Key";
export type ResponseHeaderName = "ETag" | "Location";

export interface RequestHeaderSpec {
  name: RequestHeaderName;
  /** `conditional`: see the description; the server enforces the rule with 428 or 400. */
  requirement: "required" | "optional" | "conditional";
  description: string;
}

export interface ResponseHeaderSpec {
  name: ResponseHeaderName;
  description: string;
}

export interface RequestBodySpec {
  contentType: string;
  /** `null` for raw binary bodies (`contentType` is then the wildcard media range). */
  schema: z.ZodType | null;
  required: boolean;
  description: string;
}

export interface ResponseSpec {
  status: number;
  description: string;
  /** Expected media type. Absent for empty bodies and for binary bodies of any type. */
  contentType?: string;
  /** Body schema. Absent for empty or binary bodies. */
  schema?: z.ZodType;
  headers: readonly ResponseHeaderSpec[];
}

export interface RouteDefinition {
  operationId: string;
  method: HttpMethod;
  /** Relative to `API_BASE_PATH`, with `{param}` placeholders. */
  path: string;
  tag: string;
  summary: string;
  description: string;
  /** Capability the route requires; `null` for core routes. */
  capability: CapabilityId | null;
  /** True when the route is reachable without credentials. */
  public: boolean;
  pathParams: Readonly<Record<string, z.ZodType>>;
  query: z.ZodObject | null;
  requestHeaders: readonly RequestHeaderSpec[];
  requestBody: RequestBodySpec | null;
  responses: readonly ResponseSpec[];
  /** Every error code the route may return, including the common ones. */
  errors: readonly ErrorCode[];
}

/** Error codes any authenticated route may return. */
export const COMMON_ERRORS: readonly ErrorCode[] = ["unauthenticated", "rate_limited", "internal_error", "service_unavailable"];

const JSON_CT = "application/json";
const IF_MATCH_HEADER: RequestHeaderSpec = {
  name: "If-Match",
  requirement: "conditional",
  description: "Strong entity tag of the revision being replaced or deleted, for example `\"01J...\"`. `*` is not accepted.",
};
const IF_NONE_MATCH_HEADER: RequestHeaderSpec = {
  name: "If-None-Match",
  requirement: "conditional",
  description: "Only the value `*`: create the page only if it does not exist.",
};
const idempotencyHeader = (requirement: "required" | "optional", extra = ""): RequestHeaderSpec => ({
  name: "Idempotency-Key",
  requirement,
  description: `Opaque key of 1 to 255 visible ASCII characters (a UUID is recommended). A replay with the same key and request returns the original response; the same key with a different request is 422 idempotency_key_reused.${extra}`,
});
const ETAG_HEADER: ResponseHeaderSpec = { name: "ETag", description: "Strong entity tag of the page revision in the body: the revision ID in double quotes." };
const LOCATION_HEADER: ResponseHeaderSpec = { name: "Location", description: "Absolute path of the created resource." };

const workspaceParams = { workspaceId: WorkspaceIdSchema } as const;
const pageParams = { workspaceId: WorkspaceIdSchema, pageId: PageIdSchema } as const;

interface RouteInit {
  operationId: string;
  method: HttpMethod;
  path: string;
  tag: string;
  summary: string;
  description: string;
  capability?: CapabilityId;
  public?: boolean;
  pathParams?: Record<string, z.ZodType>;
  query?: z.ZodObject;
  requestHeaders?: RequestHeaderSpec[];
  requestBody?: RequestBodySpec;
  responses: ResponseSpec[];
  errors?: ErrorCode[];
}

function route(init: RouteInit): RouteDefinition {
  const errors = new Set<ErrorCode>(init.errors ?? []);
  if (!init.public) for (const code of COMMON_ERRORS) errors.add(code);
  if (init.capability) errors.add("capability_not_supported");
  return {
    operationId: init.operationId,
    method: init.method,
    path: init.path,
    tag: init.tag,
    summary: init.summary,
    description: init.description,
    capability: init.capability ?? null,
    public: init.public ?? false,
    pathParams: init.pathParams ?? {},
    query: init.query ?? null,
    requestHeaders: init.requestHeaders ?? [],
    requestBody: init.requestBody ?? null,
    responses: init.responses,
    errors: [...errors].sort((a, b) => ERROR_CODES[a].status - ERROR_CODES[b].status || a.localeCompare(b)),
  };
}

const json = (status: number, description: string, schema: z.ZodType, headers: readonly ResponseHeaderSpec[] = []): ResponseSpec => ({
  status,
  description,
  contentType: JSON_CT,
  schema,
  headers,
});

export const ROUTES: readonly RouteDefinition[] = [
  route({
    operationId: "getCapabilities",
    method: "get",
    path: "/capabilities",
    tag: "Discovery",
    summary: "Protocol version and optional capabilities",
    description: "Reachable without credentials so clients can discover the server before signing in. Clients MUST NOT assume a capability that is not listed.",
    public: true,
    responses: [json(200, "Capabilities of this server.", CapabilitiesSchema)],
    errors: ["rate_limited", "internal_error", "service_unavailable"],
  }),
  route({
    operationId: "getMe",
    method: "get",
    path: "/me",
    tag: "Identity",
    summary: "The authenticated principal",
    description: "Returns the principal the bearer credential resolves to.",
    responses: [json(200, "The principal.", MeSchema)],
  }),
  route({
    operationId: "listWorkspaces",
    method: "get",
    path: "/workspaces",
    tag: "Identity",
    summary: "Workspaces the principal belongs to",
    description: "Lists only workspaces the principal is a member of, each with the principal's role.",
    query: PaginationQuerySchema,
    responses: [json(200, "A page of workspaces.", WorkspaceListSchema)],
    errors: ["validation_failed", "cursor_invalid"],
  }),
  route({
    operationId: "getWorkspaceTree",
    method: "get",
    path: "/workspaces/{workspaceId}/tree",
    tag: "Pages",
    summary: "Page hierarchy of a workspace",
    description: "Paginated adjacency list of the pages the principal can read, plus a change cursor to continue from.",
    pathParams: workspaceParams,
    query: PaginationQuerySchema,
    responses: [json(200, "A page of tree nodes.", TreePageSchema)],
    errors: ["not_found", "validation_failed", "cursor_invalid"],
  }),
  route({
    operationId: "getPage",
    method: "get",
    path: "/workspaces/{workspaceId}/pages/{pageId}",
    tag: "Pages",
    summary: "Read a page",
    description: "Returns the Markdown source of the current revision, or of the revision named by the `revision` query parameter. The ETag header is the revision's entity tag.",
    pathParams: pageParams,
    query: GetPageQuerySchema,
    responses: [json(200, "The page.", PageResourceSchema, [ETAG_HEADER])],
    errors: ["not_found", "validation_failed"],
  }),
  route({
    operationId: "putPage",
    method: "put",
    path: "/workspaces/{workspaceId}/pages/{pageId}",
    tag: "Pages",
    summary: "Create or update a page",
    description:
      "Conditional write. Create with `If-None-Match: *` (201). Update with `If-Match: <etag>` (200). A write with neither header is 428 `precondition_required`; both headers is 400. A stale `If-Match`, or `If-None-Match: *` on an existing page, is 412 `revision_conflict` carrying `currentRevision`; the server never overwrites silently. Every successful write creates a new immutable revision.",
    pathParams: pageParams,
    requestHeaders: [IF_MATCH_HEADER, IF_NONE_MATCH_HEADER, idempotencyHeader("optional")],
    requestBody: { contentType: JSON_CT, schema: PageWriteSchema, required: true, description: "New title, Markdown source, and optional parent." },
    responses: [
      json(200, "The page was updated; a new revision was created.", PageResourceSchema, [ETAG_HEADER]),
      json(201, "The page was created.", PageResourceSchema, [ETAG_HEADER]),
    ],
    errors: ["validation_failed", "forbidden", "not_found", "revision_conflict", "payload_too_large", "idempotency_key_reused", "precondition_required"],
  }),
  route({
    operationId: "deletePage",
    method: "delete",
    path: "/workspaces/{workspaceId}/pages/{pageId}",
    tag: "Pages",
    summary: "Delete a page",
    description: "Requires `If-Match`. The server records the deletion in the change feed. Retention of earlier revisions is unspecified (see open questions).",
    pathParams: pageParams,
    requestHeaders: [{ ...IF_MATCH_HEADER, requirement: "required" }, idempotencyHeader("optional")],
    responses: [{ status: 204, description: "The page was deleted.", headers: [] }],
    errors: ["validation_failed", "forbidden", "not_found", "revision_conflict", "idempotency_key_reused", "precondition_required"],
  }),
  route({
    operationId: "listPageRevisions",
    method: "get",
    path: "/workspaces/{workspaceId}/pages/{pageId}/revisions",
    tag: "Revisions",
    summary: "List the revisions of a page",
    description: "Newest first. Revision entries are immutable: once listed, an entry never changes.",
    pathParams: pageParams,
    query: PaginationQuerySchema,
    responses: [json(200, "A page of revisions.", RevisionListSchema)],
    errors: ["not_found", "validation_failed", "cursor_invalid"],
  }),
  route({
    operationId: "searchWorkspace",
    method: "post",
    path: "/workspaces/{workspaceId}/search",
    tag: "Search",
    summary: "Full-text search",
    description: "Read-only despite the POST verb. Results are limited to pages the principal can read. The index may lag writes by a short time.",
    capability: "search",
    pathParams: workspaceParams,
    requestBody: { contentType: JSON_CT, schema: SearchRequestSchema, required: true, description: "Query and paging." },
    responses: [json(200, "A page of hits.", SearchResponseSchema)],
    errors: ["not_found", "validation_failed", "cursor_invalid"],
  }),
  route({
    operationId: "uploadAttachment",
    method: "post",
    path: "/workspaces/{workspaceId}/attachments",
    tag: "Attachments",
    summary: "Upload an attachment",
    description: "Single-request upload. The body is the raw bytes and `Content-Type` is the MIME type.",
    capability: "attachments",
    pathParams: workspaceParams,
    query: UploadAttachmentQuerySchema,
    requestHeaders: [idempotencyHeader("optional")],
    requestBody: { contentType: "*/*", schema: null, required: true, description: "Raw attachment bytes. The declared Content-Type is stored as the attachment MIME type." },
    responses: [json(201, "The attachment was stored.", AttachmentResourceSchema, [LOCATION_HEADER])],
    errors: ["validation_failed", "forbidden", "not_found", "payload_too_large", "unsupported_media_type", "idempotency_key_reused"],
  }),
  route({
    operationId: "getAttachment",
    method: "get",
    path: "/workspaces/{workspaceId}/attachments/{attachmentId}",
    tag: "Attachments",
    summary: "Download an attachment",
    description: "Returns the stored bytes with the original Content-Type. An addition to the spec section 8 endpoint list, needed so uploaded bytes can be read back.",
    capability: "attachments",
    pathParams: { workspaceId: WorkspaceIdSchema, attachmentId: AttachmentIdSchema },
    responses: [{ status: 200, description: "The attachment bytes, with the stored Content-Type.", headers: [] }],
    errors: ["not_found", "validation_failed"],
  }),
  route({
    operationId: "listWorkspaceChanges",
    method: "get",
    path: "/workspaces/{workspaceId}/changes",
    tag: "Changes",
    summary: "Change feed",
    description: "Source of truth for changes. Returns entries after `cursor` in a stable order, a continuation cursor, and `hasMore`. SSE events are only hints to call this route.",
    pathParams: workspaceParams,
    query: ChangesQuerySchema,
    responses: [json(200, "A page of change entries.", ChangesResponseSchema)],
    errors: ["not_found", "validation_failed", "cursor_invalid", "cursor_expired"],
  }),
  route({
    operationId: "streamWorkspaceEvents",
    method: "get",
    path: "/workspaces/{workspaceId}/events",
    tag: "Changes",
    summary: "Server-sent change hints",
    description: "`text/event-stream`. Emits `event: changes` with a ChangeHintEvent payload when the change feed advances. A hint is not data; clients fetch the change feed from their own cursor and MUST be able to recover missed events that way.",
    capability: "events.sse",
    pathParams: workspaceParams,
    responses: [{ status: 200, description: "An event stream.", contentType: "text/event-stream", headers: [] }],
    errors: ["not_found"],
  }),
  route({
    operationId: "createTransfer",
    method: "post",
    path: "/workspaces/{workspaceId}/transfers",
    tag: "Transfers",
    summary: "Create a transfer operation",
    description: "Registers and stages a transfer. `Idempotency-Key` is required and MUST equal the body `operationId`. For `from_workspace` the server rejects restricted workspaces with 403 `export_restricted`.",
    capability: "transfers",
    pathParams: workspaceParams,
    requestHeaders: [idempotencyHeader("required", " MUST equal the body `operationId`.")],
    requestBody: { contentType: JSON_CT, schema: TransferCreateRequestSchema, required: true, description: "The transfer plan." },
    responses: [json(201, "The transfer was created and staged.", TransferResourceSchema, [LOCATION_HEADER])],
    errors: ["validation_failed", "forbidden", "export_restricted", "not_found", "payload_too_large", "idempotency_key_reused"],
  }),
  route({
    operationId: "getTransfer",
    method: "get",
    path: "/transfers/{operationId}",
    tag: "Transfers",
    summary: "Read a transfer operation",
    description: "Returns the recorded state of a transfer. Visible only to principals with access to its workspace.",
    capability: "transfers",
    pathParams: { operationId: TransferOperationIdSchema },
    responses: [json(200, "The transfer.", TransferResourceSchema)],
    errors: ["not_found", "validation_failed"],
  }),
  route({
    operationId: "commitTransfer",
    method: "post",
    path: "/transfers/{operationId}/commit",
    tag: "Transfers",
    summary: "Commit a transfer",
    description:
      "`to_workspace`: atomically publishes the staged pages (COMMIT_DESTINATION). `from_workspace`: confirms the client committed and verified the destination; for `move` the body `verified` is required and the server deletes a source page only when its current revision equals the verified revision. Committing a completed transfer returns it unchanged.",
    capability: "transfers",
    pathParams: { operationId: TransferOperationIdSchema },
    requestHeaders: [idempotencyHeader("optional")],
    requestBody: { contentType: JSON_CT, schema: TransferCommitRequestSchema, required: false, description: "Verification results for from_workspace transfers." },
    responses: [json(200, "The transfer after commit.", TransferResourceSchema)],
    errors: ["validation_failed", "forbidden", "not_found", "invalid_transfer_state", "idempotency_key_reused"],
  }),
  route({
    operationId: "abortTransfer",
    method: "post",
    path: "/transfers/{operationId}/abort",
    tag: "Transfers",
    summary: "Abort a transfer",
    description: "Discards uncommitted staged items. Aborting an already aborted transfer returns it unchanged; a committed transfer is 409 `invalid_transfer_state`.",
    capability: "transfers",
    pathParams: { operationId: TransferOperationIdSchema },
    requestHeaders: [idempotencyHeader("optional")],
    responses: [json(200, "The transfer after abort.", TransferResourceSchema)],
    errors: ["forbidden", "not_found", "invalid_transfer_state", "idempotency_key_reused"],
  }),
];

export function getRoute(operationId: string): RouteDefinition {
  const found = ROUTES.find((r) => r.operationId === operationId);
  if (!found) throw new Error(`Unknown operationId: ${operationId}`);
  return found;
}

/** Names of the `{param}` placeholders in a path template. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1]!);
}

/** Full request path (with `/api/v1`) for a route, percent-encoding parameters. */
export function buildRequestPath(r: RouteDefinition, params: Record<string, string> = {}): string {
  const path = r.path.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing path parameter ${name} for ${r.operationId}`);
    return encodeURIComponent(value);
  });
  return `${API_BASE_PATH}${path}`;
}

/** Statuses a route may legitimately return: its success statuses and the statuses of its error codes. */
export function allowedStatuses(r: RouteDefinition): number[] {
  return [...new Set([...r.responses.map((x) => x.status), ...r.errors.map((c) => ERROR_CODES[c].status)])].sort((a, b) => a - b);
}

/** Response schema for a status, `ProblemDetails` (or the conflict problem) for errors. */
export function responseSchemaFor(r: RouteDefinition, status: number): z.ZodType | undefined {
  const success = r.responses.find((x) => x.status === status);
  if (success) return success.schema;
  if (status === 412 && r.errors.includes("revision_conflict")) return RevisionConflictProblemSchema;
  return ProblemDetailsSchema;
}
