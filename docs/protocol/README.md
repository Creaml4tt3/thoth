# Thoth workspace protocol

**Status: Draft, Proposed per ADR-0004.** Unstable until finalized in phase P2.
Endpoint shapes may still change. Client login is the sign-in broker ([`sign-in.md`](sign-in.md), section 4).

The protocol is an open, versioned REST API between Thoth clients and any compatible
workspace server. The Thoth reference server is one implementation, not the only one.
This document and `protocol/openapi.yaml` are meant to be sufficient to implement a
server or a client without reading Thoth source code.

| Artifact | Role |
| --- | --- |
| `docs/protocol/README.md` (this file) | Normative semantics |
| `protocol/openapi.yaml` | Normative wire shapes (OpenAPI 3.1), generated; do not edit |
| `protocol/schemas/*.json` | The same shapes as standalone JSON Schema (2020-12) |
| `protocol/conformance/` | Executable conformance suite for any server URL |
| `packages/workspace-protocol` | Zod schemas, error registry and the route registry that the OpenAPI document and the suite are generated from |

The keywords MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Where this document
and the OpenAPI file disagree, that is a bug; report it.

Regenerate the derived files with `pnpm schemas` and `pnpm openapi`. `pnpm check` fails
when either is stale.

## 1. Conventions

- **Base path.** Every route is under `/api/v1`. A server may be mounted under a path
  prefix; clients treat the base URL as configuration and append `/api/v1`.
- **Transport.** HTTPS. Plain HTTP is for local development only.
- **Bodies.** JSON, UTF-8, `Content-Type: application/json`, except raw attachment bytes
  and the SSE stream. Errors are `application/problem+json`.
- **Unknown members.** Clients MUST ignore response members they do not know. Servers
  SHOULD ignore request members they do not know (this is unsettled for strict validation,
  see open questions).
- **Identifiers.**
  - Page, attachment and transfer-operation IDs are UUIDv7 strings (ADR-0003). Clients
    choose page IDs and operation IDs; the server assigns attachment IDs.
  - Workspace, user, revision and change-entry IDs are opaque server-assigned strings of 1 to
    128 characters from `[A-Za-z0-9_.~-]`. Clients MUST NOT parse them.
- **Timestamps.** RFC 3339, for example `2026-10-21T10:00:00Z`.
- **Hashes.** Lower-case hexadecimal SHA-256 of the UTF-8 bytes of the Markdown source (page
  revisions) or of the raw bytes (attachments).
- **Markdown is the wire content.** Pages travel as Markdown source (ADR-0001, ADR-0002),
  including any frontmatter. The server stores and returns it byte-for-byte as UTF-8. The
  protocol never carries a block tree. Page content is opaque to the protocol, with one exception: a server
  that lists `page-kind` reads the frontmatter key `thoth_kind` (section 7).

## 2. Versioning

- The major version is the `/api/v1` path segment. A breaking change needs `/api/v2`; both
  MAY be served side by side.
- `GET /capabilities` returns `protocolVersion` as `MAJOR.MINOR`. This draft is `1.0`.
- Within a major version only additive changes are allowed: new optional members, new
  routes, new capabilities, new `kind` values in the change feed, new error codes. A client
  MUST therefore ignore unknown members, unknown capability IDs and unknown change kinds.
- A client SHOULD refuse to talk to a server whose major version it does not implement.
- The quota limits and the `quota_exceeded` code were added within `1.0`: they are an optional
  `limits` member and a new error code, both additive, so `protocolVersion` stays `1.0`. A client that
  does not know `quota_exceeded` treats an unknown 4xx code like any other failure of that request.
- The policy for deprecation windows and for what counts as breaking is not settled (open
  questions).

## 3. Capabilities

`GET /api/v1/capabilities` is the only protocol route reachable without credentials, so clients
can discover a server before signing in. (A server that lists `public-share` also serves read-only
HTML pages under `/s/<token>`, outside `/api/v1`, without credentials; section 10. A server that lists
`invite-links` serves invite pages under `/i/<token>` the same way; section 10.)

```json
{
  "protocolVersion": "1.0",
  "capabilities": ["attachments", "search", "events.sse", "transfers"],
  "limits": { "maxMarkdownBytes": 1048576, "maxPageSize": 200, "idempotencyWindowSeconds": 86400, "maxPagesPerWorkspace": 200 },
  "server": { "name": "example", "version": "1.2.3" }
}
```

- **Clients MUST NOT assume a capability that is not listed.** An absent capability is not
  an error; the client hides or disables the feature.
- Core routes are always present and are not listed: capabilities, me, workspaces, tree,
  pages (GET, PUT, DELETE), page revisions, changes.
- A server MUST answer a route of an unlisted capability with 501 `capability_not_supported`
  (problem+json). It MUST NOT pretend support.
- Capability IDs are drawn from the registry below or carry the vendor prefix `x-`
  (`x-acme.graph-view`). A server MUST NOT list an unregistered ID without the prefix.

| ID | Routes | Notes |
| --- | --- | --- |
| `attachments` | `uploadAttachment`, `getAttachment` | single-request upload only |
| `search` | `searchWorkspace` | |
| `events.sse` | `streamWorkspaceEvents` | hints only, see section 9 |
| `transfers` | `createTransfer`, `getTransfer`, `commitTransfer`, `abortTransfer` | a server that accepts `attachmentIds` in transfers also lists `attachments` |
| `page-order` | `movePage` | the optional `position` member of pages, tree nodes and change entries; section 7 |
| `page-kind` | none | the optional `kind` member of tree nodes and page metadata, and `pageKind` of change entries, derived from frontmatter `thoth_kind`; section 7, ADR-0017 |
| `public-share` | `createShareLink`, `listShareLinks`, `revokeShareLink` | public read-only links to a page and its sub-pages, served as HTML at `/s/<token>`; section 10, ADR-0023 |
| `members` | `listMembers`, `setMemberRole`, `removeMember` | every member reads the list; owners change roles and remove; anyone leaves; one owner is always kept; section 10, ADR-0024 |
| `invite-links` | `createInviteLink`, `listInviteLinks`, `revokeInviteLink`, `acceptInvite` | owners' links that let people join with a role, opened as HTML at `/i/<token>`; section 10, ADR-0024 |
| `workspace-management` | `createWorkspace`, `renameWorkspace`, `deleteWorkspace`, `listDeletedWorkspaces`, `restoreWorkspace`, `purgeWorkspace` | any account creates workspaces it owns; owners rename and delete; deleted ones are restorable for 30 days; section 10, ADR-0025 |
| `feedback` | `sendFeedback` | a problem, an idea or a question for the operator, no sign-in needed; section 10, ADR-0033 |
| `databases` | none | reserved; no semantics in 1.0 |
| `realtime-collab` | none | reserved; no semantics in 1.0 (no CRDT in the MVP, ADR-0005) |

