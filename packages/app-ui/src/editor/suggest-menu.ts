/**
 * A floating ARIA listbox for editor suggestions (`[[` links, `/` blocks).
 * Plain DOM (like the node views): the editors own the keyboard and call
 * `move`/`selected`, so focus never leaves the text. The editor's content
 * element points at the open menu with `aria-controls` and
 * `aria-activedescendant`.
 */
export interface SuggestRow {
  title: string;
  /** Second line: a folder, an alias, a description. */
  meta?: string;
  /** A short glyph shown before the text (decorative). */
  icon?: string;
}

export interface SuggestMenuOptions<T> {
  /** CSS prefix: the classes are `<prefix>-menu`, `<prefix>-option`, `-option-title`, `-option-meta`, `-option-icon` and `-menu-empty`. */
  prefix: string;
  /** Accessible name of the listbox. */
  label: string;
  width?: number;
  render(item: T): SuggestRow;
  empty(query: string): string;
  onPick(item: T): void;
}

export interface SuggestMenu<T> {
  /** Shows `items` at `rect` (viewport coordinates of the caret); hides when `rect` is null. */
  show(items: T[], query: string, rect: DOMRect | null): void;
  move(delta: 1 | -1): void;
  /** The highlighted item, or null when the menu is empty. */
  selected(): T | null;
  hide(): void;
  isOpen(): boolean;
  destroy(): void;
}

let counter = 0;

export function createSuggestMenu<T>(owner: HTMLElement, o: SuggestMenuOptions<T>): SuggestMenu<T> {
  const id = `${o.prefix}-menu-${++counter}`;
  const width = o.width ?? 320;
  const root = document.createElement("div");
  root.className = `${o.prefix}-menu`;
  root.id = id;
  root.setAttribute("role", "listbox");
  root.setAttribute("aria-label", o.label);
  root.hidden = true;
  document.body.append(root);
  let items: T[] = [];
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
    // Several menus share the editor element; only the one that set these attributes may clear them.
    if (owner.getAttribute("aria-controls") !== id) return;
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
        empty.className = `${o.prefix}-menu-empty`;
        empty.textContent = o.empty(query);
        root.append(empty);
      }
      items.forEach((item, i) => {
        const row = o.render(item);
        const option = document.createElement("div");
        option.id = optionId(i);
        option.className = `${o.prefix}-option`;
        option.setAttribute("role", "option");
        if (row.icon) {
          const icon = document.createElement("span");
          icon.className = `${o.prefix}-option-icon`;
          icon.setAttribute("aria-hidden", "true");
          icon.textContent = row.icon;
          option.append(icon);
        }
        const title = document.createElement("span");
        title.className = `${o.prefix}-option-title`;
        title.textContent = row.title;
        option.append(title);
        if (row.meta) {
          const meta = document.createElement("span");
          meta.className = `${o.prefix}-option-meta`;
          meta.textContent = row.meta;
          option.append(meta);
        }
        // mousedown, not click: picking must not move focus out of the editor first.
        option.addEventListener("mousedown", (event) => {
          event.preventDefault();
          o.onPick(item);
        });
        option.addEventListener("mousemove", () => {
          if (active === i) return;
          active = i;
          paintActive();
        });
        root.append(option);
      });
      root.hidden = false;
      root.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
      const below = rect.bottom + 6;
      const height = root.offsetHeight || 240;
      const above = below + height > window.innerHeight - 8 && rect.top - height - 6 > 8;
      root.style.top = `${above ? rect.top - height - 6 : below}px`;
      // Which side of the caret the menu sits on: the pop-in grows from that edge (editor.css).
      root.dataset["side"] = above ? "top" : "bottom";
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
