# Drag hints (0.12.4): design

Approved by the owner on 2026-11-28 (option C of the mockups).

## Why

The owner wants Thoth to show what a drag will do while it is under way, poka-yoke style. People should see where
something can go before they let go, so they don't drop it in the wrong place or give up. Text alone is not enough:
some hints should be icons, colours or shapes.

## Goals

- When a page is picked up in the sidebar, every place that will take it lights up.
- Every drag gets the same chip by the pointer: an icon, a colour and a few words saying what letting go does here.
- A `.md` file dropped from Finder onto a Thoth window opens. Today that drop is silently refused.

## Non-goals and anti-goals

- No hints on ordinary clicks, no one-time tip bubbles, and no mascot coaching. Hints shown on every action get ignored.
- Editor block drags and Board note drags stay as they are. They already show where the item will land, and a drag
  there can only do one thing.
- Colour is never the only signal. Every chip has its own icon and words, and screen readers hear the same words
  through the existing live regions.
- Inside one Space, folders don't all light up at the start of a drag, because that is too noisy. The drop line stays.

## Approaches considered

- A. Words only by the pointer (what the cross-Space drag does today). Clear, but it has to be read, and it appears
  only once the pointer is already over a place.
- B. A chip with an icon, a colour and short words. It can be read at a glance.
- **C. B, plus outlines on every valid place as soon as the drag starts (chosen).** You see your choices before you
  move, which is the poka-yoke part. About twice the work of A.

## Design

1. **Drop places light up.** When a sidebar drag starts (`beginSpaceDrag`):
   - every workspace that accepts the drag gets a dashed outline;
   - for a drag from a workspace, the Private Space header gets one too;
   - a workspace that would refuse it (read-only, signed out, and so on) is shown greyed out, and the chip says why
     when the pointer is over it.

   The place under the pointer fills in, as it does today (`data-drop`). The rules come from the code that already
   decides a cross-Space drop (`across` / `betweenTarget`). They are computed once when the drag starts, not on every
   `dragover`.
2. **One chip, one kind per action.** One component replaces the plain `SpaceDragBadge` text and the tab drag's hint
   line:
   - Move: orange, →, "Move into Projects" / "Move to Studio"
   - Copy: blue, +, "Copy to Studio". It switches live while ⌥/Alt is held.
   - Open in new window: green, ⧉
   - Split right / move to pane: orange, ⇥
   - Refused: red outline, ⊘, "Can't drop here: <reason>"

   Move chips show a small "⌥ copy" key hint. Within one Space, a sidebar reorder or move into a folder shows the
   Move chip with the folder's name. Colours come from the existing tokens: accent, secondary, success and danger
   in both themes.
3. **Finder drop of a `.md` file.** In `main.tsx` the window-level guard lets `.md`/`.markdown` files through to the
   host (`open_paths`, the same route as the Dock icon). Image drops onto a page still go to the page (ADR-0028).
   Every other file is still refused, and the refused chip says so. The webview does not receive a dropped file's
   path (`dragDropEnabled: false`), so this needs Tauri's native drag-drop event for the window. That is the main
   technical risk; the builder decides how to wire it.

## Constraints

- English and Thai strings for every new word. Thai lines are marked REVIEW.
- Reduced motion: outlines appear without animation.
- Desktop and web share `packages/app-ui`. The web client gets the chips and outlines but not the Finder drop.

## Left to the builder

- Exact icons from the existing `Icon` set (the glyphs above are placeholders).
- How the outlines reach the workspace rows (a `useSpaceDrag()` read in the rows is the expected route).
- Tests: the chip kind for each action, outlines on drag start, the refused reason, and `.md` drop routing.
