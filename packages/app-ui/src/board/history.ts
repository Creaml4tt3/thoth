/** A Board tab's undo history: moves, pins, removals and drawn links, for the tab's life. */
export interface HistoryEntry { undo(): Promise<void> | void; redo(): Promise<void> | void }

/**
 * Undo and redo stacks. A new entry clears redo. Calls run one after another (key repeat can fire Cmd+Z faster than a
 * write finishes); an entry whose step throws stays where it was, and the error reaches the caller.
 * The type parameter is unused (kept from the plan's signature): entries are plain closures.
 */
export function createHistory<_T = unknown>(): { push(entry: HistoryEntry): void; undo(): Promise<void>; redo(): Promise<void>; canUndo(): boolean; canRedo(): boolean } {
  const done: HistoryEntry[] = [];
  const undone: HistoryEntry[] = [];
  let queue: Promise<void> = Promise.resolve();
  const step = (from: HistoryEntry[], to: HistoryEntry[], run: (e: HistoryEntry) => Promise<void> | void) => {
    const next = queue.then(async () => {
      const entry = from.at(-1);
      if (!entry) return;
      await run(entry);
      from.pop();
      to.push(entry);
    });
    queue = next.catch(() => {});
    return next;
  };
  return {
    push(entry) {
      done.push(entry);
      undone.length = 0;
    },
    undo: () => step(done, undone, (e) => e.undo()),
    redo: () => step(undone, done, (e) => e.redo()),
    canUndo: () => done.length > 0,
    canRedo: () => undone.length > 0,
  };
}
