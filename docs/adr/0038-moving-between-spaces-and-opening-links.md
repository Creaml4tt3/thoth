# ADR-0038: Moving pages between spaces, and opening links in a page

- **Status:** Proposed
- **Date:** 2026-10-29
- **Deciders:** owner (rules 1, 2, 4 and 5); implementation agent (the rest, marked "(this ADR)")
- **Refines:** ADR-0006 (transfers; amendments of 2026-10-26 and 2026-10-27), ADR-0016 rule 5 (new tabs), ADR-0019 (windows).

## Context

The owner's list after 0.2.6:

- change how pages move between the Private Space and workspaces, and let a whole folder move;
- open links with Ctrl+click, Shift+click and a middle-click, with a tooltip on hover so people know they can.

Before:

- The transfer dialog was wide. It showed Copy and Move as two large cards, each with a paragraph, and all the
  members, pages and links. Where pages came back to the Private Space was a typed folder path.
- A drop across spaces chose Copy; Alt/Option chose Move.
- A dragged folder travelled with its pages, but a move left the emptied folder behind in the Private Space.
- A page link opened on a click, always in the current tab. A web link in Blocks mode did nothing on a click, and in
  Plain mode it was only coloured text.

## Decision

1. **Keep the menu items and the dialog, simplify the dialog** (owner):
   - It is the normal width, not the wide one.
   - Copy and Move are two small choices side by side, Move first. Only the chosen one's explanation shows, under
     them.
   - "Who can see it" keeps its one line. The members, the pages and the links are folded under "Details" (this
     ADR). Problems and warnings always show.
   - Pages that come back to the Private Space go into a folder picked from a list of its folders, or the top level
     ("Put the pages", the same words as for a workspace). A new folder is made in the sidebar first (this ADR).
2. **A drop across spaces chooses Move; Alt/Option chooses Copy** (owner). The dialog still previews and waits for
   the person to confirm, and the original is still deleted only after the destination has confirmed every page.
3. **A moved folder leaves with its pages** (this ADR): after its pages are deleted, the Private Space folder and the
   empty folders inside it are removed, innermost first, and only while empty. A folder holding a page that was
   kept (edited meanwhile) stays, with that page.
4. **Page links** (owner): a click opens the page here; Cmd/Ctrl+click or a middle-click opens it in a new tab;
   Shift+click opens it in a new window of this Private Space (ADR-0019). Where there are no windows (the web), Shift
   opens a new tab.
5. **Web links** (owner): a plain click puts the cursor in the link, to edit it. Cmd/Ctrl+click or a middle-click
   opens it in the browser. Shift+click keeps extending the selection. In both editor modes.
6. **The tooltip** (owner asked for one; this ADR chose the words): the app's tooltip, not the system's. A page link
   shows its path and "Click to open · Cmd+click: new tab · Shift+click: new window". A web link shows its address and
   "Cmd+click to open" (Ctrl elsewhere).
7. **Safety** (this ADR): only `http`, `https` and `mailto` addresses open, as for pasted links. A middle-click never
   pastes into the page (Linux). The page never follows a link by itself.

## Consequences

- People who dragged to copy now hold Alt/Option to copy. The dialog shows which was chosen before anything moves.
- Someone who typed a new folder name in the dialog now makes the folder in the sidebar first.
- Web links no longer react to a plain click, so a link is edited like the text around it.

## Alternatives considered

- **One "Move to…" picker for every space:** the owner kept the dialog.
- **A plain click opens a web link:** the owner chose editing first, as most editors do.
- **Shift+click opens a new tab:** the owner chose a new window, as browsers do.
