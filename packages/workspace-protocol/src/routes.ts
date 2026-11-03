import { z } from "zod";
import { API_BASE_PATH, OpaqueIdSchema, PaginationQuerySchema, WorkspaceIdSchema } from "./common.ts";
import { CapabilitiesSchema, type CapabilityId } from "./capabilities.ts";
import { ERROR_CODES, ProblemDetailsSchema, type ErrorCode } from "./errors.ts";
import { MemberSchema, MeSchema, WorkspaceListSchema, WorkspaceSchema } from "./identity.ts";
import { GetPageQuerySchema, PageIdSchema, PageMoveSchema, PageResourceSchema, PageWriteSchema, RevisionConflictProblemSchema, RevisionListSchema } from "./pages.ts";
import { TreeNodeSchema, TreePageSchema } from "./tree.ts";
import { SearchRequestSchema, SearchResponseSchema } from "./search.ts";
import { AttachmentIdSchema, AttachmentResourceSchema, UploadAttachmentQuerySchema } from "./attachments.ts";
import { ChangesQuerySchema, ChangesResponseSchema } from "./changes.ts";
import { TransferCommitRequestSchema, TransferCreateRequestSchema, TransferOperationIdSchema, TransferResourceSchema } from "./transfers.ts";
import { ShareLinkCreateRequestSchema, ShareLinkCreatedSchema, ShareLinkIdSchema, ShareLinkListSchema } from "./shares.ts";
import { InviteAcceptRequestSchema, InviteAcceptedSchema, InviteLinkCreateRequestSchema, InviteLinkCreatedSchema, InviteLinkIdSchema, InviteLinkListSchema, MemberListSchema, MemberRoleChangeSchema } from "./members.ts";
import { DeletedWorkspaceListSchema, WorkspaceCreateRequestSchema, WorkspaceRenameSchema } from "./workspaces.ts";
import { FeedbackRequestSchema } from "./feedback.ts";
import { PageVisibilitySchema, PageVisibilityWriteSchema, TeamIdSchema, TeamListSchema, TeamPageListSchema, TeamSchema, TeamWriteSchema } from "./teams.ts";
import { TrashListSchema, TrashRestoredSchema } from "./trash.ts";
import { PresenceListSchema } from "./presence.ts";

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
  /** A public route that also reads a bearer credential when one is sent (sendFeedback). */
  optionalAuth: boolean;
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
const memberParams = { workspaceId: WorkspaceIdSchema, userId: OpaqueIdSchema } as const;
const teamParams = { workspaceId: WorkspaceIdSchema, teamId: TeamIdSchema } as const;
const teamMemberParams = { workspaceId: WorkspaceIdSchema, teamId: TeamIdSchema, userId: OpaqueIdSchema } as const;

