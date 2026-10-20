# ADR-0009: Workspace authorization and sharing semantics

- **Status:** Proposed (phase P2)
- **Date:** 2026-10-20

## Context

The server owns authorization, membership, revisions and shared content
(spec section 3.2). Local clients are not trusted to enforce access control, and
a local client must not bypass server export restrictions (sections 9.1, 12).
Moving content from Private Space to a cloud workspace makes it visible to other
people, so the user must see the consequences before commit.

## Decision

1. **Server is the sole authority.** Every resource, search result, revision,
   attachment, change-feed entry and transfer is authorized server-side. Clients
   cannot bypass it with direct IDs.
2. **MVP roles per workspace:** `owner`, `editor`, `viewer`.
3. **Export restriction.** A workspace-level export restriction flag exists. When
   set, the server refuses Workspace -> Private transfers and copies.
4. **Private -> Workspace transfers** show the destination workspace, members and
   roles, and sharing implications before commit.
5. **Audit events** are recorded for membership, permission, transfer and export
   actions, without content or secrets.

## Consequences

- Positive: a single enforcement point; the conformance suite (ADR-0004) can test
  authorization uniformly.
- Positive: permission-aware search and change feed follow from rule 1.
- Negative: authorization checks on search and change-feed paths add per-item
  cost and design effort.
- Negative: a coarse three-role model will not cover all sharing needs.
- Follow-up: acceptance test that server-side permissions cannot be bypassed by
  the client (spec section 14 step 12); the transfer UI preview in P3.

## Alternatives considered

- **Client-side enforcement or hidden UI controls.** Rejected: not a security
  boundary.
- **Per-page ACLs from the start.** Deferred (see Open questions); larger
  surface than the MVP needs.
- **Export restriction enforced only in the client.** Rejected: bypassable.

## Spec references

Section 3.2, 8, 9.1, 9.4, 11 (authorization, audit events), 12, 14 (step 12),
13 (P2).

## Open questions

- Page-level permissions beyond workspace roles.
- Guest and public links.
- Definition of "export" precisely (copy, move, download, agent context) for the
  restriction flag.
- Role-change and ownership-transfer rules; last-owner protection.
