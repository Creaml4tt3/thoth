/**
 * Drag and drop in the page trees (ADR-0016 rule 4). A row can be dropped before another row, after it, or
 * inside it (a folder, or a page that holds pages). The row under the pointer shows where with `data-drop`
 * (the accent-coloured indicator in shell.css). The dragged row id is kept here, because the browser hides
 * the data of a drag until it ends.
 *
 * Dragging is a mouse feature; the keyboard has Alt+Shift+Up/Down and "Move to…" (see `tree-keys.ts`).
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type HTMLAttributes } from "react";

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
}

export interface TreeDnd {
  dragging: string | null;
  drop: DropState | null;
  /** Props for the row element with this id. */
  rowProps(id: string): Pick<HTMLAttributes<HTMLElement>, "onDragStart" | "onDragOver" | "onDragLeave" | "onDrop" | "onDragEnd"> & { draggable?: boolean; "data-drop"?: DropZone | undefined };
}

const HOVER_OPEN_MS = 700;

export function useTreeDnd(options: TreeDndOptions): TreeDnd {
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const opts = useRef(options);
  opts.current = options;
  const drag = useRef<string | null>(null);
  const hover = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  const clearHover = useCallback(() => {
    if (hover.current) clearTimeout(hover.current.timer);
    hover.current = null;
  }, []);
  useEffect(() => clearHover, [clearHover]);

  const reset = useCallback(() => {
    drag.current = null;
    clearHover();
    setDragging(null);
    setDrop(null);
  }, [clearHover]);

  const zoneAt = (event: DragEvent<HTMLElement>, id: string): DropZone | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    const zone = dropZone(event.clientY - rect.top, rect.height, { canContain: opts.current.canContain(id), canOrder: opts.current.canOrder });
    return zone !== null && drag.current !== null && opts.current.canDrop(drag.current, id, zone) ? zone : null;
  };

  const rowProps: TreeDnd["rowProps"] = (id) => {
    if (!options.enabled) return {};
    return {
      draggable: true,
      "data-drop": drop?.id === id ? drop.zone : undefined,
      onDragStart(event) {
        event.stopPropagation();
        drag.current = id;
        setDragging(id);
        event.dataTransfer.effectAllowed = "move";
        // Firefox starts no drag without data.
        event.dataTransfer.setData("text/plain", id);
      },
      onDragOver(event) {
        if (drag.current === null) return;
        const zone = zoneAt(event, id);
        if (zone === null) {
          clearHover();
          setDrop((d) => (d?.id === id ? null : d));
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDrop((d) => (d?.id === id && d.zone === zone ? d : { id, zone }));
        if (zone === "inside" && opts.current.onHoverOpen) {
          if (hover.current?.id !== id) {
            clearHover();
            hover.current = { id, timer: setTimeout(() => opts.current.onHoverOpen?.(id), HOVER_OPEN_MS) };
          }
        } else clearHover();
      },
      onDragLeave(event) {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        clearHover();
        setDrop((d) => (d?.id === id ? null : d));
      },
      onDrop(event) {
        const from = drag.current;
        if (from === null) return;
        const zone = zoneAt(event, id);
        event.preventDefault();
        event.stopPropagation();
        reset();
        if (zone !== null) opts.current.onDrop(from, id, zone);
      },
      onDragEnd: reset,
    };
  };

  return { dragging, drop, rowProps };
}
