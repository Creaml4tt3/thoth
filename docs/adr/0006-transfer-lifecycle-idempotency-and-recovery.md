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


## Amendment (2026-10-26): starting a transfer by drag and drop — Proposed

The owner asked that drag and drop between the Private Space and a workspace work correctly. It did not exist:
each sidebar tree had its own drag state, so a row from the other tree was never accepted. Decided for the owner,
to be confirmed:

1. **A drop across spaces opens the transfer dialog and never transfers by itself.** Dropping a Private Space page,
   a folder, or the selection the dragged page is part of on a workspace row or a workspace page opens the
   `to_workspace` dialog. Dropping a workspace page on the Private Space header, a Private Space folder, or a page
   in one opens the `from_workspace` dialog. The dialog is prefilled with the pages, the workspace or folder, and
   the mode, and it still shows the preview (members, link classes, problems, warnings) and waits for the person to
   confirm. Copy is chosen unless Alt/Option is held at the drop; then Move is chosen, and the dialog's mode radio
   shows it. Within one tree, drag and drop is unchanged. A workspace page dragged onto another workspace is not
   accepted: there is no transfer between workspaces.
2. **Where it lands.** The engine and protocol already take a destination parent page (`ToWorkspaceRequest.parentId`)
   and a vault folder (`FromWorkspaceRequest.folder`), so nothing in the protocol or the server changed.
   - On a workspace page, the pages go inside it. That page row is lit, and the dialog's "Put the pages" shows it.
   - On the workspace row, they go to the top level.
   - On a Private Space folder, the page goes into that folder. That folder row is lit.
   - On a page in a folder, it goes into the page's folder. The folder row is lit, not the page.
   - On a top-level page or on the header, it goes to the top level. The header is lit.
   - A dragged Private Space folder travels as a folder page holding its pages: `base` is the folder's parent,
     ADR-0016 rule 3. Empty sub-folders do not travel, as with "Select pages".
   - A dragged workspace folder takes its whole subtree, and a dragged page takes only itself, as the page's own
     buttons do.
3. **Refused targets show no indicator and the "no drop" cursor, and the pointer says why.** The pointer badge
   names the reason. These are refused:
   - a viewer workspace as the destination ("You are a viewer in X.");
   - a server without `transfers` ("X does not accept transfers."). When capabilities are not known yet, the
     preview decides;
   - a signed-out server. Its workspaces are not listed, so this is a safeguard;
   - an export-restricted workspace as the source ("X does not allow copying or moving its pages out.").

   A page dropped on itself, or into itself, is the tree's own refusal, as before. A viewer's workspace pages
   stay undraggable, as within the tree; they copy out with the page's "Copy to Private Space…". The server
   remains the authority (ADR-0009). This only spares people a dialog that could not start.
4. **Look.** The drop uses the trees' accent indicator (`data-drop="inside"`, a tint on the row or header), with
   `effectAllowed = copyMove` and `dropEffect` set to `copy`, or `move` with Alt/Option. The browser fixes the drag
   picture at dragstart, so a badge drawn under it says "Copy to Studio…", "Move to Private Space…" or the reason.
   A polite live region repeats the badge's text. The keyboard way is unchanged: Select pages, then Copy/Move to
   workspace…, and the page header's Copy/Move to Private Space….
5. **Implementation.** `packages/app-ui/src/order/space-drag.ts` holds:
   - the payload (`application/x-thoth-page`, `{ from, row, ids, title, base? }`);
   - a small shared store, so the tree under the pointer knows what is dragged during `dragover`;
   - the pure drop rules.

   `useTreeDnd` gained `carry` (source) and `across` (target), and `useAcrossDropZone` covers the header. The
   desktop shell turns a drop into a prefilled `TransferTarget`. The web client does not opt in (`spaceDrops`).

Gaps: a drag from one app window to another is not recognised (the shared state is per window). Dropping on a
workspace page cannot choose a position among its children; the server puts the pages where a transfer always
puts them.

Pinned by `packages/app-ui/test/space-drag.test.ts`, `packages/app-ui/test/space-dnd.test.tsx`,
`apps/desktop/test/cross-space-dnd.test.tsx` and `tests/e2e/cross-space-dnd.e2e.ts`. The menu transfers were
checked again end to end in `tests/e2e/transfer.e2e.ts`: copy, move, move back, a conflict copy, a taken name, and
the export-restricted refusal. No bugs were found.
