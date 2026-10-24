import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useStrings } from "../strings/index.ts";
import { motionOff } from "../ui/presence.ts";

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
  /** The new-tab shortcut as text, for the button's tooltip. */
  newShortcut?: string;
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

/**
 * Browser-like tabs above the page (WAI-ARIA tabs, manual activation). Left and Right move between tabs and Home
 * and End jump to the ends, with one tab in the Tab order (roving); Enter or Space opens the tab that has focus,
 * Delete closes it. Middle-click and the × on the tab close it with a pointer. The current tab uses the accent tokens `--thoth-tab-active-*`.
 *
 * Motion (shell.css): a tab opened after the bar first showed widens and fades in; a closed tab is kept for a moment as an
 * inert, hidden-from-AT copy that narrows and fades out. Tabs present at the start, and everything under reduced motion, skip it.
 */
export function TabBar({ tabs, active, onActivate, onClose, onNew, newShortcut }: BarProps) {
  const t = useStrings().tabs;
  /** The tab that is in the Tab order: the one last focused, else the current one. */
  const [stop, setStop] = useState(active);
  const refs = useRef(new Map<string, HTMLButtonElement>());
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

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const at = tabs.findIndex((tab) => tab.id === id);
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const handled = () => event.preventDefault();
    switch (event.key) {
      case "ArrowRight":
        handled();
        return focusTab(tabs[(at + (rtl ? -1 : 1) + tabs.length) % tabs.length]?.id);
      case "ArrowLeft":
        handled();
        return focusTab(tabs[(at + (rtl ? 1 : -1) + tabs.length) % tabs.length]?.id);
      case "Home":
        handled();
        return focusTab(tabs[0]?.id);
      case "End":
        handled();
        return focusTab(tabs[tabs.length - 1]?.id);
      case "Delete": {
        handled();
        // Focus moves to the neighbour that stays, so the keyboard is not left on a tab that is gone.
        const next = tabs[at + 1] ?? tabs[at - 1];
        onClose(id);
        if (next) setTimeout(() => focusTab(next.id), 0);
      }
    }
  };

  return (
    <div className="tabstrip">
      <div role="tablist" aria-label={t.list} aria-orientation="horizontal" className="tablist">
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
          return (
            <div key={tab.id} role="none" className="tab" data-selected={selected || undefined} data-enter={fresh.includes(tab.id) || undefined}>
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
                aria-keyshortcuts="Delete"
                tabIndex={tab.id === stop ? 0 : -1}
                className="tab-label"
                title={tab.title ?? tab.label}
                onClick={() => onActivate(tab.id)}
                onKeyDown={(event) => onKeyDown(event, tab.id)}
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
              <span className="tab-close" aria-hidden="true" title={t.close} onClick={() => onClose(tab.id)}>
                <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </span>
            </div>
          );
        })}
      </div>
      <button type="button" className="tab-new" aria-label={t.new} title={newShortcut ? t.newWith(newShortcut) : t.new} onClick={onNew}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
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
