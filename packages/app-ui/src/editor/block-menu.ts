/**
 * The block menu: Turn into, Duplicate, Delete, Move up, Move down.
 *
 * A WAI-ARIA menu (`role=menu`, `menuitem`, roving tabindex). Opening moves
 * focus into the menu; Escape (or picking an item) gives it back to the
 * editor, so focus is never lost. "Turn into" opens a submenu with the same
 * block types as the `/` menu.
 */
import { localizedBlockKinds, type BlockKind } from "./block-kinds.ts";
import type { EditorStrings } from "../strings/en.ts";

export type BlockAction = { type: "turn"; kind: BlockKind } | { type: "duplicate" } | { type: "delete" } | { type: "up" } | { type: "down" } | { type: "alt" } | { type: "copyText" } | { type: "insertText" };

export interface BlockMenuState {
  /** Block type of the target, shown as checked in "Turn into"; null when it has none in the list. */
  current: BlockKind | null;
  canTurn: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** The block is an image: offer "Edit alt text" (ADR-0028). */
  isImage?: boolean;
  /** An image and the app has OCR (ADR-0055): offer Copy text / Insert text below; a string disables them with that reason. */
  ocr?: true | string;
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
  strings: EditorStrings;
}

/** The menu's own icons: drawn like the app's (ui/Icon.tsx: 24-unit grid, 1.8 stroke, round caps), shown at 16px. */
const DRAWN: Record<string, string[]> = {
  alt: ["M4 5.5h16v13H4z", "M7.5 15l3-3.5 2.5 2.5 1.5-1.5 2 2.5", "M15.5 8.6v.1"],
  copyText: ["M9 9h11v11H9z", "M5 15V6a2 2 0 0 1 2-2h9", "M12 13h5M12 16.5h3"],
  insertText: ["M4 5h16M4 9.5h10", "M12 12.5v7M8.8 16.5l3.2 3.2 3.2-3.2"],
  turn: ["M19.5 12a7.5 7.5 0 1 1-2.2-5.3", "M19.5 4.5v4h-4"],
  duplicate: ["M9 9h11v11H9z", "M5 15V6a2 2 0 0 1 2-2h9", "M14.5 12v5M12 14.5h5"],
  delete: ["M5 7h14", "M10 4h4", "M7 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7", "M10.5 11v5.5M13.5 11v5.5"],
  up: ["M12 19V5M6.5 10.5L12 5l5.5 5.5"],
  down: ["M12 5v14M6.5 13.5L12 19l5.5-5.5"],
};

function drawn(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  for (const d of DRAWN[name] ?? []) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export function createBlockMenu(opts: Options): BlockMenu {
  const t = opts.strings;
  const kinds = localizedBlockKinds(t.blocks);
  const root = document.createElement("div");
  root.className = "block-menu";
  root.setAttribute("role", "menu");
  root.setAttribute("aria-label", t.blockMenu);
  root.hidden = true;
  const sub = document.createElement("div");
  sub.className = "block-menu block-submenu";
  sub.setAttribute("role", "menu");
  sub.setAttribute("aria-label", t.turnInto);
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
      // A drawn icon by its name, else the block kind's own glyph (H1, •, ☐…) as text.
      if (o.icon in DRAWN) icon.append(drawn(o.icon));
      else icon.textContent = o.icon;
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
      ...kinds.map((k) =>
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
    const turn = item(t.turnInto, { icon: "turn", popup: true, disabled: !state.canTurn, onRun: () => openSub(turn, state, true) });
    root.replaceChildren(
      ...(state.isImage ? [item(t.image.editAlt, { icon: "alt", onRun: () => run({ type: "alt" }) })] : []),
      ...(state.ocr
        ? (["copyText", "insertText"] as const).map((type) => {
            const why = state.ocr === true ? undefined : state.ocr;
            const label = why ? `${t.image[type]} (${why})` : t.image[type];
            return item(label, { icon: type, disabled: !!why, onRun: () => run({ type }) });
          })
        : []),
      turn,
      item(t.duplicate, { icon: "duplicate", onRun: () => run({ type: "duplicate" }) }),
      item(t.delete, { icon: "delete", onRun: () => run({ type: "delete" }) }),
      item(t.moveUp, { icon: "up", shortcut: "Alt+Shift+↑", disabled: !state.canMoveUp, onRun: () => run({ type: "up" }) }),
      item(t.moveDown, { icon: "down", shortcut: "Alt+Shift+↓", disabled: !state.canMoveDown, onRun: () => run({ type: "down" }) }),
    );
    root.hidden = false;
    const width = root.offsetWidth || 240;
    const height = root.offsetHeight || 200;
    root.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
    const below = anchor.bottom + 4;
    const above = below + height > window.innerHeight - 8 && anchor.top - height - 4 > 8;
    root.style.top = `${above ? anchor.top - height - 4 : below}px`;
    root.dataset["side"] = above ? "top" : "bottom";
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
