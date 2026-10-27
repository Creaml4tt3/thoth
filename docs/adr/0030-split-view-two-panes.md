# ADR-0030: Split view, two panes side by side

- **Status:** Proposed
- **Date:** 2026-10-27
- **Deciders:** owner (scope: up to two panes, side by side, VS Code style), orchestrator (brief), implementation agent
- **Amends:** ADR-0019 (tabs and windows), ADR-0016 rule 5 (tabs)

## Context

A window had one tab strip and showed one tab. The owner asked for a VS Code style split: up to two panes side by side,
each with its own tabs, made by dragging a tab to the right edge or with "Split right". Constraints:

- tabs are plain data in `packages/app-ui/src/tabs/model.ts`, stored as ids with no titles (ADR-0016 rule 5, ADR-0019);
- each mounted page has a page session with its own base hash, and every write is compare-and-swap on it (ADR-0001,
  `packages/app-ui/src/editor/page-session.ts`). Two editors on one page with two sessions would make the second save a
  conflict with the first, in one window;
- `flushAll` (each window's list of `registerFlush` callbacks) must write every mounted editor before anything that
  needs saved pages: switching tabs, transfers, moving a tab to a window, closing, switching the Private Space;
- Home and Settings are one tab per window (ADR-0029).

## Decision

### Layout

1. **A window's layout is one or two panes, side by side** (`packages/app-ui/src/tabs/layout.ts`): `panes` (each a
   `TabsState`, the single-strip model unchanged), the active pane's index, and the left pane's share of the width
   (`ratio`, 0.5 by default). The single-strip functions (open, close, pin, move, prune, remapPaths…) still work on one
   pane; the layout functions find the pane and call them. Tab ids are unique across the window (the panes share one
   counter), so an operation on a tab id finds its pane. The model takes `MAX_PANES = 2`; nothing in it assumes two
   apart from that constant and "the other pane", so more panes (or stacked ones) can come later without a new store
   format.
2. **The active pane** is the one clicked or focused last. New pages, the palette, shortcuts (Cmd/Ctrl+1–9, next and
   previous tab, close tab, pin), notifications and `openOrFocus` act on it. `openOrFocus` finds a tab in either pane;
   Home, Settings and an assistant session stay one per window: opening one that is open in the other pane goes there.
   The current tab of each pane is mounted (two at most); the others are not, as before.
