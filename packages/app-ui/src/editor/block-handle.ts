/**
 * Block handle, block menu, drag and drop, and block keyboard shortcuts for
 * Blocks mode.
 *
 * - Hovering a top-level block or a list item shows a ⋮⋮ handle in the left
 *   gutter. Clicking it opens the block menu; dragging it moves the block.
 * - Alt+Shift+ArrowUp/Down moves the block at the cursor. Mod+Alt+M (Ctrl+Alt+M)
 *   opens the block menu for it; the menu is a keyboard-driven ARIA menu.
 * - Dragging uses ProseMirror's own mechanism: a NodeSelection plus
 *   `view.dragging`. The drop is handled here, as one transaction that moves
 *   the same node objects, so an untouched block keeps its original source.
 * - A read-only editor (non-UTF-8 file, open conflict) shows no handle and no menu.
 */
import { Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { createBlockMenu, type BlockAction, type BlockMenu } from "./block-menu.ts";
import type { EditorStrings } from "../strings/en.ts";
import {
  applyAsOneStep,
  blockAtSelection,
  canMove,
  canTurnInto,
  deleteBlock,
  duplicateBlock,
  handleBlockAt,
  kindOfBlock,
  moveBlock,
  moveBlockToSlot,
  siblingsOf,
  turnInto,
  type BlockTarget,
} from "./block-ops.ts";

const key = new PluginKey("thothBlockHandle");

/** Opens the block menu for the block at the cursor. Free in the editor, the app shell and the browser; Mod+Shift+E, Mod+K, Mod+S and the Tiptap defaults are taken. */
export const BLOCK_MENU_SHORTCUT = "Mod-Alt-m";

/** Handle geometry (CSS px). */
const HANDLE = 22;

function targetAtPos(view: EditorView, pos: number): BlockTarget | null {
  try {
    return handleBlockAt(view.state.doc.resolve(Math.max(0, Math.min(pos, view.state.doc.content.size))));
  } catch {
    return null;
  }
}

export function blockHandleExtension(strings: EditorStrings) {
  return Extension.create({
    name: "thothBlockHandle",
    addProseMirrorPlugins() {
      let menu: BlockMenu | null = null;
      let handle: HTMLElement | null = null;
      let indicator: HTMLElement | null = null;
      let editorView: EditorView | null = null;
      /** The block the handle (and a menu opened from it) belongs to. */
      let hovered: BlockTarget | null = null;
      let menuTarget: BlockTarget | null = null;
      let dragged: BlockTarget | null = null;

      let hideTimer: ReturnType<typeof setTimeout> | undefined;
      const hideHandle = () => {
        clearTimeout(hideTimer);
        if (handle) handle.hidden = true;
        hovered = null;
      };
      /** A short grace period, so the pointer can cross the gap between the text and the handle. */
      const scheduleHide = () => {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          if (!menu?.isOpen() && !dragged) hideHandle();
        }, 160);
      };

      const refreshTarget = (view: EditorView, from: BlockTarget): BlockTarget | null => {
        // The document may have changed since the target was taken: find the same node again.
        const found = view.state.doc.nodeAt(from.pos);
        return found === from.node ? from : (menuTarget && view.state.doc.nodeAt(menuTarget.pos) === menuTarget.node ? menuTarget : null);
      };

      const run = (view: EditorView, target: BlockTarget, action: BlockAction): void => {
        applyAsOneStep(view, (tr) => {
          switch (action.type) {
            case "turn":
              return turnInto(tr, target, action.kind);
            case "duplicate":
              return duplicateBlock(tr, target);
            case "delete":
              return deleteBlock(tr, target);
            case "up":
              return moveBlock(tr, target, "up");
            case "down":
              return moveBlock(tr, target, "down");
          }
        });
      };

      const openMenu = (view: EditorView, target: BlockTarget, anchor: DOMRect): void => {
        if (!view.editable || !menu) return;
        menuTarget = target;
        const parent = view.state.doc.resolve(target.pos).parent;
        const moves = canMove(view.state.doc, target);
        menu.open({ current: kindOfBlock(target.node, parent), canTurn: canTurnInto(target), canMoveUp: moves.up, canMoveDown: moves.down }, anchor);
      };

      const place = (view: EditorView, target: BlockTarget): void => {
        if (!handle) return;
        const dom = view.nodeDOM(target.pos);
        if (!(dom instanceof HTMLElement)) return hideHandle();
        const box = dom.getBoundingClientRect();
        const host = handle.offsetParent instanceof HTMLElement ? handle.offsetParent.getBoundingClientRect() : view.dom.getBoundingClientRect();
        const line = parseFloat(getComputedStyle(dom).lineHeight);
        const first = Number.isFinite(line) ? line : 26;
        handle.style.top = `${box.top - host.top + Math.max(0, (first - HANDLE) / 2)}px`;
        // Nested items sit further right; keep the handle in the gutter next to them.
        handle.style.left = `${box.left - host.left - HANDLE - 6}px`;
        handle.hidden = false;
        hovered = target;
      };

      const gutterTarget = (view: EditorView, event: MouseEvent): BlockTarget | null => {
        const rect = view.dom.getBoundingClientRect();
        // Inside the gutter strip to the left of the text, the block at the same height.
        const x = Math.max(event.clientX, rect.left + 4);
        const at = view.posAtCoords({ left: x, top: event.clientY });
        if (!at) return null;
        return targetAtPos(view, at.inside >= 0 ? at.inside : at.pos);
      };

      // Drag and drop ------------------------------------------------------

      const slotAt = (view: EditorView, event: DragEvent, target: BlockTarget): { slot: number; y: number } | null => {
        const sibs = siblingsOf(view.state.doc, target);
        const min = view.state.doc.resolve(target.pos).parent.type.name === "callout" ? 1 : 0;
        let best: { slot: number; y: number } | null = null;
        let bestDistance = Infinity;
        sibs.forEach((s, i) => {
          if (i < min) return;
          const dom = view.nodeDOM(s.pos);
          if (!(dom instanceof HTMLElement)) return;
          const r = dom.getBoundingClientRect();
          for (const [slot, y] of [[i, r.top], [i + 1, r.bottom]] as const) {
            const d = Math.abs(event.clientY - y);
            if (d < bestDistance) {
              bestDistance = d;
              best = { slot, y };
            }
          }
        });
        return best;
      };

      const showIndicator = (view: EditorView, y: number | null): void => {
        if (!indicator) return;
        if (y === null) {
          indicator.hidden = true;
          return;
        }
        const host = indicator.offsetParent instanceof HTMLElement ? indicator.offsetParent.getBoundingClientRect() : view.dom.getBoundingClientRect();
        const rect = view.dom.getBoundingClientRect();
        indicator.style.top = `${y - host.top - 1}px`;
        indicator.style.left = `${rect.left - host.left}px`;
        indicator.style.width = `${rect.width}px`;
        indicator.hidden = false;
      };

      const endDrag = (view: EditorView | null): void => {
        dragged = null;
        if (view) view.dragging = null;
        if (indicator) indicator.hidden = true;
        editorView?.dom.classList.remove("is-block-dragging");
      };

      return [
        new Plugin({
          key,
          view(view) {
            editorView = view;
            const host = view.dom.parentElement;
            // A div, not a <button>: Chromium does not start a drag from a button.
            handle = document.createElement("div");
            handle.setAttribute("role", "button");
            handle.className = "block-handle";
            handle.hidden = true;
            handle.draggable = true;
            handle.tabIndex = -1; // mouse-only; keyboard users have Alt+Shift+Up/Down and the menu shortcut
            handle.setAttribute("aria-label", strings.handleLabel);
            handle.title = strings.handleTitle;
            handle.textContent = "⋮⋮";
            handle.setAttribute("contenteditable", "false");
            indicator = document.createElement("div");
            indicator.className = "block-drop-indicator";
            indicator.hidden = true;
            indicator.setAttribute("aria-hidden", "true");
            host?.append(handle, indicator);

            menu = createBlockMenu({
              onAction: (action) => {
                const target = menuTarget ? refreshTarget(view, menuTarget) : null;
                if (target) run(view, target, action);
              },
              onClose: (refocus) => {
                menuTarget = null;
                if (refocus) view.focus();
              },
              strings,
            });

            // No preventDefault on mousedown: that would cancel the browser's dragstart. The editor loses focus
            // for a moment; a drop, a menu action and Escape all give it back.
            handle.addEventListener("mouseenter", () => clearTimeout(hideTimer));
            handle.addEventListener("mouseleave", () => scheduleHide());
            handle.addEventListener("click", (event) => {
              event.preventDefault();
              if (!hovered || !view.editable) return;
              if (menu?.isOpen()) return menu.close();
              const target = hovered;
              // Put the caret in the block, so that Escape returns to it and menu actions read naturally.
              try {
                const at = view.state.doc.resolve(target.pos + 1);
                if (!view.state.selection.eq(NodeSelection.isSelectable(target.node) && target.node.isAtom ? NodeSelection.create(view.state.doc, target.pos) : TextSelection.near(at, 1))) {
                  view.dispatch(view.state.tr.setSelection(target.node.isAtom ? NodeSelection.create(view.state.doc, target.pos) : TextSelection.near(at, 1)));
                }
              } catch {
                // atoms and odd positions keep the current selection
              }
              openMenu(view, target, handle!.getBoundingClientRect());
            });
            handle.addEventListener("dragstart", (event) => {
              const target = hovered;
              if (!target || !view.editable || !event.dataTransfer) return event.preventDefault();
              dragged = target;
              menu?.close();
              const sel = NodeSelection.create(view.state.doc, target.pos);
              view.dispatch(view.state.tr.setSelection(sel));
              // ProseMirror's own drag state: `dragging` marks this as a move of that node.
              view.dragging = { slice: sel.content(), move: true };
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", "");
              const dom = view.nodeDOM(target.pos);
              if (dom instanceof HTMLElement) event.dataTransfer.setDragImage(dom, 0, 0);
              view.dom.classList.add("is-block-dragging");
            });
            handle.addEventListener("dragend", () => endDrag(view));
            return {
              update(v) {
                if (!v.editable) {
                  hideHandle();
                  menu?.close();
                }
              },
              destroy() {
                clearTimeout(hideTimer);
                menu?.destroy();
                handle?.remove();
                indicator?.remove();
                menu = handle = indicator = editorView = null;
              },
            };
          },
          props: {
            handleDOMEvents: {
              mousemove(view, event) {
                if (!view.editable || dragged || menu?.isOpen()) return false;
                const target = gutterTarget(view, event);
                if (!target) return hideHandle(), false;
                clearTimeout(hideTimer);
                if (!hovered || hovered.pos !== target.pos || hovered.node !== target.node) place(view, target);
                return false;
              },
              mouseleave(_view, event) {
                if (event.relatedTarget instanceof Node && handle?.contains(event.relatedTarget)) return false;
                scheduleHide();
                return false;
              },
              dragover(view, event) {
                if (!dragged) return false;
                const current = refreshTarget(view, dragged);
                if (!current) return false;
                const hit = slotAt(view, event, current);
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                showIndicator(view, hit ? hit.y : null);
                return true;
              },
              dragleave(view, event) {
                if (!dragged) return false;
                const rect = view.dom.getBoundingClientRect();
                if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) showIndicator(view, null);
                return false;
              },
              drop(view, event) {
                if (!dragged) return false;
                const current = refreshTarget(view, dragged);
                const hit = current ? slotAt(view, event, current) : null;
                event.preventDefault();
                if (current && hit) {
                  applyAsOneStep(view, (tr) => moveBlockToSlot(tr, current, hit.slot));
                  view.focus();
                }
                endDrag(view);
                return true;
              },
            },
            handleKeyDown(view, event) {
              if (!view.editable) return false;
              const mod = event.metaKey || event.ctrlKey;
              if (event.altKey && event.shiftKey && !mod && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                const target = blockAtSelection(view.state);
                if (!target) return false;
                event.preventDefault();
                run(view, target, { type: event.key === "ArrowUp" ? "up" : "down" });
                return true;
              }
              // `code` is layout independent; Alt+M types a dead character on macOS keyboards.
              if (mod && event.altKey && !event.shiftKey && (event.code === "KeyM" || event.key.toLowerCase() === "m")) {
                const target = blockAtSelection(view.state);
                if (!target) return false;
                event.preventDefault();
                const caret = view.coordsAtPos(view.state.selection.head);
                openMenu(view, target, new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top));
                return true;
              }
              return false;
            },
          },
        }),
      ];
    },
  });
}
