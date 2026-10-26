/**
 * Drag and drop in the page trees (ADR-0016 rule 4). A row can be dropped before another row, after it, or
 * inside it (a folder, or a page that holds pages). The row under the pointer shows where with `data-drop`
 * (the accent-coloured indicator in shell.css). The dragged row id is kept here, because the browser hides
 * the data of a drag until it ends.
 *
 * What the browser needs for this to work (each was a reason a drag did nothing or flickered):
 * - the row must really be draggable: `.tree-item` sets `all: unset`, which removes the browser's own
 *   `[draggable="true"] { -webkit-user-drag: element }`, so shell.css says it again;
 * - `dragenter` and `dragover` must both be cancelled on a place that accepts the drop;
 * - while a drag runs the rows' children take no pointer events (`data-tree-dragging` on the root, set a tick after
 *   the drag starts), so crossing the icon and the label of one row is not leaving it. WebKit also reports no
 *   `relatedTarget` on `dragleave`, so leaving is decided by where the pointer is, not by what it entered.
 *
 * Dragging is a mouse feature; the keyboard has Alt+Shift+Up/Down and "Move to…" (see `tree-keys.ts`).
 *
 * A row can also be dragged onto the other space's tree (`carry` in the source tree, `across` in the target; see
 * `space-drag.ts`). That only asks for the transfer dialog; within one tree everything works as described above.
 */
import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type HTMLAttributes } from "react";
import { SPACE_DRAG_TYPE, beginSpaceDrag, clearSpaceHover, currentSpaceDrag, dropAcrossSpaces, encodeSpaceDrag, endSpaceDrag, modeAtDrop, setSpaceHover, type SpaceDestination, type SpaceDrag } from "./space-drag.ts";

/** Where a drag from the other space would land over a row, and what the pointer says. */
export interface AcrossTarget {
  /** The row to light ("inside"); null when the light is elsewhere (the Private Space header) or the drop is refused. */
  highlight: string | null;
  /** Null: refused, and `text` says why. */
  to: SpaceDestination | null;
  /** "Copy to Studio…", or the reason it is refused. */
  text: string;
}

export type DropZone = "before" | "inside" | "after";
export interface DropState {
  id: string;
  zone: DropZone;
}

/**
 * Which part of a row the pointer is over. A row that can hold others has a middle band for "inside" and thin
 * bands for before and after; a row that cannot is split in two. Without ordering (no `page-order`), only the
 * middle band counts and the edges are not drop places at all.
 */
export function dropZone(offsetY: number, height: number, options: { canContain: boolean; canOrder: boolean }): DropZone | null {
  const f = height > 0 ? Math.min(1, Math.max(0, offsetY / height)) : 0.5;
  if (!options.canOrder) return options.canContain && f >= 0.25 && f <= 0.75 ? "inside" : null;
  if (options.canContain) return f < 0.25 ? "before" : f > 0.75 ? "after" : "inside";
  return f < 0.5 ? "before" : "after";
}

export interface TreeDndOptions {
  /** False for read-only trees: rows are not draggable and accept nothing. */
  enabled: boolean;
  /** Can others be dropped inside this row? */
  canContain(id: string): boolean;
  /** Does the tree keep an order, so that before/after mean something? */
  canOrder: boolean;
  /** Is this drop allowed (not onto itself, not into its own descendant, ...)? */
  canDrop(drag: string, over: string, zone: DropZone): boolean;
  onDrop(drag: string, over: string, zone: DropZone): void;
  /** A closed row stayed under a dragged one for a moment: open it so the drop can go deeper. */
  onHoverOpen?(id: string): void;
  /** A row that is only a place to drop into (the "Top level" strip, a workspace's own row): its whole height means "inside". */
  onlyInside?(id: string): boolean;
  /**
   * The first row shown under this one when it is open, else null. The lower edge of an open folder then means "first
   * inside it": that is where a line drawn under the folder row lands, and a drop "after" it would land below all its children.
   */
  firstChild?(id: string): string | null;
  /**
   * What a drag of this row would take to the other space, asked at dragstart; null: nothing. With `carry` a row is
   * draggable even when `enabled` is false (a viewer can still copy pages out), but then it is never reordered.
   */
  carry?(id: string): SpaceDrag | null;
  /** A drag from another tree is over row `id`: where it would land, or null when this row is no place for it at all. */
  across?(drag: SpaceDrag, id: string, move: boolean): AcrossTarget | null;
}

export interface TreeDnd {
  dragging: string | null;
  drop: DropState | null;
  /** Props for the row element with this id. */
  rowProps(id: string): Pick<HTMLAttributes<HTMLElement>, "onDragStart" | "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop" | "onDragEnd"> & { draggable?: boolean; "data-drop"?: DropZone | undefined };
}

const HOVER_OPEN_MS = 700;
const ACTIVE_ATTRIBUTE = "data-tree-dragging";

