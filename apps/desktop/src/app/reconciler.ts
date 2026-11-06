/**
 * Turns watcher events into `vault.reconcile()` calls (ADR-001: the watcher is
 * only a trigger). Bursts coalesce into one reconcile; a `rescan` upgrades it
 * to a full one; events during a reconcile queue exactly one more run. The
 * changed paths go along, so a burst the index already reflects (Thoth's own
 * save) costs a few stats instead of a walk of the whole vault.
 */
import type { ReconcileReport, Vault } from "@thoth/local-store";

export interface ReconcilerOptions {
  debounceMs: number;
  /** Longest an unbroken burst can postpone a reconcile. Defaults to 10x the debounce. */
  maxWaitMs?: number;
  onReconciled(report: ReconcileReport): void;
  onError(error: unknown): void;
}

export interface Reconciler {
  trigger(event: { rescan: boolean; paths?: readonly string[] }): void;
  /** Resolves once nothing is scheduled or running. */
  idle(): Promise<void>;
  dispose(): void;
}

export function createReconciler(vault: Pick<Vault, "reconcile">, options: ReconcilerOptions): Reconciler {
  /** Paths named since the last run; `undefined` once an event came without them (then nothing is skipped). */
  let changed: Set<string> | undefined = new Set();
  const maxWait = options.maxWaitMs ?? options.debounceMs * 10;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt: number | undefined;
  let full = false;
  let rerun = false;
  let running: Promise<void> | undefined;
  let disposed = false;

  const fire = (): void => {
    timer = undefined;
    firstAt = undefined;
    if (disposed) return;
    if (running) {
      rerun = true;
      return;
    }
    const wantFull = full;
    const paths = changed;
    full = false;
    changed = new Set();
    running = vault
      .reconcile(wantFull ? { full: true } : paths && paths.size > 0 ? { changed: [...paths] } : {})
      .then(
        (report) => {
          if (!disposed) options.onReconciled(report);
        },
        (error: unknown) => {
          if (!disposed) options.onError(error);
        },
      )
      .finally(() => {
        running = undefined;
        if (rerun && !disposed) {
          rerun = false;
          fire();
        }
      });
  };

  return {
    trigger(event) {
      if (disposed) return;
      if (event.rescan) full = true;
      if (event.paths && event.paths.length > 0) for (const path of event.paths) changed?.add(path);
      else changed = undefined;
      const now = Date.now();
      firstAt ??= now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, Math.max(0, Math.min(options.debounceMs, firstAt + maxWait - now)));
    },
    async idle() {
      while (timer || running) {
        if (running) await running;
        else await new Promise((resolve) => setTimeout(resolve, options.debounceMs));
      }
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
