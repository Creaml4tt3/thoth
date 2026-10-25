import { useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { HintContext, useShortcutHint } from "../keyboard/hints.ts";
import { ariaKeyShortcut, chordsFor, currentPlatform, formatChordShort, shortcutById } from "../keyboard/shortcuts.ts";
import { ContextMenu, type MenuItem } from "../order/ContextMenu.tsx";
import { useStrings } from "../strings/index.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { Icon } from "../ui/Icon.tsx";
import { motionOff } from "../ui/presence.ts";
import { tip, tipIfClipped } from "../ui/Tooltip.tsx";
import { useTabDrag } from "./drag.ts";

/** What the bar shows for one tab. The app names it (page titles are looked up live, never stored). */
export interface TabItem {
  id: string;
  label: string;
  /** A longer name for the tooltip (for example the file path). */
  title?: string;
}

const tabDomId = (id: string) => `thoth-tab-${id}`;
const panelDomId = (id: string) => `thoth-tabpanel-${id}`;

interface BarProps {
  tabs: readonly TabItem[];
  active: string;
  onActivate(id: string): void;
  onClose(id: string): void;
  onNew(): void;
  /** Reorders: the tab `id` to index `to` (ADR-0019). Without it the tabs stay where they are. */
  onMove?(id: string, to: number): void;
  /**
   * Moves the tab `id` to a new window (the desktop, ADR-0019): `at` is the screen point it was let go at, null when
   * it was asked for from the menu. Without it there is no new window (the web client: that is the browser's job).
   */
  onDetach?(id: string, at: { x: number; y: number } | null): void;
}

/** A tab that was closed and is still narrowing away: where it sat (after which tab), what it looked like. */
interface Leaving {
  item: TabItem;
  /** The nearest tab before it that is still open; null when it was first. */
  after: string | null;
  selected: boolean;
}

type Row = ({ ghost: false; item: TabItem } | ({ ghost: true } & Leaving));

/** How long (ms) a closed tab stays in the strip at most, if its animation never reports an end. */
const LEAVE_MS = 400;

/** The motion tokens of the strip, read from its CSS (0 under reduced motion, where the tokens are 0). */
function slideTiming(el: Element): { duration: number; easing: string } {
  const style = getComputedStyle(el);
  const raw = style.getPropertyValue("--thoth-dur-fast").trim();
  const n = Number.parseFloat(raw);
  const duration = raw === "" || Number.isNaN(n) ? 140 : raw.endsWith("ms") ? n : n * 1000;
  return { duration, easing: style.getPropertyValue("--thoth-ease-out").trim() || "cubic-bezier(0.2, 0.8, 0.2, 1)" };
}

/**
 * Browser-like tabs above the page (WAI-ARIA tabs, manual activation). Left and Right move between tabs and Home
 * and End jump to the ends, with one tab in the Tab order (roving); Enter or Space opens the tab that has focus,
 * Delete closes it. Middle-click and the × on the tab close it with a pointer. The current tab uses the accent tokens `--thoth-tab-active-*`.
 *
 * Order (ADR-0019): a tab is dragged along the bar to reorder it, with an accent line where it would land; on the
 * desktop, dragged well below the bar or out of the window, it opens in a new window. While it is dragged it stays in
 * place, faded, and a picture of it follows the pointer (as in the page trees). Alt/Option+Shift+Left/Right moves
 * the focused tab, and its menu (right click, the Menu key, Shift+F10) has Move left, Move right, Move to new window and
 * Close. Each move is announced.
 *
 * Motion (shell.css): a tab opened after the bar first showed widens and fades in; a closed tab is kept for a moment as an
 * inert, hidden-from-AT copy that narrows and fades out. After a drop, the tabs that changed place slide there (transform
 * only, `--thoth-dur-fast`). Tabs present at the start, moves made with the keyboard, and everything under reduced
 * motion, skip it.
 */
export function TabBar({ tabs, active, onActivate, onClose, onNew, onMove, onDetach }: BarProps) {
  const t = useStrings().tabs;
  const closeHint = useShortcutHint("tab.close");
  const hints = useContext(HintContext);
  const platform = hints?.platform ?? currentPlatform();
  const client = hints?.client ?? "desktop";
  /** The tab that is in the Tab order: the one last focused, else the current one. */
  const [stop, setStop] = useState(active);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const boxes = useRef(new Map<string, HTMLDivElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const [said, setSaid] = useState("");
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(null);
  /** Where each tab was just before a pointer drop, so they can slide from there to where they land (FLIP). */
  const flip = useRef<Map<string, number> | null>(null);
  /** A tab sent to a new window from the keyboard or the menu: focus goes to the current tab once it has left. */
  const refocus = useRef<string | null>(null);
  useEffect(() => setStop(active), [active]);

  // What changed since the last render, worked out while rendering (derived state): which tabs are new, which just left.
  const [seen, setSeen] = useState({ tabs, active, fresh: [] as string[], leaving: [] as Leaving[] });
  if (seen.tabs !== tabs) {
    const open = new Set(tabs.map((tab) => tab.id));
    const before = new Set(seen.tabs.map((tab) => tab.id));
    const motion = !motionOff();
    const gone: Leaving[] = motion
      ? seen.tabs.flatMap((item, i) => {
          if (open.has(item.id)) return [];
          const prior = seen.tabs.slice(0, i).reverse().find((tab) => open.has(tab.id));
          return [{ item, after: prior?.id ?? null, selected: item.id === seen.active }];
        })
      : [];
    setSeen({
      tabs,
      active,
      fresh: motion ? [...seen.fresh.filter((id) => open.has(id)), ...tabs.filter((tab) => !before.has(tab.id)).map((tab) => tab.id)] : [],
      leaving: [...seen.leaving.filter((l) => !open.has(l.item.id)), ...gone],
    });
  }
  const { fresh, leaving } = seen;
  const leavingKey = leaving.map((l) => l.item.id).join("\u0000");
  useEffect(() => {
    if (!leavingKey) return;
    const timer = setTimeout(() => setSeen((now) => ({ ...now, leaving: [] })), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leavingKey]);
  // The current tab scrolls into view when there are more tabs than room.
  useEffect(() => {
    refs.current.get(active)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  // FLIP: each tab that changed place starts where it was and slides to where it is now.
  useLayoutEffect(() => {
    const first = flip.current;
    flip.current = null;
    if (!first || !listRef.current) return;
    const timing = slideTiming(listRef.current);
    if (timing.duration <= 0) return;
    for (const tab of tabs) {
      const el = boxes.current.get(tab.id);
      const was = first.get(tab.id);
      if (!el || was === undefined) continue;
      const dx = was - el.getBoundingClientRect().left;
      if (Math.abs(dx) < 0.5) continue;
      el.animate?.([{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }], { duration: timing.duration, easing: timing.easing });
    }
  }, [tabs]);

  // A tab sent away from the keyboard: once it has left, the keyboard is on the current tab, not on nothing.
  useEffect(() => {
    const gone = refocus.current;
    if (!gone || tabs.some((tab) => tab.id === gone)) return;
    refocus.current = null;
    setTimeout(() => focusTab(active), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, active]);

  const order = tabs.map((tab) => tab.id);
  const canDetach = onDetach !== undefined && tabs.length > 1;
  const labelOf = (id: string) => tabs.find((tab) => tab.id === id)?.label ?? "";

  /** Moves a tab and says so. `slide` (a pointer drop) animates the tabs that changed place. */
  const moveTab = (id: string, to: number, slide: boolean) => {
    if (!onMove) return;
    const at = Math.max(0, Math.min(to, tabs.length - 1));
    if (at === order.indexOf(id)) return;
    if (slide && !motionOff()) {
      const places = new Map<string, number>();
      for (const [key, el] of boxes.current) places.set(key, el.getBoundingClientRect().left);
      flip.current = places;
    }
    onMove(id, at);
    setSaid(t.movedTo(labelOf(id), at + 1, tabs.length));
  };

  const detachTab = (id: string, at: { x: number; y: number } | null) => {
    if (!onDetach || tabs.length < 2) return;
    if (at === null) refocus.current = id;
    setSaid(t.movedToWindow(labelOf(id)));
    onDetach(id, at);
  };

  const { drag, drop, onPointerDown, swallowClick } = useTabDrag({
    order,
    list: () => listRef.current,
    tab: (id) => boxes.current.get(id) ?? null,
    canDetach,
    onMove: (id, to) => moveTab(id, to, true),
    onDetach: (id, at) => detachTab(id, at),
  });

  /** Open tabs in order, each closed one still narrowing away where it sat. */
  const rows: Row[] = [
    ...leaving.filter((l) => l.after === null).map((l): Row => ({ ghost: true, ...l })),
    ...tabs.flatMap((tab): Row[] => [{ ghost: false, item: tab }, ...leaving.filter((l) => l.after === tab.id).map((l): Row => ({ ghost: true, ...l }))]),
  ];

  const focusTab = (id: string | undefined) => {
    if (!id) return;
    setStop(id);
    refs.current.get(id)?.focus();
  };
  /** After the bar re-renders: React moving a focused node can drop its focus. */
  const focusSoon = (id: string) => setTimeout(() => focusTab(id), 0);

  const moveKeys = shortcutById("tab.move");
  const moveChords = moveKeys ? chordsFor(moveKeys, client) : [];
  const keyshortcuts = ["Delete", ...(onMove ? moveChords.map((c) => ariaKeyShortcut(c, platform)) : []), "Shift+F10"].join(" ");

  const openMenu = (id: string, at: { x: number; y: number }) => setMenu({ id, at });

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const at = tabs.findIndex((tab) => tab.id === id);
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    // Alt/Option+Shift+Left/Right: move this tab one place (never animated: keys want speed).
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      if (!onMove) return;
      handled();
      const delta = (event.key === "ArrowRight") !== rtl ? 1 : -1;
      if (at + delta < 0 || at + delta >= tabs.length) return;
      moveTab(id, at + delta, false);
      focusSoon(id);
      return;
    }
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey)) {
      handled();
      const r = event.currentTarget.getBoundingClientRect();
      openMenu(id, { x: r.left + 16, y: r.bottom });
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        return focusTab(tabs[(at + (rtl ? -1 : 1) + tabs.length) % tabs.length]?.id);
      case "ArrowLeft":
        event.preventDefault();
        return focusTab(tabs[(at + (rtl ? 1 : -1) + tabs.length) % tabs.length]?.id);
      case "Home":
        event.preventDefault();
        return focusTab(tabs[0]?.id);
      case "End":
        event.preventDefault();
        return focusTab(tabs[tabs.length - 1]?.id);
      case "Delete": {
        event.preventDefault();
        // Focus moves to the neighbour that stays, so the keyboard is not left on a tab that is gone.
        const next = tabs[at + 1] ?? tabs[at - 1];
        onClose(id);
        if (next) setTimeout(() => focusTab(next.id), 0);
      }
    }
  };

  const menuItems = (id: string): MenuItem[] => {
    const at = order.indexOf(id);
    const hint = (i: number) => (moveChords[i] ? formatChordShort(moveChords[i]!, platform) : undefined);
    const items: MenuItem[] = [];
    if (onMove) {
      const left = hint(0);
      const right = hint(1);
      items.push({ id: "left", label: t.moveLeft, ...(left ? { hint: left } : {}), disabled: at <= 0, onSelect: () => (moveTab(id, at - 1, false), focusSoon(id)) });
      items.push({ id: "right", label: t.moveRight, ...(right ? { hint: right } : {}), disabled: at >= tabs.length - 1, onSelect: () => (moveTab(id, at + 1, false), focusSoon(id)) });
    }
    if (onDetach) items.push({ id: "window", label: t.moveToWindow, disabled: tabs.length < 2, onSelect: () => detachTab(id, null) });
    items.push({ id: "close", label: t.close, onSelect: () => onClose(id) });
    return items;
  };

  return (
    <div className="tabstrip" data-tab-dragging={drag ? "" : undefined}>
      <div ref={listRef} role="tablist" aria-label={t.list} aria-orientation="horizontal" className="tablist">
        {rows.map((row) => {
          if (row.ghost) {
            // A tab on its way out: only a picture of it. Nothing in it can be focused or announced.
            return (
              <div key={`leaving-${row.item.id}`} role="none" className="tab" data-selected={row.selected || undefined} data-leaving="" inert aria-hidden="true">
                <span className="tab-label">
                  <span className="tab-text">{row.item.label}</span>
                </span>
              </div>
            );
          }
          const tab = row.item;
          const selected = tab.id === active;
          const dragged = drag?.id === tab.id ? drag : null;
          return (
            <div
              key={tab.id}
              ref={(el) => {
                if (el) boxes.current.set(tab.id, el);
                else boxes.current.delete(tab.id);
              }}
              role="none"
              className="tab"
              data-selected={selected || undefined}
              data-enter={fresh.includes(tab.id) || undefined}
              data-dragging={dragged ? "" : undefined}
              data-detach={dragged?.detach ? "" : undefined}
              data-drop={drop?.id === tab.id ? drop.side : undefined}
              {...(onMove ? { onPointerDown: (event: PointerEvent<HTMLDivElement>) => onPointerDown(event, tab.id) } : {})}
            >
              <button
                ref={(el) => {
                  if (el) refs.current.set(tab.id, el);
                  else refs.current.delete(tab.id);
                }}
                type="button"
                role="tab"
                id={tabDomId(tab.id)}
                aria-selected={selected}
                aria-controls={panelDomId(tab.id)}
                aria-keyshortcuts={keyshortcuts}
                tabIndex={tab.id === stop ? 0 : -1}
                className="tab-label"
                {...(tab.title ? { title: tab.title } : {})}
                {...tipIfClipped(tab.label)}
                onClick={() => {
                  if (swallowClick.current) return;
                  onActivate(tab.id);
                }}
                onKeyDown={(event) => onKeyDown(event, tab.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openMenu(tab.id, { x: event.clientX, y: event.clientY });
                }}
                onMouseDown={(event: MouseEvent) => {
                  if (event.button === 1) event.preventDefault(); // no auto-scroll cursor
                }}
                onAuxClick={(event: MouseEvent) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  onClose(tab.id);
                }}
              >
                <span className="tab-text">{tab.label}</span>
              </button>
              {/* A mouse and touch affordance only: a tablist may own tabs and nothing else, so it is not a button. Delete, Cmd/Ctrl+W and middle-click close for everyone else. */}
              <span className="tab-close" aria-hidden="true" {...tip(t.close, closeHint?.keys)} onClick={() => onClose(tab.id)}>
                <Icon name="close" size={12} />
              </span>
            </div>
          );
        })}
      </div>
      <IconButton icon="plus" label={t.new} shortcut="tab.new" className="tab-new" onClick={onNew} />
      {drag && (
        // A picture of the tab follows the pointer, below it so the line stays in sight; out of the bar it says what
        // letting go will do. The list clips anything outside it, so this is fixed to the window.
        <div className="tab-drag-image" aria-hidden="true" style={{ left: drag.x + 12, top: drag.y + 16 }}>
          <span className="tab-drag-label">{labelOf(drag.id)}</span>
          {drag.detach && <span className="tab-drag-hint">{t.releaseForWindow}</span>}
        </div>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-tabs-said="">
        {said}
      </div>
      {menu && (
        <ContextMenu
          label={t.menu(labelOf(menu.id))}
          at={menu.at}
          items={menuItems(menu.id)}
          onClose={(restore) => {
            const id = menu.id;
            setMenu(null);
            if (restore) focusTab(id);
          }}
        />
      )}
    </div>
  );
}

/** The content of the current tab. Labelled by its tab, so a screen reader announces both together. */
export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={panelDomId(id)} aria-labelledby={tabDomId(id)} className="tab-panel">
      {children}
    </div>
  );
}