`server` is optional (protocol 1.0). It names the software answering and how people should see it:

- `name` is the operator's display name for the server, shown by clients in their server lists and
  sidebars. The reference server reads it from `SERVER_NAME` (1 to 64 characters, no control characters;
  default: the host name of `PUBLIC_URL`, else `Thoth server`). Clients remove control characters, trim
  it and keep at most 64 characters. When `server` is absent or the name is empty, clients show the
  server's host name (without the port).
- `version` is the server software's version, for diagnostics only. Clients MUST NOT infer features from
  it; capabilities do that.

`limits` members are optional. When present they are authoritative: a request above
`maxMarkdownBytes` or `maxAttachmentBytes` is 413 `payload_too_large`. `idempotencyWindowSeconds`,
when present, MUST be at least 86400.

Quota limits (protocol 1.0, additive; absent means the server sets no such limit). Exceeding one
is 409 `quota_exceeded` (section 5), never 413 (that is the size of one request) and never 403:

| Member | Meaning |
| --- | --- |
| `maxPagesPerWorkspace` | Live pages per workspace. Deleted pages do not count; updates never count. |
| `maxWorkspaceAttachmentBytes` | Sum of the sizes of a workspace's attachments. Every upload counts, including an upload of bytes the server already stores for another attachment (the quota measures what the workspace holds, not how the server deduplicates). |
| `maxMembersPerWorkspace` | Members of one workspace. |
| `maxWorkspacesPerAccount` | Workspaces one account owns. A deleted workspace counts until it is purged (ADR-0025). |
| `revisionRetentionDays` | Revisions that are not current are removed after this many days; see section 7. |

A server may have further quotas that it does not advertise (for example a server-wide storage
limit); they surface only as `quota_exceeded`.

## 4. Authentication and authorization

### Authentication

Every route except `GET /capabilities` takes an HTTP bearer credential:
`Authorization: Bearer <credential>`. How a client obtains it is the server's business; the
protocol does not require one login flow of every server.

- **Client login is defined by the sign-in broker,** [`sign-in.md`](sign-in.md): OAuth 2.0
  Authorization Code with PKCE (S256) against the server's own `/auth/*` endpoints, with
  the server signing the user in at Google, any OIDC issuer or GitHub. The reference server
  implements it. A server that offers it advertises the optional `signIn` member of
  `GET /capabilities` (additive in 1.0); Thoth's desktop and web clients use it when present.
- Without `signIn`, credentials are issued out of band (for example the reference server's
  personal access tokens for scripts and self-hosting).
- Whether third-party servers should also accept tokens from an external OAuth 2.1 / OIDC
  authorization server remains open (ADR-0004).

Rules for every credential:

- A missing, malformed, expired or revoked credential is 401 `unauthenticated`. A 401
  response MUST carry a `WWW-Authenticate` header (RFC 9110 section 11.6.1), for example
  `Bearer`.
- Credentials travel only in the `Authorization` header, never in URLs or bodies.
- `GET /capabilities` is public. Every other `/api/v1` route requires a credential. The
  share pages of `public-share` (`/s/<token>`) are not protocol routes: the token in the path is
  the only thing that opens them (section 10).
- Browser `EventSource` cannot set headers, which constrains `events.sse`; this is tied to the
  authentication decision (open questions).

### Authorization (ADR-0009)

- **The server is the sole authority.** Every resource, tree entry, search result,
  revision, attachment, change-feed entry and transfer is authorized server-side. A client
  cannot bypass it by guessing IDs.
- **Roles per workspace:** `owner`, `editor`, `viewer`.

| Capability of the role | viewer | editor | owner |
| --- | --- | --- | --- |
| read tree, pages, revisions, attachments, search, changes, events | yes | yes | yes |
| write or delete pages, upload attachments | no | yes | yes |
| create `to_workspace` transfers, create `from_workspace` move transfers | no | yes | yes |
| create `from_workspace` copy transfers | yes, unless export restricted | yes, unless export restricted | yes, unless export restricted |
| create, list and revoke share links (`public-share`) | no | yes, unless export restricted | yes, unless export restricted |
| read the member list (`members`) | yes | yes | yes |
| change roles, remove members, create, list and revoke invite links (`members`, `invite-links`) | no | no | yes |
| leave the workspace | yes | yes | yes, unless the last owner |

- **Existence is not leaked.** A workspace, page, attachment or transfer the principal may
  not read is 404 `not_found`. 403 `forbidden` is used only when the principal can see the
  resource but its role does not allow the action (for example a viewer writing).
- **Export restriction.** A workspace carries `exportRestricted`. When true the server
  refuses Workspace to Private transfers and copies with 403 `export_restricted`, even for
  owners. A local client must not bypass it. What exactly counts as "export" beyond transfers
  is an open question.
- **Search, tree, revisions, changes and events** return only what the principal may read.
  Hits, titles, snippets and change entries for unreadable pages MUST NOT appear.
