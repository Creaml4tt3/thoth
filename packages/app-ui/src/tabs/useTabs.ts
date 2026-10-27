import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as L from "./layout.ts";
import type { Layout } from "./layout.ts";
import type { OpenOptions, Tab, TabTarget, TabsState } from "./model.ts";

export interface TabsController {
  /** The window's panes (ADR-0030). */
  layout: Layout;
  /** The tabs of the active pane. */
  state: TabsState;
  /** The current tab of the active pane. */
  active: Tab;
  /** Opens a target in the current tab of the active pane, or in a new one (`newTab`). Home and Settings: wherever they are. */
  open(target: TabTarget, options?: OpenOptions): void;
  /** Goes to the tab that shows `target` in either pane, else opens it in a new tab (a notification about a page). */
  openOrFocus(target: TabTarget): void;
  newTab(): void;
  /** Closes a tab (the current one by default). A pinned tab is not closed (ADR-0027). A pane's last tab closes the pane. */
  close(id?: string): void;
  /** Closes every tab of its pane but `id` (the current one by default) and the pinned ones; `id` becomes current. */
  closeOthers(id?: string): void;
  /** Pins or unpins the tab `id` (the current one by default). The current tab does not change. */
  setPinned(pinned: boolean, id?: string): void;
  /** The tab `id` becomes current, and its pane active. */
  activate(id: string): void;
  /** The next (1) or previous (-1) tab of the active pane. */
  step(delta: number): void;
  /** The n-th tab (1–9) of the active pane. */
  jump(n: number): void;
  /** Closes background tabs whose target is gone. */
  prune(gone: (target: TabTarget) => boolean): void;
  /** A page or folder moved or was renamed: every tab on it (or on a page under it) follows. */
  remapPaths(from: string, to: string): void;
  /** Puts the tab `id` at index `to` of its pane (a drag in the tab bar). The current tab does not change. */
  move(id: string, to: number): void;
  /** Moves the tab `id` (the current one by default) one place left (-1) or right (1); nothing at the ends. */
  moveBy(delta: -1 | 1, id?: string): void;
  /** "Split right" (the current tab by default): into a new right pane, or with two panes to the other one. */
  split(id?: string): void;
  /** Moves the tab `id` to the pane `pane` (at `index`, else after its current tab). */
  moveToPane(id: string, pane: number, index?: number): void;
  focusPane(pane: number): void;
  /** The other pane becomes active (nothing with one pane). */
  focusOther(): void;
  /** The left pane's share of the width. */
  setRatio(ratio: number): void;
  /** The tab that last changed pane (split, moved), once: the split view moves focus to it. */
  takeMoved(): string | null;
  /**
   * Moves the tab `id` to another window (ADR-0019). Its pending edits are written first when it is on screen; then
   * `send` gets the new window's tabs, and only when it reports success does the tab leave this window.
   * False when the tab cannot leave (the window's only tab), the edit could not be written, or `send` failed.
   */
  detach(id: string, send: (moved: TabsState) => Promise<boolean>): Promise<boolean>;
}

interface Options {
  /** The starting layout, read once (restored from storage). */
  initial(): Layout;
  /**
   * Writes the pending edits of the pages on screen. False means "stay here" (a conflict or an error needs the
   * user), and the tabs are not changed. Every change of what a pane shows goes through it, so a switch never loses an edit.
   */
  flush(): Promise<boolean>;
  /** Called with each new layout, to store it. */
  save?(layout: Layout): void;
}

/** True when the tab `id` is on screen: the current tab of its pane. */
const shown = (layout: Layout, id: string): boolean => layout.panes.some((p) => p.active === id);

