/**
 * The drag handle on the sidebar's edge. A focusable `role="separator"` (the WAI-ARIA window splitter) with
 * `aria-valuenow/min/max`; Left and Right change the width by 16px (Shift: 64px), Home and End go to the smallest and
 * largest, Enter and a double-click bring back the default. A pointer drag follows the pointer exactly and costs one
 * style write per frame: the width is a CSS variable on the shell (`--thoth-sidebar-width`), set from
 * `requestAnimationFrame`, and React hears about it once, when the drag ends. While it runs the shell carries
 * `data-resizing`, which stops text selection and any transition.
 *
 * The width is clamped to 200px and to 480px or 40% of the window, whichever is less; a window that shrinks clamps what
 * is shown without forgetting what was chosen. The choice is stored by the app (per Private Space on the desktop,
 * in the browser on the web) through `save`; the default is stored as nothing.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { useStrings } from "../strings/index.ts";
import { tip } from "./Tooltip.tsx";

export const SIDEBAR_DEFAULT = 260;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
/** The sidebar never takes more than this share of the window. */
export const SIDEBAR_MAX_SHARE = 0.4;
const STEP = 16;
const BIG_STEP = 64;
const VARIABLE = "--thoth-sidebar-width";

/** The widest the sidebar may be in a window `viewport` px wide: 480, or 40% of the window if that is less (never under the minimum). */
export const sidebarMax = (viewport: number): number => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(viewport * SIDEBAR_MAX_SHARE)));
export const clampSidebar = (width: number, viewport: number): number => Math.round(Math.min(sidebarMax(viewport), Math.max(SIDEBAR_MIN, width)));

/** A stored value read back: a whole number in range, else null (the default). */
export function parseSidebarWidth(text: string | null | undefined): number | null {
  if (typeof text !== "string" || !/^\d{1,4}$/.test(text)) return null;
  const n = Number(text);
  return n >= SIDEBAR_MIN && n <= SIDEBAR_MAX ? n : null;
}

export interface SidebarWidth {
  /** The width shown now, clamped to this window. */
  width: number;
  min: number;
  max: number;
  /** Put on the shell element: sets the CSS variable. */
  style: CSSProperties;
  /** Chooses a width (null: the default) and stores it. */
  choose(width: number | null): void;
}

const viewportWidth = () => (typeof window === "undefined" ? 1280 : document.documentElement.clientWidth || window.innerWidth);

/** The chosen sidebar width. `initial` reads the stored choice once; `save` stores a new one (null: back to the default). */
export function useSidebarWidth({ initial, save }: { initial(): number | null; save(width: number | null): void }): SidebarWidth {
  const [chosen, setChosen] = useState<number | null>(initial);
  const [viewport, setViewport] = useState(viewportWidth);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onResize = () => setViewport(viewportWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const max = sidebarMax(viewport);
  const width = clampSidebar(chosen ?? SIDEBAR_DEFAULT, viewport);
  const choose = useCallback((next: number | null) => {
    const value = next === null || next === SIDEBAR_DEFAULT ? null : Math.round(next);
    setChosen(value);
    saveRef.current(value);
  }, []);
  return { width, min: SIDEBAR_MIN, max, style: { [VARIABLE]: `${width}px` } as CSSProperties, choose };
}

interface Props {
  sidebar: SidebarWidth;
  /** The shell element that carries the width variable. */
  shell: RefObject<HTMLElement | null>;
}

interface Drag {
  pointerId: number;
  startX: number;
  start: number;
  now: number;
  frame: number;
  sign: 1 | -1;
}

export function SidebarResizer({ sidebar, shell }: Props) {
  const t = useStrings().sidebar;
  const { width, min, max, choose } = sidebar;
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  /** Writes the width to the page now: the variable on the shell and the handle's `aria-valuenow`. */
  const paint = (value: number) => {
    shell.current?.style.setProperty(VARIABLE, `${value}px`);
    handle.current?.setAttribute("aria-valuenow", String(value));
  };

  const finish = (commit: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    shell.current?.removeAttribute("data-resizing");
    try {
      handle.current?.releasePointerCapture?.(d.pointerId);
    } catch {
      // the pointer is already gone
    }
    if (commit && d.now !== d.start) {
      paint(d.now);
      choose(d.now);
    } else paint(d.start);
  };

  // A drag that is still on when the sidebar goes away must not leave the shell marked.
  useEffect(() => () => finish(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !shell.current) return;
    event.preventDefault(); // no text selection, no drag of whatever is under the pointer
    event.currentTarget.focus();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // a pointer that cannot be captured still drags while it stays over the handle
    }
    drag.current = { pointerId: event.pointerId, startX: event.clientX, start: width, now: width, frame: 0, sign: getComputedStyle(shell.current).direction === "rtl" ? -1 : 1 };
    shell.current.setAttribute("data-resizing", "");
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.pointerId) return;
    d.now = clampSidebar(d.start + (event.clientX - d.startX) * d.sign, viewportWidth());
    if (d.frame === 0) {
      d.frame = requestAnimationFrame(() => {
        d.frame = 0;
        paint(d.now);
      });
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (drag.current && event.key === "Escape") {
      event.preventDefault();
      return finish(false);
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const rtl = shell.current ? getComputedStyle(shell.current).direction === "rtl" : false;
    const step = event.shiftKey ? BIG_STEP : STEP;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = width + (rtl ? -step : step);
    else if (event.key === "ArrowLeft") next = width + (rtl ? step : -step);
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "Enter") next = SIDEBAR_DEFAULT;
    if (next === null) return;
    event.preventDefault();
    choose(clampSidebar(next, viewportWidth()));
  };

  return (
    <div
      ref={handle}
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t.resize}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      {...tip(t.resizeHint)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(true)}
      onDoubleClick={() => choose(null)}
      onKeyDown={onKeyDown}
    />
  );
}