- **Private to Workspace.** The client shows the destination workspace, its members and roles
  (`Workspace.members`, when disclosed) and the sharing implications before it commits a
  transfer. The server only enforces; it does not render that preview.
- **Audit.** Servers record membership, permission, transfer and export events without
  content or secrets (ADR-0009). Audit events are not exposed by this protocol.

## 5. Errors

All errors are RFC 9457 `application/problem+json`. This includes 404 for unknown routes,
405, 401, and 5xx. A plain `application/json` error, or an HTML error page, is a protocol
violation.

```json
{
  "type": "https://thoth.invalid/problems/revision_conflict",
  "title": "Revision conflict",
  "status": 412,
  "code": "revision_conflict",
  "detail": "If-Match does not match the current revision",
  "currentRevision": { "id": "rev_2", "pageId": "...", "parentId": "rev_1", "...": "..." }
}
```

- `code` is **required** and stable. Clients branch on `code`, never on `title` or `detail`.
  It is a registered code or a vendor code prefixed `x-`.
- `status` MUST equal the HTTP status, and for a registered code it MUST equal the status in
  the registry.
- `type` is a URI reference. The `https://thoth.invalid/problems/<code>` form is a
  placeholder namespace; `about:blank` is also acceptable.
- `errors` (optional) lists field problems for `validation_failed`:
  `[{ "pointer": "/title", "detail": "..." }]`, where `pointer` is a JSON Pointer or one of
  `header:<Name>`, `query:<name>`, `path:<name>`.
- `requestId` (optional) is for support correlation.
- Extension members are allowed; clients ignore unknown ones. `revision_conflict` always
  carries `currentRevision`. `quota_exceeded` MAY carry `quota` (which quota, for example
  `pagesPerWorkspace`; an open set), `limit` and `current` (integers, in the unit of the quota).
  A server-wide quota carries none of the three numbers.
- `quota_exceeded` is **409**, deliberately. It is not 403: `forbidden` means the role may not do
  this and no change of data helps, whereas a quota is a state of the workspace, account or server, and
  deleting a page or waiting makes the identical request succeed. It is not 413 (the size of this one
  request against `maxMarkdownBytes` or `maxAttachmentBytes`), and not 429 (request rate, honour
  `Retry-After`). 409 is the status RFC 9110 gives to a request that conflicts with the current state of
  the target resource. A client branches on `code`, so the three never blur. A rejected request writes
  nothing; a server SHOULD NOT remember a `quota_exceeded` reply under an `Idempotency-Key` (section 8),
  so retrying after freeing room runs the request. `putPage`, `uploadAttachment`, `createTransfer` and
  `commitTransfer` list it. A `to_workspace` transfer that would exceed `maxPagesPerWorkspace` is
  refused as a whole, at creation or at commit; no page of it is ever published, and a transfer refused
  at commit stays staged so the client can retry.
- `429 rate_limited` SHOULD carry `Retry-After`. `405 method_not_allowed` MUST carry `Allow`.

### Error-code registry

| Code | HTTP | Meaning |
| --- | --- | --- |
| `validation_failed` | 400 | Malformed or invalid body, header, query or path value |
| `cursor_invalid` | 400 | Cursor is malformed or was not issued for this collection |
| `unauthenticated` | 401 | Credential missing, invalid, expired or revoked |
| `forbidden` | 403 | Visible resource, but the role does not allow the action |
| `export_restricted` | 403 | The workspace forbids exporting content |
| `not_found` | 404 | Unknown route, or a resource the principal may not know exists |
| `method_not_allowed` | 405 | Route exists, method does not |
| `invalid_transfer_state` | 409 | The transfer state does not allow the action |
| `cursor_expired` | 410 | Cursor points before retained change history; resynchronize from the tree |
| `last_owner` | 409 | The change would leave the workspace without an owner (ADR-0024) |
| `quota_exceeded` | 409 | Valid, permitted request that would exceed a quota; may carry `quota`, `limit`, `current` |
| `revision_conflict` | 412 | Conditional write did not match; body has `currentRevision` |
| `payload_too_large` | 413 | Body exceeds an advertised limit |
| `unsupported_media_type` | 415 | Content type not accepted |
| `idempotency_key_reused` | 422 | Idempotency-Key reused with a different request |
| `precondition_required` | 428 | Write without `If-Match` or `If-None-Match` |
| `rate_limited` | 429 | Too many requests |
| `internal_error` | 500 | Unexpected failure |
| `capability_not_supported` | 501 | Route belongs to an unlisted capability |
| `service_unavailable` | 503 | Temporarily unable to serve |

The OpenAPI document lists, per operation, the codes it may return
(`x-thoth-error-codes`). A server MUST NOT return a registered code on an operation that
does not list it. When several problems apply, a server SHOULD report them in this order:
401, 404 or 403, 501 (capability), 428, 400, 412. (The suite only ever triggers one
problem at a time.)

## 6. Pagination and cursors

- **Envelope.** Paginated routes return `{ "items": [...], "nextCursor": "..." | null }`.
  `nextCursor` is `null` on the last page. The change feed uses its own envelope (section 9).
- **Request.** `GET` routes take `?cursor=<opaque>&limit=<1..200>`. `searchWorkspace` takes
  `cursor` and `limit` in the JSON body because it is a POST. Without `limit` the server
  picks a page size (50 is recommended). `limit` is an upper bound: a server MAY return fewer
  items, never more, and MAY clamp a large `limit` to its own maximum (`limits.maxPageSize`).
- **Cursors are opaque.** Clients store and replay them and MUST NOT parse or construct them.
  A server MUST emit only characters from `[A-Za-z0-9_.~-]`, at most 2048 of them, so cursors
  need no URL escaping.
- **Invalid cursors.** A cursor that does not decode, or was not issued for that collection,
  is 400 `cursor_invalid`. A cursor that was valid but points before retained change history
  is 410 `cursor_expired` (change feed only).
- **No duplicates.** Within one traversal of an unchanged collection, an item appears on
  exactly one page. No total counts are returned.
