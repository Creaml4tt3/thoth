import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useStrings } from "../strings/index.ts";

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

/**
 * Browser-like tabs above the page (WAI-ARIA tabs, manual activation). Left and Right move between tabs and Home
 * and End jump to the ends, with one tab in the Tab order (roving); Enter or Space opens the tab that has focus,
 * Delete closes it. Middle-click and the × on the tab close it with a pointer. The current tab uses the accent tokens `--thoth-tab-active-*`.
 */
export function TabBar({ tabs, active, onActivate, onClose, onNew, newShortcut }: BarProps) {
  const t = useStrings().tabs;
  /** The tab that is in the Tab order: the one last focused, else the current one. */
  const [stop, setStop] = useState(active);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => setStop(active), [active]);
  // The current tab scrolls into view when there are more tabs than room.
  useEffect(() => {
    refs.current.get(active)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

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
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <div key={tab.id} role="none" className="tab" data-selected={selected || undefined}>
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
