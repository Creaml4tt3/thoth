# ADR-0010: Notion/Obsidian import format and compatibility policy

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

Import from Notion and Obsidian is an MVP requirement (spec section 7). Notion
exports are lossy (databases become CSV; relations, formulas, views and
permissions are not reconstructable), and Notion itself warns that an export does
not recreate the original workspace. Obsidian vaults are already Markdown, but use
wikilinks, aliases and plugin syntax. ZIP inputs are untrusted (path traversal,
archive bombs). Source formats must be re-checked against the official
references in spec section 17 at implementation time.

## Decision

1. **Sources.** Notion "Markdown & CSV" export ZIP (including the multi-part
   nested-ZIP form if present) or its extracted folder; Obsidian vault directory,
   copied folder, or ZIP. Notion HTML export is a later extension.
2. **Adapters** over a shared pipeline in `packages/importer-core`:
   `NotionZipImporter`, `NotionMarkdownCsvImporter`, `ObsidianVaultImporter`,
   `ObsidianZipImporter`. Pipeline: secure scan -> source manifest ->
   preview/validation -> identity/path mapping -> convert -> stage -> verify links
   and hashes -> commit -> report.
3. **Security limits (configurable defaults).**
   - max entries: 50,000
   - max single uncompressed entry: 1 GiB
   - max total uncompressed: 10 GiB
   - max compression ratio: 200:1 for entries over 1 MiB
   - max nested ZIP depth: 1 (Notion multi-part only)
   - reject: absolute paths, drive letters, `..` segments, backslash traversal, NUL
     bytes, symlink entries, encrypted entries, duplicate normalized paths.
   Directory scans never follow symlinks and never leave the chosen root.
4. **Source is never mutated or deleted.** Default mode is copy-into-vault. "Open
   folder in place as a vault" is a separate explicit action, not an import.
5. **Idempotency.** Each job has an ID; each item has a deterministic key (source
   system + normalized source path). Resuming re-uses staged items whose hashes
   verify and never creates duplicates. Commit is a per-item rename from staging
   into the vault, with a journal (ADR-0001).
6. **Fidelity is best-effort and reported honestly.** Notion databases import as
   their original CSV files (all columns preserved) plus row pages. Relations,
   formulas, rollups, views, filters, automations, permissions, comments and
   history are not reconstructed and are listed in the compatibility report.
   Unknown or unsupported syntax is preserved verbatim and reported, never
   silently dropped.
7. **Links.** Obsidian wikilinks are preserved as wikilinks and resolved after the
   full scan, using Obsidian resolution order: exact path, then unique basename,
   then alias. Ambiguous targets are reported, never guessed. Notion URL-encoded
   relative links are rewritten to the new vault-relative paths. Same-title pages
   are never merged; source path/ID is kept as `thoth_source` metadata
   (ADR-0003).
8. **Filenames.** Notion 32-hex ID suffixes are stripped from destination names
   and kept as `sourceId`. Collisions (case-insensitive, NFC) get a deterministic
   numeric suffix and are reported. Unicode, Thai and emoji names are preserved.
9. **No code execution.** Imported scripts and plugin code are never executed.
   `.obsidian/` configuration is not imported and is reported as skipped.

## Consequences

- Positive: safe by default against hostile archives; resumable; no silent loss;
  the report is the user's record of what did not carry over.
- Negative: Notion fidelity is intentionally limited; users with heavy database
  use will see CSV files rather than live databases.
- Negative: default limits may reject legitimate very large exports until the
  user raises them.
- Follow-up: fixtures and acceptance tests listed in spec section 7.5; compat
  report format; verifying Notion naming conventions and multi-part export layout
  against current official docs and real exports.

## Alternatives considered

- **Generic file upload into one folder.** Rejected by spec section 7.
- **In-place adoption as the default for Obsidian vaults.** Rejected: ownership
  and watch semantics are unclear; copy is non-destructive.
- **Resolve duplicate titles by merging or guessing.** Rejected: risks wrong links
  and content merges.
- **Reconstruct Notion databases as native Thoth databases in MVP.** Not
  possible from export files alone and out of MVP scope.

## Spec references

Section 2 (imports), 7.1-7.5, 12 (archive protections), 13 (P1), 14 (steps 2-3),
17, 18.

## Open questions

- Compatibility report schema and where it is stored (`.thoth/manifests/` is
  specified for manifests; report format is not).
- Treatment of Notion callouts and other constructs exported as HTML (preserve as
  `html` or `raw` blocks, ADR-0002); exact mapping needs real export samples.
- Whether the limits are configured per import job, globally, or both.
- Handling of Obsidian embedded notes (`![[Note]]`) in the report beyond
  preservation.
