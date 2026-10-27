import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

/** The gap kept between a menu and the window edge. */
const MARGIN = 8;

export interface MenuItem {
  id: string;
  label: string;
  /** Shown after the label, for example "F2". */
  hint?: string;
  disabled?: boolean;
  onSelect(): void;
}

/** The element dialogs and menus mount into, so they inherit the app's theme tokens. */
export function shellRoot(): HTMLElement {
  return document.querySelector<HTMLElement>(".shell") ?? document.body;
}

interface Props {
  label: string;
  /** Screen position (a pointer click) or the element the menu opens from (a key press). */
  at: { x: number; y: number };
  items: MenuItem[];
  /** Closes the menu. `restoreFocus` is false when the chosen action moves focus itself. */
  onClose(restoreFocus: boolean): void;
}

/**
 * A small menu for one tree row: opened by right click, the Menu key or Shift+F10. Up/Down move, Enter or a click
 * chooses, Escape or a click elsewhere closes. Focus returns to the row unless the action takes it elsewhere.
 */
export function ContextMenu({ label, at, items, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight?: number; origin: string } | null>(null);

  // Before paint: open at the point, flip above / to the left when it would overflow, then keep it inside the window.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const viewW = document.documentElement.clientWidth || window.innerWidth;
    const viewH = document.documentElement.clientHeight || window.innerHeight;
    const size = el.getBoundingClientRect();
    const cap = viewH - 2 * MARGIN;
    const height = Math.min(size.height, cap);
    const flipY = at.y + height > viewH - MARGIN && at.y - height >= MARGIN;
    const flipX = at.x + size.width > viewW - MARGIN && at.x - size.width >= MARGIN;
    const clamp = (v: number, size: number, view: number) => Math.max(MARGIN, Math.min(v, view - MARGIN - size));
    setPlace({
      left: flipX ? at.x - size.width : clamp(at.x, size.width, viewW),
      top: flipY ? at.y - height : clamp(at.y, height, viewH),
      maxHeight: size.height > cap ? cap : undefined,
      origin: `${flipY ? "bottom" : "top"} ${flipX ? "right" : "left"}`,
    });
  }, [at.x, at.y]);

  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    const onDown = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) close.current(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(box.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => {
      event.preventDefault();
      buttons[(i + buttons.length) % buttons.length]?.focus();
    };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(buttons.length - 1);
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close.current(true);
    }
  };

  const style: CSSProperties = place
    ? { left: place.left, top: place.top, maxHeight: place.maxHeight, overflowY: place.maxHeight ? "auto" : undefined, transformOrigin: place.origin }
    : { left: at.x, top: at.y }; // replaced before paint; not hidden, so the first item can take focus

  return createPortal(
    <div ref={box} className="ctx-menu" role="menu" aria-label={label} style={style} onKeyDown={onKeyDown}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="ctx-item"
          disabled={item.disabled}
          onClick={() => {
            onClose(false);
            item.onSelect();
          }}
        >
          <span>{item.label}</span>
          {item.hint && <kbd aria-hidden="true">{item.hint}</kbd>}
        </button>
      ))}
    </div>,
    shellRoot(),
  );
}
