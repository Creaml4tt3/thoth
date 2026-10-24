/**
 * Keyboard use of the page trees (WAI-ARIA tree pattern), shared by the Private Space tree and the workspace
 * tree. Rows are `[role="treeitem"]` elements with a `data-tree-id`; moving focus works on the DOM, so one
 * handler serves both trees and the nesting shown on screen is what the arrow keys follow.
 *
 * - Up/Down move between visible rows, Home/End jump to the first and last, Right opens a folder (or steps into
 *   it), Left closes it (or steps out to the parent). Enter and Space are the row's own click.
 * - F2 renames, Alt+Shift+Up/Down reorders, the Menu key (or Shift+F10) opens the row's menu.
 * - Only one row is in the Tab order (the focused one, else the open page, else the first), so Tab leaves the tree.
 */
import { useEffect, type KeyboardEvent, type RefObject } from "react";

export interface TreeKeyHandlers {
  /** The row can have children shown below it. */
  expandable: boolean;
  expanded: boolean;
  expand(): void;
  collapse(): void;
  /** F2. Omit when the row cannot be renamed. */
  rename?(): void;
  /** Alt+Shift+Up (-1) or Down (1). Omit when the row cannot be reordered. */
  reorder?(delta: -1 | 1): void;
  /** Menu key or Shift+F10. */
  menu?(): void;
}

const ITEMS = '[role="treeitem"]';

/** The rows of the tree that holds `from`, in the order they are on screen. */
function rowsAround(from: HTMLElement): HTMLElement[] {
  const tree = from.closest<HTMLElement>('[role="tree"]');
  return tree ? [...tree.querySelectorAll<HTMLElement>(ITEMS)] : [];
}

/** The row's own element (the treeitem) in a list item, not those of its children. */
function ownItem(li: Element | null): HTMLElement | null {
  if (!li) return null;
  for (const child of li.children) {
    if (child.getAttribute("role") === "treeitem") return child as HTMLElement;
    const inner = child.matches(".tree-row") ? child.querySelector<HTMLElement>(`:scope > ${ITEMS}`) : null;
    if (inner) return inner;
  }
  return null;
}

export function focusTreeItem(id: string): void {
  const el = [...document.querySelectorAll<HTMLElement>("[data-tree-id]")].find((e) => e.dataset["treeId"] === id);
  el?.focus();
}

/** Focuses a row once the tree has re-rendered (the moved row may have been re-created). */
export function focusTreeItemSoon(id: string): void {
  setTimeout(() => focusTreeItem(id), 0);
}

/** Handles one key press on a row. Returns true when the key was ours. */
export function treeKeyDown(event: KeyboardEvent<HTMLElement>, h: TreeKeyHandlers): boolean {
  if (event.target !== event.currentTarget) return false; // a key typed in a control inside the row
  const el = event.currentTarget;
  const handled = () => {
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
  const focus = (target: HTMLElement | null | undefined) => {
    target?.focus();
    return handled();
  };

  if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    if (!h.reorder) return false;
    h.reorder(event.key === "ArrowUp" ? -1 : 1);
    return handled();
  }
  if (event.altKey || event.ctrlKey || event.metaKey) return false;

  const rows = rowsAround(el);
  const at = rows.indexOf(el);
  switch (event.key) {
    case "ArrowDown":
      return focus(rows[at + 1]);
    case "ArrowUp":
      return focus(rows[at - 1]);
    case "Home":
      return focus(rows[0]);
    case "End":
      return focus(rows[rows.length - 1]);
    case "ArrowRight": {
      if (!h.expandable) return handled();
      if (!h.expanded) {
        h.expand();
        return handled();
      }
      // Already open: step into the first child.
      return focus(ownItem(el.closest("li")?.querySelector(':scope > [role="group"] > li') ?? null));
    }
    case "ArrowLeft": {
      if (h.expandable && h.expanded) {
        h.collapse();
        return handled();
      }
      return focus(ownItem(el.closest("li")?.parentElement?.closest("li") ?? null));
    }
    case "F2":
      if (!h.rename) return false;
      h.rename();
      return handled();
    case "ContextMenu":
      if (!h.menu) return false;
      h.menu();
      return handled();
    case "F10":
      if (!event.shiftKey || !h.menu) return false;
      h.menu();
      return handled();
    default:
      return false;
  }
}

/**
 * Keeps exactly one row of the tree in the Tab order. Rows come and go as folders open and the lists change,
 * so this watches the tree rather than being told: the row last focused keeps the stop, else the open page
 * (`aria-current`), else the first row.
 */
export function useRovingTabStop(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const tree = root.current;
    if (!tree) return;
    let active: string | null = null;
    const sync = () => {
      const rows = [...tree.querySelectorAll<HTMLElement>(ITEMS)];
      if (rows.length === 0) return;
      const stop = rows.find((r) => r.dataset["treeId"] === active) ?? rows.find((r) => r.getAttribute("aria-current") === "page") ?? rows[0]!;
      for (const row of rows) {
        const wanted = row === stop ? "0" : "-1";
        if (row.getAttribute("tabindex") !== wanted) row.setAttribute("tabindex", wanted);
      }
    };
    const onFocus = (event: FocusEvent) => {
      const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(ITEMS);
      if (row?.dataset["treeId"] !== undefined) {
        active = row.dataset["treeId"];
        sync();
      }
    };
    tree.addEventListener("focusin", onFocus);
    const observer = new MutationObserver(sync);
    observer.observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-current", "data-tree-id"] });
    sync();
    return () => {
      tree.removeEventListener("focusin", onFocus);
      observer.disconnect();
    };
  }, [root]);
}
