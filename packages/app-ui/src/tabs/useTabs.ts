import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as model from "./model.ts";
import type { OpenOptions, Tab, TabTarget, TabsState } from "./model.ts";

export interface TabsController {
  state: TabsState;
  /** The current tab. */
  active: Tab;
  /** Opens a target in the current tab, or in a new one (`newTab`). */
  open(target: TabTarget, options?: OpenOptions): void;
  /** Goes to the tab that shows `target`, else opens it in a new tab (a notification about a page). */
  openOrFocus(target: TabTarget): void;
  newTab(): void;
  /** Closes a tab (the current one by default). A pinned tab is not closed (ADR-0027). */
  close(id?: string): void;
  /** Closes every tab but `id` (the current one by default) and the pinned ones; `id` becomes current. */
  closeOthers(id?: string): void;
  /** Pins or unpins the tab `id` (the current one by default). The current tab does not change. */
  setPinned(pinned: boolean, id?: string): void;
  activate(id: string): void;
  /** The next (1) or previous (-1) tab. */
  step(delta: number): void;
  /** The n-th tab (1–9). */
  jump(n: number): void;
  /** Closes background tabs whose target is gone. */
  prune(gone: (target: TabTarget) => boolean): void;
  /** A page or folder moved or was renamed: every tab on it (or on a page under it) follows. */
  remapPaths(from: string, to: string): void;
  /** Puts the tab `id` at index `to` (a drag in the tab bar). The current tab does not change. */
  move(id: string, to: number): void;
  /** Moves the tab `id` (the current one by default) one place left (-1) or right (1); nothing at the ends. */
  moveBy(delta: -1 | 1, id?: string): void;
  /**
   * Moves the tab `id` to another window (ADR-0019). Its pending edits are written first when it is the current
   * tab; then `send` gets the new window's tabs, and only when it reports success does the tab leave this window.
   * False when the tab cannot leave (the only tab), the edit could not be written, or `send` failed.
   */
  detach(id: string, send: (moved: TabsState) => Promise<boolean>): Promise<boolean>;
}

interface Options {
  /** The starting tabs, read once (restored from storage). */
  initial(): TabsState;
  /**
   * Writes the pending edits of the page on screen. False means "stay here" (a conflict or an error needs the
   * user), and the tab is not changed. Every change of the current tab goes through it, so a switch never loses an edit.
   */
  flush(): Promise<boolean>;
  /** Called with each new state, to store it. */
  save?(state: TabsState): void;
}

/** The tabs of one window. Changes that leave the page on screen write its pending edits first. */
export function useTabs({ initial, flush, save }: Options): TabsController {
  const [state, setState] = useState<TabsState>(initial);
  const latest = useRef(state);
  latest.current = state;
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => saveRef.current?.(state), [state]);

  /** Applies `change` after the page on screen has been saved; `change` sees the state as it is by then. */
  const guarded = useCallback((change: (s: TabsState) => TabsState) => {
    void flushRef.current().then((ok) => ok && setState(change));
  }, []);

  // These only ever read the state they are given, so their identity never changes: an effect that lists them as a
  // dependency (the shell prunes when the page list changes) must not re-run because a tab changed.
  const prune = useCallback((gone: (target: TabTarget) => boolean) => setState((s) => model.prune(s, gone)), []);
  const remapPaths = useCallback((from: string, to: string) => setState((s) => model.remapPaths(s, from, to)), []);

  return useMemo<TabsController>(
    () => ({
      state,
      active: model.activeTab(state),
      open: (target, options) => guarded((s) => model.open(s, target, options)),
      openOrFocus: (target) => guarded((s) => model.openOrFocus(s, target)),
      newTab: () => guarded(model.newTab),
      close: (id) => {
        const target = id ?? latest.current.active;
        // A background tab holds no editor: it closes at once. The current one saves first.
        if (target !== latest.current.active) setState((s) => model.close(s, target));
        else guarded((s) => model.close(s, target));
      },
      closeOthers: (id) => {
        const target = id ?? latest.current.active;
        if (target === latest.current.active) setState((s) => model.closeOthers(s, target));
        else guarded((s) => model.closeOthers(s, target));
      },
      setPinned: (pinned, id) => setState((s) => model.setPinned(s, id ?? s.active, pinned)),
      activate: (id) => guarded((s) => model.activate(s, id)),
      step: (delta) => guarded((s) => model.step(s, delta)),
      jump: (n) => guarded((s) => model.jump(s, n)),
      prune,
      remapPaths,
      // The current tab stays current, so nothing on screen changes and nothing needs saving first.
      move: (id, to) => setState((s) => model.move(s, id, to)),
      moveBy: (delta, id) => setState((s) => model.moveBy(s, id ?? s.active, delta)),
      detach: async (id, send) => {
        if (id === latest.current.active && !(await flushRef.current())) return false;
        const out = model.detach(latest.current, id);
        if (!out) return false;
        const sent = await send(out.moved).catch(() => false);
        // `removeTab`: a pinned tab leaves too (it is pinned in the new window).
        if (sent) setState((s) => model.removeTab(s, id));
        return sent;
      },
    }),
    [state, guarded, prune, remapPaths],
  );
}

/** The palette's Move tab left and right for the current tab at `index` of `count`: only the ones that can move it. */
export function tabMoves(index: number, count: number, moveBy: (delta: -1 | 1) => void): { moveLeft?(): void; moveRight?(): void } {
  return {
    ...(index > 0 ? { moveLeft: () => moveBy(-1) } : {}),
    ...(index >= 0 && index < count - 1 ? { moveRight: () => moveBy(1) } : {}),
  };
}