/** The tabs of one window. Changes that take a page off the screen write its pending edits first. */
export function useTabs({ initial, flush, save }: Options): TabsController {
  const [layout, setLayout] = useState<Layout>(initial);
  const latest = useRef(layout);
  latest.current = layout;
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const saveRef = useRef(save);
  saveRef.current = save;
  const moved = useRef<string | null>(null);

  useEffect(() => saveRef.current?.(layout), [layout]);

  /** Applies `change` after the pages on screen have been saved; `change` sees the layout as it is by then. */
  const guarded = useCallback((change: (l: Layout) => Layout) => {
    void flushRef.current().then((ok) => ok && setLayout(change));
  }, []);

  // These only ever read the layout they are given, so their identity never changes: an effect that lists them as a
  // dependency (the shell prunes when the page list changes) must not re-run because a tab changed.
  const prune = useCallback((gone: (target: TabTarget) => boolean) => setLayout((l) => L.prune(l, gone)), []);
  const remapPaths = useCallback((from: string, to: string) => setLayout((l) => L.remapPaths(l, from, to)), []);

  return useMemo<TabsController>(() => {
    const state = L.activePane(layout);
    const current = () => L.activePane(latest.current).active;
    return {
      layout,
      state,
      active: L.activeTabOf(layout),
      open: (target, options) => guarded((l) => L.open(l, target, options)),
      openOrFocus: (target) => guarded((l) => L.openOrFocus(l, target)),
      newTab: () => guarded(L.newTab),
      close: (id) => {
        const target = id ?? current();
        // A background tab holds no editor: it closes at once. One on screen saves first.
        if (!shown(latest.current, target)) setLayout((l) => L.close(l, target));
        else guarded((l) => L.close(l, target));
      },
      closeOthers: (id) => {
        const target = id ?? current();
        if (shown(latest.current, target)) setLayout((l) => L.closeOthers(l, target));
        else guarded((l) => L.closeOthers(l, target));
      },
      setPinned: (pinned, id) => setLayout((l) => L.setPinned(l, id ?? L.activePane(l).active, pinned)),
      activate: (id) => {
        // A pane's current tab only makes its pane active: nothing leaves the screen.
        if (shown(latest.current, id)) setLayout((l) => L.activate(l, id));
        else guarded((l) => L.activate(l, id));
      },
      step: (delta) => guarded((l) => L.step(l, delta)),
      jump: (n) => guarded((l) => L.jump(l, n)),
      prune,
      remapPaths,
      // The current tab stays current, so nothing on screen changes and nothing needs saving first.
      move: (id, to) => setLayout((l) => L.move(l, id, to)),
      moveBy: (delta, id) => setLayout((l) => L.moveBy(l, id ?? L.activePane(l).active, delta)),
      // A tab that changes pane is mounted again there: its edits are written first.
      split: (id) =>
        guarded((l) => {
          const tab = id ?? L.activePane(l).active;
          const next = L.split(l, tab);
          if (next !== l) moved.current = tab;
          return next;
        }),
      moveToPane: (id, pane, index) =>
        guarded((l) => {
          const next = L.moveToPane(l, id, pane, index);
          if (next !== l) moved.current = id;
          return next;
        }),
      takeMoved: () => {
        const id = moved.current;
        moved.current = null;
        return id;
      },
      focusPane: (pane) => setLayout((l) => L.focusPane(l, pane)),
      focusOther: () => setLayout(L.focusOther),
      setRatio: (ratio) => setLayout((l) => L.setRatio(l, ratio)),
      detach: async (id, send) => {
        if (shown(latest.current, id) && !(await flushRef.current())) return false;
        const out = L.detach(latest.current, id);
        if (!out) return false;
        const sent = await send(out.moved).catch(() => false);
        // `removeTab`: a pinned tab leaves too (it is pinned in the new window).
        if (sent) setLayout((l) => L.removeTab(l, id));
        return sent;
      },
    };
  }, [layout, guarded, prune, remapPaths]);
}

/** The palette's Move tab left and right for the current tab at `index` of `count`: only the ones that can move it. */
export function tabMoves(index: number, count: number, moveBy: (delta: -1 | 1) => void): { moveLeft?(): void; moveRight?(): void } {
  return {
    ...(index > 0 ? { moveLeft: () => moveBy(-1) } : {}),
    ...(index >= 0 && index < count - 1 ? { moveRight: () => moveBy(1) } : {}),
  };
}
