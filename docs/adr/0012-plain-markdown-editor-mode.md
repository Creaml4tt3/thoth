# ADR-0012: Plain Markdown editor mode beside the block editor

- **Status:** Accepted (owner request 2026-10-22: "Block plus Plain with live preview")
- **Date:** 2026-10-22

## Context

The spec locks "Editor: Tiptap / ProseMirror, with explicit Markdown
serialization" (section 2), and ADR-0002 defines that editor. The owner asked
for two ways to write: a block editor like Notion, and plain Markdown writing
like Obsidian. Pages are Markdown files (ADR-0001), so a text editor can edit
them directly. The question is how to add one without weakening the
guarantees in ADR-0002 and the save and conflict rules of `PageSession`.

## Decision

1. **Two modes, one file.** *Blocks* is the Tiptap editor from ADR-0002,
   unchanged. *Plain* is a CodeMirror 6 text editor over the same file. Both
   implement the same `EditorBridge`, so `PageSession` (compare-and-swap
   writes, no-op saves, conflict dialog, read-only non-UTF-8 files) is shared
   code, not reimplemented.
2. **Plain mode has no model and no serializer.** What it saves is the loaded
   source with the user's edits applied. Untouched text is byte-identical
   because nothing re-renders it:
   - the line separator is chosen per file (CRLF only when every line break is
     CRLF); other line-break characters stay inside their line as text;
   - a leading BOM is held aside and written back;
   - pasted text takes the file's line ending.
3. **Live preview is display only.** Markup is hidden on lines without the
   cursor; wikilinks render as chips, task markers as checkboxes, bullets as
   dots. The line being edited always shows its exact source. Toggling a
   checkbox is an ordinary one-character edit. The preview never rewrites the
   document.
4. **Switching modes never saves.** The current text, unsaved edits included,
   is carried into the other editor. Switching is disabled while a conflict is
   open. Leaving Plain for Blocks parses the text with ADR-0002's rules, so
   per-block preservation still applies when the page is later saved from
   Blocks.
5. **Mode is a view preference, never stored in the file.** The default mode
   is an app preference (Settings → Editor, kept in the webview's
   localStorage). The toggle above a page (or Ctrl/Cmd+Shift+E) switches that
   page for the session.
6. **Dependencies:** `@codemirror/*` and `@lezer/*` (MIT). Versions are pinned
   to releases at least a day old, matching the workspace's release-age rule.

## Consequences

- Positive: an Obsidian-style way to write with no risk to the file. Plain mode
  is the strictest "minimal diff" editor Thoth has.
- Positive: unsupported constructs (shown read-only in Blocks as `raw`) can be
  edited in Plain mode.
- Negative: two editors to maintain and style. Keyboard shortcuts differ by
  mode (Blocks: Mod-B/I/E marks; Plain: plain text editing).
- Negative: the Markdown grammar for highlighting (`@lezer/markdown`) is a
  second parser beside mdast. It only drives display; indexing and saving
  still use `@thoth/content`. Rare disagreements show as odd highlighting,
  never as changed text.
- Follow-up: wikilink autocomplete, and a slash menu and toolbar for Blocks
  (both listed as missing after Phase 1c); remembering a page's mode across
  restarts if the owner wants it.

## Alternatives considered

- **Replace Tiptap with CodeMirror.** Rejected: contradicts the locked editor
  decision and drops the block editing the owner asked to keep.
- **Source view inside Tiptap (a code block holding the whole page).**
  Rejected: no live preview, and the text would still pass through the block
  serializer.
- **Store the mode in frontmatter.** Rejected: writes to user files for a view
  preference and makes switching produce diffs.
- **Show the editor's own serialization in Plain mode.** Rejected: would
  reformat text the user did not touch.

## Spec references

Section 2 (editor), 3.1 (local-first saving), 18 (no silent content loss).

## Open questions

- Whether a page's chosen mode should persist across restarts (for example in
  `.thoth/`, never in the page). Not needed for v1.
- Night theme styling of Plain mode follows when Night ships in the shell.
