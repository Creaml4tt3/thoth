# ADR-0005: Revision-based synchronization and conflict resolution

- **Status:** Proposed
- **Date:** 2026-10-20

## Context

Workspace pages are edited by multiple users and by local clients that may be
offline. The spec requires immutable revisions, conditional writes, a change feed,
and conflict responses for stale writes, never silent overwrite (spec section 8).
Real-time collaborative editing is out of MVP scope (section 13). Private Space
files have an analogous problem with external editors (ADR-0001).

## Decision

1. **Immutable server revisions.** Each page write creates a revision with a
   server-assigned ID and a parent revision ID. Revisions are never modified.
2. **Stale writes.** A write whose `If-Match` does not match the current revision
   returns HTTP 412 with problem code `revision_conflict` and the current
   revision. The server never silently overwrites.
3. **Client sync state.** The client keeps `sync_state` in the local index: last
   known remote revision, base content hash, and pending local changes.
4. **MVP conflict resolution: keep both.** On conflict the client creates a
   conflict copy or presents a diff. There is no automatic merge of divergent
   text.
5. **No CRDT in MVP.** Real-time collaboration is out of scope for the MVP.
6. **Local analog.** Conflicts between Thoth and external editors in a Private
   Space follow the same principle through content-hash compare-and-swap
   (ADR-0001).

## Consequences

- Positive: simple, auditable semantics; no data loss on concurrent edits; the
  change feed plus revision IDs give a recoverable history.
- Negative: users must resolve divergence manually; conflict copies can
  accumulate.
- Negative: because `sync_state` lives in the regenerable index, losing the index
  loses the base hash; recovery behavior (treat as conflict vs. re-fetch) needs
  specifying (see Open questions).
- Follow-up: `packages/sync` implements cursors, conflict handling and
  `sync_state`; conformance tests assert 412 and `revision_conflict` behavior.

## Alternatives considered

- **Last-writer-wins.** Rejected: silent data loss, forbidden by spec section 8.
- **Automatic three-way text merge.** Not in MVP; the risk of corrupting content
  silently outweighs the convenience. May be proposed later with a new ADR.
- **CRDT/OT real-time collaboration.** Out of MVP scope; the `realtime-collab`
  capability (ADR-0004) leaves room for it.
- **Pessimistic locking.** Rejected: unworkable for offline clients.

## Spec references

Section 2, 3.2, 6.3 (`sync_state`), 8 (conditional writes, immutable revisions,
change feed), 13 (out of scope), 15 step 4-5.

## Open questions

- Naming and placement of conflict copies (Private vs. Workspace side).
- Behavior when `sync_state` is lost with the index.
- Revision retention and compaction policy; spec section 12 requires backups and
  retention to be documented separately from revision history.
- Whether revision IDs are totally ordered across a page or only linked by parent.
