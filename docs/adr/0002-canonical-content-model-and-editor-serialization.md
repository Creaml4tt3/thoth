# ADR-0002: Canonical content model and editor serialization

- **Status:** Accepted (editor part accepted 2026-10-21 when `packages/editor` landed with golden tests); a second, Plain text mode is added by ADR-0012 without changing this decision
- **Date:** 2026-10-20

## Context

Content is stored as Markdown (ADR-0001) but the application, importers,
transfer engine and protocol need a typed in-memory model. The editor is
Tiptap/ProseMirror with explicit Markdown serialization (spec section 2). Users
and other tools edit the same files, so Thoth must not rewrite text it did not
need to touch, and must not drop constructs it does not understand. Wikilinks and
Obsidian-style callouts are common in the vaults Thoth imports (spec section
7.3).

## Decision

1. **Persisted canonical form is the Markdown source.**
2. **In-memory canonical model: `PageDocument` (schemaVersion 1)** consisting of:
   - frontmatter: an ordered map; unknown keys preserved;
   - body source text;
   - derived block list;
   - derived references.
   The model is defined as Zod schemas in `packages/content` and
   `packages/domain`. JSON Schema is generated from the Zod schemas for protocol
   use.
3. **Block types, v1:** `paragraph`, `heading` (level 1-6), `list` (ordered,
   items), `listItem`, `taskItem` (checked), `blockquote`, `callout` (kind, title;
   Obsidian `> [!kind]` syntax), `code` (lang), `table`, `thematicBreak`, `image`,
   `embed` (`![[...]]`), `html`, `math` (reserved), `raw`.
4. **Nothing is dropped.** Any construct Thoth does not understand becomes a `raw`
   block carrying its exact source text.
5. **References** recognized and indexed:
   - Markdown links `[t](path.md)` and images `![a](path)`;
   - wikilinks `[[Target]]`, `[[Target|alias]]`, `[[Target#Heading]]`,
     `[[Target#^block]]`;
   - embeds `![[file]]`;
   - tags (`#tag` and frontmatter `tags`);
   - aliases (frontmatter `aliases`).
   Wikilinks are a first-class supported syntax and are not converted to
   Markdown links.
6. **Programmatic edits are source-range splices.** Link rewriting during import,
   transfer and rename uses parser source positions to replace only the affected
   ranges, so untouched text keeps its exact original formatting. Whole-document
   reserialization happens only when the user edits in the editor.
7. **Editor.** The Tiptap/ProseMirror schema maps 1:1 to the block types
   above. The Markdown serializer must round-trip the supported subset,
   verified with golden-file tests. Unsupported blocks render as read-only raw
   nodes that round-trip byte-for-byte. Implementation (`packages/editor`, contract
   in `docs/architecture/editor-serialization.md`):
   - Parsing reuses `@thoth/content` (mdast + GFM). The editor uses a custom
     Tiptap extension set, not starter-kit.
   - **Preservation is per top-level block.** Each block carries its exact source
     (`mdSrc`), its preceding separator (`mdSep`) and a fingerprint of its
     canonical form at parse time (`mdFp`). An untouched block is written back
     byte-for-byte. An edited block is written in canonical form. The output is
     reparsed to verify block boundaries, and a blank-line separator is used when
     a move would glue blocks together.
   - Editing one list item or table cell rewrites the whole list or table.
     Range-splicing smaller units remains the job of programmatic edits (rule 6).
   - **Raw fallback.** A top-level container that holds an unsupported child (a
     link reference or footnote definition, HTML, math) becomes a single `raw`
     block. `math` is a read-only atom with no behavior in v1.

## Consequences

- Positive: external tools see minimal diffs; imports and transfers cannot lose
  unknown syntax; one schema serves content, protocol and index.
- Positive: raw blocks make "no silent content loss" (spec section 18) a
  structural property.
- Negative: the editor's serializer is the one place that reformats text; golden
  tests must define what "round-trip the supported subset" means exactly.
- Negative: the block list is derived, so block IDs for the `blocks` index table
  are positional/derived unless a later decision adds persisted block IDs (see
  Open questions).
- Follow-up: choose and pin a Markdown parser that exposes source positions and
  frontmatter handling that preserves key order.

## Alternatives considered

- **Block JSON as canonical form, Markdown as export.** Rejected: conflicts with
  ADR-0001.
- **Convert wikilinks to Markdown links on read.** Rejected: loses Obsidian
  compatibility and changes user text.
- **Whole-document reserialization for every programmatic edit.** Rejected:
  produces noisy diffs and risks altering unsupported constructs.
- **Drop or flatten unsupported syntax.** Rejected: silent content loss.

## Spec references

Section 2 (editor, private storage), 6.1, 6.2 (frontmatter, unknown keys), 7.3
(wikilinks, embeds, callouts, tags, aliases), 15 step 1, 18.

## Open questions

- Persisted block IDs (for `[[Target#^block]]` anchors and the `blocks` table):
  whether Thoth ever writes `^block` markers itself. Not decided.
- ~~Which Markdown parser and Tiptap extension set to use.~~ Decided: mdast with
  GFM from `@thoth/content`, and a custom Tiptap extension set.
- Math block semantics (reserved in v1, no behavior defined).
- Finer-grained preservation (per list item or table row) if whole-container
  rewrites prove too noisy in practice.
