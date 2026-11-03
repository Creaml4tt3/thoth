/**
 * The page follows the caret a line at a time when arrow keys move it, as in Plain mode.
 *
 * ProseMirror leaves an arrow key that moves the caret within text to the browser (prosemirror-view `selectVertically`
 * returns false). Chromium and WebKit then reveal the caret with "center if needed": once it passes the bottom (or top)
 * of the page, the page jumps by half a screen and the caret lands in the middle, which reads as the page bouncing.
 * After such a key, the scroll the browser made is undone and the smallest scroll that shows the caret (with a margin)
 * is made instead, in the same frame, so nothing is painted in between.
 */
import { Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** Room kept between the caret and the edge of the page area (CSS px), about a line. */
export const CARET_MARGIN = 32;

const KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/**
 * How far to scroll (positive: down) so `caret` sits inside `area`, `margin` from its edges; 0 when it already does.
 * A caret taller than the room left keeps its top in view.
 */
export function revealDelta(caret: { top: number; bottom: number }, area: { top: number; bottom: number }, margin = CARET_MARGIN): number {
  const room = Math.max(0, Math.min(margin, (area.bottom - area.top - (caret.bottom - caret.top)) / 2));
  if (caret.top < area.top + room) return caret.top - (area.top + room);
  if (caret.bottom > area.bottom - room) return Math.min(caret.bottom - (area.bottom - room), caret.top - (area.top + room));
  return 0;
}

/** The nearest ancestor of `el` that scrolls vertically. */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let at = el.parentElement; at; at = at.parentElement) {
    const y = getComputedStyle(at).overflowY;
    if ((y === "auto" || y === "scroll") && at.scrollHeight > at.clientHeight) return at;
  }
  return null;
}

/** Where the caret (the focus end of the DOM selection) is on screen. */
function caretRect(view: EditorView): DOMRect | null {
  const sel = (view.root as Document).getSelection?.();
  const node = sel?.focusNode;
  if (!sel || !node || !view.dom.contains(node)) return null;
  const range = document.createRange();
  range.setStart(node, sel.focusOffset);
  range.collapse(true);
  const rects = range.getClientRects();
  if (rects.length > 0) return rects[rects.length - 1]!;
  // An empty paragraph or a position between blocks has no text box: use the element there.
  const child = node.childNodes[sel.focusOffset];
  const el = child instanceof Element ? child : node instanceof Element ? node : node.parentElement;
  return el?.getBoundingClientRect() ?? null;
}

/**
 * Page Up/Down scroll the page by a screen and take the caret along at the same height, as Plain mode does. The
 * browser scrolls an inner page area without moving the caret, so the next arrow key jumped back to where it was.
 * At the end of the page the caret goes to the first or last position. Shift extends the selection.
 */
function pageMove(view: EditorView, dir: 1 | -1, event: KeyboardEvent): boolean {
  const area = scroller(view.dom);
  if (!area) return false;
  const { state } = view;
  let head: { left: number; top: number; bottom: number };
  try {
    head = view.coordsAtPos(state.selection.head);
  } catch {
    return false;
  }
  event.preventDefault();
  const box = area.getBoundingClientRect();
  const y = Math.min(Math.max((head.top + head.bottom) / 2, box.top + CARET_MARGIN), box.top + area.clientHeight - CARET_MARGIN);
  const before = area.scrollTop;
  area.scrollTop = before + dir * Math.max(area.clientHeight - 2 * CARET_MARGIN, area.clientHeight / 2);
  const hit = area.scrollTop !== before ? view.posAtCoords({ left: head.left, top: y }) : null;
  const $to = hit ? state.doc.resolve(hit.pos) : dir > 0 ? Selection.atEnd(state.doc).$head : Selection.atStart(state.doc).$head;
  const selection = event.shiftKey ? TextSelection.between(state.selection.$anchor, $to) : Selection.near($to, dir);
  view.dispatch(state.tr.setSelection(selection));
  return true;
}

export function caretScrollExtension() {
  return Extension.create({
    name: "thothCaretScroll",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("thothCaretScroll"),
          props: {
            handleKeyDown(view, event) {
              if (event.metaKey || event.ctrlKey || view.composing) return false;
              if ((event.key === "PageDown" || event.key === "PageUp") && !event.altKey) return pageMove(view, event.key === "PageDown" ? 1 : -1, event);
              if (!KEYS.has(event.key)) return false;
              const area = scroller(view.dom);
              if (!area) return false;
              const before = area.scrollTop;
              // The browser moves the caret and scrolls during the key's default action; this runs before the next paint.
              requestAnimationFrame(() => {
                const after = area.scrollTop;
                // A selected block (image, divider) was scrolled to by ProseMirror itself, already the least it could.
                if (after === before || !view.dom.isConnected || view.state.selection instanceof NodeSelection) return;
                area.scrollTop = before;
                const caret = caretRect(view);
                if (!caret) {
                  area.scrollTop = after;
                  return;
                }
                const box = area.getBoundingClientRect();
                area.scrollTop = before + revealDelta(caret, { top: box.top, bottom: box.top + area.clientHeight });
              });
              return false;
            },
          },
        }),
      ];
    },
  });
}
