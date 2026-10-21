/**
 * Turns watcher events into `vault.reconcile()` calls (ADR-001: the watcher is
 * only a trigger). Bursts coalesce into one reconcile; a `rescan` upgrades it
 * to a full one; events during a reconcile queue exactly one more run.
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
  trigger(event: { rescan: boolean }): void;
  /** Resolves once nothing is scheduled or running. */
  idle(): Promise<void>;
  dispose(): void;
}

export function createReconciler(vault: Pick<Vault, "reconcile">, options: ReconcilerOptions): Reconciler {
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
    full = false;
    running = vault
      .reconcile(wantFull ? { full: true } : {})
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
