# ADR-0003: Stable logical identity vs physical location

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

A filename or URL must not be the sole identity of a page (spec section 6.1).
Pages move between folders, between Private Space and Workspaces, and get
imported from systems with their own IDs. Users also create and rename files
outside Thoth. The spec requires separating logical identity, location, revision,
provenance and access.

## Decision

1. **Five separate concepts.**

   | Concept | Representation |
   | --- | --- |
   | Identity | page ID |
   | Location | vault-relative POSIX path, Unicode NFC-normalized |
   | Revision | local: sha256 of file bytes; remote: opaque server revision ID |
   | Provenance | import source or transfer origin |
   | Access | server-side for Workspaces; Private Space is single-user local |

2. **Persisted page ID** is a UUIDv7 string in frontmatter key `thoth_id`. It is
   written when Thoth creates or imports a page, or before a page participates in
   a transfer or remote mapping.
3. **Provisional IDs.** A file Thoth has not adopted (for example, created
   externally) gets `local:<first 32 hex of sha256(NFC vault-relative path)>`,
   recomputed deterministically on index rebuild. Thoth does not write
   frontmatter into externally created files merely by reading or indexing them.
   Provisional IDs change if the file is renamed externally; this is an accepted
   limitation.
4. **Duplicate IDs.** If two files carry the same `thoth_id` (for example, a user
   duplicated a file), the index keeps the first by path order and flags a
   duplicate-ID warning. No automatic rewrite.
5. **Provenance for imports** is stored in frontmatter key `thoth_source` (map:
   `system`, `sourcePath`, `sourceId` when known, `importJobId`) and in the import
   manifest, so it survives index loss.
6. **Remote mapping.** The `external_locations` table maps local page IDs to
   remote workspace resource IDs. Mappings are also journaled in transfer
   operation records (ADR-0006).
7. **Path collisions** are evaluated case-insensitively and after NFC
   normalization, because default macOS and Windows filesystems are
   case-insensitive.

## Consequences

- Positive: moves and renames inside the vault do not change identity for adopted
  pages; links can be remapped by ID; provenance survives index loss.
- Positive: reading a vault never modifies it.
- Negative: unadopted files lose identity on external rename; remote mappings for
  such files cannot be kept (hence adoption before transfer).
- Negative: `thoth_id` and `thoth_source` add visible frontmatter to adopted
  pages; users who dislike this have no opt-out defined yet.
- Follow-up: the index rebuild must be deterministic regarding duplicate IDs;
  tests for NFC, case-insensitive collisions and Thai/emoji names (spec 7.5).

## Alternatives considered

- **Path as identity.** Rejected: breaks on rename and cannot map across systems.
- **Sidecar ID files or an ID table only in SQLite.** Rejected: IDs would be lost
  with the index, contradicting "index loss never means content loss".
- **Write `thoth_id` into every file on first scan.** Rejected: mutates files the
  user did not ask Thoth to change and conflicts with no-exclusive-control
  (ADR-0001).
- **Content-hash-based identity.** Rejected: changes on every edit.

## Spec references

Section 2, 6.1, 6.2, 6.3 (`external_locations`), 7.2 (source IDs, same-title
pages), 7.5 (Unicode and case collisions), 9.1 (mappings).

## Open questions

- Opt-out or alternate location for `thoth_id` for users who do not want
  frontmatter changes. Not decided.
- Content-based re-matching of externally renamed unadopted files (heuristic) is
  not part of this decision.
- Whether the duplicate-ID warning offers a guided fix action in the UI.