/** A small themed picture of the dragged row for the pointer (the browser's own is a faded copy of the whole row). */
function dragImage(row: HTMLElement): { node: HTMLElement; x: number; y: number } | null {
  const text = row.querySelector(".tree-label")?.textContent?.trim();
  if (!text) return null;
  const node = document.createElement("div");
  node.className = "tree-drag-image";
  node.textContent = text;
  document.body.appendChild(node);
  return { node, x: 12, y: 14 };
}

export function useTreeDnd(options: TreeDndOptions): TreeDnd {
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const opts = useRef(options);
  opts.current = options;
  const drag = useRef<string | null>(null);
  const hover = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const active = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The row whose events last set `drop` (the indicator may sit on another row: the first child of an open folder). */
  const via = useRef<string | null>(null);
  /** This tree's name in the shared hover state (`space-drag.ts`). */
  const owner = useId();

  const clearHover = useCallback(() => {
    if (hover.current) clearTimeout(hover.current.timer);
    hover.current = null;
  }, []);
  const clearActive = useCallback(() => {
    if (active.current) clearTimeout(active.current);
    active.current = null;
    document.documentElement.removeAttribute(ACTIVE_ATTRIBUTE);
  }, []);
  useEffect(
    () => () => {
      clearHover();
      clearActive();
    },
    [clearHover, clearActive],
  );

  const reset = useCallback(() => {
    if (drag.current !== null && currentSpaceDrag()?.row === drag.current) endSpaceDrag();
    drag.current = null;
    via.current = null;
    clearHover();
    clearActive();
    setDragging(null);
    setDrop(null);
  }, [clearHover, clearActive]);

  /** Where a drop on the row `id` would go, or null when it would not be allowed. */
  const target = (event: DragEvent<HTMLElement>, id: string): DropState | null => {
    const from = drag.current;
    // A row of a tree that cannot reorder was only dragged to be carried elsewhere.
    if (from === null || !opts.current.enabled) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const o = opts.current;
    const zone = o.onlyInside?.(id) ? "inside" : dropZone(event.clientY - rect.top, rect.height, { canContain: o.canContain(id), canOrder: o.canOrder });
    if (zone === null) return null;
    if (zone === "after") {
      // Under an open folder's own row the next row is its first child.
      const first = o.firstChild?.(id) ?? null;
      if (first !== null) return o.canDrop(from, first, "before") ? { id: first, zone: "before" } : null;
    }
    return o.canDrop(from, id, zone) ? { id, zone } : null;
  };

  /** A drag from another tree over row `id`: where it would land, or null (not a place for it at all). */
  const acrossTarget = (event: DragEvent<HTMLElement>, id: string): { drag: SpaceDrag; to: AcrossTarget } | null => {
    if (drag.current !== null || !opts.current.across) return null;
    const carried = currentSpaceDrag();
    if (carried === null) return null;
    const to = opts.current.across(carried, id, modeAtDrop(event) === "move");
    return to ? { drag: carried, to } : null;
  };

  /** dragenter and dragover of a drag from another tree: light the target, or say why it is refused. */
  const hoverAcross = (event: DragEvent<HTMLElement>, id: string) => {
    const found = acrossTarget(event, id);
    const key = `${owner}\n${id}`;
    if (found === null || found.to.to === null) {
      // Refused (or no place for it): no indicator, and without preventDefault the pointer shows "no drop".
      clearHover();
      if (via.current === id) via.current = null;
      setDrop(null);
      if (found) setSpaceHover({ owner: key, x: event.clientX, y: event.clientY, text: found.to.text, to: null });
      else clearSpaceHover(key);
      return;
    }
    const { highlight, to, text } = found.to;
    event.preventDefault();
    event.dataTransfer.dropEffect = modeAtDrop(event);
    via.current = id;
    setDrop((d) => (highlight === null ? null : d?.id === highlight && d.zone === "inside" ? d : { id: highlight, zone: "inside" }));
    setSpaceHover({ owner: key, x: event.clientX, y: event.clientY, text, to });
    if (highlight === id && opts.current.onHoverOpen) {
      if (hover.current?.id !== id) {
        clearHover();
        hover.current = { id, timer: setTimeout(() => opts.current.onHoverOpen?.(id), HOVER_OPEN_MS) };
      }
    } else clearHover();
  };

  /** dragenter and dragover: accept the drop where it is allowed and show where it would go. */
  const hoverOn = (event: DragEvent<HTMLElement>, id: string) => {
    if (drag.current === null) return hoverAcross(event, id);
    const to = target(event, id);
    if (to === null) {
      // Nothing may be dropped here: no row shows an indicator.
      clearHover();
      via.current = null;
      setDrop(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    via.current = id;
    setDrop((d) => (d?.id === to.id && d.zone === to.zone ? d : to));
    if (to.zone === "inside" && opts.current.onHoverOpen) {
      if (hover.current?.id !== id) {
        clearHover();
        hover.current = { id, timer: setTimeout(() => opts.current.onHoverOpen?.(id), HOVER_OPEN_MS) };
      }
    } else clearHover();
  };

  const rowProps: TreeDnd["rowProps"] = (id) => {
    if (!options.enabled && !options.carry && !options.across) return {};
    return {
      ...(options.enabled || options.carry ? { draggable: true } : {}),
      "data-drop": drop?.id === id ? drop.zone : undefined,
      onDragStart(event) {
        event.stopPropagation();
        const carried = opts.current.carry?.(id) ?? null;
        if (!opts.current.enabled && carried === null) {
          event.preventDefault(); // nothing to reorder, nothing to carry
          return;
        }
        drag.current = id;
        setDragging(id);
        event.dataTransfer.effectAllowed = carried ? "copyMove" : "move";
        // Firefox starts no drag without data.
        event.dataTransfer.setData("text/plain", id);
        if (carried) {
          event.dataTransfer.setData(SPACE_DRAG_TYPE, encodeSpaceDrag(carried));
          beginSpaceDrag(carried);
        }
        const picture = dragImage(event.currentTarget);
        if (picture) {
          event.dataTransfer.setDragImage?.(picture.node, picture.x, picture.y);
          setTimeout(() => picture.node.remove(), 0); // the browser has taken its picture by then
        }
        // Changing what the page looks like inside `dragstart` can end the drag at once in some browsers: do it a tick later.
        active.current = setTimeout(() => {
          active.current = null;
          if (drag.current !== null) document.documentElement.setAttribute(ACTIVE_ATTRIBUTE, "");
        }, 0);
      },
      onDragEnter: (event) => hoverOn(event, id),
      onDragOver: (event) => hoverOn(event, id),
      onDragLeave(event) {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        // Still over the row (a child took the event, and the browser named no related target): not leaving.
        const r = event.currentTarget.getBoundingClientRect();
        if (event.clientX > r.left && event.clientX < r.right && event.clientY > r.top && event.clientY < r.bottom) return;
        // `dragenter` of the next row comes before this `dragleave`: only clear what this row set.
        if (hover.current?.id === id) clearHover();
        clearSpaceHover(`${owner}\n${id}`);
        if (via.current !== id) return;
        via.current = null;
        setDrop(null);
      },
      onDrop(event) {
        const from = drag.current;
        if (from === null) {
          const found = acrossTarget(event, id);
          via.current = null;
          clearHover();
          setDrop(null);
          clearSpaceHover(`${owner}\n${id}`);
          if (found === null || found.to.to === null) return;
          event.preventDefault();
          event.stopPropagation();
          dropAcrossSpaces({ drag: found.drag, to: found.to.to, mode: modeAtDrop(event) });
          return;
        }
        const to = target(event, id);
        event.preventDefault();
        event.stopPropagation();
        reset();
        if (to !== null) opts.current.onDrop(from, to.id, to.zone);
      },
      onDragEnd: reset,
    };
  };

  return { dragging, drop, rowProps };
}

/**
 * A place outside the trees that takes drags from another space (the Private Space header). `resolve` says where a
 * drop would land, as for a tree row; spread `props` on the element. Its light (`data-drop`) is the caller's: it is
 * on whenever the shared hover state lands where this place stands for, also from a row (`useSpaceHoverAt`).
 */
export function useAcrossDropZone(resolve: (drag: SpaceDrag, move: boolean) => AcrossTarget | null): Pick<HTMLAttributes<HTMLElement>, "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop"> {
  const owner = useId();
  const latest = useRef(resolve);
  latest.current = resolve;
  const find = (event: DragEvent<HTMLElement>) => {
    const carried = currentSpaceDrag();
    const to = carried ? latest.current(carried, modeAtDrop(event) === "move") : null;
    return carried && to ? { drag: carried, to } : null;
  };
  const over = (event: DragEvent<HTMLElement>) => {
    const found = find(event);
    if (found === null) return clearSpaceHover(owner);
    setSpaceHover({ owner, x: event.clientX, y: event.clientY, text: found.to.text, to: found.to.to });
    if (found.to.to === null) return; // refused: the pointer shows "no drop"
    event.preventDefault();
    event.dataTransfer.dropEffect = modeAtDrop(event);
  };
  return {
    onDragEnter: over,
    onDragOver: over,
    onDragLeave(event) {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      const r = event.currentTarget.getBoundingClientRect();
      if (event.clientX > r.left && event.clientX < r.right && event.clientY > r.top && event.clientY < r.bottom) return;
      clearSpaceHover(owner);
    },
    onDrop(event) {
      const found = find(event);
      clearSpaceHover(owner);
      if (found === null || found.to.to === null) return;
      event.preventDefault();
      event.stopPropagation();
      dropAcrossSpaces({ drag: found.drag, to: found.to.to, mode: modeAtDrop(event) });
    },
  };
}
