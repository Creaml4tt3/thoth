/**
 * The desktop's transfer service: one `TransferEngine` per open Private Space, wired to the vault and to the
 * servers the host knows (every request goes through `ServerDirectory.client`, where the host adds the
 * credential). It runs startup recovery once and keeps the latest record of each operation for the UI.
 */
import type { Vault } from "@thoth/local-store";
import type { ServerDirectory } from "@thoth/app-ui/workspace/directory.ts";
import { TransferEngine, TransferInterrupted, isTerminal, type OperationRecord, type Preview, type RecoveryReport } from "@thoth/transfer";

export interface TransferState {
  /** Latest record of every operation this window has seen (recovered, started or resumed). */
  records: Record<string, OperationRecord>;
  /** What startup recovery did; null until it ran. */
  recovery: RecoveryReport | null;
}

export interface TransferService {
  engine: TransferEngine;
  getState(): TransferState;
  subscribe(listener: () => void): () => void;
  /** Runs recovery (once per service). Never throws; problems end up in `recovery.waiting`. */
  recover(): Promise<void>;
  /** Starts a transfer; resolves with its final record, or the last durable one when interrupted. */
  start(preview: Preview): Promise<{ record: OperationRecord; interrupted: string | null }>;
  resume(id: string): Promise<{ record: OperationRecord; interrupted: string | null }>;
  abort(id: string): Promise<OperationRecord>;
  dismiss(id: string): Promise<void>;
}

export function createTransferService(
  vault: Vault,
  servers: ServerDirectory,
  /** `onSettled`: a started or resumed transfer ended (or was interrupted); not called for an undo. */
  options: { now?: () => Date; onChanged?: () => void; onSettled?: (record: OperationRecord, interrupted: boolean) => void } = {},
): TransferService {
  let state: TransferState = { records: {}, recovery: null };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<TransferState>) => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };
  const note = (record: OperationRecord) => set({ records: { ...state.records, [record.id]: record } });
  const engine = new TransferEngine({
    vault,
    server: (id) => {
      const entry = servers.server(id);
      return entry && entry.info.auth !== "signed-out" ? { client: servers.client(id), url: entry.info.url } : undefined;
    },
    ...(options.now ? { now: options.now } : {}),
    onProgress: note,
  });
  let recovering: Promise<void> | null = null;

  const settle = async (run: () => Promise<OperationRecord>) => {
    try {
      const record = await run();
      options.onSettled?.(record, false);
      return { record, interrupted: null };
    } catch (error) {
      if (error instanceof TransferInterrupted) {
        options.onSettled?.(error.record, true);
        return { record: error.record, interrupted: error.message };
      }
      throw error;
    } finally {
      // The vault changed (adopted IDs, deleted or written pages): refresh the views.
      options.onChanged?.();
    }
  };

  return {
    engine,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recover() {
      recovering ??= (async () => {
        try {
          const report = await engine.recover();
          const records = Object.fromEntries((await engine.list()).map((r) => [r.id, r]));
          set({ recovery: report, records: { ...records, ...state.records } });
          if (report.completed.length + report.rolledBack.length > 0) options.onChanged?.();
        } catch {
          set({ recovery: { completed: [], rolledBack: [], waiting: [], invalid: [] } });
        }
      })();
      return recovering;
    },
    start: (preview) => settle(() => engine.start(preview)),
    resume: (id) => settle(() => engine.resume(id)),
    async abort(id) {
      const record = await engine.abort(id);
      note(record);
      options.onChanged?.();
      return record;
    },
    async dismiss(id) {
      await engine.dismiss(id);
      const { [id]: _gone, ...rest } = state.records;
      set({ records: rest });
    },
  };
}

/** Moves whose originals were kept (shown until dismissed). */
export const pendingCleanups = (state: TransferState): OperationRecord[] =>
  Object.values(state.records).filter((r) => r.state === "destination_committed_source_cleanup_pending").sort((a, b) => (a.id < b.id ? 1 : -1));

export const unfinished = (state: TransferState): OperationRecord[] => Object.values(state.records).filter((r) => !isTerminal(r.state));
