# ADR-0027: Favorites and pinned tabs

- **Status:** Proposed
- **Date:** 2026-10-26
- **Deciders:** owner (request), orchestrator (interpretation), implementation agent

## Context

The owner asked for a "Pin and Favorite pages function" on 2026-10-26. The orchestrator read it as two features, and this
ADR records that reading:

1. **Favorites:** star a page to keep it in a Favorites section at the top of the sidebar.
2. **Pinned tabs:** pin a tab so it stays at the left of the tab bar, compact, and is not closed by accident.

Constraints: page ids are stable only once adopted (ADR-0003: a path-derived id does not survive a move); `.thoth/` holds
Thoth's records and travels with the folder (ADR-0001); the tree order lives in `.thoth/order.json` (ADR-0016 rule 4);
tab order, windows and the reorderable sidebar sections are ADR-0019 and its amendment; the web client keeps no sign-in
data in `localStorage` (ADR-0015 rule 1); several windows may share one Private Space (ADR-0019).

## Decision

### Favorites

1. A page is starred or unstarred from: the star in its header (a toggle button named "Favorite" with `aria-pressed`;
   its tooltip says "Add to Favorites" or "Remove from Favorites"), the tree row's menu (pages only, not folders; in a
   workspace a viewer's row menu now offers this one item), the tab's menu, the palette ("Add to Favorites" / "Remove
   from Favorites") and the shortcut `page.favorite`: Cmd/Ctrl+D on the desktop, Alt+Shift+D on the web (Cmd/Ctrl+D is
   a browser's bookmark key and is added to `BROWSER_RESERVED`).
2. **The Favorites section** (stable id `favorites`) is one of the reorderable sidebar sections. When the stored order
   does not name it (a new layout, or one stored before it existed), it goes first; once moved, it keeps its place. It is
   **hidden while there is no favorite** (no empty header or hint), and keeps its stored place for when it comes back.
3. It lists the Private Space's favorites first, then each workspace's, in the order the person gave them. When the
   list holds more than one space, each row has a small hint ("Local", or the workspace's name). A click opens the
   page; Cmd/Ctrl+click, a middle-click and Cmd/Ctrl+Enter open a new tab. Up/Down/Home/End move between rows.
4. **Reordering** is among the favorites of the same space (a group): Alt/Option+Shift+Up/Down, the row's menu (Open in
   new tab, Move up, Move down, Remove from Favorites), or a pointer drag with the same live preview as the sections
   (`order/list-drag.ts`, moved from the desktop's `section-drag.ts`), which stops at the edge of the group. Every move
   is announced. Why groups: the two kinds are stored apart (rules 5 and 6), so one order across them would need a
   third record; keeping each space's order in its own store keeps one source of truth.
5. **Private Space favorites** are `.thoth/favorites.json`: `{"version":1,"pages":["<UUIDv7>", …]}`, stable page ids
   only. Starring a page adopts it first (`Vault.adoptPage`, which writes `thoth_id` into its frontmatter, the step a
   transfer takes), so the favorite follows renames and moves made in the app or outside it. Unsaved edits are written
   before. Every write is a compare-and-swap on the bytes that were read (`Vault.writeRecordIfUnchanged`, the host's
   `rename` with `replaceHash` / `noReplace`), and a change is worked out again on what another window wrote, up to four
   times, then reported. A missing or malformed file is "no favorites", never an error.
6. **Workspace favorites** are per person and local to the app, never sent to a server: one `localStorage` key,
   `thoth.favorites.workspaces`, `{"v":1,"lists":[{"server":"<url>","account":"<id>","workspace":"<id>","pages":[…]}]}`.
   Ids only (no title or text). The account id is an identifier, not a credential; signing out of the web client keeps
   the favorites (the tabs are cleared, as before).
7. **What drops out:**
   - A Private Space favorite whose page is not in the index is not shown. Its id stays in the file until the next change
     to the favorites, which writes only ids that are pages; a page that comes back first (an undo, a sync) is a
     favorite again.
   - A workspace favorite is removed once the server has said it is gone (`remoteGone`: the loaded tree lacks the page,
     or the workspace list lacks the workspace, which covers a workspace the person lost access to). While its tree is
     loading or failed to load it stays, muted, as "Not available right now". A signed-out server shows none of its
     favorites (whose they are is not known); they come back with the sign-in.
8. **Web client:** the same list component, star, menus and storage (shared in `packages/app-ui/src/favorites/`), for
   workspace pages, above the Workspaces list (the web sidebar has no reorderable sections). The account comes from
   `GET /me`.

### Pinned tabs

9. A tab is pinned or unpinned from its menu ("Pin tab" / "Unpin tab"), the palette, and `tab.pin`: Alt/Option+Shift+P
   on both clients (by physical key, since Option changes the letter on a Mac). An empty tab is never pinned.
10. Pinned tabs sit together at the start of the bar and keep their order among themselves. Pinning puts a tab at the
    end of the pinned ones; unpinning puts it first among the others. A drag, Alt/Option+Shift+Left/Right and the menu's
    Move left/right stop at the boundary (the preview opens no gap past it, and the dragged tab is kept over its own
    group); nothing moves a tab across it but pinning and unpinning.
11. A pinned tab is compact: its first two letters (graphemes) on a 44px tab (above the 28px minimum), with the full
    name as its accessible name ("Beta, pinned") and its tooltip. It has no close button.
12. A pinned tab is not closed by Cmd/Ctrl+W (Alt+W on the web), Delete, a middle-click or the menu (which has no Close
    for it): nothing closes and the bar says "Pinned tab: unpin it to close it" (live region, and a short visible note
    under the bar). Chosen over switching to the next tab because switching would look as if the pinned tab had closed.
    "Close other tabs" (new, in the tab's menu and the palette) never closes a pinned tab.
13. A pinned tab keeps its page: opening a page "in the current tab" while a pinned tab is current opens it in a new
    tab after the pinned ones, as does a new tab opened from a pinned one. A link followed inside it still retargets it.
14. Pinned is stored with the window's tabs as `pin: true` on the tab's entry (`serializeTabs`); the stored version stays
    1, lists stored before read as unpinned, and a hand-edited list with pinned tabs out of place is put in order. A tab
    moved to a new window (drag or menu) is pinned there. A pinned background tab whose page is gone is still pruned.

## Consequences

- Positive: favorites survive renames, moves, restarts and other windows' changes; workspace favorites never reach a
  server; one shared component for both clients; the pinned rules are pure functions in `tabs/model.ts`.
- Negative: starring a Private Space page that has no `thoth_id` writes one into its frontmatter (a visible file change,
  the same one a transfer makes). A read-only page cannot be adopted, so it cannot be starred (the error is shown).
  The order across spaces is fixed (Private Space first). Another window's star shows here when this window regains
  focus or the index changes (the watcher does not report `.thoth/`).
- Follow-up: none required.

## Alternatives considered

- **Favorites by path:** simple, but a rename or move would lose them; ADR-0003 exists for this.
- **Provisional (path-derived) ids:** no file change, but they change with the path, so the favorite would not follow.
- **Workspace favorites on the server:** would travel between devices, but needs a protocol change and the brief asks
  for local only.
- **Cmd/Ctrl+W on a pinned tab switches to the next tab:** rejected in rule 12.
- **Dragging across the boundary pins or unpins:** rejected by the brief; too easy to do by accident.

## Spec references

Section 2 (Markdown as the source of truth, compare-and-swap writes), 6.1 and 6.2 (stable page ids, `.thoth/` records),
7 (editor and tabs), 13 (web client).

## Open questions

- The Thai strings marked `// REVIEW` need a native reader (does not block).
