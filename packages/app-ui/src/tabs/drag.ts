/**
 * Dragging tabs (ADR-0019), with the pointer: along the bar to reorder, and on the desktop out of it to open the tab in
 * a new window. Pointer events rather than HTML5 drag and drop (which the page trees use, `order/dnd.ts`): the tab
 * follows the pointer along the bar, the bar scrolls when the pointer nears an edge, and a release outside the window
 * still reports where it happened, so the new window can open there.
 *
 * - A press becomes a drag after it moves `DRAG_PX`; less is a click. Touch never drags (it scrolls the bar).
 * - While dragging, `drop` names the place the tab would land: a line before or after another tab (`data-drop`).
 * - Released `DETACH_PX` below the bar or outside the window, with `canDetach`, it is a move to a new window.
 * - Escape, a cancelled pointer or losing the window's focus puts the tab back.
 *
 * The keyboard has Alt/Option+Shift+Left/Right and the tab's menu (TabBar.tsx).
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export const DRAG_PX = 5;
/** How far below the bar a release means "a new window", in CSS pixels. Closer than this is still a reorder. */
export const DETACH_PX = 48;
/** The band at each end of an overflowing bar where it scrolls by itself, and its fastest speed (px per frame). */
const EDGE_PX = 32;
const EDGE_SPEED = 14;

export type TabDrop = { id: string; side: "before" | "after" };

/**
 * Where a tab dragged to `x` lands among the other tabs: the number of them whose middle it has passed (in reading
 * order, so right to left in a right-to-left bar). That is its new index.
 */
export function dropIndex(others: readonly { left: number; width: number }[], x: number, rtl = false): number {
  return others.filter((r) => (rtl ? r.left + r.width / 2 > x : r.left + r.width / 2 < x)).length;
}

export interface DragState {
  id: string;
  /** How far the tab has been carried along the bar, in pixels. */
  dx: number;
  /** The index it would land at, or null over a place it cannot go (it is outside the bar, for a new window). */
  to: number | null;
  /** Far enough out for a new window. */
  detach: boolean;
  /** The pointer, for the "new window" label. */
  x: number;
  y: number;
}

export interface TabDragOptions {
  /** The tabs in order (ids). */
  order: readonly string[];
  /** The list element (it scrolls) and each tab's element. */
  list(): HTMLElement | null;
  tab(id: string): HTMLElement | null;
  canDetach: boolean;
  onMove(id: string, to: number): void;
  onDetach(id: string, at: { x: number; y: number }): void;
}

interface Pending {
  id: string;
  pointer: number;
  x: number;
  y: number;
  scroll: number;
  started: boolean;
}

const inWindow = (x: number, y: number): boolean => x >= 0 && y >= 0 && x <= globalThis.innerWidth && y <= globalThis.innerHeight;