- A cursor does not carry authorization; the server re-authorizes on every request.

## 7. Pages, revisions and conditional writes

### Resources

- `GET /workspaces/{workspaceId}/tree` returns a paginated adjacency list of
  `{ id, parentId, title, position?, kind?, revisionId, updatedAt }` for readable pages, plus `changeCursor`
  (section 9). Parents may appear on a later page than their children.
- A **page** is `{ id, markdown, revision, metadata }`: the Markdown source of one revision,
  a `RevisionSummary` and metadata (`workspaceId`, `parentId`, `title`, `position?`, `kind?`, timestamps and actors).
- A **revision summary** is `{ id, pageId, parentId, createdAt, authorId, title, size,
  contentHash }`. `parentId` is the previous revision of the same page, `null` for the first.
  `size` is the UTF-8 byte length of the Markdown; `contentHash` its SHA-256.
- `PUT /workspaces/{workspaceId}/pages/{pageId}` takes `{ "title", "markdown", "parentId"?, "position"? }`.
  `parentId` omitted means: root on create, unchanged on update; `null` moves to the root.
  `position` is the same (none on create, unchanged on update, `null` clears it); servers without
  `page-order` ignore it. Every successful PUT, including a pure move or retitle, creates a new revision.
  The one write that does not is `movePage` (below), which changes only metadata.
- The `title` is supplied by the client; the server does not derive it from the Markdown
  (open question).
- `GET .../pages/{pageId}` returns the current revision, or the revision named by
  `?revision=<id>` (the page as it was). The response `ETag` is always the entity tag of the
  revision in the body.

### Page order and moves (capability `page-order`)

ADR-0016 rule 4. A page may carry a `position`: an opaque sort key among its siblings, 1 to 128
characters from `[0-9A-Za-z]`, chosen by the client (a fractional index, so a page can be placed between
two others without renumbering them). The server stores and returns it; it never interprets it.

- **Sibling order.** Clients compare positions as byte strings (ASCII order, never a locale collation).
  Pages without a position come after the positioned ones, A to Z by title; ties fall back to the title,
  then the page ID. A client that does not know `position` keeps working and shows its own order.
- **`POST /workspaces/{workspaceId}/pages/{pageId}/move`** takes `{ "parentId"?, "position"? }` (at least
  one; omitted is unchanged, `null` moves to the root or clears the position) and answers 200 with the
  page's `TreeNode`. It is a metadata change: **no revision is created**, the `ETag` stays the current
  revision's, and the change feed records `page.updated` naming the unchanged current revision, with the
  new `parentId` and `position`. It needs the editor or owner role.
- **Preconditions.** `If-Match` is required (428 without it) and must name the current revision (412
  `revision_conflict` with `currentRevision` otherwise), so a client never moves a page it has not seen.
  `If-Match` guards the content revision only. Moves create no revision, so two moves based on the same
  revision both succeed and the last one wins; a move is a cheap, repeatable choice, not content.
  A parent that is the page itself or one of its descendants is 400. `Idempotency-Key` works as in section 8.
- The parent and position of a page are properties of the page, not of a revision: `GET` of the current
  revision reports them as they are now; an older revision (`?revision=`) reports the parent it was written
  with and no position.

### Page kind (capability `page-kind`)

ADR-0017, refining ADR-0016 rule 3. **Page content is opaque to the protocol: the server stores Markdown byte for
byte and does not interpret it. A server that lists `page-kind` is the one exception, and it reads exactly one
frontmatter key, `thoth_kind`.** Nothing else in the Markdown is read.

- **The member.** `kind` is `"page"` or `"folder"`. It is optional in tree nodes and in page `metadata`; change
  entries name it `pageKind`, because `kind` already names the change. `null` or absent means unknown, and clients
  treat unknown as a page. An older server does not list the capability and omits it; an older client ignores it.
- **Derivation.** On every write that stores Markdown (`putPage`, and a transfer commit) the server parses the
  frontmatter. If it parses and `thoth_kind` is the string `folder`, the kind is `folder`. If it parses (or there is
  none) and `thoth_kind` is anything else or absent, the kind is `page`. If the frontmatter is malformed the kind is
  `null`. A write is never refused because of its frontmatter. Clients do not send `kind`; `PageWrite` has no such
  member, so the Markdown stays the single source of truth.
- **Where it appears.** Tree nodes (`kind`), the page `metadata` of `getPage` and `putPage` (`kind`), and the
  `page.created` and `page.updated` change entries (`pageKind`, the kind after the change). `movePage` changes only
  the parent and position, so the kind it returns, and records in the feed, is the page's unchanged kind.
- **Revisions.** `GET ...?revision=<id>` reports the kind of the revision returned, from that revision's own
  frontmatter. The current revision's `kind` is the stored value, the same one the tree shows.
- **Clients.** With the capability, a client draws folders from `kind` and does not download child pages to find them.
  Without it, a client has to read each child page and look for `thoth_kind: folder` itself (ADR-0016 rule 3).
- **Existing data.** A server that gains the capability on existing data reports `null` for pages written earlier
  until it has filled them in. The reference server does this with `node src/cli.ts backfill-kind` (see
  `docs/deploy/trial.md`).

### ETag format

The entity tag is the revision ID in double quotes: `"<revisionId>"`. Tags are strong; weak
tags (`W/"..."`) are never produced or accepted. Revision IDs contain no quotes.

### Conditional writes

| Request | Page state | Result |
| --- | --- | --- |
| `PUT` with `If-None-Match: *` | does not exist | 201, new revision, `ETag` |
| `PUT` with `If-None-Match: *` | exists | 412 `revision_conflict` with `currentRevision` |
| `PUT` with `If-Match: "<etag>"` matching current | exists | 200, new revision, `ETag` |
| `PUT` with `If-Match: "<etag>"` not matching | exists | 412 `revision_conflict` with `currentRevision` |
| `PUT` with `If-Match` | does not exist (or deleted) | 404 `not_found` |
| `PUT` with neither header | any | 428 `precondition_required` |
| `PUT` with both headers | any | 400 `validation_failed` |
| `DELETE` with `If-Match` matching | exists | 204, empty body |
| `DELETE` with `If-Match` not matching | exists | 412 `revision_conflict` with `currentRevision` |
| `DELETE` without `If-Match` | any | 428 `precondition_required` |

