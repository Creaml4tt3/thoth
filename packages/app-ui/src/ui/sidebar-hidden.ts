/**
 * The whole sidebar hidden or shown (Cmd/Ctrl+\, the palette, the Hide button in its brand row, the Show button at the
 * start of the tab bar). Hidden, it is `inert` and `aria-hidden`: out of the tab order and the accessibility tree, not
 * only zero wide; the resizer is not rendered. The shell carries `data-sidebar-hidden` for the layout (shell.css: a
 * short width and fade, none under reduced motion where the duration tokens are 0). Stored by the app: per Private
 * Space on the desktop, in the browser on the web.
 *
 * Focus is never left on something that went away: hiding moves it to the Show button when it was in the sidebar;
 * showing moves it to the Hide button when it was on the Show button (or nowhere).
 *
 * Anything that reveals a row in the sidebar (a breadcrumb's folder, an import's folder) calls `requestShowSidebar()`
 * first; the shell listens with `onShowSidebarRequest`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

const listeners = new Set<() => void>();

export function requestShowSidebar(): void {
  for (const listener of [...listeners]) listener();
}

export function onShowSidebarRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export interface SidebarHidden {
  hidden: boolean;
  setHidden(hidden: boolean): void;
  toggle(): void;
  /** The sidebar element, the Hide button in it and the Show button in the tab bar (for focus). */
  sidebarRef: RefObject<HTMLElement | null>;
  hideRef: RefObject<HTMLButtonElement | null>;
  showRef: RefObject<HTMLButtonElement | null>;
}

export function useSidebarHidden({ initial, save }: { initial(): boolean; save(hidden: boolean): void }): SidebarHidden {
  const [hidden, setState] = useState(initial);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const hideRef = useRef<HTMLButtonElement | null>(null);
  const showRef = useRef<HTMLButtonElement | null>(null);
  /** Where focus goes once the change is on screen. */
  const refocus = useRef<RefObject<HTMLButtonElement | null> | null>(null);
  const latest = useRef(hidden);
  latest.current = hidden;
  const saveRef = useRef(save);
  saveRef.current = save;

  const setHidden = useCallback((next: boolean) => {
    if (next === latest.current) return;
    const active = document.activeElement;
    if (next && active && sidebarRef.current?.contains(active)) refocus.current = showRef;
    else if (!next && (active === null || active === document.body || active === showRef.current)) refocus.current = hideRef;
    latest.current = next;
    setState(next);
    saveRef.current(next);
  }, []);
  const toggle = useCallback(() => setHidden(!latest.current), [setHidden]);

  useLayoutEffect(() => {
    const to = refocus.current;
    refocus.current = null;
    to?.current?.focus();
  }, [hidden]);

  useEffect(() => onShowSidebarRequest(() => setHidden(false)), [setHidden]);

  return { hidden, setHidden, toggle, sidebarRef, hideRef, showRef };
}
