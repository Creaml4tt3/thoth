/**
 * What the import wizard needs, and nothing more. The UI is coded against
 * `ImportService`; `createImportService` implements it on the shared pipeline
 * in `@thoth/importer-core`. How a source is opened is injected (`openSource`).
 */
import {
  buildReport,
  listManifests,
  planImport,
  resumeImport,
  runImport,
  type ImportManifest,
  type ImportOptions,
  type ImportPhase,
  type ImportPreview,
  type ImportProvider,
  type ImportReport,
  type ImportSource,
} from "@thoth/importer-core";
import type { ImportSourceKind } from "@thoth/domain";
import type { Vault } from "@thoth/local-store";

export interface ScanResult {
  preview: ImportPreview;
  manifest: ImportManifest;
  source: ImportSource;
  provider: ImportProvider;
}

export interface ImportProgress {
  phase: ImportPhase;
  done: number;
  total: number;
}

export interface RunHandlers {
  onProgress?: (progress: ImportProgress) => void;
}

export interface ImportService {
  /** Opens and validates a source and plans the import. Writes nothing to the vault. */
  scan(kind: ImportSourceKind, location: string, options?: Partial<ImportOptions>): Promise<ScanResult>;
  /** Plans again over the same open source with new destination or options. Writes nothing. */
  replan(scan: ScanResult, options: Partial<ImportOptions>): Promise<ScanResult>;
  /** Releases a scan that will not be run. */
  discard(scan: ScanResult): Promise<void>;
  /** Runs a planned job. Resolves with a report even when cancelled (state `cancelled`). */
  run(scan: ScanResult, handlers?: RunHandlers): Promise<ImportReport>;
  /** Re-opens the job's source from its manifest and continues. */
  resume(jobId: string, handlers?: RunHandlers): Promise<ImportReport>;
  /** Asks a running job to stop at the next item. */
  cancel(jobId: string): void;
  /** Jobs that did not finish (any state but `completed`). */
  listJobs(): Promise<ImportManifest[]>;
}

export type OpenSource = (kind: ImportSourceKind, location: string) => Promise<{ source: ImportSource; provider: ImportProvider }>;

export function createImportService(vault: Vault, openSource: OpenSource): ImportService {
  const running = new Map<string, AbortController>();

  const plan = async (source: ImportSource, provider: ImportProvider, options: Partial<ImportOptions> | undefined): Promise<ScanResult> => {
    const { manifest, preview } = await planImport({ vault, source, provider, ...(options ? { options } : {}) });
    return { preview, manifest, source, provider };
  };

  const execute = async (jobId: string, source: ImportSource, start: (signal: AbortSignal, onProgress: RunHandlers["onProgress"]) => Promise<ImportReport>, handlers?: RunHandlers) => {
    const controller = new AbortController();
    running.set(jobId, controller);
    try {
      return await start(controller.signal, handlers?.onProgress);
    } finally {
      running.delete(jobId);
      await source.close().catch(() => undefined);
    }
  };

  return {
    async scan(kind, location, options) {
      const { source, provider } = await openSource(kind, location);
      try {
        return await plan(source, provider, options);
      } catch (error) {
        await source.close().catch(() => undefined);
        throw error;
      }
    },

    replan: (scan, options) => plan(scan.source, scan.provider, options),

    async discard(scan) {
      await scan.source.close().catch(() => undefined);
    },

    run: (scan, handlers) =>
      execute(
        scan.manifest.jobId,
        scan.source,
        (signal, onProgress) => runImport(vault, scan.source, scan.manifest, { signal, ...(onProgress ? { onProgress } : {}) }),
        handlers,
      ),

    async resume(jobId, handlers) {
      const manifests = await listManifests(vault.fs);
      const manifest = manifests.find((m) => m.jobId === jobId);
      if (!manifest) throw new Error(`Import job ${jobId} was not found`);
      if (manifest.state === "completed") return buildReport(manifest);
      const { source } = await openSource(manifest.sourceKind, manifest.sourceLocation);
      return execute(jobId, source, (signal, onProgress) => resumeImport(vault, jobId, source, { signal, ...(onProgress ? { onProgress } : {}) }), handlers);
    },

    cancel(jobId) {
      running.get(jobId)?.abort();
    },

    async listJobs() {
      return (await listManifests(vault.fs)).filter((m) => m.state !== "completed").sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
  };
}