- **A stale write is never applied.** A server MUST NOT silently overwrite. This is the
  contract of ADR-0005: the client sees the 412, fetches or keeps `currentRevision`, and
  resolves (the MVP resolution is keep-both, done by the client).
- `If-None-Match` accepts only `*`. `If-Match` accepts exactly one strong entity tag; the
  wildcard `*` and tag lists are 400 `validation_failed` (a deliberate tightening of RFC 9110:
  a wildcard `If-Match` would be an overwrite).
- Creating a page at an ID that exists is a conflict even if the content is identical,
  unless the request is an idempotent replay (section 8).
- The 412 body's `currentRevision` is the revision that was current when the request was
  evaluated. A client that wants the content then does `GET`.

### Immutable revisions

Revisions are append-only. Once a revision has been returned by any route, its summary, its
Markdown (via `GET ?revision=`) and its hash never change. The change feed and the revision
list both refer to revisions by ID. Whether and when old revisions are compacted is an open
question; until decided a server MUST NOT alter a revision, and MAY refuse `?revision=` with
404 only for a revision it has removed under a documented retention policy. A server that does so
advertises `limits.revisionRetentionDays`. It never removes the current revision of a page, nor a
revision a pending transfer still pins. A revision whose parent was removed keeps its summary
unchanged, so its `parentId` names a revision that now answers 404, and the revision list simply
omits removed revisions.

`GET .../pages/{pageId}/revisions` lists revisions newest first (paginated envelope).

## 8. Idempotency

Mutating requests (`PUT`, `DELETE` and the mutating `POST`s: attachment upload and the
transfer actions) accept an `Idempotency-Key` header: 1 to 255 visible ASCII characters,
a UUID recommended. `POST .../search` is read-only and ignores it. `POST .../transfers`
REQUIRES the header and it MUST equal the body `operationId` (ADR-0006).

- **Scope.** A key is scoped to the authenticated principal. The same string used by two
  principals is two keys.
- **Fingerprint.** A request's identity is its method, target URI (path and query), the
  `If-Match` and `If-None-Match` headers, and a digest of the body bytes.
- **Replay.** A request with a known key and the same fingerprint, within the replay window,
  MUST NOT be executed again. The server returns the **same response**: same status, same
  body, same `ETag` and `Location`. It SHOULD add `Idempotent-Replayed: true`. In particular
  a replayed create returns the original 201, not the 412 a fresh create over the now-existing
  page would produce.
- **Reuse.** A known key with a different fingerprint is 422 `idempotency_key_reused`; the
  request is not executed.
- **Replay window.** At least 24 hours (86400 seconds). A server MAY retain longer and SHOULD
  say so in `limits.idempotencyWindowSeconds`. After the window a key is treated as new.
- **What is stored.** The server stores the final response of requests that were executed or
  rejected for request-specific reasons (2xx and 4xx other than 401 and 429). It SHOULD NOT
  store 5xx or 429 responses, so a retry can succeed. 401 responses are never stored (the
  principal is unknown).
- Idempotency complements, and does not replace, conditional writes: a retry after a lost
  response is safe with a key; a concurrent edit is caught by `If-Match`.

Behavior for a second request that arrives while the first is still executing is not
settled (open questions).

## 9. Change feed and server-sent events

### The change feed is the source of truth

`GET /workspaces/{workspaceId}/changes?cursor=<opaque>&limit=<n>` returns

```json
{ "entries": [ ... ], "cursor": "<opaque>", "hasMore": false }
```

- `entries` are the changes after `cursor`, oldest first, in a stable order. Without `cursor`
  the feed starts at the beginning of retained history.
- `cursor` is the position after the last returned entry (or the request cursor when no
  entries were returned). Passing it back returns the next entries. Clients persist it after
  applying a page.
- `hasMore` is true when more entries are available now. A client reads until `hasMore` is
  false.
- An entry is `{ id, kind, occurredAt, actorId, pageId?, revisionId?, parentId?, title?,
  position?, pageKind?, attachmentId? }`. `id` is unique within the workspace for the life of the feed, so clients
  can de-duplicate.

| `kind` | Required members |
| --- | --- |
| `page.created` | `pageId`, `revisionId` |
| `page.updated` | `pageId`, `revisionId` (also used for a move or retitle; for `movePage`, the unchanged current revision) |
| `page.deleted` | `pageId` |
| `attachment.created` | `attachmentId` |

  Unknown kinds MUST be ignored by clients. Entries identify what changed; clients fetch the
  resource for content. Entries never contain Markdown.
- **Baseline cursor.** Each tree page carries `changeCursor`, a cursor taken no later than the
  start of that traversal. A client that reads the whole tree and then follows the feed from
  `changeCursor` misses nothing. All pages of one traversal carry the same value. Applying a
  change that the tree already reflects is harmless because entries carry revision IDs.
- **Missed events are always recoverable** by reading the feed from the stored cursor. A
  cursor older than the retained history is 410 `cursor_expired`: the client rebuilds from
  the tree.
- The feed is permission-aware (section 4).

### SSE is a hint

`GET /workspaces/{workspaceId}/events` (capability `events.sse`) is `text/event-stream`.
When the feed advances in a workspace the stream's principal can read, a server that lists
`events.sse` MUST send a hint promptly (the conformance suite waits up to 10 seconds), in this form:

```text
event: changes
data: {"type":"changes.available","workspaceId":"ws_1","cursor":"<head cursor>"}

```

- The payload is **only a hint** that changes exist. It carries no page content and no
  entries. On receiving it, the client calls `GET .../changes` from **its own** stored cursor.
  It MUST NOT treat the hint's `cursor` as its position.
