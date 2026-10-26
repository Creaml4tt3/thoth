/**
 * Dragging an item of a vertical list to a new place, with the same live preview as the tabs (`../tabs/drag.ts`): the
 * item lifts and follows the pointer up and down, and the others slide aside to open the gap where it would land. The
 * sidebar's sections use it by their headers (ADR-0019 amendment) and the Favorites by their rows (ADR-0027). Pointer
 * events, not HTML5 drag and drop: the page trees use HTML5 drag and drop on their rows, and a press there never
 * reaches a section header or a favorite, so neither drag can start the other.
 *
 * - A press becomes a drag after it moves `DRAG_PX`; less is a click. Touch never drags (it scrolls the sidebar).
 * - Positions are measured from the sections' boxes cached when the drag began, plus how far the sidebar has scrolled
 *   since; it scrolls by itself while the pointer is near its top or bottom.
 * - Escape, a cancelled pointer or losing the window's focus puts everything back.
 * - `onEnd` is called just before a drag that had started ends, while the sections are still shown where it put them.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { gapBetween, previewShifts, slotIndex, type Span } from "./live-reorder.ts";

export const DRAG_PX = 5;
const EDGE_PX = 32;
const EDGE_SPEED = 14;

export interface ListDragState {
  id: string;
  /** The index it would land at. */
  to: number;
  /** How far each item is shown moved down (px). */
  shifts: Readonly<Record<string, number>>;
}

export interface ListDragOptions {
  /** The items in order (ids). */
  order: readonly string[];
  /** The element that scrolls (the sidebar's list) and each item's element. */
  scroller(): HTMLElement | null;
  item(id: string): HTMLElement | null;
  /** The indexes the item `id` may land at, both included (a favorite stays among those of its space). Omitted: anywhere. */
  bounds?(id: string): readonly [number, number];
  onMove(id: string, to: number): void;
  onEnd?(): void;
}

interface Pending {
  id: string;
  pointer: number;
  y: number;
  started: boolean;
}

interface Cache {
  order: readonly string[];
  spans: Span[];
  scroll: number;
  gap: number;
  min: number;
  max: number;
}

/** A press on one of these inside an item is the control's own, not the start of a drag (a header's grip and name are). */
const OWN_CONTROLS = ".sec-actions, input, select, textarea, a";

export function useListDrag(options: ListDragOptions) {
  const opts = useRef(options);
  opts.current = options;
  const [drag, setDrag] = useState<ListDragState | null>(null);
  const pending = useRef<Pending | null>(null);
  const cache = useRef<Cache | null>(null);
  const last = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const swallowClick = useRef(false);
  const detachListeners = useRef<(() => void) | null>(null);

  const remember = useCallback((scroller: HTMLElement): Cache => {
    const o = opts.current;
    const spans = o.order.map((id) => {
      const r = o.item(id)?.getBoundingClientRect();
      return { start: r?.top ?? 0, size: r?.height ?? 0 };
    });
    return { order: [...o.order], spans, scroll: scroller.scrollTop, gap: gapBetween(spans), min: Math.min(...spans.map((s) => s.start)), max: Math.max(...spans.map((s) => s.start + s.size)) };
  }, []);

  const measure = useCallback((y: number): ListDragState | null => {
    const p = pending.current;
    const c = cache.current;
    const scroller = opts.current.scroller();
    if (!p || !c || !scroller) return null;
    const from = c.order.indexOf(p.id);
    const self = c.spans[from];
    if (!self) return null;
    const scrolled = scroller.scrollTop - c.scroll;
    const dy = y - p.y;
    const slot = slotIndex(c.spans.filter((_, i) => i !== from), self.start + self.size / 2 + dy, false, scrolled);
    const [first, last] = opts.current.bounds?.(p.id) ?? [0, c.order.length - 1];
    const to = Math.max(first, Math.min(slot, last));
    const moved = previewShifts(c.order.length, from, to, self.size, c.gap);
    // It follows the pointer, kept between the first section's top and the last one's bottom, and within what the
    // sidebar shows (unless it is taller than that, then it just follows).
    const box = scroller.getBoundingClientRect();
    const lo = Math.max(box.top, c.min - scrolled);
    const hi = Math.min(box.bottom, c.max - scrolled) - self.size;
    const want = self.start + dy;
    const top = hi < lo ? want : Math.min(hi, Math.max(lo, want));
    moved[from] = top - (self.start - scrolled);
    return { id: p.id, to, shifts: Object.fromEntries(c.order.map((id, i) => [id, Math.round((moved[i] ?? 0) * 100) / 100 || 0])) };
  }, []);

  const end = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    detachListeners.current?.();
    detachListeners.current = null;
    if (pending.current?.started) opts.current.onEnd?.();
    pending.current = null;
    cache.current = null;
    last.current = null;
    setDrag(null);
  }, []);

  useEffect(() => end, [end]);

  // An item that comes or goes during the drag (a server added in Settings): the measured places are gone.
  const orderKey = options.order.join("\u0000");
  useEffect(() => {
    const c = cache.current;
    if (c && c.order.join("\u0000") !== orderKey) end();
  }, [orderKey, end]);

  const edgeScroll = useCallback(() => {
    frame.current = null;
    const scroller = opts.current.scroller();
    const y = last.current;
    if (!scroller || y === null || !pending.current?.started || scroller.scrollHeight <= scroller.clientHeight) return;
    const r = scroller.getBoundingClientRect();
    const into = y < r.top + EDGE_PX ? -(r.top + EDGE_PX - y) : y > r.bottom - EDGE_PX ? y - (r.bottom - EDGE_PX) : 0;
    if (into === 0) return;
    const before = scroller.scrollTop;
    scroller.scrollTop += Math.sign(into) * Math.min(EDGE_SPEED, Math.ceil(Math.abs(into) / 2));
    if (scroller.scrollTop !== before) setDrag(measure(y));
    frame.current = requestAnimationFrame(edgeScroll);
  }, [measure]);

  const onWindowMove = useCallback(
    (event: PointerEvent) => {
      const p = pending.current;
      if (!p || event.pointerId !== p.pointer) return;
      last.current = event.clientY;
      if (!p.started) {
        if (Math.abs(event.clientY - p.y) < DRAG_PX) return;
        const scroller = opts.current.scroller();
        if (!scroller) return;
        cache.current = remember(scroller);
        p.started = true;
      }
      event.preventDefault();
      setDrag(measure(event.clientY));
      if (frame.current === null && typeof requestAnimationFrame === "function") frame.current = requestAnimationFrame(edgeScroll);
    },
    [measure, edgeScroll, remember],
  );

  const swallowNextClick = () => {
    swallowClick.current = true;
    setTimeout(() => (swallowClick.current = false), 0);
  };

  const onWindowUp = useCallback(
    (event: PointerEvent) => {
      const p = pending.current;
      if (!p || event.pointerId !== p.pointer) return;
      if (!p.started) return end();
      const result = measure(event.clientY);
      const from = cache.current?.order.indexOf(p.id) ?? -1;
      swallowNextClick();
      end();
      if (result && result.to !== from) opts.current.onMove(p.id, result.to);
    },
    [measure, end],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (event.button !== 0 || event.pointerType === "touch" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if ((event.target as Element).closest?.(OWN_CONTROLS)) return;
    end();
    pending.current = { id, pointer: event.pointerId, y: event.clientY, started: false };
    try {
      (event.target as Element).setPointerCapture?.(event.pointerId);
    } catch {
      // not every pointer can be captured; the window listeners below still see it in the window
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !pending.current?.started) return;
      e.preventDefault();
      e.stopPropagation();
      swallowNextClick();
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
