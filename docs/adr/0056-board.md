# ADR-0056: Board, sticky notes for pages and string for their links

- **Status:** Proposed. The owner chose the direction on 2026-11-19 (a new view separate from Connections, an Overview
  and the user's own boards, drawn string adds a real link, the sticky-note look, `.canvas` files); the rest are the
  Main Thread's calls in the design (`docs/superpowers/specs/2026-11-19-settings-select-board-design.md`, Part 3).
- **Date:** 2026-11-20
- **Deciders:** project owner (the view, its two modes, links from string, the look, the file format); the details
  are this ADR's.
- **Amends:** ADR-0045's "no graph view" (its Consequences). Connections (ADR-0050) stays as the panel.

## Context

ADR-0045 accepted that Thoth has no graph view. People still want to *see* how their notes connect, as in Obsidian's
graph, and the owner wants that to feel like Thoth's own, not floating dots. The link index of a Private Space already
holds every page, tag and resolved link, so a view of them costs one read. Obsidian keeps hand-made boards as JSON
Canvas 1.0 files, an open format that Thoth can read and write without locking people in.

## Decision

1. **A Board view, separate from Connections.** A tab `{ kind: "board"; path?: string }`, opened from a "Board" entry in
   the sidebar (next to Timeline), the command palette ("Open Board"), a `.canvas` row in the page tree, and "Board
   from this page". No `path` is the **Overview**; a `path` is one of the user's **boards**.
2. **Overview:** every page of the Private Space as a note and every resolved link as string, laid out by `d3-force`
   once to rest (in a worker above 300 pages), then still. Positions are cached for the session only, never written.
   Filters by tag and by folder. Below 40 % zoom notes draw as coloured squares in one SVG; above it only notes in view
   are in the DOM.
3. **Boards are `.canvas` files** (JSON Canvas 1.0) in the Space, next to the notes; Obsidian can open them. Each pinned
   page is a `file` node (top-left `x`, `y`, `width`, `height`). Unknown nodes (`text`, `link`, `group`), edges and
   fields are kept as they were, so a round trip loses nothing. A save is debounced 500 ms and compare-and-swap; on a
   conflict Thoth reads the file again, re-applies only its own changes by node id, and writes once more. Moving or
   renaming a pinned page rewrites its `file` path in every board, as links are rewritten.
4. **Strings are links, never edges.** Strings are drawn from the pages' real links in the index, so they are always
   true. Thoth never writes canvas edges.
5. **Drawing string adds a link.** Dragging from a note's pin onto another note appends one link line at the end of
   the source page, spelled by the same `linkText` as Connections' "Link", through compare-and-swap after every open
   page's edits are written; one conflict retries, then Thoth says so. "Link to…" in a note's menu does the same from
   the keyboard.
6. **Rendering:** notes are real DOM buttons on a plane moved by CSS `transform`; strings are one SVG layer. No
   `<canvas>` drawing. The region is `role="application"` with instructions; a List view shows the same notes and links
   as a plain list.
7. **Undo/redo** (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z) covers moves, pins, removals and drawn links for the tab's life. A drawn
   link is undone only while its line is still the page's last line and unchanged.
8. **Private Spaces in the desktop app only.** Shared workspaces have no link index on the server and the web app is
   trial-only (ADR-0015), so neither has a Board yet.
9. **Look:** the paper desk with sticky notes in their folder's colour, a Moon pin, tag chips in the Moon soft wash, and
   Moon strings on the selected note (`design/DESIGN.md`, "Board").

## Consequences

- Positive: people see clusters and stray notes at a glance, and build case boards that stay put and open in Obsidian.
- Positive: a string on the board is always a link the index resolves, so the board and the pages never disagree.
- Negative: `d3-force` (ISC) is a new dependency, listed in `THIRD-PARTY-LICENSES.txt`.
- Notes from the build:
  - The layout pushes overlapping notes apart with a grid separation pass instead of `forceCollide`, which took seconds
    at 2,000 notes.
  - The layout works in note centres; the Overview turns them into top-left corners (JSON Canvas's convention) in one
    place.
  - A drawn link is written only if, in the page as it would be, the new line parses as one whole link that resolves
    to the target (not inside an open code block, not a name that cannot be spelled as a link); otherwise nothing is
    written and the board says the page changed.
  - A `.canvas` file is re-indented with 2 spaces the first time Thoth writes it; its content is unchanged.
  - Boards appear in the page tree (board icon) and can be renamed, moved and deleted like any file; they never go to
    a workspace.
  - A note's accessible name includes what it shows (title, first line, tags) and then its number of links (WCAG 2.5.3).

## Alternatives considered

- **A floating force graph** (Obsidian's): rejected by the owner; Thoth's view stays still and readable.
- **Storing strings as canvas edges:** they would drift from the pages' real links.
- **Drawing on a `<canvas>`:** about three times the work, and not accessible without a parallel DOM.
- **Saving Overview positions:** it is Thoth's layout; only boards keep places.

## Open questions

- Board in shared workspaces and the web app: needs a link index on the server (later).
- The first line on a note is the page's raw first line, so link syntax (`[[Notes]]`) shows as typed.
- Free-text cards, images or groups created in Thoth: not planned (kept only if Obsidian made them).