interface RouteInit {
  operationId: string;
  method: HttpMethod;
  path: string;
  tag: string;
  summary: string;
  description: string;
  capability?: CapabilityId;
  public?: boolean;
  optionalAuth?: boolean;
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
    optionalAuth: init.optionalAuth ?? false,
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
    description: "Paginated adjacency list of the pages the principal can read, plus a change cursor to continue from. A server that lists capability `page-kind` also returns each page's `kind` (`page` or `folder`), so a client can draw folders without reading page content.",
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
      "Conditional write. Create with `If-None-Match: *` (201). Update with `If-Match: <etag>` (200). A write with neither header is 428 `precondition_required`; both headers is 400. A stale `If-Match`, or `If-None-Match: *` on an existing page, is 412 `revision_conflict` carrying `currentRevision`; the server never overwrites silently. Every successful write creates a new immutable revision. A server that lists capability `page-kind` derives the page's `kind` from the frontmatter key `thoth_kind` of the Markdown it receives (ADR-0017); clients do not send it.",
    pathParams: pageParams,
    requestHeaders: [IF_MATCH_HEADER, IF_NONE_MATCH_HEADER, idempotencyHeader("optional")],
    requestBody: { contentType: JSON_CT, schema: PageWriteSchema, required: true, description: "New title, Markdown source, and optional parent." },
    responses: [
      json(200, "The page was updated; a new revision was created.", PageResourceSchema, [ETAG_HEADER]),
      json(201, "The page was created.", PageResourceSchema, [ETAG_HEADER]),
    ],
    errors: ["validation_failed", "forbidden", "not_found", "revision_conflict", "quota_exceeded", "payload_too_large", "idempotency_key_reused", "precondition_required"],
  }),
  route({
    operationId: "movePage",
    method: "post",
    path: "/workspaces/{workspaceId}/pages/{pageId}/move",
    tag: "Pages",
    summary: "Move or reorder a page without a new revision",
    description:
      "Metadata-only change of the page's parent and/or sibling position (capability `page-order`). `If-Match` is required and names the page's current revision: a stale one is 412 `revision_conflict`, none is 428. No revision is created, so the ETag is unchanged; the change feed records `page.updated` with the current revision. Moving a page under itself or one of its descendants is 400.",
    capability: "page-order",
    pathParams: pageParams,
    requestHeaders: [{ ...IF_MATCH_HEADER, requirement: "required" }, idempotencyHeader("optional")],
    requestBody: { contentType: JSON_CT, schema: PageMoveSchema, required: true, description: "New parent and/or position; at least one member." },
    responses: [json(200, "The page's tree node after the move.", TreeNodeSchema, [ETAG_HEADER])],
    errors: ["validation_failed", "forbidden", "not_found", "revision_conflict", "idempotency_key_reused", "precondition_required"],
  }),
  route({
    operationId: "deletePage",
    method: "delete",
    path: "/workspaces/{workspaceId}/pages/{pageId}",
    tag: "Pages",
    summary: "Delete a page",
    description: "Requires `If-Match`. The server records the deletion in the change feed. With capability `trash` the page is in the workspace's Trash for 30 days (listTrash), then removed for good with its revisions (ADR-0043); without it, retention is unspecified (see open questions).",
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
    errors: ["validation_failed", "forbidden", "not_found", "quota_exceeded", "payload_too_large", "unsupported_media_type", "idempotency_key_reused"],
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
    errors: ["validation_failed", "forbidden", "export_restricted", "not_found", "quota_exceeded", "payload_too_large", "idempotency_key_reused"],
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
    errors: ["validation_failed", "forbidden", "not_found", "invalid_transfer_state", "quota_exceeded", "idempotency_key_reused"],
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
  route({
    operationId: "createShareLink",
    method: "post",
    path: "/workspaces/{workspaceId}/pages/{pageId}/share-links",
    tag: "Sharing",
    summary: "Create a public read-only link to a page",
    description:
      "ADR-0023. Owners and editors only. The link shows the page and its sub-pages, read-only and without sign-in, at the returned `url` (`<origin>/s/<token>`). The token is returned this once: the server stores only its hash. `Idempotency-Key` is not honoured (a replay would have to store the token); a retry makes a second link. 403 `export_restricted` in a workspace that forbids exporting; 409 `quota_exceeded` (`quota: shareLinksPerWorkspace`) past the server's limit of active links.",
    capability: "public-share",
    pathParams: pageParams,
    requestBody: { contentType: JSON_CT, schema: ShareLinkCreateRequestSchema, required: false, description: "The expiry: 7, 30 or 90 days, or null for never. Absent means 30 days." },
    responses: [json(201, "The link, with its token and address (shown once).", ShareLinkCreatedSchema)],
    errors: ["validation_failed", "forbidden", "export_restricted", "not_found", "quota_exceeded"],
  }),
  route({
    operationId: "listShareLinks",
    method: "get",
    path: "/workspaces/{workspaceId}/pages/{pageId}/share-links",
    tag: "Sharing",
    summary: "Active share links of a page",
    description: "Owners and editors only. The links of the page that are neither revoked nor expired, newest first. Tokens are never returned here.",
    capability: "public-share",
    pathParams: pageParams,
    query: PaginationQuerySchema,
    responses: [json(200, "A page of share links.", ShareLinkListSchema)],
    errors: ["validation_failed", "forbidden", "not_found", "cursor_invalid"],
  }),
  route({
    operationId: "revokeShareLink",
    method: "delete",
    path: "/workspaces/{workspaceId}/share-links/{linkId}",
    tag: "Sharing",
    summary: "Revoke a share link",
    description: "Owners and editors only. The link stops working at once. Revoking a link that is already revoked or expired succeeds and changes nothing.",
    capability: "public-share",
    pathParams: { workspaceId: WorkspaceIdSchema, linkId: ShareLinkIdSchema },
    requestHeaders: [idempotencyHeader("optional")],
    responses: [{ status: 204, description: "Revoked.", headers: [] }],
    errors: ["validation_failed", "forbidden", "not_found", "idempotency_key_reused"],
  }),
  route({
    operationId: "listMembers",
    method: "get",
    path: "/workspaces/{workspaceId}/members",
    tag: "Members",
    summary: "Members of a workspace",
    description: "ADR-0024. Every member may read the list: display names and roles, never emails. Ordered by user ID.",
    capability: "members",
    pathParams: workspaceParams,
    query: PaginationQuerySchema,
    responses: [json(200, "A page of members.", MemberListSchema)],
    errors: ["validation_failed", "not_found", "cursor_invalid"],
  }),
  route({
    operationId: "setMemberRole",
    method: "put",
    path: "/workspaces/{workspaceId}/members/{userId}",
    tag: "Members",
    summary: "Change a member's role",
    description:
      "Owners and managers (403 for others; 404 for non-members and for a user who is not a member). Only owners make someone an owner or change an owner's role (ADR-0043): a manager doing so is 403. Making someone an owner counts against that account's `maxWorkspacesPerAccount` (409 `quota_exceeded`, `quota: workspacesPerAccount`). Demoting the last owner is 409 `last_owner`. Setting the role a member already has succeeds and changes nothing.",
    capability: "members",
    pathParams: memberParams,
    requestHeaders: [idempotencyHeader("optional")],
    requestBody: { contentType: JSON_CT, schema: MemberRoleChangeSchema, required: true, description: "The new role." },
    responses: [json(200, "The member with the new role.", MemberSchema)],
    errors: ["validation_failed", "forbidden", "not_found", "last_owner", "quota_exceeded", "idempotency_key_reused"],
  }),
  route({
    operationId: "removeMember",
    method: "delete",
    path: "/workspaces/{workspaceId}/members/{userId}",
    tag: "Members",
    summary: "Remove a member, or leave",
    description:
      "Owners remove any member; managers remove any member who is not an owner (403 for an owner, ADR-0043); any member removes themself (leaves). Access ends at once: the removed account's requests to the workspace are 404 from then on, and share links it made stop working. Removing the last owner, or the last owner leaving, is 409 `last_owner`.",
    capability: "members",
    pathParams: memberParams,
    requestHeaders: [idempotencyHeader("optional")],
    responses: [{ status: 204, description: "Removed.", headers: [] }],
    errors: ["validation_failed", "forbidden", "not_found", "last_owner", "idempotency_key_reused"],
  }),
  route({
    operationId: "createInviteLink",
    method: "post",
    path: "/workspaces/{workspaceId}/invite-links",
    tag: "Members",
    summary: "Create an invite link",
    description:
      "ADR-0024, ADR-0043. Owners and managers. A link works while its creator is still an owner or a manager. Whoever opens the returned `url` (`<origin>/i/<token>`) and signs in joins with `role`. The token is returned this once: the server stores only its hash, so `Idempotency-Key` is not honoured. 409 `quota_exceeded` past the server's number of active links (`quota: inviteLinksPerWorkspace`) or when `maxUses` is more than the member quota leaves room for (`quota: membersPerWorkspace`).",
    capability: "invite-links",
    pathParams: workspaceParams,
    requestBody: { contentType: JSON_CT, schema: InviteLinkCreateRequestSchema, required: true, description: "The role, and optionally the expiry (1, 7 or 30 days; default 7) and the number of uses (1, 5 or 10; default 1)." },
    responses: [json(201, "The link, with its token and address (shown once).", InviteLinkCreatedSchema)],
    errors: ["validation_failed", "forbidden", "not_found", "quota_exceeded"],
  }),
  route({
    operationId: "listInviteLinks",
    method: "get",
    path: "/workspaces/{workspaceId}/invite-links",
    tag: "Members",
    summary: "Active invite links of a workspace",
    description: "Owners and managers. Links that are neither revoked, expired nor used up, newest first. Tokens are never returned here.",
    capability: "invite-links",
    pathParams: workspaceParams,
    query: PaginationQuerySchema,
    responses: [json(200, "A page of invite links.", InviteLinkListSchema)],
    errors: ["validation_failed", "forbidden", "not_found", "cursor_invalid"],
  }),
  route({
    operationId: "revokeInviteLink",
    method: "delete",
    path: "/workspaces/{workspaceId}/invite-links/{inviteId}",
    tag: "Members",
    summary: "Revoke an invite link",
    description: "Owners and managers. The link stops working at once. Revoking a link that is already revoked, expired or used up succeeds and changes nothing.",
    capability: "invite-links",
    pathParams: { workspaceId: WorkspaceIdSchema, inviteId: InviteLinkIdSchema },
    requestHeaders: [idempotencyHeader("optional")],
    responses: [{ status: 204, description: "Revoked.", headers: [] }],
    errors: ["validation_failed", "forbidden", "not_found", "idempotency_key_reused"],
  }),
  route({
    operationId: "acceptInvite",
    method: "post",
    path: "/invites/accept",
    tag: "Members",
    summary: "Join a workspace with an invite link",
    description:
      "Any signed-in account. The same 404 for a token that is unknown, malformed, expired, revoked, used up or from another server. A member already in the workspace keeps their role and uses nothing (`joined: false`). 409 `quota_exceeded` (`quota: membersPerWorkspace`) when the workspace is full. Rate limited per client address.",
    capability: "invite-links",
    requestBody: { contentType: JSON_CT, schema: InviteAcceptRequestSchema, required: true, description: "The token from the link." },
    responses: [json(200, "The workspace joined (or already a member of).", InviteAcceptedSchema)],
    errors: ["validation_failed", "not_found", "quota_exceeded"],
  }),
  route({
    operationId: "createWorkspace",
    method: "post",
    path: "/workspaces",
    tag: "Workspaces",
    summary: "Create a workspace",
    description:
      "ADR-0025. Any signed-in account; the caller becomes its only member, as owner. The name is trimmed and must then be 1 to 200 characters. 409 `quota_exceeded` when the caller already owns `maxWorkspacesPerAccount` workspaces (`quota: workspacesPerAccount`; deleted workspaces count until they are purged) or created too many today (`quota: workspaceCreationsPerDay`, with `Retry-After`). A retry with the same `Idempotency-Key` returns the workspace created the first time.",
    capability: "workspace-management",
    requestHeaders: [idempotencyHeader("optional")],
    requestBody: { contentType: JSON_CT, schema: WorkspaceCreateRequestSchema, required: true, description: "The name, and whether exporting out of the workspace is refused (default false)." },
    responses: [json(201, "The new workspace, as the caller sees it in listWorkspaces.", WorkspaceSchema)],
    errors: ["validation_failed", "quota_exceeded", "idempotency_key_reused"],
  }),
  route({
    operationId: "renameWorkspace",
    method: "put",
    path: "/workspaces/{workspaceId}/name",
    tag: "Workspaces",
    summary: "Rename a workspace",
    description: "ADR-0025. Owners only (403 for other members, 404 for non-members and deleted workspaces). The name is trimmed and must then be 1 to 200 characters. Setting the name it already has succeeds and changes nothing.",
    capability: "workspace-management",
    pathParams: workspaceParams,
    requestHeaders: [idempotencyHeader("optional")],
    requestBody: { contentType: JSON_CT, schema: WorkspaceRenameSchema, required: true, description: "The new name." },
    responses: [json(200, "The workspace with its new name.", WorkspaceSchema)],
    errors: ["validation_failed", "forbidden", "not_found", "idempotency_key_reused"],
  }),
  route({
    operationId: "deleteWorkspace",
    method: "delete",
    path: "/workspaces/{workspaceId}",
    tag: "Workspaces",
    summary: "Delete a workspace (restorable for 30 days)",
    description:
      "ADR-0025. Owners only. From then on every route of the workspace is 404 for every member, it is no longer listed, and its share links and invite links stop working for good (a restore does not bring them back). Its owners see it in listDeletedWorkspaces and can restore it for 30 days; then the server purges it with its pages, revisions and attachments. It keeps counting toward its owners' `maxWorkspacesPerAccount` until it is purged.",
    capability: "workspace-management",
    pathParams: workspaceParams,
    requestHeaders: [idempotencyHeader("optional")],
    responses: [{ status: 204, description: "Deleted.", headers: [] }],
    errors: ["validation_failed", "forbidden", "not_found", "idempotency_key_reused"],
  }),
  route({
    operationId: "listDeletedWorkspaces",
    method: "get",
    path: "/deleted-workspaces",
    tag: "Workspaces",
    summary: "Recently deleted workspaces the caller can restore",
    description: "ADR-0025. The deleted workspaces where the caller is an owner and that can still be restored, newest first.",
    capability: "workspace-management",
    query: PaginationQuerySchema,
    responses: [json(200, "A page of deleted workspaces.", DeletedWorkspaceListSchema)],
    errors: ["validation_failed", "cursor_invalid"],
  }),
  route({
    operationId: "restoreWorkspace",
    method: "post",
    path: "/deleted-workspaces/{workspaceId}/restore",
    tag: "Workspaces",
    summary: "Restore a deleted workspace",
    description:
      "ADR-0025. Owners of the deleted workspace only (403 for its other members; 404 for anyone else, for a workspace that is not deleted and for one past its 30 days). Its pages, members and roles come back as they were; its share links and invite links do not.",
    capability: "workspace-management",
    pathParams: workspaceParams,
    requestHeaders: [idempotencyHeader("optional")],
    responses: [json(200, "The restored workspace.", WorkspaceSchema)],
    errors: ["validation_failed", "forbidden", "not_found", "idempotency_key_reused"],
  }),
  route({
    operationId: "purgeWorkspace",
    method: "delete",
    path: "/deleted-workspaces/{workspaceId}",
    tag: "Workspaces",
    summary: "Delete a deleted workspace permanently, now",
    description:
      "ADR-0025. Owners of the deleted workspace only, with the same answers as restoreWorkspace. Removes it with its pages, revisions and attachments at once, so it stops counting toward its owners' `maxWorkspacesPerAccount`. This cannot be undone.",
    capability: "workspace-management",
    pathParams: workspaceParams,
    requestHeaders: [idempotencyHeader("optional")],
    responses: [{ status: 204, description: "Purged.", headers: [] }],
    errors: ["validation_failed", "forbidden", "not_found", "idempotency_key_reused"],
  }),  route({
    operationId: "listTeams",
    method: "get",
    path: "/workspaces/{workspaceId}/teams",
    tag: "Teams",
    summary: "Teams of a workspace",
    description: "ADR-0042. Every member may read the list: each team's name and its members' user IDs. At most `TEAMS_MAX` (100) teams, all in one response, by name.",
    capability: "teams",
    pathParams: workspaceParams,
    responses: [json(200, "Every team of the workspace.", TeamListSchema)],
    errors: ["not_found"],
  }),
  route({
    operationId: "createTeam",
    method: "post",
    path: "/workspaces/{workspaceId}/teams",
    tag: "Teams",
    summary: "Create a team",
    description: "Owners and managers (403 for others). A name of 1 to 100 characters. 409 `quota_exceeded` (`quota: teamsPerWorkspace`) past 100 teams.",
    capability: "teams",
    pathParams: workspaceParams,
    requestHeaders: [idempotencyHeader("optional")],
    requestBody: { contentType: JSON_CT, schema: TeamWriteSchema, required: true, description: "The name." },
    responses: [json(201, "The new team, with no members.", TeamSchema)],
    errors: ["validation_failed", "forbidden", "not_found", "quota_exceeded", "idempotency_key_reused"],
  }),
  route({
    operationId: "renameTeam",
    method: "put",
    path: "/workspaces/{workspaceId}/teams/{teamId}",
    tag: "Teams",
    summary: "Rename a team",
    description: "Owners and managers (403 for others; 404 for an unknown team).",
    capability: "teams",
    pathParams: teamParams,
    requestHeaders: [idempotencyHeader("optional")],
    requestBody: { contentType: JSON_CT, schema: TeamWriteSchema, required: true, description: "The new name." },
    responses: [json(200, "The renamed team.", TeamSchema)],
    errors: ["validation_failed", "forbidden", "not_found", "idempotency_key_reused"],
  }),
  route({
    operationId: "deleteTeam",
    method: "delete",
    path: "/workspaces/{workspaceId}/teams/{teamId}",
    tag: "Teams",
    summary: "Delete a team",
    description:
      "Owners and managers. Pages limited to this team stay limited to their other teams; a page left with no team is seen by owners and managers only (deleting a team never shows a page to more people). Older change cursors expire (410 `cursor_expired`).",
    capability: "teams",
    pathParams: teamParams,
    requestHeaders: [idempotencyHeader("optional")],
    responses: [{ status: 204, description: "Deleted.", headers: [] }],
    errors: ["validation_failed", "forbidden", "not_found", "idempotency_key_reused"],
  }),
  route({
    operationId: "addTeamMember",
    method: "put",
    path: "/workspaces/{workspaceId}/teams/{teamId}/members/{userId}",
    tag: "Teams",
    summary: "Add a member to a team",
    description: "Owners and managers. The user must be a member of the workspace (404 otherwise). Adding someone already in the team succeeds and changes nothing. Older change cursors expire (410 `cursor_expired`).",
    capability: "teams",
    pathParams: teamMemberParams,
    requestHeaders: [idempotencyHeader("optional")],
    responses: [json(200, "The team.", TeamSchema)],
    errors: ["validation_failed", "forbidden", "not_found", "idempotency_key_reused"],
  }),
  route({
    operationId: "removeTeamMember",
    method: "delete",
    path: "/workspaces/{workspaceId}/teams/{teamId}/members/{userId}",
    tag: "Teams",
    summary: "Remove a member from a team",
    description: "Owners and managers. Removing someone who is not in the team succeeds and changes nothing. Older change cursors expire (410 `cursor_expired`).",
    capability: "teams",
    pathParams: teamMemberParams,
    requestHeaders: [idempotencyHeader("optional")],
    responses: [json(200, "The team.", TeamSchema)],
    errors: ["validation_failed", "forbidden", "not_found", "idempotency_key_reused"],
  }),
  route({
    operationId: "getPageVisibility",
    method: "get",
    path: "/workspaces/{workspaceId}/pages/{pageId}/visibility",
    tag: "Teams",
    summary: "Who sees a page",
    description: "Owners and managers (403 for others). 404 for a page the caller cannot see.",
    capability: "teams",
    pathParams: pageParams,
    responses: [json(200, "The page's teams, or null for no limit on the page itself.", PageVisibilitySchema)],
    errors: ["validation_failed", "forbidden", "not_found"],
  }),
  route({
    operationId: "setPageVisibility",
    method: "put",
    path: "/workspaces/{workspaceId}/pages/{pageId}/visibility",
    tag: "Teams",
    summary: "Limit a page, and everything below it, to some teams",
    description:
      "Owners and managers (403 for others; 404 for a page the caller cannot see). `teamIds`: one or more teams of this workspace, or `null` for everyone. The limit applies to the page and every page below it, and to pages moved under it later. Members in none of the teams no longer see them (404); owners and managers always do (ADR-0043). Older change cursors expire (410 `cursor_expired`).",
    capability: "teams",
    pathParams: pageParams,
    requestHeaders: [idempotencyHeader("optional")],
    requestBody: { contentType: JSON_CT, schema: PageVisibilityWriteSchema, required: true, description: "The teams, or null." },
    responses: [json(200, "Who sees the page now.", PageVisibilitySchema)],
    errors: ["validation_failed", "forbidden", "not_found", "idempotency_key_reused"],
  }),
  route({
    operationId: "listTeamPages",
    method: "get",
    path: "/workspaces/{workspaceId}/teams/{teamId}/pages",
    tag: "Teams",
    summary: "Pages limited to a team",
    description:
      "ADR-0043. Owners and managers (403 for others). Every page (not deleted) whose limit names this team, by title, so a client can say what deleting the team changes: `onlyTeam` pages are seen by owners and managers alone once it is gone.",
    capability: "teams",
    pathParams: teamParams,
    responses: [json(200, "The pages limited to this team.", TeamPageListSchema)],
    errors: ["forbidden", "not_found"],
  }),
  route({
    operationId: "listTrash",
    method: "get",
    path: "/workspaces/{workspaceId}/trash",
    tag: "Trash",
    summary: "Deleted pages that can still be restored",
    description:
      "ADR-0043. Owners and managers see every deleted page; editors only those they deleted; viewers get 403. A folder is one item, with the pages deleted below it counted in `pagesBelow`. Pages the caller cannot see are left out. Newest first. An item stays for 30 days (`restorableUntil`), then the server removes it for good.",
    capability: "trash",
    pathParams: workspaceParams,
    query: PaginationQuerySchema,
    responses: [json(200, "A page of deleted pages.", TrashListSchema)],
    errors: ["validation_failed", "forbidden", "not_found", "cursor_invalid"],
  }),
  route({
    operationId: "restoreTrashedPage",
    method: "post",
    path: "/workspaces/{workspaceId}/trash/{pageId}/restore",
    tag: "Trash",
    summary: "Restore a deleted page",
    description:
      "ADR-0043. Owners and managers restore any item of the Trash; editors only one they deleted (404 otherwise, as in listTrash); viewers get 403. The page comes back where it was, or at the top level when that folder is gone for good, with every page deleted below it that the caller may restore; the others stay in the Trash. Each one is `page.created` in the change feed. Restored pages count toward `maxPagesPerWorkspace` (409 `quota_exceeded`).",
    capability: "trash",
    pathParams: pageParams,
    requestHeaders: [idempotencyHeader("optional")],
    responses: [json(200, "The pages that came back, the restored page first.", TrashRestoredSchema)],
    errors: ["validation_failed", "forbidden", "not_found", "quota_exceeded", "idempotency_key_reused"],
  }),
  route({
    operationId: "purgeTrashedPage",
    method: "delete",
    path: "/workspaces/{workspaceId}/trash/{pageId}",
    tag: "Trash",
    summary: "Delete a page for good",
    description:
      "ADR-0043. Owners and managers (403 for others). Removes the page and every page deleted below it, with their revisions, their change-feed entries and their share links; this cannot be undone. A page someone added below it after it was deleted is moved to where the deleted page was, and stays limited to whoever could see it.",
    capability: "trash",
    pathParams: pageParams,
    requestHeaders: [idempotencyHeader("optional")],
    responses: [{ status: 204, description: "Deleted for good.", headers: [] }],
    errors: ["validation_failed", "forbidden", "not_found", "idempotency_key_reused"],
  }),
  route({
    operationId: "heartbeatPresence",
    method: "put",
    path: "/workspaces/{workspaceId}/pages/{pageId}/presence",
    tag: "Presence",
    summary: "Say that the caller has this page open, and read who else has",
    description:
      "ADR-0041. Any member who can read the workspace (viewers too). No body. Send it when the page opens and at least every 15 seconds while it stays open; the server forgets a heartbeat 45 seconds after it arrived. The answer lists the other members who have the page open now (never the caller), with only their user ID and display name. A deleted or unknown page is 404.",
    capability: "presence",
    pathParams: pageParams,
    responses: [json(200, "The other members who have the page open.", PresenceListSchema)],
    errors: ["validation_failed", "not_found"],
  }),
  route({
    operationId: "leavePresence",
    method: "delete",
    path: "/workspaces/{workspaceId}/pages/{pageId}/presence",
    tag: "Presence",
    summary: "Say that the caller closed this page",
    description: "ADR-0041. Removes the caller's heartbeat for the page at once. Leaving a page the caller never sent a heartbeat for succeeds and changes nothing.",
    capability: "presence",
    pathParams: pageParams,
    responses: [{ status: 204, description: "Removed.", headers: [] }],
    errors: ["validation_failed", "not_found"],
  }),
  route({
    operationId: "sendFeedback",
    method: "post",
    path: "/feedback",
    tag: "Feedback",
    summary: "Send a problem, an idea or a question to the server's operator",
    description:
      "ADR-0033. No credentials needed; a valid bearer credential, when sent, ties the feedback to that account (an invalid one is ignored, never 401). The body is strict: only `kind`, `message`, an optional `email`, an optional `context` (client, version, os, language), an optional `diagnostics` (`log`: 1 to 200 printable lines of at most 500 characters, the app log the person chose to attach) and the website form's honeypot `website`. Nothing is stored for a refused request. A request whose honeypot is filled in gets the same 204 and is not stored. Rate limited per client address and per account, a short and a daily window (429 with `Retry-After`). The website's no-JavaScript form may send the same fields form-encoded (`context` as `client`, `version`, `os`, `language`; never `diagnostics`, which a form cannot carry) and gets an HTML page back; such a request must come from an origin the server allows for CORS.",
    capability: "feedback",
    public: true,
    optionalAuth: true,
    requestBody: { contentType: JSON_CT, schema: FeedbackRequestSchema, required: true, description: "The kind, the message, and optionally an email address, the client's description of itself and the app log the person chose to attach." },
    responses: [{ status: 204, description: "Received.", headers: [] }],
    errors: ["validation_failed", "forbidden", "payload_too_large", "unsupported_media_type", "rate_limited", "internal_error", "service_unavailable"],
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
