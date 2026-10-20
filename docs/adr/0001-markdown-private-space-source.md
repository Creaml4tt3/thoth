# ADR-0001: Markdown as portable Private Space source

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

The Private Space must exist with no account, server or network; must stay
usable in ordinary text editors if Thoth is uninstalled; must survive loss of
the index; and must never upload content automatically (spec sections 3.1, 12).
Users may point Thoth at a folder that other tools (editors, Obsidian, sync
clients, git) also modify, so Thoth cannot assume exclusive control. The locked
decision for private storage is "Hybrid Markdown plus local index" (section 2).

Filesystem writes and SQLite transactions cannot be made atomic together, so a
crash can leave the file tree and the index disagreeing (section 6.3).

## Decision

1. **Source of truth.** Markdown files (CommonMark + GFM) with optional YAML
   frontmatter are the source of truth for page content. Attachments are
   ordinary files in the vault.
2. **`.thoth/` directory.** It holds:
   - `config.json`
   - `index.sqlite` - a cache. Deleting it loses no content and the index is
     rebuilt from the files plus the durable JSON records below.
   - `operations/` - journal and staging for imports and transfers.
   - `manifests/` - import manifests and reports.
   - `sync/` (reserved for P2/P3) - durable JSON records for remote mappings
     (`external_locations`) and sync base revisions (`sync_state`). Spec §6.3
     lists these as index tables. Because they cannot be derived from Markdown,
     the index table is a projection of these files, never the only copy.
3. **Frontmatter is optional for reading.** Thoth never requires frontmatter to
   read a file. Unknown frontmatter keys, and their order, are preserved on every
   write.
4. **No exclusive control.** External edits are detected by reconciling
   (mtime, size, sha256 content hash) against the index. A filesystem watcher is
   only a trigger for reconciliation, not the source of truth for change
   detection. Periodic reconciliation also runs (spec section 6.3).
5. **Compare-and-swap writes.** Each write carries the content hash the caller
   expects to replace. If the file on disk no longer matches, Thoth refuses to
   overwrite it and surfaces a conflict. There is no silent overwrite.
6. **Atomic per-file writes.** Write a temp file in the same directory, fsync,
   then rename over the target.
7. **Journal for filesystem + index.** An operation journal entry is written
   before a mutation and cleared after the index update. On startup, pending
   journal entries are reconciled against the filesystem and the index.
8. **No automatic upload; no network required.** Private Space operations never
   need network access and never send content anywhere without an explicit user
   action.

## Consequences

- Positive: content is portable and inspectable; index corruption is a rebuild,
  not data loss; coexistence with other editors is possible.
- Positive: the compare-and-swap rule gives one conflict principle that other
  ADRs reuse (ADR-0005, ADR-0007).
- Negative: reading a large vault requires hashing and reconciliation work;
  rebuild time scales with vault size.
- Negative: features that need metadata Markdown cannot carry must go in
  frontmatter, a durable `.thoth/` JSON record, or the regenerable index;
  anything stored only in the index is by definition disposable.
- Follow-up: `packages/local-store` implements journal, CAS write, reconciliation
  and rebuild; failure-injection tests are needed for crashes between rename and
  index update.

## Alternatives considered

- **SQLite (or another database) as source of truth.** Rejected: violates
  "usable in ordinary text editors" and "index loss must never mean content
  loss".
- **Proprietary block JSON files.** Rejected: not readable outside Thoth.
- **Exclusive-ownership folder with a lock file.** Rejected: users are expected
  to run other tools on the same folder (spec section 6.2).
- **Trust the watcher alone for change detection.** Rejected: watchers drop and
  coalesce events; hash reconciliation is required for correctness.

## Spec references

Section 2 (private storage, local index), 3.1, 6.2, 6.3, 12 (no automatic
upload), 18 (no hidden network requirement, no silent destructive operations).

## Open questions

- Maximum tolerated reconciliation cost for very large vaults (full rehash vs.
  mtime/size short-circuit thresholds). Blocks performance tuning only.
- Behavior on network or cloud-synced folders where mtime or rename semantics are
  unreliable. Not decided.
