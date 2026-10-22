# ADR-0004: Workspace protocol and capability negotiation

- **Status:** Proposed (to be finalized in phase P2)
- **Date:** 2026-10-20

## Context

Workspace connections use an open protocol with the Thoth reference server as one
implementation, not the only one (spec sections 2, 3.2). The protocol must be
implementable by other servers in other languages, so it cannot be defined by
TypeScript types alone. Optional features (databases, real-time collaboration,
search) will not exist on every server, and a server must be able to say so
(spec section 8). The endpoint list in section 8 is explicitly a proposal.

## Decision

1. **Transport and documentation.** REST over HTTPS under `/api/v1`, documented
   in `protocol/openapi.yaml` (OpenAPI 3.1). Request and response schemas live in
   `protocol/schemas/`, generated from shared Zod schemas. A conformance suite in
   `protocol/conformance/` runs against any server.
2. **Capabilities.** `GET /api/v1/capabilities` returns the protocol version and
   an explicit list of optional capabilities, for example `attachments`,
   `search`, `events.sse`, `transfers`, `databases`, `realtime-collab`. Clients
   must not assume capabilities that are not listed.
3. **Errors.** RFC 9457 `application/problem+json`, with a stable machine-readable
   `code` field.
4. **Pagination.** Opaque cursors. The change feed
   `GET /workspaces/{id}/changes?cursor=` is the source of truth for changes; SSE
   events are only hints that a client should fetch changes.
5. **Mutations.** Conditional writes use `If-Match` with revision ETags (ADR-0005).
   Mutating POSTs accept an `Idempotency-Key` header.
6. **Endpoints** are those listed in spec section 8: `/capabilities`, `/me`,
   `/workspaces`, `/workspaces/{id}/tree`, pages (GET, PUT, DELETE),
   page revisions, `/workspaces/{id}/search`, `/workspaces/{id}/attachments`,
   `/workspaces/{id}/changes`, `/workspaces/{id}/events`,
   `/workspaces/{id}/transfers`, `/transfers/{operationId}`, and its `commit` and
   `abort` actions. Each is finalized in P2.

## Consequences

- Positive: third parties can implement and test servers without reading Thoth
  code; clients degrade explicitly instead of probing.
- Positive: recovery from missed events is always possible via the change feed.
- Negative: maintaining OpenAPI, generated schemas and conformance tests is
  ongoing work; generated schemas must be checked in CI for drift.
- Negative: endpoint shapes may still change before P2 finalization, so the
  protocol must be treated as unstable until then.
- Follow-up: `packages/workspace-protocol` client generated or validated from the
  same schemas; the reference server must pass the conformance suite.

## Alternatives considered

- **GraphQL or gRPC.** Not chosen: spec section 8 proposes REST with OpenAPI;
  broader tooling support for third-party implementers.
- **Version-only negotiation (no capability list).** Rejected: forces all-or-
  nothing feature sets.
- **WebSocket-first sync.** Rejected: clients must recover missed events from a
  cursor anyway (spec section 8).
- **Ad hoc error JSON.** Rejected in favor of a standard format.

## Spec references

Section 2 (workspace connection, reference server), 3.2, 4, 8, 11 (capability
registry), 15 step 4.

## Open questions

- ~~Authentication scheme for third-party servers.~~ Decided 2026-10-22 in
  ADR-0013: OIDC (Authorization Code + PKCE), plus personal access tokens for
  tools.
- Versioning policy for breaking changes under `/api/v1`.
- Exact set and naming of capability identifiers beyond the examples above.
- Attachment upload mechanism details (single request vs. resumable).