- Events may be lost, delayed, merged or duplicated. Clients MUST NOT rely on them for
  correctness and SHOULD poll the feed on reconnect and at a low background interval.
- A server MAY send comment lines (`:`) as keep-alives.

## 10. Search, attachments, share links, members, invite links and workspaces

- `POST .../search` (capability `search`) takes `{ query, limit?, cursor?, withinPageId? }`
  and returns a paginated envelope of `{ pageId, title, revisionId, snippet?, score? }`. It
  is read-only. The index MAY lag writes briefly; query syntax and ranking are unspecified
  (open questions).
- `POST .../attachments` (capability `attachments`) is a single request: the body is the raw
  bytes, `Content-Type` is the MIME type, `?fileName=` is optional. The response is 201 with
  an `AttachmentResource` (`id`, `hash` SHA-256, `size`, `mimeType`, ...) and a `Location`.
  `GET .../attachments/{attachmentId}` returns the bytes with the stored `Content-Type`.
  `GET` of attachments is an addition to the spec section 8 list, needed to read uploads back.
  Resumable or multipart upload is not defined (open questions).

### Public share links (capability `public-share`, ADR-0023)

- `POST .../pages/{pageId}/share-links` (owners and editors) takes
  `{ expiresInDays?: 7 | 30 | 90 | null }` (absent: 30; `null`: never) and returns 201 with the
  link (`id`, `workspaceId`, `pageId`, `createdAt`, `createdBy`, `expiresAt`) plus `token` and
  `url`. **The token is returned this once.** A server MUST store only a hash of it, so it
  cannot be listed again. The token is URL-safe with at least 128 bits from a CSPRNG.
  `Idempotency-Key` is not honoured, because a stored replay would keep the token.
- Refusals:
  - 403 `forbidden` for a viewer;
  - 403 `export_restricted` in an export-restricted workspace;
  - 409 `quota_exceeded` with `quota: shareLinksPerWorkspace` past the server's limit of
    active links.
- `GET .../pages/{pageId}/share-links` lists the page's active (not revoked, not expired) links,
  newest first, without tokens. `DELETE .../share-links/{linkId}` revokes a link at once (204).
  Revoking a revoked or expired link also answers 204.
- The link opens `GET <origin>/s/<token>`: the page as HTML, read-only, no sign-in. Its
  sub-pages are at `/s/<token>/p/<pageId>`, and the attachments those pages use at
  `/s/<token>/a/<attachmentId>`. Nothing else of the workspace is reachable.
- The page is the current revision, not a snapshot. Every request re-checks:
  - the link is active;
  - the page is not deleted and is still in the subtree;
  - the link's creator is still an owner or editor;
  - the capability is on.
- An unknown, expired, revoked, out-of-scope or malformed token gets one and the same 404:
  HTML for a browser, problem+json otherwise. Rate limits count the token as given, so a 429
  does not tell whether a token exists.
