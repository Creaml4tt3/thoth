/**
 * The starred pages (ADR-0027), as the Favorites section shows them: Private Space pages first, then each workspace's,
 * each row with a small hint of its space ("Local", the workspace's name) when the list has more than one space.
 *
 * - A click opens the page in the current tab; Cmd/Ctrl+click, a middle-click and Cmd/Ctrl+Enter open a new tab.
 * - Up and Down move between rows, Home and End to the ends.
 * - Favorites are reordered among those of the same space: Alt/Option+Shift+Up/Down, the row's menu (right click, the
 *   Menu key, Shift+F10: Open in new tab, Move up, Move down, Remove from Favorites), or a pointer drag with a live
 *   preview that stops at the edge of its space (`order/list-drag.ts`). Every move is announced.
 * - A favorite that cannot be checked right now (its server signed out, its workspace not loaded) stays, muted, with
 *   "Not available right now" as its hint; opening it shows why.
 */
import { useContext, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { HintContext } from "../keyboard/hints.ts";
import { currentPlatform, formatChordShort } from "../keyboard/shortcuts.ts";
import { ContextMenu, type MenuItem } from "../order/ContextMenu.tsx";
import { PageIcon } from "../order/icons.tsx";
import { useListDrag } from "../order/list-drag.ts";
import { useStrings } from "../strings/index.ts";
import { clickOpens, isMiddleClick, isOpenInNewTabKey } from "../tabs/open-keys.ts";
import { motionOff } from "../ui/presence.ts";
import { tipIfClipped } from "../ui/Tooltip.tsx";

export interface FavoriteItem {
  /** Unique in the list. */
  key: string;
  /** The space it belongs to: favorites move only among those of the same group. */
  group: string;
  title: string;
  /** Which space it is in ("Local", a workspace's name), shown when there is more than one group. */
  hint?: string;
  /** Can't be checked now (signed out, still loading). */
  unavailable?: boolean;
  /** The page of the current tab. */
  current?: boolean;
  /** A longer name for the tooltip (the file's path). */
  detail?: string;
}

interface Props {
  items: readonly FavoriteItem[];
  onOpen(key: string, options: { newTab: boolean }): void;
  /** Moves `key` to index `to` among the favorites of its group. */
  onMove(key: string, to: number): void;
  onRemove(key: string): void;
  /** The element that scrolls while a row is dragged near its edge (the sidebar's list). */
  scroller?(): HTMLElement | null;
}

const KEYS = "Alt+Shift+ArrowUp Alt+Shift+ArrowDown Control+Enter Meta+Enter Shift+F10";

export function FavoritesList({ items, onOpen, onMove, onRemove, scroller }: Props) {
  const t = useStrings().favorites;
  const platform = useContext(HintContext)?.platform ?? currentPlatform();
  const newTabKeys = formatChordShort({ key: "Enter", mod: true }, platform);
  const host = useRef<HTMLUListElement>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const flip = useRef<Map<string, number> | null>(null);
  const [said, setSaid] = useState("");
  const [menu, setMenu] = useState<{ key: string; at: { x: number; y: number } } | null>(null);
  const order = items.map((i) => i.key);
  const groups = new Set(items.map((i) => i.group));
  const showHints = groups.size > 1;

  /** The first and last index of `key`'s group in the whole list. */
  const bounds = (key: string): readonly [number, number] => {
    const group = items.find((i) => i.key === key)?.group;
    const first = items.findIndex((i) => i.group === group);
    let last = first;
    while (items[last + 1]?.group === group) last++;
    return [first, last];
  };
  const titleOf = (key: string) => items.find((i) => i.key === key)?.title ?? "";

  /** Moves `key` to index `to` of the whole list (kept within its group); says where it went. */
  const move = (key: string, to: number): boolean => {
    const [first, last] = bounds(key);
    const at = Math.max(first, Math.min(to, last));
    if (at === order.indexOf(key)) return false;
    onMove(key, at - first);
    setSaid(t.moved(titleOf(key), at - first + 1, last - first + 1));
    return true;
  };

  const button = (key: string) => rows.current.get(key)?.querySelector<HTMLButtonElement>(".fav-item") ?? null;
  const focusSoon = (key: string) => setTimeout(() => button(key)?.focus(), 0);

  const rememberPlaces = () => {
    if (motionOff()) return;
    flip.current = new Map([...rows.current].map(([key, el]) => [key, el.getBoundingClientRect().top]));
  };
  useLayoutEffect(() => {
    const first = flip.current;
    flip.current = null;
    if (!first) return;
    for (const [key, el] of rows.current) {
      const was = first.get(key);
      const dy = was === undefined ? 0 : was - el.getBoundingClientRect().top;
      if (Math.abs(dy) >= 0.5) el.animate?.([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], { duration: 140, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    }
  });

  const { drag, onPointerDown, swallowClick } = useListDrag({
    order,
    scroller: () => scroller?.() ?? host.current,
    item: (key) => rows.current.get(key) ?? null,
    bounds,
    onMove: (key, to) => void move(key, to),
    onEnd: rememberPlaces,
  });

  const menuItems = (key: string): MenuItem[] => {
    const at = order.indexOf(key);
    const [first, last] = bounds(key);
    return [
      { id: "open-tab", label: t.openNewTab, hint: newTabKeys, onSelect: () => onOpen(key, { newTab: true }) },
      { id: "up", label: t.moveUp, hint: "⌥⇧↑", disabled: at <= first, onSelect: () => (move(key, at - 1), focusSoon(key)) },
      { id: "down", label: t.moveDown, hint: "⌥⇧↓", disabled: at >= last, onSelect: () => (move(key, at + 1), focusSoon(key)) },
      { id: "remove", label: t.remove, onSelect: () => onRemove(key) },
    ];
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    const at = order.indexOf(key);
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      event.stopPropagation();
      if (move(key, at + (event.key === "ArrowDown" ? 1 : -1))) focusSoon(key);
      return;
    }
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      const r = event.currentTarget.getBoundingClientRect();
      setMenu({ key, at: { x: r.left + 16, y: r.bottom } });
      return;
    }
    if (isOpenInNewTabKey(event)) {
      event.preventDefault();
      onOpen(key, { newTab: true });
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const to = event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? order.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    button(order[Math.max(0, Math.min(to, order.length - 1))]!)?.focus();
  };

  return (
    <>
      <ul ref={host} className="fav-list" aria-label={t.list} data-fav-dragging={drag ? "" : undefined}>
        {items.map((item) => {
          const shift = drag?.shifts[item.key];
          return (
            <li
              key={item.key}
              ref={(el) => {
                if (el) rows.current.set(item.key, el);
                else rows.current.delete(item.key);
              }}
              className="fav-row"
              data-dragging={drag?.id === item.key ? "" : undefined}
              style={shift === undefined ? undefined : { transform: `translateY(${shift}px)` }}
              onPointerDown={(event) => onPointerDown(event, item.key)}
            >
              <button
                type="button"
                className="tree-item fav-item"
                data-unavailable={item.unavailable || undefined}
                aria-current={item.current ? "page" : undefined}
                aria-keyshortcuts={KEYS}
                {...(item.unavailable ? { "aria-description": t.unavailable } : {})}
                {...(item.detail ? { title: item.detail } : {})}
                {...tipIfClipped(item.title)}
                onClick={(event: MouseEvent) => {
                  if (swallowClick.current) return;
                  onOpen(item.key, { newTab: clickOpens(event)?.newTab === true });
                }}
                onMouseDown={(event) => {
                  if (event.button === 1) event.preventDefault();
                }}
                onAuxClick={(event) => {
                  if (!isMiddleClick(event)) return;
                  event.preventDefault();
                  onOpen(item.key, { newTab: true });
                }}
                onKeyDown={(event) => onKeyDown(event, item.key)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ key: item.key, at: { x: event.clientX, y: event.clientY } });
                }}
              >
                <PageIcon />
                <span className="tree-label">{item.title}</span>
                {(showHints || item.unavailable) && <span className="fav-hint">{item.unavailable ? t.unavailable : item.hint}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-favorites-said="">
        {said}
      </div>
      {menu && order.includes(menu.key) && (
        <ContextMenu
          label={t.menu(titleOf(menu.key))}
          at={menu.at}
          items={menuItems(menu.key)}
          onClose={(restore) => {
            const { key } = menu;
            setMenu(null);
            if (restore) button(key)?.focus();
          }}
        />
      )}
    </>
  );
}
