/**
 * The Board (ADR-0056): pages as sticky notes, links as string between them, on a paper desk that pans and zooms.
 *
 * - Notes are real buttons on one plane `div` moved by `transform: translate() scale()`; strings are one SVG of quadratic
 *   paths under them. A note's `x`/`y` is its top-left corner in board units (JSON Canvas's convention); the Overview's
 *   centres are only shifted by half a note, which nothing on the board can see.
 * - Click selects (its strings turn Moon), double-click or Enter opens, Cmd/Ctrl+click opens a new tab, a click on a faded
 *   suggestion pins it. Drag a note to move it (it lifts, then wobbles once unless reduced motion is on); arrow keys move
 *   the selected one 8 px (Shift: 40). Without `actions.move` (the Overview) a move lasts for the session only.
 * - Drag the paper or scroll to pan; Ctrl/Cmd+scroll or pinch zooms around the pointer; + / - / 0 on the board.
 * - Below 40 % the notes are coloured squares in one SVG and no note is a button; above it only notes in view are.
 *   The List view shows every note and its links as a plain list, so keyboard and screen-reader users always reach them.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ContextMenu, type MenuItem } from "../order/ContextMenu.tsx";
import { useStrings } from "../strings/index.ts";
import type { OpenOptions } from "../tabs/model.ts";
import { clickOpens } from "../tabs/open-keys.ts";
import { motionOff } from "../ui/presence.ts";
import { tip } from "../ui/Tooltip.tsx";
import type { BoardNote, BoardString } from "./model.ts";

export interface BoardActions {
  open(path: string, options?: OpenOptions): void;
  /** Absent in the Overview: its positions are not saved. */
  move?(path: string, x: number, y: number): void;
  pin?(path: string): void;
  unpin?(path: string): void;
  /** Task 7: drawing string between two notes adds a link. */
  drawLink?(from: string, to: string): Promise<"linked" | "changed" | "gone">;
  /** Shows the page in the sidebar tree. */
  reveal?(path: string): void;
  undo?(): void;
  redo?(): void;
}

export const NOTE_W = 160;
export const NOTE_H = 120;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;
const STEP = 1.25;
const SQUARES_BELOW = 0.4;
const DRAG_PX = 4;
const WOBBLE_MS = 300;
const FIT_PAD = 48;
/** jsdom and a region not laid out yet measure 0×0. */
const FALLBACK = { w: 1200, h: 800 };

type View = { x: number; y: number; z: number };
type Point = { x: number; y: number };

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Zoom to `z` keeping the board point under the screen point (px, py) where it is. */
function zoomAt(v: View, z: number, px: number, py: number): View {
  const nz = clampZoom(z);
  return { z: nz, x: px - ((px - v.x) * nz) / v.z, y: py - ((py - v.y) * nz) / v.z };
}

/** Every note in view, never above 100 %. */
function fit(points: readonly Point[], w: number, h: number): View {
  if (!points.length) return { x: 0, y: 0, z: 1 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  const [bw, bh] = [Math.max(...xs) + NOTE_W - x0, Math.max(...ys) + NOTE_H - y0];
  const z = clampZoom(Math.min(1, (w - 2 * FIT_PAD) / bw, (h - 2 * FIT_PAD) / bh));
  return { z, x: (w - bw * z) / 2 - x0 * z, y: (h - bh * z) / 2 - y0 * z };
}

/** Fitted when every note is still readable; otherwise 100 % at the notes' top-left, so the first note in Tab order shows. */
function opening(points: readonly Point[], w: number, h: number): View {
  const fitted = fit(points, w, h);
  if (fitted.z >= SQUARES_BELOW) return fitted;
  return { z: 1, x: FIT_PAD - Math.min(...points.map((p) => p.x)), y: FIT_PAD - Math.min(...points.map((p) => p.y)) };
}

/** A string from centre to centre, sagging a little under its own weight. */
function stringPath(a: Point, b: Point): string {
  const [ax, ay, bx, by] = [a.x + NOTE_W / 2, a.y + NOTE_H / 2, b.x + NOTE_W / 2, b.y + NOTE_H / 2];
  const sag = Math.min(60, Math.hypot(bx - ax, by - ay) * 0.12);
  return `M${ax} ${ay}Q${(ax + bx) / 2} ${(ay + by) / 2 + sag} ${bx} ${by}`;
}

const isMenuKey = (e: KeyboardEvent) => e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey);

