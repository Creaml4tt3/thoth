/**
 * The split view (ADR-0030): a window's panes side by side, each with its own tab bar and its current tab, the
 * separator between them, and the drop zones shown while a tab is dragged. Both clients use it; the shell draws each
 * pane's tab bar (`bar`) and what a tab shows (`content`).
 *
 * - A pane becomes active when something in it gets focus or a pointer press. The active pane's page listens for the
 *   window-wide editor keys (`PaneContext`).
 * - While a tab is dragged: with one pane, the right part of the page area is the "Split right" zone (the right half is
 *   shaded, where the new pane will go); with two, the other pane is the zone, and a release on its tab bar lands where
 *   it was let go. The zones are pointer-only pictures (`aria-hidden`); the tab's menu and the palette do the same.
 * - The separator follows the `SidebarResizer` pattern; the left pane's width is `--thoth-pane-ratio` of the panes, clamped
 *   in CSS so each pane keeps 320px while there is room for both.
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useStrings } from "../strings/index.ts";
import { tip } from "../ui/Tooltip.tsx";
import type { MenuItem } from "../order/ContextMenu.tsx";
import { dropIndex } from "./drag.ts";
import { DEFAULT_RATIO, MAX_PANES } from "./layout.ts";
import type { Tab, TabsState } from "./model.ts";
import { PaneContext } from "./pane.ts";
import { TabPanel, type PaneDrop } from "./TabBar.tsx";
import type { TabsController } from "./useTabs.ts";

/** The narrowest a pane is while the window has room for both. */
export const PANE_MIN = 320;
const STEP = 16;
const BIG_STEP = 64;
const VARIABLE = "--thoth-pane-ratio";

/** What one pane's tab bar needs from the split view. */
export interface PaneParts {
  index: number;
  state: TabsState;
  /** The tab list's name ("Open pages", or each pane's own while there are two). */
  label: string;
  /** All the window's tabs (a tab may leave for a new window while there is another). */
  windowTabs: number;
  paneDrop: PaneDrop;
  /** Split right, or Move to other pane, for the tab's menu. */
  menuItems(id: string): MenuItem[];
}

interface Props {
  tabs: TabsController;
  bar(parts: PaneParts): ReactNode;
  content(tab: Tab): ReactNode;
  /** Shown under the first pane's tab bar (the window's banners). */
  notices?: ReactNode;
}

/** The left pane's share, from a pixel width: kept so each pane has `PANE_MIN` (the middle when there is no room). */
export function clampRatio(left: number, total: number): number {
  if (total <= 0) return DEFAULT_RATIO;
  if (total < PANE_MIN * 2) return 0.5;
  return Math.min(total - PANE_MIN, Math.max(PANE_MIN, left)) / total;
}

/** Focuses the current tab of the pane `index` once it is on screen. */
export function focusPaneTab(index: number): void {
  setTimeout(() => document.querySelector<HTMLElement>(`[data-pane="${index}"] [role="tab"][aria-selected="true"]`)?.focus(), 0);
}

type Shown = { from: number; zone: string | null } | null;

