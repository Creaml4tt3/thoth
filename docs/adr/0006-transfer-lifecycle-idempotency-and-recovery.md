# ADR-0006: Transfer lifecycle, idempotency, and recovery

- **Status:** Proposed (implementation phase P3)
- **Date:** 2026-10-20

## Context

Transfers between Private Space and Workspace are a first-class domain service
and the defining product proof (spec sections 9, 14, 18). They cross a
filesystem, a local index, a network and a remote server, none of which share a
transaction. Moves delete source content, so the ordering of commit and deletion
must be explicit and crash-safe. Destination permissions and server export
restrictions always apply.

## Decision

1. **States.** `PLAN -> VALIDATE -> STAGE -> TRANSFER -> VERIFY ->
   COMMIT_DESTINATION -> FINALIZE_SOURCE` (move only) `-> DONE`, plus `FAILED`,
   `ABORTED`, and the terminal-but-incomplete
   `destination_committed_source_cleanup_pending`. A move is not reported as
   finalized in that last state.
2. **Operation identity.** Every operation has a client-generated stable ID
   (UUIDv7) used as the idempotency key at both ends.
3. **Persistence.** Operation records are stored at
   `.thoth/operations/<id>.json` (authoritative local journal) and in the
   `operation_journal` index table. A record contains source revision/hash,
   destination mapping, per-item state, verification results and errors. It never
   contains page content or secrets.
4. **Identity handling.** Copy generates new logical IDs and records a
   source-to-destination ID mapping. Move preserves IDs when the destination
   supports it.
5. **Reference classification:** included, already-at-destination, left-at-source,
   external, unresolved. The mapping is built before any link is rewritten. A
   link that cannot be resolved safely keeps its original target and is flagged.
   Links are never retargeted by title match.
6. **Source deletion** happens only after a verified destination commit.
7. **Recovery.** On startup, operations resume from the last durable state.
   Rollback is offered where the destination supports deletion of uncommitted
   staged items; otherwise the operation is flagged for manual recovery.
8. **Permissions.** Destination permissions and server export restrictions always
   apply (ADR-0009).

## Consequences

- Positive: a crash at any state leaves the source intact or the destination
  committed with an explicit pending-cleanup flag.
- Positive: retries with the same operation ID do not duplicate content.
- Negative: more states and journal handling than a naive copy; every state
  transition needs failure-injection tests.
- Negative: rollback is not universal; some destinations require manual cleanup.
- Follow-up: `packages/transfer` state machine, server transfer endpoints
  (ADR-0004), and acceptance tests for Private -> Workspace and
  Workspace -> Private, including simulated interruption (spec section 14 step 8).

## Alternatives considered

- **Direct copy-then-delete without staging.** Rejected: no safe point to verify
  or resume.
- **Distributed two-phase commit.** Not available across filesystems and
  third-party servers.
- **Title-based link retargeting.** Rejected: risks pointing to a different page.
- **Journal only in SQLite.** Rejected: the index is regenerable; the operation
  record must survive index loss (ADR-0001).

## Spec references

Section 2 (transfers), 9.1-9.4, 12, 14 (steps 5-8), 15 step 6, 18.

## Open questions

- Which destinations support deleting uncommitted staged items (server `abort`
  semantics in ADR-0004 are not finalized).
- Retention and cleanup policy for completed operation records in
  `.thoth/operations/`.
- Behavior for transfers that include pages without `thoth_id` beyond adoption
  (ADR-0003).
- Per-item partial-success semantics for large selections.
