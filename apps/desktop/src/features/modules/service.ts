/**
 * The OCR module's state for one window (ADR-0055): the host keeps one download for the whole app and sends its status
 * to every window (`module.progress`); this mirrors it for Settings → Modules and the image menu.
 */
import type { ModuleStatus, Modules, OcrModel } from "@thoth/platform";

export interface ModuleService {
  subscribe(listener: () => void): () => void;
  /** null until the host answered. */
  getState(): ModuleStatus | null;
  /** Asks the host again; `refresh` also reads the signed model list. */
  refresh(): Promise<void>;
  install(model: OcrModel): Promise<void>;
  cancel(): Promise<void>;
  remove(model: OcrModel): Promise<void>;
  setAutoUpdate(on: boolean): Promise<void>;
}

export function createModuleService(host: Modules): ModuleService {
  let state: ModuleStatus | null = null;
  const listeners = new Set<() => void>();
  const set = (next: ModuleStatus) => {
    state = next;
    for (const l of listeners) l();
  };
  // A failed call keeps the last state: the next event or refresh brings the host's.
  const run = async (call: Promise<ModuleStatus>) => set(await call.catch(() => state ?? call));
  let stop: (() => void) | null = null;
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) void host.onProgress(set).then((off) => (listeners.size ? (stop = off) : off()));
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop?.();
          stop = null;
        }
      };
    },
    getState: () => state,
    refresh: () => run(host.status({ refresh: true })),
    install: (model) => run(host.install(model)),
    cancel: () => run(host.cancel()),
    remove: (model) => run(host.remove(model)),
    setAutoUpdate: (on) => run(host.setAutoUpdate(on)),
  };
}
