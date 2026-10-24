import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as model from "./model.ts";
import type { OpenOptions, Tab, TabTarget, TabsState } from "./model.ts";

export interface TabsController {
  state: TabsState;
  /** The current tab. */
  active: Tab;
  /** Opens a target in the current tab, or in a new one (`newTab`). */
  open(target: TabTarget, options?: OpenOptions): void;
  newTab(): void;
  /** Closes a tab (the current one by default). */
  close(id?: string): void;
  activate(id: string): void;
  /** The next (1) or previous (-1) tab. */
  step(delta: number): void;
  /** The n-th tab (1–9). */
  jump(n: number): void;
  /** Closes background tabs whose target is gone. */
  prune(gone: (target: TabTarget) => boolean): void;
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

  return useMemo<TabsController>(
    () => ({
      state,
      active: model.activeTab(state),
      open: (target, options) => guarded((s) => model.open(s, target, options)),
      newTab: () => guarded(model.newTab),
      close: (id) => {
        const target = id ?? latest.current.active;
        // A background tab holds no editor: it closes at once. The current one saves first.
        if (target !== latest.current.active) setState((s) => model.close(s, target));
        else guarded((s) => model.close(s, target));
      },
      activate: (id) => guarded((s) => model.activate(s, id)),
      step: (delta) => guarded((s) => model.step(s, delta)),
      jump: (n) => guarded((s) => model.jump(s, n)),
      prune: (gone) => setState((s) => model.prune(s, gone)),
    }),
    [state, guarded],
  );
}
