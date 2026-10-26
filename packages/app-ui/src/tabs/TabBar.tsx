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
  /** Pinned (ADR-0027): at the start of the bar, compact, with no close button. The pinned tabs come first in `tabs`. */
  pinned?: boolean;
}

/** The first two letters (graphemes, so a Thai vowel or an emoji is not cut in half) of a pinned tab's name. */
export function tabInitials(label: string): string {
  const text = label.trim();
  const Segmenter = (Intl as { Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  const parts = Segmenter ? [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((p) => p.segment) : Array.from(text);
  return parts.slice(0, 2).join("") || "·";
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
  /** Pins or unpins the tab `id` (ADR-0027). Without it the menu offers neither. */
  onPin?(id: string, pinned: boolean): void;
  /** Closes every tab but `id` and the pinned ones ("Close other tabs"). */
  onCloseOthers?(id: string): void;
  /** More items for the tab's menu, after the bar's own (for example Add to Favorites). */
  menuExtras?(id: string): MenuItem[];
  /** Something to say about the tabs from outside the bar (Cmd/Ctrl+W on a pinned tab); a new `seq` says it again. */
  notice?: { text: string; seq: number } | null;
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
 * Order (ADR-0019, amended 2026-10-26): a tab is dragged along the bar to reorder it. It lifts and follows the
 * pointer, and the other tabs slide aside to open the gap where it would land (a live preview, as in a browser). On
 * the desktop, dragged well below the bar or out of the window, the others go back to their places and a picture of it
 * says it opens in a new window. Alt/Option+Shift+Left/Right moves the focused tab, and its menu (right click, the
 * Menu key, Shift+F10) has Move left, Move right, Move to new window and Close. Each move is announced.
 *
 * Motion (shell.css): a tab opened after the bar first showed widens and fades in; a closed tab is kept for a moment as an
 * inert, hidden-from-AT copy that narrows and fades out. While dragging, the others slide (transform only,
 * `--thoth-dur-fast`); when the drag ends, every tab slides from where it was shown to its place (FLIP, once: the
 * others are already there after a drop, so only the dropped tab settles). Tabs present at the start, moves made with
 * the keyboard, and everything under reduced motion (the tabs jump to their places), skip it.
 */
export function TabBar({ tabs, active, onActivate, onClose, onNew, onMove, onDetach, onPin, onCloseOthers, menuExtras, notice }: BarProps) {
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
  /** Where each tab was shown just before a pointer drag ended, so they can slide from there to their places (FLIP). */
  const flip = useRef<Map<string, number> | null>(null);
  /** A tab sent to a new window from the keyboard or the menu: focus goes to the current tab once it has left. */
  const refocus = useRef<string | null>(null);
  useEffect(() => setStop(active), [active]);
  /** A short note under the bar that a pinned tab was not closed (the live region says it for a screen reader). */
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sayPinned = () => {
    setSaid(t.pinnedNoClose);
    setNote(t.pinnedNoClose);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 2500);
  };
  useEffect(() => () => void (noteTimer.current && clearTimeout(noteTimer.current)), []);
  const noticeSeq = notice?.seq;
  useEffect(() => {
    if (noticeSeq === undefined || !notice) return;
    if (notice.text === t.pinnedNoClose) sayPinned();
    else setSaid(notice.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noticeSeq]);

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

  // FLIP: each tab shown somewhere else (moved, or shifted by the drag) starts where it was and slides to where it is now.
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
  });

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
  const pinnedCount = tabs.filter((tab) => tab.pinned).length;
  const isPinned = (id: string) => tabs.some((tab) => tab.id === id && tab.pinned === true);
  /** The indexes a tab may take: among the pinned tabs, or among the others (ADR-0027). */
  const bounds = (id: string): readonly [number, number] => (isPinned(id) ? [0, pinnedCount - 1] : [pinnedCount, tabs.length - 1]);
  /** Closes a tab unless it is pinned; a pinned one says how to close it instead. */
  const closeTab = (id: string): boolean => {
    if (isPinned(id)) {
      sayPinned();
      return false;
    }
    onClose(id);
    return true;
  };
  const pinTab = (id: string, pinned: boolean) => {
    if (!onPin) return;
    onPin(id, pinned);
    setSaid(pinned ? t.pinnedSaid(labelOf(id)) : t.unpinnedSaid(labelOf(id)));
  };

  /** Where every tab is shown now (with the drag's shifts), for the slide once the drag has ended. */
  const rememberPlaces = () => {
    if (motionOff()) return;
    const places = new Map<string, number>();
    for (const [key, el] of boxes.current) places.set(key, el.getBoundingClientRect().left);
    flip.current = places;
  };

  /** Moves a tab and says so. A pointer drop has already remembered where the tabs were shown (`rememberPlaces`). */
  const moveTab = (id: string, to: number) => {
    if (!onMove) return;
    const [lo, hi] = bounds(id);
    const at = Math.max(lo, Math.min(to, hi));
    if (at === order.indexOf(id)) return;
    onMove(id, at);
    setSaid(t.movedTo(labelOf(id), at + 1, tabs.length));
  };

  const detachTab = (id: string, at: { x: number; y: number } | null) => {
    if (!onDetach || tabs.length < 2) return;
    if (at === null) refocus.current = id;
    setSaid(t.movedToWindow(labelOf(id)));
    onDetach(id, at);
  };

  const { drag, onPointerDown, swallowClick } = useTabDrag({
    order,
    list: () => listRef.current,
    tab: (id) => boxes.current.get(id) ?? null,
    canDetach,
    bounds,
    onMove: (id, to) => moveTab(id, to),
    onDetach: (id, at) => detachTab(id, at),
    onEnd: rememberPlaces,
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
      const [lo, hi] = bounds(id);
      if (at + delta < lo || at + delta > hi) return;
      moveTab(id, at + delta);
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
        if (closeTab(id) && next) setTimeout(() => focusTab(next.id), 0);
      }
    }
  };

  const pinKeys = shortcutById("tab.pin");
  const pinChord = pinKeys ? chordsFor(pinKeys, client)[0] : undefined;
  const menuItems = (id: string): MenuItem[] => {
    const at = order.indexOf(id);
    const [lo, hi] = bounds(id);
    const pinned = isPinned(id);
    const hint = (i: number) => (moveChords[i] ? formatChordShort(moveChords[i]!, platform) : undefined);
    const items: MenuItem[] = [];
    if (onPin) {
      const keys = pinChord ? formatChordShort(pinChord, platform) : undefined;
      items.push({ id: "pin", label: pinned ? t.unpin : t.pin, ...(keys ? { hint: keys } : {}), onSelect: () => (pinTab(id, !pinned), focusSoon(id)) });
    }
    if (onMove) {
      const left = hint(0);
      const right = hint(1);
      items.push({ id: "left", label: t.moveLeft, ...(left ? { hint: left } : {}), disabled: at <= lo, onSelect: () => (moveTab(id, at - 1), focusSoon(id)) });
      items.push({ id: "right", label: t.moveRight, ...(right ? { hint: right } : {}), disabled: at >= hi, onSelect: () => (moveTab(id, at + 1), focusSoon(id)) });
    }
    if (onDetach) items.push({ id: "window", label: t.moveToWindow, disabled: tabs.length < 2, onSelect: () => detachTab(id, null) });
    items.push(...(menuExtras?.(id) ?? []));
    // A pinned tab has no Close: unpin it first (ADR-0027).
    if (!pinned) items.push({ id: "close", label: t.close, onSelect: () => onClose(id) });
    if (onCloseOthers) items.push({ id: "others", label: t.closeOthers, disabled: tabs.every((tab) => tab.id === id || tab.pinned), onSelect: () => onCloseOthers(id) });
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
          const pinned = tab.pinned === true;
          const dragged = drag?.id === tab.id ? drag : null;
          const shift = drag?.shifts[tab.id];
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
              data-pinned={pinned ? "" : undefined}
              data-enter={fresh.includes(tab.id) || undefined}
              data-dragging={dragged ? "" : undefined}
              data-detach={dragged?.detach ? "" : undefined}
              style={shift === undefined ? undefined : { transform: `translateX(${shift}px)` }}
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
                {...(pinned ? { "aria-label": t.pinnedName(tab.label), ...tip(tab.label, undefined, tab.title) } : { ...(tab.title ? { title: tab.title } : {}), ...tipIfClipped(tab.label) })}
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
                  closeTab(tab.id);
                }}
              >
                <span className="tab-text">{pinned ? tabInitials(tab.label) : tab.label}</span>
              </button>
              {/* A mouse and touch affordance only: a tablist may own tabs and nothing else, so it is not a button. Delete, Cmd/Ctrl+W and middle-click close for everyone else. A pinned tab has none (ADR-0027). */}
              {!pinned && (
                <span className="tab-close" aria-hidden="true" {...tip(t.close, closeHint?.keys)} onClick={() => onClose(tab.id)}>
                  <Icon name="close" size={12} />
                </span>
              )}
            </div>
          );
        })}
      </div>
      <IconButton icon="plus" label={t.new} shortcut="tab.new" className="tab-new" onClick={onNew} />
      {drag?.detach && (
        // Out of the bar, a picture of the tab follows the pointer and says what letting go will do. The list clips
        // anything outside it, so this is fixed to the window.
        <div className="tab-drag-image" aria-hidden="true" style={{ left: drag.x + 12, top: drag.y + 16 }}>
          <span className="tab-drag-label">{labelOf(drag.id)}</span>
          <span className="tab-drag-hint">{t.releaseForWindow}</span>
        </div>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-tabs-said="">
        {said}
      </div>
      {note && (
        // What the live region says, for the eyes: Cmd/Ctrl+W, Delete or a middle-click left a pinned tab open.
        <div className="tab-note" aria-hidden="true">
          {note}
        </div>
      )}
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
