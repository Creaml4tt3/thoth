/**
 * The `[[` suggestion menu, shared by both editor modes. Plain DOM (like the
 * node views): the editors own the keyboard and call `move`/`pick`, so focus
 * never leaves the text. The menu is an ARIA listbox; the editor's content
 * element points at it with `aria-controls` and `aria-activedescendant`.
 */
import type { LinkSuggestion } from "./link-suggest.ts";

export interface LinkMenu {
  /** Shows `items` at `rect` (viewport coordinates of the caret); hides when `rect` is null. */
  show(items: LinkSuggestion[], query: string, rect: DOMRect | null): void;
  move(delta: 1 | -1): void;
  /** The highlighted item, or null when the menu is empty. */
  selected(): LinkSuggestion | null;
  hide(): void;
  isOpen(): boolean;
  destroy(): void;
}

let counter = 0;

export function createLinkMenu(owner: HTMLElement, onPick: (item: LinkSuggestion) => void): LinkMenu {
  const id = `link-menu-${++counter}`;
  const root = document.createElement("div");
  root.className = "link-menu";
  root.id = id;
  root.setAttribute("role", "listbox");
  root.setAttribute("aria-label", "Link to page");
  root.hidden = true;
  document.body.append(root);
  let items: LinkSuggestion[] = [];
  let active = 0;

  const optionId = (i: number) => `${id}-${i}`;
  const paintActive = (): void => {
    root.querySelectorAll<HTMLElement>("[role=option]").forEach((el, i) => {
      el.setAttribute("aria-selected", String(i === active));
      if (i === active) el.scrollIntoView({ block: "nearest" });
    });
    if (items.length) owner.setAttribute("aria-activedescendant", optionId(active));
    else owner.removeAttribute("aria-activedescendant");
  };

  const hide = (): void => {
    root.hidden = true;
    items = [];
    owner.removeAttribute("aria-controls");
    owner.removeAttribute("aria-activedescendant");
    owner.removeAttribute("aria-expanded");
  };

  return {
    show(next, query, rect) {
      if (!rect) return hide();
      items = next;
      active = Math.min(active, Math.max(0, items.length - 1));
      root.replaceChildren();
      if (items.length === 0) {
        const empty = document.createElement("div");
        empty.className = "link-menu-empty";
        empty.textContent = query.trim() ? `No page matches “${query.trim()}”. Keep typing to link to a new page.` : "No other pages yet.";
        root.append(empty);
      }
      items.forEach((item, i) => {
        const option = document.createElement("div");
        option.id = optionId(i);
        option.className = "link-option";
        option.setAttribute("role", "option");
        const title = document.createElement("span");
        title.className = "link-option-title";
        title.textContent = item.title;
        option.append(title);
        const detail = [item.alias ? `alias “${item.alias}”` : "", item.folder].filter(Boolean).join(" · ");
        if (detail) {
          const meta = document.createElement("span");
          meta.className = "link-option-meta";
          meta.textContent = detail;
          option.append(meta);
        }
        // mousedown, not click: picking must not move focus out of the editor first.
        option.addEventListener("mousedown", (event) => {
          event.preventDefault();
          onPick(item);
        });
        option.addEventListener("mousemove", () => {
          if (active === i) return;
          active = i;
          paintActive();
        });
        root.append(option);
      });
      root.hidden = false;
      const width = 320;
      root.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
      const below = rect.bottom + 6;
      const height = root.offsetHeight || 240;
      root.style.top = `${below + height > window.innerHeight - 8 && rect.top - height - 6 > 8 ? rect.top - height - 6 : below}px`;
      owner.setAttribute("aria-controls", id);
      owner.setAttribute("aria-expanded", "true");
      paintActive();
    },
    move(delta) {
      if (!items.length) return;
      active = (active + delta + items.length) % items.length;
      paintActive();
    },
    selected: () => items[active] ?? null,
    hide() {
      active = 0;
      hide();
    },
    isOpen: () => !root.hidden,
    destroy() {
      hide();
      root.remove();
    },
  };
}
