# ADR-0032: First run, Welcome pages and a tour of the basic tools

- **Status:** Proposed
- **Date:** 2026-10-27
- **Deciders:** owner (scope: a Welcome page set instead of an empty space, and a skippable tour), orchestrator (brief), implementation agent

## Context

A new, empty Private Space opened on the Intro ("Start writing" / "Import"), and "Start writing" left an empty space,
so the first thing a person saw was nothing. The owner asked for pages that teach by example and a short tour of the
controls. Constraints: pages are the user's Markdown files (ADR-0001), every write is compare-and-swap, nothing may be
overwritten, and the editor must round-trip what it opens byte for byte.

## Decision

1. **The Welcome pages are real Markdown files in the repo**, `apps/desktop/src/features/onboarding/welcome/en/` and
   `th/`, plus one SVG, bundled with `?raw`. `Welcome to Thoth.md` shows every block kind and text style the editor
   round-trips (no raw or HTML blocks), each with its `/` command, key or Markdown; `Linking pages.md` every kind of
   link and an embed; `Getting started/Keyboard shortcuts.md` the keys that matter, per platform, as the shortcut
   table writes them. A unit test opens and saves each file (untouched and canonical) and gets the same bytes, and
   checks the shortcuts page against `shortcuts.ts`.
2. **Written once, only into an empty space, never over anything.** "Start writing" on the Intro calls `seedWelcome`:
   nothing when `.thoth/onboarding/welcome.json` exists or the space has pages; otherwise each file through
   `writePage` / `writeFileAtomic` with `expectedHash: null` (a taken name is skipped), then the record (also
   create-only). The language is the UI's at that moment. The pages carry no `thoth_id`, so the files are the repo's
   bytes; one is added the first time something needs it (ADR-0003). Deleted pages never come back. A failure to write
   them opens the space as before. The Intro keeps "Import from Notion or Obsidian".
3. **The tour** (`apps/desktop/src/features/tour/`): up to seven steps, each beside a real control: the tree, New page /
   New folder / Import, search and the palette, the editor (`/` menu and block handle), the tab bar, Home, and the
   assistant. A step whose control is not on screen (inert or hidden, no size, outside the window) is left out, so
   "3 of 6" counts what is shown. It starts once the Welcome page's editor is on screen after the set was written, and
   from Settings → Getting started → "Show the tour again" and the palette command "Show the tour".
4. **Not modal.** Focus moves to the popover's main button at every step; Escape or "Skip tour" skips; Back / Next /
   Done. The control is ringed and described by the step's text (`aria-describedby`), and each later step is said in a
   live region. The ring and description of the editor step go on the editor's frame, never on nodes the editor owns.
   Placement is `placeBeside` (`packages/app-ui/src/ui/place.ts`), which the tooltip now uses too; motion is the motion
   tokens, so reduced motion has none.
5. **Seen is remembered** in the webview's localStorage (`thoth.desktop.tour`: `finished` or `skipped`), per app, not
   per Private Space: a second new space does not show it again.

## Consequences

- Scenarios that start from an empty space and expect it empty mark the Welcome pages as done first
  (`tests/e2e/welcome.ts`, and the record in two unit tests).
- The Thai page names and text want a native reader's pass (marked REVIEW).
- Not checked in a real Tauri window: the tour's placement and focus (checked in Chromium through the bridge).

## Open questions

- Whether the web client wants the tour too (it has no Intro and no assistant).
