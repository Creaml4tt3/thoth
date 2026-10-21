import { useCallback, useEffect, useRef, useState } from "react";
import type { ImportPhase, ImportReport } from "@thoth/importer-core";
import { useSession } from "../../app/context.ts";
import type { ImportService, ScanResult } from "./service.ts";

export type PhaseProgress = Partial<Record<ImportPhase, { done: number; total: number }>>;

export interface RunView {
  status: "idle" | "running" | "finished" | "failed";
  jobId: string | null;
  /** Where the imported files go (shown in the report and used by "Open imported folder"). */
  destinationRoot: string;
  progress: PhaseProgress;
  /** Per-item failures, live while running (planned jobs) and final in the report. */
  failed: { sourcePath: string; error: string }[];
  report: ImportReport | null;
  error: string | null;
  cancelling: boolean;
}

const IDLE: RunView = { status: "idle", jobId: null, destinationRoot: "", progress: {}, failed: [], report: null, error: null, cancelling: false };

/** Runs or resumes one job at a time and exposes its progress to the wizard. */
export function useImportRun(service: ImportService) {
  const { refresh } = useSession();
  const [view, setView] = useState<RunView>(IDLE);
  const jobId = useRef<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const drive = useCallback(
    async (id: string, destinationRoot: string, go: (handlers: { onProgress(p: { phase: ImportPhase; done: number; total: number }): void }) => Promise<ImportReport>, liveFailures?: () => { sourcePath: string; error: string }[]) => {
      jobId.current = id;
      setView({ ...IDLE, status: "running", jobId: id, destinationRoot });
      try {
        const report = await go({
          onProgress: (p) => {
            if (!live.current) return;
            setView((v) => ({ ...v, progress: { ...v.progress, [p.phase]: { done: p.done, total: p.total } }, ...(liveFailures ? { failed: liveFailures() } : {}) }));
          },
        });
        await refresh().catch(() => undefined);
        if (live.current) setView((v) => ({ ...v, status: "finished", report, failed: report.failed, cancelling: false }));
      } catch (error) {
        await refresh().catch(() => undefined);
        if (live.current) setView((v) => ({ ...v, status: "failed", error: error instanceof Error ? error.message : String(error), cancelling: false }));
      } finally {
        jobId.current = null;
      }
    },
    [refresh],
  );

  const start = useCallback(
    (scan: ScanResult) =>
      drive(scan.manifest.jobId, scan.manifest.options.destinationRoot, (h) => service.run(scan, h), () =>
        scan.manifest.items.filter((i) => i.state === "failed").map((i) => ({ sourcePath: i.sourcePath, error: i.error ?? "unknown error" })),
      ),
    [drive, service],
  );

  const resume = useCallback((id: string, destinationRoot: string) => drive(id, destinationRoot, (h) => service.resume(id, h)), [drive, service]);

  const cancel = useCallback(() => {
    if (!jobId.current) return;
    setView((v) => ({ ...v, cancelling: true }));
    service.cancel(jobId.current);
  }, [service]);

  const reset = useCallback(() => setView(IDLE), []);

  return { view, start, resume, cancel, reset };
}