- Share pages carry no script, a CSP with `default-src 'none'`, `frame-ancestors 'none'`,
  `base-uri 'none'` and `form-action 'none'`, `X-Robots-Tag: noindex, nofollow`,
  `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. They show no workspace
  IDs, member names or emails, and no titles of pages outside the subtree. Raw HTML in the
  Markdown is never passed through.
- Attachments keep their stored `Content-Type`. Raster images and SVG are inline (SVG with
  the CSP `default-src 'none'; style-src 'unsafe-inline'; sandbox`, ADR-0023 amendment);
  everything else downloads.

### Members (capability `members`, ADR-0024)

- `GET .../members` (every member) lists `{ userId, displayName, role }`, paginated, ordered by user
  ID. Emails are never returned.
- `PUT .../members/{userId}` (owners) takes `{ role }` and returns the member. Setting the role a member
  already has changes nothing. Making someone an owner counts against that account's
  `maxWorkspacesPerAccount` (409 `quota_exceeded`, `quota: workspacesPerAccount`).
- `DELETE .../members/{userId}` (204): owners remove anyone; any member removes themself (leaves).
- **One owner is always kept.** Demoting or removing the last owner, or the last owner leaving, is 409
  `last_owner`. The check runs under the workspace's write lock, so two owners stepping down at once
  cannot both succeed.
- Removal takes effect at once: the account's next request to the workspace is 404, and share links
  it made stop working (their creator is re-checked on every view). An open event stream ends at its
  next re-check (30 seconds).
- Editors and viewers get 403 for the owners' calls; non-members get 404.

### Invite links (capability `invite-links`, ADR-0024)

- `POST .../invite-links` (owners) takes `{ role: "editor" | "viewer", expiresInDays?: 1 | 7 | 30,
  maxUses?: 1 | 5 | 10 }` (absent: 7 days, 1 use) and returns 201 with the link (`id`, `workspaceId`,
  `role`, `maxUses`, `usesLeft`, `createdAt`, `createdBy`, `createdByName`, `expiresAt`) plus `token`
  and `url` (`<origin>/i/<token>`). As for share links, the token is returned this once, only a hash is
  stored, and `Idempotency-Key` is not honoured. Owner is not offered: an owner promotes an existing
  member instead.
- Refusals: 403 `forbidden` for editors and viewers; 409 `quota_exceeded` with `quota:
  inviteLinksPerWorkspace` past the server's number of active links, or `quota: membersPerWorkspace`
  when `maxUses` is more than the member limit leaves room for.
- `GET .../invite-links` lists the active links (not revoked, not expired, not used up), newest first,
  without tokens. `DELETE .../invite-links/{inviteId}` revokes at once (204, also for a dead link).
  Dead links are kept as records.
- `POST /invites/accept` (any signed-in account) takes `{ token }` and returns `{ workspaceId, name,
  role, joined }`. Someone already a member keeps their role and spends no use (`joined: false`). A
  full workspace is 409 `quota_exceeded` (`membersPerWorkspace`). Uses and the member limit are counted
  under the workspace's write lock: two people racing for the last use, or the last place, cannot both
  join.
- **One answer for every dead token.** Unknown, malformed, expired, revoked, used up, a token of another
  server, and a link whose creator is no longer an owner all get the same 404. Per-client-address rate
  limits run before the token is looked up.
- `GET <origin>/i/<token>` is an HTML page with no script (the share pages' headers, with
  `form-action 'self'`). It names only the workspace, the inviter's display name and the role. On a
  server with a sign-in broker it offers "Sign in with … to join": the broker's provider callback, for
  this sign-in only, issues no code, session or token, but a short-lived, single-use join ticket in an
  HttpOnly `SameSite=Lax` cookie, and returns to `/i/accept`. There a form `POST /i/accept` joins; it
  needs the ticket, a value derived from it in the form, and a same-origin request (`Origin`, or Fetch
  Metadata when `Origin` is `null`). A GET never joins.

### Workspaces (capability `workspace-management`, ADR-0025)

- `POST /workspaces` (any signed-in account) takes `{ name, exportRestricted? }` and returns 201 with
  the `Workspace`, the caller its only member and owner. The name is trimmed and must then be 1 to 200
  characters. `Idempotency-Key` is honoured. Refusals: 409 `quota_exceeded` with `quota:
  workspacesPerAccount` (owned workspaces, deleted ones included until purged) or `quota:
  workspaceCreationsPerDay` (with `Retry-After`).
- `PUT /workspaces/{id}/name` (owners) takes `{ name }` and returns the `Workspace`.
- `DELETE /workspaces/{id}` (owners, 204). From then on every route of the workspace is 404 for every
  member and it is not listed; its share and invite links stop, for good. Its members are kept.
- `GET /deleted-workspaces` lists the caller's deleted workspaces (where they are an owner) that can
  still be restored, newest first: `{ id, name, exportRestricted, memberCount, deletedAt, deletedBy,
  restorableUntil }`.
- `POST /deleted-workspaces/{id}/restore` (owners of it) returns the `Workspace` with its pages and
  members; its old share and invite links stay revoked. `DELETE /deleted-workspaces/{id}` (owners of it,
  204) purges it now. Both: 403 for its other members, 404 for anyone else, a live workspace, and one
  past its 30 days (`DELETED_WORKSPACE_RESTORE_DAYS`).
- After 30 days the server purges a deleted workspace with its pages, revisions and attachments.

### Feedback (capability `feedback`, ADR-0033)

- `POST /feedback` needs no credentials. A valid bearer credential ties the feedback to the account; an invalid one is
  ignored (never 401). The body is strict: `kind` (`problem` | `idea` | `question`), `message` (1 to 5000 characters,
  not blank), optional `email`, optional `context` `{ client, version?, os?, arch?, language? }`, optional `diagnostics` `{ log }` (1 to 200
  printable lines of at most 500 characters: the app log the person chose to attach), and the honeypot `website`
  (filled in: the same 204, nothing stored). 204 when received; 400 `validation_failed` for anything else; 429
  `rate_limited` with `Retry-After`. Nothing is stored for a refused request.
- A form-encoded body (the website without JavaScript) carries the same fields flat, plus `return` (a path); it must
  come from an `Origin` the server allows for CORS (else 403), and the answer is an HTML page.

## 11. Transfers

Transfers (capability `transfers`) are the server half of ADR-0006. The client owns the
planning and the local journal; the server provides a durable, idempotent staging and commit
point. `TransferState` is shared with the client journal; a server only ever reports
`stage`, `commit_destination`, `finalize_source`, `done`,
`destination_committed_source_cleanup_pending`, `failed` and `aborted`.

### Create: `POST /workspaces/{workspaceId}/transfers`

The workspace is the destination (`to_workspace`) or the source (`from_workspace`).
`Idempotency-Key` is required and equals the body `operationId` (a client-generated UUIDv7).

- **`to_workspace`** (Private to Workspace). Body: `mode` (`copy` or `move`) and `pages`, each
  `{ sourceId, pageId, parentId, title, markdown }`. `pageId` is the logical ID the page gets
  (fresh for copy, preserved for move). Requires `editor` or `owner`. The server validates
  and stages the pages; they are **not visible** (`GET` is 404, not in the tree or feed) until
  commit. The response is 201 with state `stage` and items in `staged`.
- **`from_workspace`** (Workspace to Private). Body: `mode` and `pages: [{ pageId }]`. Refused
  with 403 `export_restricted` if the workspace is restricted. `move` also requires `editor`.
  The server pins each page's current revision: items report `revisionId`. The client
  downloads exactly those revisions with `GET ...?revision=<id>`.
- Re-sending the same `operationId` with the same body returns the original response; with a
  different body, 422 `idempotency_key_reused`.

### Commit: `POST /transfers/{operationId}/commit`

- **`to_workspace`.** Atomically publishes all staged pages (COMMIT_DESTINATION). Pages get
  revisions and appear in the tree and the change feed. State `done`; items `committed` with
  their `revisionId`.
- **`from_workspace`.** The client calls it after it committed and verified the destination.
  Body `{ "verified": [{ pageId, revisionId, contentHash }] }`. Each entry MUST match the
  pinned revision, else 400. For `copy`, `verified` is optional and the state becomes `done`.
  For `move`, `verified` is required for every item; the server deletes a source page only if
  its current revision equals the verified revision and hash. If any deletion cannot be done,
  the state is `destination_committed_source_cleanup_pending` (never `done`) and failed items
  are marked. The server never deletes the source before this verified commit.
- Committing a finished transfer returns it unchanged (200). Committing an aborted or failed
  one is 409 `invalid_transfer_state`.

### Abort: `POST /transfers/{operationId}/abort`

Discards staged items and sets `aborted`. Repeating it is 200 with no change. A committed
transfer (`done` or `destination_committed_source_cleanup_pending`) is 409
`invalid_transfer_state`. Aborting is the rollback point; after commit, undoing is a new
operation.

### Read: `GET /transfers/{operationId}`

Visible to principals with access to the transfer's workspace; otherwise 404.

### Rules that hold throughout

- Destination permissions always apply, and a local client cannot bypass the server's export
  restrictions (ADR-0006, ADR-0009).
- A retry after any crash, with the same `operationId`, never duplicates content.
- Servers record operation state without logging page content or secrets (spec section 9.4).

The Thoth desktop client (`packages/transfer`) writes links between transferred pages and attachments as
`thoth:page/<pageId>` and `thoth:attachment/<attachmentId>` inside the Markdown, and turns them back into vault
paths when pages come back. This is a client convention. Page Markdown stays opaque to the protocol, and
servers need not understand it (implementation plan §4 item 8; only a server that lists `page-kind` reads `thoth_kind`, section 7). Clients send attachment uploads in a transfer
with an `Idempotency-Key`, so a retry after a lost response does not store a second attachment.

## 12. Conformance

`protocol/conformance/` is a framework-independent runner:

```ts
import { runConformance } from "./protocol/conformance/src/index.ts";
const report = await runConformance({ baseUrl, token, fetch /* optional */ });
// report.groups: [{ capability: "core" | "attachments" | ..., results: [{ id, title, status, detail }] }]
```

or from a shell, with the credential in the environment (the token is never accepted as an
argument and never printed):

```sh
THOTH_TOKEN=... node protocol/conformance/src/cli.ts --url https://workspace.example.com
```

- Checks for capabilities the server does not list are reported as `skip`.
- The suite needs a principal that is `owner` or `editor` in at least one workspace
  (`--workspace <id>` selects it). **It creates and then deletes pages in that workspace;
  run it against a test workspace.**
- Every response seen during the run is also validated against the route registry (status,
  media type, body schema, error code and status) and the run fails if any is off.
- Not covered yet: rate limiting, `cursor_expired`, `payload_too_large`, role-matrix checks
  with a second principal, and very large collections.
- Run the suite against the in-memory fixture with `pnpm test`.

## 13. Decided here and open

**Decided in this draft** (each is implemented in the route registry and exercised by the
suite unless noted): the endpoint set of spec section 8 plus attachment download; strong
revision-ID ETags; 428/412/404 conditional-write rules and the `If-Match: *` rejection;
`?revision=` for historical reads; idempotency scope, fingerprint, replay and 24-hour window;
the change-feed envelope, entry kinds and the tree `changeCursor` baseline; SSE as a hint
with a fixed payload; opaque URL-safe cursors; the error registry and statuses; 404 instead of
403 for unreadable resources; 501 for unlisted capabilities; public `GET /capabilities`;
the transfer lifecycle seen by the server (stage, commit, abort, pinned revisions, verified
move commit); sibling order through an optional `position` and the metadata-only `movePage`
(capability `page-order`); the optional page `kind`, derived by the server from frontmatter `thoth_kind`
(capability `page-kind`, ADR-0017). Not covered by the suite: 405, `unsupported_media_type`, the role matrix beyond
the fixture tests, and `Retry-After`.

**Open questions (not decided here):**

1. **Authentication scheme** for third-party servers: OAuth 2.1 / OIDC versus session tokens;
   how clients obtain credentials; browser SSE authentication; the final shape of `GET /me`
   (ADR-0004).
2. **Versioning policy:** what is breaking, deprecation windows, running v1 and v2 together.
3. **Capability registry:** naming beyond the nine IDs; governance of `x-` IDs; semantics of
   `databases` and `realtime-collab`.
4. **Attachments:** resumable or multipart upload; chunking; how page Markdown refers to an
   attachment (URL form); deduplication; deletion and retention; size limits per MIME type.
5. **Revision retention and compaction;** whether revisions of deleted pages stay readable;
   undelete; behavior of `PUT` to the ID of a deleted page; whether revision IDs are totally
   ordered or only parent-linked (ADR-0005).
6. **Tree rules:** behavior of `DELETE` for a page with children (cascade, orphan or refuse), a
   missing parent. (Sibling order, cycle prevention and moving a page without sending its content are
   decided in section 7 for servers that list `page-order`.)
7. **Titles and frontmatter:** whether the server derives `title` from Markdown, and whether it
   checks that frontmatter `thoth_id` equals the path ID; newline and Unicode normalization of
   stored Markdown.
8. **Roles and sharing:** page-level permissions; guest links (public read-only links are decided in ADR-0023;
   the member list, role changes, the last-owner rule and invite links in ADR-0024); the definition of
   "export" (copy, move, download, agent context) for the restriction flag (ADR-0009).
9. **Search:** query syntax, ranking, snippet format, tokenization (notably Thai), and a bound on
   index lag.
10. **Change feed:** retention period; `cursor_expired` thresholds; entries for membership and
    permission changes; how entries are filtered when a principal loses access.
11. **SSE:** `Last-Event-ID` resume, keep-alive interval, per-principal fan-out limits.
12. **Idempotency:** a duplicate that arrives while the first request is executing (wait,
    409, or 422); retention beyond 24 hours; scope when the credential is rotated.
13. **Transfers:** per-item partial success for large selections; selections larger than a
    request body; attachments inside transfers and their garbage collection; time-to-live of
    staged items; collisions at the destination (the fixture answers 400); server-side
    verification of rewritten references; transfers of pages without `thoth_id`; retention of
    transfer records (ADR-0006).
14. **Caching:** conditional `GET` with `If-None-Match` (304) and `Cache-Control` are not
    specified.
15. **Operations:** rate-limit headers beyond `Retry-After`; a request-ID header; CORS for the
    web client; bulk or batch writes.
16. **Request strictness:** whether servers reject or ignore unknown request members.
17. **Namespaces and licensing:** the `https://thoth.invalid/problems/` error-type namespace is a
    placeholder; the OpenAPI document carries no license until ADR-0011 is decided.
