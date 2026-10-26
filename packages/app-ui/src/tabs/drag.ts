/**
 * Dragging tabs (ADR-0019, amended 2026-10-26), with the pointer: along the bar to reorder, and on the desktop out of it
 * to open the tab in a new window. Pointer events rather than HTML5 drag and drop (which the page trees use,
 * `order/dnd.ts`): the bar scrolls when the pointer nears an edge, the tab itself follows the pointer, and a release
 * outside the window still reports where it happened, so the new window can open there.
 *
 * - A press becomes a drag after it moves `DRAG_PX`; less is a click. Touch never drags (it scrolls the bar).
 * - While dragging, the tab follows the pointer along the bar (kept within it) and the others slide aside to open the
 *   gap where it would land: `drag.shifts` says how far each tab is moved (TabBar.tsx applies them as transforms).
 *   Everything is measured from the tabs' boxes cached when the drag began, plus how far the bar has scrolled since,
 *   so the gap does not chase the pointer (`order/live-reorder.ts`).
 * - Released `DETACH_PX` below the bar or outside the window, with `canDetach`, it is a move to a new window. Out
 *   there, every tab is back in its place.
 * - Escape, a cancelled pointer or losing the window's focus puts the tab back.
 * - `onEnd` is called just before a drag that had started ends, while the tabs are still shown where the drag put
 *   them, so they can slide from there to where they end up.
 *
 * The keyboard has Alt/Option+Shift+Left/Right and the tab's menu (TabBar.tsx).
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { gapBetween, previewShifts, slotIndex, type Span } from "../order/live-reorder.ts";

export const DRAG_PX = 5;
/** How far below the bar a release means "a new window", in CSS pixels. Closer than this is still a reorder. */
export const DETACH_PX = 48;
/** The band at each end of an overflowing bar where it scrolls by itself, and its fastest speed (px per frame). */
const EDGE_PX = 32;
const EDGE_SPEED = 14;

/**
 * Where a tab whose middle is at `x` lands among the other tabs: the number of them whose middle it has passed (in
 * reading order, so right to left in a right-to-left bar). That is its new index.
 */
export function dropIndex(others: readonly { left: number; width: number }[], x: number, rtl = false): number {
  return slotIndex(others.map((r) => ({ start: r.left, size: r.width })), x, rtl);
}

export interface DragState {
  id: string;
  /** The index it would land at, or null over a place it cannot go (it is outside the bar, for a new window). */
  to: number | null;
  /** Far enough out for a new window. */
  detach: boolean;
  /** The pointer, for the "new window" label. */
  x: number;
  y: number;
  /** How far each tab is shown moved along the bar (px; the dragged one follows the pointer, the others make room). */
  shifts: Readonly<Record<string, number>>;
}

export interface TabDragOptions {
  /** The tabs in order (ids). */
  order: readonly string[];
  /** The list element (it scrolls) and each tab's element. */
  list(): HTMLElement | null;
  tab(id: string): HTMLElement | null;
  canDetach: boolean;
  /**
   * The indexes the tab `id` may land at, both included (ADR-0027: a pinned tab among the pinned ones, another among
   * the others). Omitted: anywhere. The preview never opens a gap past them.
   */
  bounds?(id: string): readonly [number, number];
  onMove(id: string, to: number): void;
  onDetach(id: string, at: { x: number; y: number }): void;
  /** A drag that had started is about to end (drop or cancel); the tabs are still where it showed them. */
  onEnd?(): void;
}

interface Pending {
  id: string;
  pointer: number;
  x: number;
  y: number;
  started: boolean;
}

/** The bar as it was when the drag began: the tabs in order with their boxes, and the list's scroll. */
interface Cache {
  order: readonly string[];
  spans: Span[];
  scroll: number;
  rtl: boolean;
  gap: number;
  /** Where the first tab starts and the last one ends (the tabs can be narrower than the bar). */
  min: number;
  max: number;
}

const inWindow = (x: number, y: number): boolean => x >= 0 && y >= 0 && x <= globalThis.innerWidth && y <= globalThis.innerHeight;

