# Canonical content schema and Markdown contract (v1)

Implements ADR-0001, ADR-0002, ADR-0003. The Zod schemas in
`packages/domain` and `packages/content` are the source of truth. JSON Schema
copies are generated into `protocol/schemas/` with `pnpm schemas`, and
`pnpm schemas:check` fails when the copies are stale.

## 1. On-disk page format

A page is a UTF-8 `.md` file: optional YAML frontmatter, then a
CommonMark + GFM body.

```markdown
---
aliases: [Start]          # user/plugin keys: preserved byte-for-byte
tags: [project]
thoth_id: 01a15a16-13ff-73a8-9964-000300ca0d43   # optional; written by Thoth
thoth_source:                                    # optional; imports/transfers only
  system: notion
  sourcePath: Thoth Handbook 1a2b…/Project Atlas 6f70….md
  sourceId: 6f708192a3b44cf3a4b5c6d7e8f90112
  importJobId: 01a15a16-…
---
# Body
```

| Key | Owner | Meaning |
|---|---|---|
| `thoth_id` | Thoth | Stable logical identity (UUIDv7). Absent → provisional `local:<hash(path)>` ID in the index only. |
| `thoth_source` | Thoth | Provenance (`ProvenanceSchema`). Never used for identity. |
| `title` | User | Display title. Falls back to the filename stem. |
| `aliases` / `alias` | User | Alternative link names (list or comma-separated string). |
| `tags` / `tag` | User | Tags, merged with inline `#tags`. |
| anything else | User/plugins | Preserved; never reordered, reformatted, or dropped. |

Write rules (`updateFrontmatter`):

- Changed keys are spliced into the YAML text by node range. New keys are
  appended. Other lines, comments, quoting, and flow lists are untouched.
- If the frontmatter is malformed or flow-style (`{...}`), Thoth refuses to edit
  it. Import keeps such files verbatim and does not write `thoth_id`.
- BOM and CRLF line endings are preserved.

## 2. In-memory model: `PageDocument` (schemaVersion 1)

Derived from source on every read and never persisted, so it can always be
regenerated.

- `frontmatter`, `frontmatterError?`, `bodyOffset`
- `blocks[]`: `paragraph | heading | list | taskList | blockquote | callout |
  code | table | thematicBreak | image | embed | html | math | raw`. Each block
  carries an exact `SourceRange`; `raw`/`html` blocks keep their source verbatim.
- `references[]` (`ParsedReference`): `markdown-link | markdown-image |
  definition | wikilink | embed`. Each has the decoded `target`, `fragment`,
  `label`, `external`, the whole-construct `range`, and the `targetRange` used
  for in-place rewriting.
- `headings[]`, `blockAnchors[]` (explicit `^id` only), `tags[]`, `aliases[]`,
  `thothId?`, `plainText` (for FTS)

## 3. Link semantics

- Wikilinks stay wikilinks. Resolution happens against the whole file set, in
  this order: exact vault path (`.md` optional) → path relative to the linking
  file → unique basename → unique path suffix → unique alias.
- Several candidates → `ambiguous`. Thoth never guesses, and never retargets a
  link by title.
- Markdown links resolve relative to the file, then from the vault root.
  `%`-encoding and `<...>` destinations are supported.
- Links inside code spans, code blocks, and HTML are not references.
- Programmatic rewrites (`rewriteTargets`) replace only the `targetRange`.
  Fragments, aliases, titles, and surrounding text keep their exact bytes.

## 4. Index (cache) — `.thoth/index.sqlite`

Tables per spec §6.3: `pages`, `page_aliases`, `page_tags`, `blocks`, `refs`,
`attachments`, `search_content` (FTS5 `unicode61`, diacritic-insensitive),
`search_trigram` (FTS5 `trigram`, for scripts without word separators such as
Thai), `index_warnings`. Also present: `external_locations`, `sync_state`,
`operation_journal`, `import_jobs`, `import_items`. The first two are
projections of durable `.thoth/` JSON records (ADR-0001 §2).

Deleting the index loses nothing; `Vault.rebuildIndex()` and `Vault.open()`
regenerate it. The rebuilt index is identical, which is checked by the
`rebuilds an identical index` test.

## 5. Import manifest — `.thoth/manifests/import-<jobId>.json`

`ImportManifestSchema` records:

- job state, the source fingerprint, and the stripped wrapper prefix
- options
- every item: key, source path and hash, destination, assigned `pageId`,
  `sourceId`, state, staged hash, and warnings
- link statistics

It never contains page content.