export function useTabDrag(options: TabDragOptions) {
  const opts = useRef(options);
  opts.current = options;
  const [drag, setDrag] = useState<DragState | null>(null);
  const pending = useRef<Pending | null>(null);
  const last = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const frame = useRef<number | null>(null);
  /** Set when a drag ended over a tab, so the click that follows does not also open it. */
  const swallowClick = useRef(false);
  const detachListeners = useRef<(() => void) | null>(null);

  /** Where the tab would go with the pointer at (x, y). */
  const measure = useCallback((x: number, y: number): DragState | null => {
    const p = pending.current;
    const list = opts.current.list();
    if (!p || !list) return null;
    const o = opts.current;
    const bar = list.getBoundingClientRect();
    const detach = o.canDetach && (!inWindow(x, y) || y > bar.bottom + DETACH_PX);
    const rtl = getComputedStyle(list).direction === "rtl";
    const others = o.order.filter((id) => id !== p.id).map((id) => o.tab(id)?.getBoundingClientRect() ?? { left: 0, width: 0 });
    const dx = x - p.x + (list.scrollLeft - p.scroll);
    return { id: p.id, dx, to: detach ? null : dropIndex(others, x, rtl), detach, x, y };
  }, []);

  const stopFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  const end = useCallback(() => {
    stopFrame();
    detachListeners.current?.();
    detachListeners.current = null;
    pending.current = null;
    last.current = null;
    setDrag(null);
  }, []);

  useEffect(() => end, [end]);

  /** Scrolls an overflowing bar while the pointer stays near one of its ends, then measures again. */
  const edgeScroll = useCallback(() => {
    frame.current = null;
    const list = opts.current.list();
    const at = last.current;
    if (!list || !at || !pending.current?.started || list.scrollWidth <= list.clientWidth) return;
    const r = list.getBoundingClientRect();
    const into = at.x < r.left + EDGE_PX ? -(r.left + EDGE_PX - at.x) : at.x > r.right - EDGE_PX ? at.x - (r.right - EDGE_PX) : 0;
    if (into === 0 || at.y > r.bottom + DETACH_PX) return;
    const before = list.scrollLeft;
    list.scrollLeft += Math.sign(into) * Math.min(EDGE_SPEED, Math.ceil(Math.abs(into) / 2));
    if (list.scrollLeft !== before) setDrag(measure(at.x, at.y));
    frame.current = requestAnimationFrame(edgeScroll);
  }, [measure]);

  const onWindowMove = useCallback(
    (event: PointerEvent) => {
      const p = pending.current;
      if (!p || event.pointerId !== p.pointer) return;
      last.current = { x: event.clientX, y: event.clientY, sx: event.screenX, sy: event.screenY };
      if (!p.started) {
        if (Math.hypot(event.clientX - p.x, event.clientY - p.y) < DRAG_PX) return;
        p.started = true;
      }
      event.preventDefault();
      setDrag(measure(event.clientX, event.clientY));
      if (frame.current === null) frame.current = requestAnimationFrame(edgeScroll);
    },
    [measure, edgeScroll],
  );

  const onWindowUp = useCallback(
    (event: PointerEvent) => {
      const p = pending.current;
      if (!p || event.pointerId !== p.pointer) return;
      if (!p.started) return end();
      const result = measure(event.clientX, event.clientY);
      const from = opts.current.order.indexOf(p.id);
      swallowClick.current = true;
      setTimeout(() => (swallowClick.current = false), 0);
      end();
      if (!result) return;
      if (result.detach) opts.current.onDetach(p.id, { x: event.screenX, y: event.screenY });
      else if (result.to !== null && result.to !== from) opts.current.onMove(p.id, result.to);
    },
    [measure, end],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (event.button !== 0 || event.pointerType === "touch" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if ((event.target as Element).closest?.(".tab-close")) return;
    end();
    const list = opts.current.list();
    pending.current = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, scroll: list?.scrollLeft ?? 0, started: false };
    // Keep getting the pointer when it leaves the window, so a release out there is seen (and opens a new window).
    try {
      (event.target as Element).setPointerCapture?.(event.pointerId);
    } catch {
      // not every pointer can be captured; the window listeners below still see it in the window
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !pending.current?.started) return;
      e.preventDefault();
      e.stopPropagation();
      swallowClick.current = true;
      setTimeout(() => (swallowClick.current = false), 0);
      end();
    };
    const cancel = () => end();
    window.addEventListener("pointermove", onWindowMove);
    window.addEventListener("pointerup", onWindowUp);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", cancel);
    detachListeners.current = () => {
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onWindowUp);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", cancel);
    };
  };

  /** The line: before the tab now at `to`, or after the last one. Nothing where the tab already is. */
  let drop: TabDrop | null = null;
  if (drag && drag.to !== null) {
    const order = options.order;
    const from = order.indexOf(drag.id);
    const others = order.filter((id) => id !== drag.id);
    if (drag.to !== from && others.length > 0) drop = drag.to < others.length ? { id: others[drag.to]!, side: "before" } : { id: others[others.length - 1]!, side: "after" };
  }

  return { drag, drop, onPointerDown, swallowClick };
}