export function useTabDrag(options: TabDragOptions) {
  const opts = useRef(options);
  opts.current = options;
  const [drag, setDrag] = useState<DragState | null>(null);
  const pending = useRef<Pending | null>(null);
  const cache = useRef<Cache | null>(null);
  const last = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const frame = useRef<number | null>(null);
  /** Set when a drag ended over a tab, so the click that follows does not also open it. */
  const swallowClick = useRef(false);
  const detachListeners = useRef<(() => void) | null>(null);

  /** Reads the bar once, as the drag begins: every later measure works from this. */
  const remember = useCallback((list: HTMLElement): Cache => {
    const o = opts.current;
    const spans = o.order.map((id) => {
      const r = o.tab(id)?.getBoundingClientRect();
      return { start: r?.left ?? 0, size: r?.width ?? 0 };
    });
    const rtl = getComputedStyle(list).direction === "rtl";
    return {
      order: [...o.order],
      spans,
      scroll: list.scrollLeft,
      rtl,
      gap: gapBetween(spans, rtl),
      min: Math.min(...spans.map((s) => s.start)),
      max: Math.max(...spans.map((s) => s.start + s.size)),
    };
  }, []);

  /** Where the tab would go with the pointer at (x, y), and where every tab is shown meanwhile. */
  const measure = useCallback((x: number, y: number): DragState | null => {
    const p = pending.current;
    const c = cache.current;
    const list = opts.current.list();
    if (!p || !c || !list) return null;
    const from = c.order.indexOf(p.id);
    const self = c.spans[from];
    if (!self) return null;
    const bar = list.getBoundingClientRect();
    const detach = opts.current.canDetach && (!inWindow(x, y) || y > bar.bottom + DETACH_PX);
    const scrolled = list.scrollLeft - c.scroll;
    const dx = x - p.x;
    // Its middle where the pointer has taken it (not held back at the ends, so the far end is always reachable).
    const center = self.start + self.size / 2 + dx;
    const slot = detach ? null : slotIndex(c.spans.filter((_, i) => i !== from), center, c.rtl, scrolled);
    const [first, last] = opts.current.bounds?.(p.id) ?? [0, c.order.length - 1];
    const to = slot === null ? null : Math.max(first, Math.min(slot, last));
    const moved = previewShifts(c.order.length, from, to, self.size, c.gap, c.rtl);
    if (!detach) {
      // The tab follows the pointer along the bar, kept between the first tab's start and the last tab's end, and
      // within what the bar shows. Its own place has moved with the scroll, so it is shifted by that too.
      // Kept over its own group too (ADR-0027): an unpinned tab never covers the pinned ones.
      const group = c.spans.slice(first, last + 1);
      const gMin = group.length > 0 ? Math.min(...group.map((g) => g.start)) : c.min;
      const gMax = group.length > 0 ? Math.max(...group.map((g) => g.start + g.size)) : c.max;
      const lo = Math.max(bar.left, gMin - scrolled);
      const hi = Math.min(bar.right, gMax - scrolled) - self.size;
      const want = self.start + dx;
      const left = hi < lo ? want : Math.min(hi, Math.max(lo, want));
      moved[from] = left - (self.start - scrolled);
    }
    const shifts = Object.fromEntries(c.order.map((id, i) => [id, Math.round((moved[i] ?? 0) * 100) / 100 || 0]));
    return { id: p.id, to, detach, x, y, shifts };
  }, []);

  const stopFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  const end = useCallback(() => {
    stopFrame();
    detachListeners.current?.();
    detachListeners.current = null;
    if (pending.current?.started) opts.current.onEnd?.();
    pending.current = null;
    cache.current = null;
    last.current = null;
    setDrag(null);
  }, []);

  useEffect(() => end, [end]);

  // Tabs opened or closed during a drag (a shortcut, another window): the places it measured are gone, so it stops.
  const orderKey = options.order.join("\u0000");
  useEffect(() => {
    const c = cache.current;
    if (c && c.order.join("\u0000") !== orderKey) end();
  }, [orderKey, end]);

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
        const list = opts.current.list();
        if (!list) return;
        cache.current = remember(list);
        p.started = true;
      }
      event.preventDefault();
      setDrag(measure(event.clientX, event.clientY));
      if (frame.current === null) frame.current = requestAnimationFrame(edgeScroll);
    },
    [measure, edgeScroll, remember],
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
    pending.current = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, started: false };
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

  return { drag, onPointerDown, swallowClick };
}