/** Follows a pointer on the window from a pointerdown until it is released. */
function track(start: ReactPointerEvent, onMove: (dx: number, dy: number) => void, onUp: (moved: boolean) => void) {
  let moved = false;
  const move = (e: PointerEvent) => {
    const [dx, dy] = [e.clientX - start.clientX, e.clientY - start.clientY];
    if (!moved && Math.hypot(dx, dy) < DRAG_PX) return;
    moved = true;
    onMove(dx, dy);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    onUp(moved);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

export function BoardView({ label, notes, strings, actions }: { label: string; notes: BoardNote[]; strings: BoardString[]; actions: BoardActions }) {
  const t = useStrings().board;
  const help = useId();
  const region = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(FALLBACK);
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [list, setList] = useState(false);
  const [menu, setMenu] = useState<{ path: string; at: Point } | null>(null);
  // Session positions: a move shows at once; it gives way when the note's own position changes (saved, undone, re-laid out).
  const [moved, setMoved] = useState<ReadonlyMap<string, Point & { from: Point }>>(new Map());
  const [drag, setDrag] = useState<{ path: string } & Point | null>(null);
  const [wobble, setWobble] = useState<string | null>(null);
  const dragged = useRef(false);
  const wobbleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const at = (n: BoardNote): Point => {
    if (drag?.path === n.path) return drag;
    const m = moved.get(n.path);
    return m && m.from.x === n.x && m.from.y === n.y ? m : n;
  };
  const byPath = new Map(notes.map((n) => [n.path, n]));

  // Measure the region; fit the notes once, when it first has a size.
  useLayoutEffect(() => {
    const el = region.current;
    const measure = () => {
      const r = el?.getBoundingClientRect();
      return r && r.width && r.height ? { w: r.width, h: r.height } : FALLBACK;
    };
    const first = measure();
    setSize(first);
    setView(opening(notes.map(at), first.w, first.h));
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setSize(measure()));
    ro.observe(el);
    return () => ro.disconnect();
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => clearTimeout(wobbleTimer.current), []);

  // Zooming out to squares removes the focused note button: keep focus on the board instead of losing it to the page.
  const squares = !list && view.z < SQUARES_BELOW;
  useEffect(() => {
    if (squares && document.activeElement === document.body) region.current?.focus();
  }, [squares]);

  // Wheel needs a non-passive listener so Ctrl/Cmd+scroll zooms the board, not the window.
  useEffect(() => {
    const el = region.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        setView((v) => zoomAt(v, v.z * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top));
      } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [list]);

  const zoomBy = (factor: number | null) => setView((v) => zoomAt(v, factor === null ? 1 : v.z * factor, size.w / 2, size.h / 2));
  const zoomFit = () => setView(fit(notes.map(at), size.w, size.h));

  const place = (path: string, p: Point) => {
    const n = byPath.get(path);
    if (!n) return;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    setMoved((m) => new Map(m).set(path, { x, y, from: { x: n.x, y: n.y } }));
    actions.move?.(path, x, y);
  };

  const focusNote = (path: string) => {
    for (const el of region.current?.querySelectorAll<HTMLElement>("[data-path]") ?? []) if (el.dataset.path === path) el.focus();
  };

  const onRegionKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      (e.shiftKey ? actions.redo : actions.undo)?.();
      return;
    }
    if (mod || e.altKey) return;
    if (e.key === "Escape" && selected !== null) setSelected(null);
    else if (e.key === "+" || e.key === "=") zoomBy(STEP);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / STEP);
    else if (e.key === "0") zoomBy(null);
    else return;
    e.preventDefault();
  };

  const onPaperDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const start = view;
    track(e, (dx, dy) => setView({ ...start, x: start.x + dx, y: start.y + dy }), (moved) => moved || setSelected(null));
  };

  const onNoteDown = (e: ReactPointerEvent<HTMLButtonElement>, n: BoardNote) => {
    e.stopPropagation();
    dragged.current = false;
    if (e.button !== 0) return;
    const from = at(n);
    const z = view.z;
    let last = from;
    track(
      e,
      (dx, dy) => {
        last = { x: from.x + dx / z, y: from.y + dy / z };
        setDrag({ path: n.path, ...last });
      },
      (wasMoved) => {
        if (!wasMoved) return;
        dragged.current = true;
        setDrag(null);
        place(n.path, last);
        if (motionOff()) return;
        clearTimeout(wobbleTimer.current);
        setWobble(n.path);
        wobbleTimer.current = setTimeout(() => setWobble(null), WOBBLE_MS);
      },
    );
  };

  const onNoteClick = (e: MouseEvent, n: BoardNote) => {
    if (dragged.current) return void (dragged.current = false);
    const newTab = clickOpens(e);
    if (newTab) return void (n.state !== "missing" && actions.open(n.path, newTab));
    if (n.state === "suggested" && actions.pin) actions.pin(n.path);
    setSelected(n.path);
  };

  const onNoteKeyDown = (e: KeyboardEvent<HTMLButtonElement>, n: BoardNote) => {
    if (isMenuKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      setSelected(n.path);
      setMenu({ path: n.path, at: { x: r.left + 16, y: r.bottom } });
      return;
    }
    if (e.key === "Enter" && !e.altKey && !e.shiftKey) {
      e.preventDefault(); // not a click: Enter opens, Space selects
      if (n.state !== "missing") actions.open(n.path, ...(e.metaKey || e.ctrlKey ? [{ newTab: true }] : []));
      return;
    }
    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!arrow || selected !== n.path || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const step = e.shiftKey ? 40 : 8;
    const p = at(n);
    place(n.path, { x: p.x + arrow[0]! * step, y: p.y + arrow[1]! * step });
  };

  const menuItems = (n: BoardNote): MenuItem[] => {
    const gone = n.state === "missing";
    const items: MenuItem[] = [
      { id: "open", label: t.open, disabled: gone, onSelect: () => actions.open(n.path) },
      { id: "open-tab", label: t.openNewTab, disabled: gone, onSelect: () => actions.open(n.path, { newTab: true }) },
    ];
    // Task 7 adds "Link to…" here.
    const { unpin, reveal } = actions;
    if (unpin && (n.state === "pinned" || gone)) items.push({ id: "unpin", label: t.unpin, separator: true, onSelect: () => unpin(n.path) });
    if (reveal && !gone) items.push({ id: "reveal", label: t.reveal, onSelect: () => reveal(n.path) });
    return items;
  };

  // Reading order: top to bottom, then left to right.
  const ordered = [...notes].sort((a, b) => at(a).y - at(b).y || at(a).x - at(b).x);
  const linked = (path: string) => strings.flatMap((s) => (s.from === path ? [s.to] : s.to === path ? [s.from] : []));

  const toolbar = (
    <div className="board-toolbar">
      {!list && (
        <div className="board-zoom-group" role="group" aria-label={t.zoom}>
          <button type="button" className="board-tool" aria-label={t.zoomOut} {...tip(t.zoomOut, "−")} disabled={view.z <= MIN_ZOOM} onClick={() => zoomBy(1 / STEP)}>
            −
          </button>
          <span className="board-zoom">{t.zoomPercent(Math.round(view.z * 100))}</span>
          <button type="button" className="board-tool" aria-label={t.zoomIn} {...tip(t.zoomIn, "+")} disabled={view.z >= MAX_ZOOM} onClick={() => zoomBy(STEP)}>
            +
          </button>
          <button type="button" className="board-tool" onClick={zoomFit}>{t.zoomFit}</button>
        </div>
      )}
      <button type="button" className="board-tool" aria-pressed={list} onClick={() => setList(!list)}>
        {t.listView}
      </button>
    </div>
  );

  if (list) {
    return (
      <div className="board">
        {toolbar}
        <ul className="board-list" aria-label={label}>
          {ordered.map((n) => {
            const links = linked(n.path).map((p) => byPath.get(p)?.title ?? p);
            return (
              <li key={n.path}>
                <button type="button" className="board-list-open" disabled={n.state === "missing"} onClick={(e) => actions.open(n.path, ...(clickOpens(e) ? [{ newTab: true }] : []))}>
                  {n.title}
                </button>
                {n.state === "missing" && <span className="board-list-state"> {t.missing}</span>}
                {links.length > 0 && (
                  <ul aria-label={t.linksOf(n.title)}>
                    {links.map((title, i) => <li key={i}>{title}</li>)}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  // Notes in view, with a margin of one note so a pan does not show them popping in.
  const [vx0, vy0] = [-view.x / view.z - NOTE_W, -view.y / view.z - NOTE_H];
  const [vx1, vy1] = [(size.w - view.x) / view.z + NOTE_W, (size.h - view.y) / view.z + NOTE_H];
  const inView = (p: Point) => p.x + NOTE_W >= vx0 && p.x <= vx1 && p.y + NOTE_H >= vy0 && p.y <= vy1;
  const paper = (n: BoardNote) => `var(--thoth-note-${n.color ?? "cream"}, var(--thoth-note-cream))`;
  const menuNote = menu && byPath.get(menu.path);

  return (
    <div className="board">
      {toolbar}
      <div
        ref={region}
        className="board-paper"
        role="application"
        aria-label={label}
        aria-describedby={help}
        tabIndex={0}
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * view.z}px ${24 * view.z}px` }}
        onKeyDown={onRegionKeyDown}
        onPointerDown={onPaperDown}
      >
        <p id={help} className="sr-only">{t.instructions}</p>
        <div className="board-plane" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          <svg className="board-strings" aria-hidden="true" width="1" height="1">
            {strings.map((s) => {
              const a = byPath.get(s.from);
              const b = byPath.get(s.to);
              if (!a || !b) return null;
              const active = selected !== null && (s.from === selected || s.to === selected);
              return <path key={`${s.from}\n${s.to}`} d={stringPath(at(a), at(b))} data-from={s.from} data-to={s.to} data-active={active || undefined} />;
            })}
          </svg>
          {squares ? (
            <svg className="board-squares" aria-hidden="true" width="1" height="1">
              {notes.map((n) => {
                const p = at(n);
                return <rect key={n.path} x={p.x} y={p.y} width={NOTE_W} height={NOTE_H} rx={4} style={{ fill: paper(n) }} data-state={n.state} />;
              })}
            </svg>
          ) : (
            ordered.map((n) => {
              const p = at(n);
              if (!inView(p) && n.path !== selected) return null; // the selected note keeps its focus when panned away
              return (
                <button
                  key={n.path}
                  type="button"
                  className="board-note"
                  data-path={n.path}
                  data-state={n.state}
                  data-color={n.color ?? undefined}
                  data-lifted={drag?.path === n.path || undefined}
                  data-wobble={wobble === n.path || undefined}
                  aria-pressed={selected === n.path}
                  aria-label={t.noteLabel(n.title, n.tags, n.links, n.state)}
                  style={{ left: p.x, top: p.y }}
                  onPointerDown={(e) => onNoteDown(e, n)}
                  onClick={(e) => onNoteClick(e, n)}
                  onDoubleClick={() => n.state !== "missing" && actions.open(n.path)}
                  onKeyDown={(e) => onNoteKeyDown(e, n)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSelected(n.path);
                    setMenu({ path: n.path, at: { x: e.clientX, y: e.clientY } });
                  }}
                >
                  <span className="board-pin" aria-hidden="true" />
                  {n.state === "suggested" && <span className="board-plus" aria-hidden="true">+</span>}
                  <span className="board-title">{n.title}</span>
                  {n.state === "missing" ? <span className="board-excerpt">{t.missing}</span> : n.excerpt && <span className="board-excerpt">{n.excerpt}</span>}
                  {n.tags.length > 0 && (
                    <span className="board-tags">
                      {n.tags.slice(0, 3).map((tag) => <span key={tag} className="board-tag">#{tag}</span>)}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
      {menu && menuNote && (
        <ContextMenu
          label={t.menu(menuNote.title)}
          at={menu.at}
          items={menuItems(menuNote)}
          onClose={(restore) => {
            const { path } = menu;
            setMenu(null);
            if (restore) focusNote(path);
          }}
        />
      )}
    </div>
  );
}