3. **Splitting.** "Split right" (the tab's menu, the palette, Cmd/Ctrl+Option/Alt+\ by physical key) moves a tab into
   a new right pane, which becomes active. A split from a pane with one tab leaves a new tab behind (Home), so the left
   pane is never empty. With two panes, "Split right" is not offered; "Move to other pane" (menu and palette) moves the
   tab there instead.
4. **Dragging.** While a tab is dragged (pointer only, ADR-0019 rule 2), the page area shows a drop zone:
   - with one pane, the right part of the page area (from 60% of its width). The zone shades the right half, where the
     new pane will go (dashed while dragging, filled once the pointer is over it), and the tab's picture at the pointer
     says "Release to split right". A release there splits;
   - with two panes, the other pane (its tab bar or its page). A release on its tab bar puts the tab where it was let
     go among that pane's tabs (pinned tabs stay among the pinned ones); on its page, after its current tab.

   A release over a zone is never a move to a new window. Elsewhere the drag works as before (reorder in its own bar,
   or a new window below the bar or outside the window on the desktop).
5. **A pane whose last tab leaves closes** (moved to the other pane, closed, or sent to a new window), and the window is
   one pane again; the remaining pane is active. Closing the last tab of the only pane leaves a new tab, as before.
   Pinned tabs keep their rules per pane (ADR-0027): Cmd/Ctrl+W on one says how to close it; a pinned tab that moves
   stays pinned. A pane holds up to 30 tabs (`MAX_TABS`); a move into a full pane does nothing.
6. **Resizing.** A vertical `role="separator"` between the panes, the pattern of `SidebarResizer`: pointer drag,
   Left/Right by 16 px (Shift: 64 px), Home and End to the smallest and largest, Enter or a double-click back to half.
   Each pane is at least 320 px; a window too narrow for two panes keeps both, and the separator clamps to the middle.
7. **Keyboard.** Alt/Option+Shift+\ (both clients, by physical key) and F6 (desktop) move focus to the other pane: the
   pane becomes active and focus goes to its current tab. Each pane's tab list is named "Open pages, left" and "Open
   pages, right" while there are two (just "Open pages" with one). Moving a tab between panes is announced.

### Storage and windows

8. **Stored form `v: 2`**: `{ "v": 2, "active": <pane index>, "ratio": <0–1>, "panes": [{ "active": n, "tabs": [...] }] }`,
   each pane's entries as in `v: 1`. A `v: 1` list reads as one pane, so nothing is lost on upgrade; an older version
   reading `v: 2` starts with one new tab. On reading, Home and Settings after their first appearance are dropped (one
   per window), a pane left with no readable tab is dropped, and a ratio out of range is 0.5. The desktop saves the
   layout per Private Space and window, as before; the web per browser.
9. **Moving a tab to a new window** (ADR-0019 rule 11) works from either pane. The new window opens with that one tab
   (one pane, stored as `v: 1`, which `v: 2` reads). The tab's pane closes if it was its last; a window's only tab still
   cannot leave.

### One page in both panes

10. **One page session per page per window, shared by every editor showing it** (`editor/session-pool.ts`). The pool is
    per window (per `PageHost`), keyed by the store's kind and the page's mode key (Private Space folder and path, or
    server, workspace and page id). The second editor joins the first one's session: one base hash, one autosave, one
    save, one conflict dialog, one `registerFlush`. Concretely:
    - **What is saved** is the text of the editor that was edited or focused last (the *lead*). The other editor is
      brought up to date from it a moment after each edit (150 ms) and at once when it gets focus, so an edit is never
      typed into a stale copy. That update replaces the other editor's document and its undo history (it is a load,
      like a change on disk; Undo never brings back text from before it).
    - **A change on disk** (or on the server) reloads every editor of the page, by the existing rules (silently with no
      local edits, else the conflict dialog).
    - **The conflict dialog, the save-conflict notification and the "saved" analytics event** come from one editor
      only (the lead, else the first), so they are not doubled.
    - **Leaving.** When one of two editors goes (its tab switched, closed or moved), its text is given to the other
      first. When the last one goes, the session flushes (the text is read at once) and is disposed afterwards. If the
      same page is shown again before that flush ends, the new editor joins that session with the text just read,
      rather than a new session reading a disk that the flush is still writing.
    - **Mode.** Each editor keeps its own Blocks/Plain mode. The mode key (Cmd/Ctrl+Shift+E) and the palette's editor
      commands act on the editor of the active pane only.

    The alternative (the same page cannot be open in both panes) was not chosen: seeing one page twice (the top and the
    end of a long page) is a reason to split.

## Consequences

- Positive: two pages, or two places in one page, side by side; one save path, so no self-made conflict.
- Negative: the second editor's undo history restarts on each catch-up; a page open twice costs a second
  serialization after edits. A window that was split comes back as one pane in an older Thoth.
- Follow-up: more panes or a stacked split (the model allows it); a keyboard way to resize from the palette.

## Alternatives considered

- **One page in one pane only** (opening it in the other pane switches to its tab). Simpler, but it rules out a common
  reason to split.
- **Two sessions and merging.** Each editor saving on its own base, with a three-way merge on conflict: more code, and a
  merge can still need the user, inside one window.
- **A layout tree** (VS Code's grid). Not needed for two panes side by side; the flat list of panes leaves room for it.

## Spec references

- ADR-0016 rule 5 (tabs), ADR-0019 (tab order, windows), ADR-0027 (pinned tabs), ADR-0029 (Home), ADR-0001 (writes).

## Open questions

- Whether a split from a one-tab pane should duplicate the tab (VS Code) rather than leave a new tab behind.