const inside = (r: DOMRect, x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

export function Panes({ tabs, bar, content, notices }: Props) {
  const strings = useStrings();
  const t = strings.tabs;
  const { layout } = tabs;
  const split = layout.panes.length > 1;
  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Shown>(null);
  const [said, setSaid] = useState("");
  const windowTabs = layout.panes.reduce((n, p) => n + p.tabs.length, 0);

  // A tab that changed pane (menu, palette, shortcut, drop): focus follows it, so the keyboard is not left on nothing.
  const { takeMoved } = tabs;
  useEffect(() => {
    const id = takeMoved();
    if (id) setTimeout(() => document.getElementById(`thoth-tab-${id}`)?.focus(), 0);
  }, [layout, takeMoved]);

  const paneEl = (i: number) => root.current?.querySelector<HTMLElement>(`[data-pane="${i}"]`) ?? null;

  /** The zone at (x, y) for a tab dragged from the pane `from`: "split", or "pane:<i>[:<index>]". */
  const zoneAt = (from: number, x: number, y: number): string | null => {
    if (!split) {
      const panel = paneEl(0)?.querySelector<HTMLElement>(".tab-panel");
      const r = panel?.getBoundingClientRect();
      // The right part of the page area: from 60% of its width.
      return r && inside(r, x, y) && x >= r.left + r.width * 0.6 ? "split" : null;
    }
    for (let i = 0; i < layout.panes.length; i++) {
      if (i === from) continue;
      const el = paneEl(i);
      if (!el || !inside(el.getBoundingClientRect(), x, y)) continue;
      const list = el.querySelector<HTMLElement>("[role='tablist']");
      const lr = list?.getBoundingClientRect();
      if (list && lr && y <= lr.bottom) {
        const boxes = [...list.querySelectorAll<HTMLElement>(".tab:not([data-leaving])")].map((b) => b.getBoundingClientRect());
        return `pane:${i}:${dropIndex(boxes, x, getComputedStyle(list).direction === "rtl")}`;
      }
      return `pane:${i}`;
    }
    return null;
  };

  /** The tab's name as its bar gives it (a pinned tab's is its label). */
  const nameOf = (id: string): string => {
    const el = document.getElementById(`thoth-tab-${id}`);
    return el?.getAttribute("aria-label") ?? el?.textContent ?? "";
  };
  const announce = (id: string, right: boolean) => setSaid(t.movedToPane(nameOf(id), right));

  const runSplit = (id: string, from: number) => {
    announce(id, layout.panes.length < MAX_PANES ? true : from === 0);
    tabs.split(id);
  };
  const runMove = (id: string, to: number, index?: number) => {
    announce(id, to > 0);
    tabs.moveToPane(id, to, index);
  };

  const partsFor = (index: number, state: TabsState): PaneParts => ({
    index,
    state,
    label: split ? (index === 0 ? t.listLeft : t.listRight) : t.list,
    windowTabs,
    paneDrop: {
      at: (x, y) => zoneAt(index, x, y),
      label: (zone) => (zone === "split" ? t.dropSplit : t.dropHere),
      show: (dragging, zone) => setShown(dragging ? { from: index, zone } : null),
      drop: (id, zone) => {
        if (zone === "split") return runSplit(id, index);
        const [, pane, at] = zone.split(":");
        runMove(id, Number(pane), at === undefined ? undefined : Number(at));
      },
    },
    menuItems: (id) => {
      // A window's only tab: splitting it leaves a new tab behind (ADR-0030 rule 3).
      return split
        ? [{ id: "other-pane", label: t.moveToOtherPane, onSelect: () => runMove(id, index === 0 ? 1 : 0) }]
        : [{ id: "split", label: t.splitRight, onSelect: () => runSplit(id, index) }];
    },
  });

  return (
    <div ref={root} className="panes" data-split={split ? "" : undefined} style={{ [VARIABLE]: String(layout.ratio) } as CSSProperties}>
      {layout.panes.map((state, index) => {
        const tab = state.tabs.find((x) => x.id === state.active) ?? state.tabs[0]!;
        const active = index === layout.active;
        const target = shown && shown.from !== index ? shown : null;
        return (
          <div
            key={index}
            className="pane"
            data-pane={index}
            data-active-pane={split && active ? "" : undefined}
            onFocus={() => tabs.focusPane(index)}
            onPointerDownCapture={() => tabs.focusPane(index)}
          >
            {bar(partsFor(index, state))}
            {index === 0 && notices}
            <PaneContext value={{ active }}>
              <TabPanel id={tab.id}>
                {content(tab)}
                {index === 0 && shown && !split && (
                  // Where the new pane will go: the right half of the page area, shaded once the pointer is over the zone.
                  // The picture at the pointer says what letting go does; this only shows where.
                  <div className="pane-drop pane-drop-split" aria-hidden="true" data-over={shown.zone === "split" ? "" : undefined} />
                )}
              </TabPanel>
            </PaneContext>
            {target && split && (
              <div className="pane-drop" aria-hidden="true" data-over={target.zone?.startsWith(`pane:${index}`) ? "" : undefined} />
            )}
          </div>
        );
      })}
      {split && <PaneResizer ratio={layout.ratio} panes={root} onChange={tabs.setRatio} />}
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-panes-said="">
        {said}
      </div>
    </div>
  );
}

interface Drag {
  pointerId: number;
  left: number;
  width: number;
  start: number;
  now: number;
  frame: number;
  rtl: boolean;
}

/** The separator between the panes (the WAI-ARIA window splitter), like `SidebarResizer`. Values are percent of the width. */
function PaneResizer({ ratio, panes, onChange }: { ratio: number; panes: React.RefObject<HTMLDivElement | null>; onChange(ratio: number): void }) {
  const t = useStrings().tabs;
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const measure = () => setWidth(panes.current?.getBoundingClientRect().width ?? 0);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [panes]);

  const box = () => panes.current?.getBoundingClientRect() ?? null;
  const bounds = (w: number): [number, number] => (w < PANE_MIN * 2 || w <= 0 ? [0.5, 0.5] : [PANE_MIN / w, 1 - PANE_MIN / w]);
  const [lo, hi] = bounds(width);
  const shownRatio = Math.min(hi, Math.max(lo, ratio));
  const pct = (r: number) => Math.round(r * 100);

  const paint = (value: number) => {
    panes.current?.style.setProperty(VARIABLE, String(value));
    handle.current?.setAttribute("aria-valuenow", String(pct(value)));
  };

  const finish = (commit: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    panes.current?.removeAttribute("data-resizing");
    try {
      handle.current?.releasePointerCapture?.(d.pointerId);
    } catch {
      // the pointer is already gone
    }
    if (commit && d.now !== d.start) {
      paint(d.now);
      onChange(d.now);
    } else paint(d.start);
  };
  useEffect(() => () => finish(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const r = box();
    if (event.button !== 0 || !r || !panes.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // still drags while the pointer stays over the handle
    }
    drag.current = { pointerId: event.pointerId, left: r.left, width: r.width, start: shownRatio, now: shownRatio, frame: 0, rtl: getComputedStyle(panes.current).direction === "rtl" };
    panes.current.setAttribute("data-resizing", "");
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.pointerId) return;
    const x = event.clientX - d.left;
    d.now = clampRatio(d.rtl ? d.width - x : x, d.width);
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
    const r = box();
    const w = r?.width ?? width;
    const rtl = panes.current ? getComputedStyle(panes.current).direction === "rtl" : false;
    const step = (event.shiftKey ? BIG_STEP : STEP) / (w || 1);
    const [min, max] = bounds(w);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = shownRatio + (rtl ? -step : step);
    else if (event.key === "ArrowLeft") next = shownRatio + (rtl ? step : -step);
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "Enter") next = DEFAULT_RATIO;
    if (next === null) return;
    event.preventDefault();
    onChange(Math.min(max, Math.max(min, next)));
  };

  return (
    <div
      ref={handle}
      className="pane-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t.resizePanes}
      aria-valuenow={pct(shownRatio)}
      aria-valuemin={pct(lo)}
      aria-valuemax={pct(hi)}
      aria-valuetext={`${pct(shownRatio)}%`}
      tabIndex={0}
      {...tip(t.resizePanesHint)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(true)}
      onDoubleClick={() => onChange(DEFAULT_RATIO)}
      onKeyDown={onKeyDown}
    />
  );
}
