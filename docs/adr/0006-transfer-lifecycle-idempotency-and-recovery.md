# ADR-0006: Transfer lifecycle, idempotency, and recovery

- **Status:** Proposed (implementation phase P3). Implemented 2026-10-24 in `packages/transfer`; the open
  questions below are answered in "Resolved in implementation". Acceptance is the owner's decision.
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

## Resolved in implementation (2026-10-24)

Each answer below is pinned by tests in `packages/transfer/test` and `apps/server/test-db/transfer-engine.test.ts`.

- **Deleting uncommitted staged items.** The reference server's `abort` discards staged items and is
  idempotent; a committed transfer answers 409 `invalid_transfer_state` (protocol §11). Recovery uses
  it as the rollback point:
  - every operation interrupted before COMMIT_DESTINATION is aborted at the server, and our own
    unedited local files (Workspace → Private) are removed;
  - a 409 on abort means the server committed and the response was lost, so the operation continues
    forward and is never reported as rolled back;
  - when the server cannot be reached, the operation waits and is retried on the next open;
  - staged items are invisible, so a transfer that could not be aborted is harmless at the server.
- **Record retention.** Records of `done`, `failed` and `aborted` operations are removed 30 days after
  their last update, on open. `destination_committed_source_cleanup_pending` records are kept until
  the user dismisses them, because they describe something still to do. Records are small and never
  hold content.
- **Pages without `thoth_id`.** They are adopted before VALIDATE completes (ADR-0003 §2), and adoption
  is the only change a transfer makes to a copied original. Pages that cannot be adopted (not UTF-8,
  unreadable frontmatter, edited during adoption) are refused with a reason, in the preview and at
  VALIDATE. Two selected files that claim one `thoth_id` are refused.
- **Per-item partial success.** A transfer is all-or-nothing at the destination (one server commit).
  Partial results exist only on the source side, per item:
  - a move whose source changed after it was sent keeps that source, so the item and the operation
    are `destination_committed_source_cleanup_pending`;
  - for Workspace → Private, the server reports per-item `revision_conflict`, with the same state.
  Selections larger than one request (32 MiB, or the server's limits) are refused in the preview
  rather than split.
- **Move preserves IDs "when the destination supports it".** A move keeps the ID unless the workspace
  has had a page with it before (`.thoth/sync/` says so), because servers never reuse a page ID. It
  then gets a fresh ID and a mapping, as a copy does.
- **Verification.**
  - Private → Workspace: every created revision is read back and its content hash compared with the
    hash of the exact payload, which is recorded before it was sent. An item that fails verification
    is never deleted at the source.
  - Workspace → Private: the downloaded revision's bytes must hash to the pinned revision's
    `contentHash`, and each written file is re-read and compared before the server is told
    `verified`.

