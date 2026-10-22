/**
 * The block menu: Turn into, Duplicate, Delete, Move up, Move down.
 *
 * A WAI-ARIA menu (`role=menu`, `menuitem`, roving tabindex). Opening moves
 * focus into the menu; Escape (or picking an item) gives it back to the
 * editor, so focus is never lost. "Turn into" opens a submenu with the same
 * block types as the `/` menu.
 */
import { BLOCK_KINDS, type BlockKind } from "./block-kinds.ts";

export type BlockAction = { type: "turn"; kind: BlockKind } | { type: "duplicate" } | { type: "delete" } | { type: "up" } | { type: "down" };

export interface BlockMenuState {
  /** Block type of the target, shown as checked in "Turn into"; null when it has none in the list. */
  current: BlockKind | null;
  canTurn: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

export interface BlockMenu {
  open(state: BlockMenuState, anchor: DOMRect): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

interface Options {
  /** Runs an action on the block the menu was opened for. */
  onAction(action: BlockAction): void;
  /** Called whenever the menu closes. `refocus` is false when the user clicked elsewhere (focus is already where they put it). */
  onClose(refocus: boolean): void;
}

export function createBlockMenu(opts: Options): BlockMenu {
  const root = document.createElement("div");
  root.className = "block-menu";
  root.setAttribute("role", "menu");
  root.setAttribute("aria-label", "Block menu");
  root.hidden = true;
  const sub = document.createElement("div");
  sub.className = "block-menu block-submenu";
  sub.setAttribute("role", "menu");
  sub.setAttribute("aria-label", "Turn into");
  sub.hidden = true;
  document.body.append(root, sub);

  const items = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  const focusItem = (menu: HTMLElement, el: HTMLElement | undefined) => {
    if (!el) return;
    for (const i of items(menu)) i.tabIndex = i === el ? 0 : -1;
    el.focus();
  };

  const item = (label: string, o: { shortcut?: string; disabled?: boolean; role?: string; icon?: string; onRun(): void; popup?: boolean; checked?: boolean }): HTMLElement => {
    const b = document.createElement("div");
    b.className = "block-menu-item";
    b.setAttribute("role", o.role ?? "menuitem");
    b.tabIndex = -1;
    if (o.checked !== undefined) b.setAttribute("aria-checked", String(o.checked));
    if (o.disabled) b.setAttribute("aria-disabled", "true");
    if (o.popup) {
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-expanded", "false");
    }
    if (o.icon) {
      const icon = document.createElement("span");
      icon.className = "block-menu-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = o.icon;
      b.append(icon);
    }
    const text = document.createElement("span");
    text.className = "block-menu-label";
    text.textContent = label;
    b.append(text);
    if (o.shortcut) {
      const hint = document.createElement("span");
      hint.className = "block-menu-hint";
      hint.textContent = o.shortcut;
      b.append(hint);
    }
    // mousedown must not move focus out of the menu before the click lands
    b.addEventListener("mousedown", (event) => event.preventDefault());
    b.addEventListener("click", () => {
      if (o.disabled) return;
      o.onRun();
    });
    b.addEventListener("mousemove", () => {
      if (document.activeElement !== b) focusItem(b.closest<HTMLElement>(".block-menu")!, b);
    });
    return b;
  };

  const hideSub = (): void => {
    sub.hidden = true;
    root.querySelector('[aria-haspopup="menu"]')?.setAttribute("aria-expanded", "false");
  };

  const run = (action: BlockAction): void => {
    opts.onAction(action);
    close();
  };

  function openSub(from: HTMLElement, state: BlockMenuState, focus: boolean): void {
    sub.replaceChildren(
      ...BLOCK_KINDS.map((k) =>
        item(k.title, { role: "menuitemradio", icon: k.icon, checked: k.kind === state.current, onRun: () => (k.kind === state.current ? close() : run({ type: "turn", kind: k.kind })) }),
      ),
    );
    sub.hidden = false;
    from.setAttribute("aria-expanded", "true");
    const r = from.getBoundingClientRect();
    const width = sub.offsetWidth || 220;
    const height = sub.offsetHeight || 320;
    const fits = r.right + 4 + width <= window.innerWidth - 8;
    sub.style.left = `${fits ? r.right + 4 : Math.max(8, r.left - width - 4)}px`;
    sub.style.top = `${Math.max(8, Math.min(r.top - 4, window.innerHeight - height - 8))}px`;
    if (focus) focusItem(sub, items(sub).find((i) => i.getAttribute("aria-checked") === "true") ?? items(sub)[0]);
  }

  function open(state: BlockMenuState, anchor: DOMRect): void {
    hideSub();
    const turn = item("Turn into", { icon: "↻", popup: true, disabled: !state.canTurn, onRun: () => openSub(turn, state, true) });
    root.replaceChildren(
      turn,
      item("Duplicate", { icon: "⧉", onRun: () => run({ type: "duplicate" }) }),
      item("Delete", { icon: "✕", onRun: () => run({ type: "delete" }) }),
      item("Move up", { icon: "↑", shortcut: "Alt+Shift+↑", disabled: !state.canMoveUp, onRun: () => run({ type: "up" }) }),
      item("Move down", { icon: "↓", shortcut: "Alt+Shift+↓", disabled: !state.canMoveDown, onRun: () => run({ type: "down" }) }),
    );
    root.hidden = false;
    const width = root.offsetWidth || 240;
    const height = root.offsetHeight || 200;
    root.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
    const below = anchor.bottom + 4;
    root.style.top = `${below + height > window.innerHeight - 8 && anchor.top - height - 4 > 8 ? anchor.top - height - 4 : below}px`;
    focusItem(root, items(root)[0]);
    document.addEventListener("mousedown", outside, true);
  }

  function close(): void {
    if (root.hidden) return;
    root.hidden = true;
    hideSub();
    document.removeEventListener("mousedown", outside, true);
    opts.onClose(true);
  }

  function outside(event: MouseEvent): void {
    const t = event.target as Node | null;
    if (t && (root.contains(t) || sub.contains(t))) return;
    // The click lands where it landed (the editor, the handle); only the menu goes away.
    root.hidden = true;
    hideSub();
    document.removeEventListener("mousedown", outside, true);
    opts.onClose(false);
  }

  const onKey = (menu: HTMLElement) => (event: KeyboardEvent) => {
    const list = items(menu);
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      event.preventDefault();
      focusItem(menu, list[(i + list.length) % list.length]);
    };
    switch (event.key) {
      case "ArrowDown":
        return go(at + 1);
      case "ArrowUp":
        return go(at < 0 ? list.length - 1 : at - 1);
      case "Home":
        return go(0);
      case "End":
        return go(list.length - 1);
      case "Enter":
      case " ":
        event.preventDefault();
        (document.activeElement as HTMLElement | null)?.click();
        return;
      case "ArrowRight": {
        const cur = document.activeElement as HTMLElement | null;
        if (menu === root && cur?.getAttribute("aria-haspopup") === "menu") {
          event.preventDefault();
          cur.click();
        }
        return;
      }
      case "ArrowLeft":
        if (menu === sub) {
          event.preventDefault();
          const parent = root.querySelector<HTMLElement>('[aria-haspopup="menu"]');
          hideSub();
          focusItem(root, parent ?? undefined);
        }
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        if (menu === sub) {
          const parent = root.querySelector<HTMLElement>('[aria-haspopup="menu"]');
          hideSub();
          focusItem(root, parent ?? undefined);
        } else close();
        return;
      case "Tab":
        // Tab leaves the menu, back to the text, like Escape.
        event.preventDefault();
        close();
        return;
    }
  };
  root.addEventListener("keydown", onKey(root));
  sub.addEventListener("keydown", onKey(sub));

  return {
    open,
    close,
    isOpen: () => !root.hidden,
    destroy() {
      document.removeEventListener("mousedown", outside, true);
      root.remove();
      sub.remove();
    },
  };
}
