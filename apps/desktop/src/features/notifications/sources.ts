/**
 * Where the desktop's notifications come from (ADR-0018): an agent run that ended by itself, a transfer, an
 * import, a save conflict. Each turns its record into an event of titles and names only; what an event may carry
 * is enforced again by the notification core.
 */
import { basename, stripExtension } from "@thoth/domain";
import type { RunRecord } from "@thoth/agent-core";
import type { ImportReport } from "@thoth/importer-core";
import type { OperationRecord } from "@thoth/transfer";
import type { AgentFailure, NotificationCenter, NotificationEvent } from "@thoth/app-ui/notifications/core.ts";
import type { AgentsService, RunPhase } from "../agents/service.ts";

const pageTitle = (path: string) => stripExtension(basename(path));

/** The pages a run was given (the ones picked, not files linked from them), by title. */
function runPages(record: RunRecord): string[] {
  const out: string[] = [];
  for (const entry of record.context) {
    if (entry.kind !== "page" || entry.via === "linked" || entry.via === "space") continue;
    out.push(entry.workspace ? entry.workspace.title : pageTitle(entry.path));
  }
  return out;
}

const FAILURES: Record<string, AgentFailure> = { not_logged_in: "notSignedIn", billing: "billing", rate_limit: "rateLimit", model_not_found: "modelNotFound" };

/** The event for a run that has just ended by itself, or null (cancelled, interrupted, or not ended). */
export function runEvent(record: RunRecord): NotificationEvent | null {
  const base = { runId: record.id, agent: record.provider.name, pages: runPages(record) };
  const stopped = record.outcome?.stoppedBy;
  if (stopped && (record.state === "review" || record.state === "failed")) return { kind: "agentLimit", ...base, limit: stopped, review: record.state === "review" };
  switch (record.state) {
    case "review":
      return { kind: "agentReview", ...base };
    case "done":
      return { kind: "agentFinished", ...base };
    case "failed":
      return { kind: "agentFailed", ...base, reason: FAILURES[record.outcome?.error?.code ?? ""] ?? "error" };
    default:
      return null;
  }
}

const RUNNING: ReadonlySet<RunPhase> = new Set(["starting", "running", "cancelling"]);

/**
 * Pushes an event when a run ends: the phase leaves running for review or finished. Opening an earlier run's
 * review again, applying and discarding are the person's own doing and say nothing.
 */
export function watchAgentRuns(agents: AgentsService, center: NotificationCenter): () => void {
  let phase = agents.getState().phase;
  return agents.subscribe(() => {
    const state = agents.getState();
    const before = phase;
    phase = state.phase;
    if (!RUNNING.has(before) || RUNNING.has(state.phase) || !state.record) return;
    if (state.phase !== "review" && state.phase !== "finished") return;
    const event = runEvent(state.record);
    if (event) center.push(event);
  });
}

/** The event for a transfer that settled (done, failed or interrupted); null when it was undone. */
export function transferEvent(record: OperationRecord, interrupted: boolean): NotificationEvent | null {
  const done = !interrupted && (record.state === "done" || record.state === "destination_committed_source_cleanup_pending");
  if (!interrupted && !done && record.state !== "failed") return null;
  const where = record.direction === "to_workspace" ? record.workspace.name : null;
  const pages = record.items.filter((i) => !i.folder).map((i) => (record.direction === "to_workspace" ? pageTitle(i.sourcePath) : i.title));
  const first = (done ? record.items.find((i) => i.state !== "failed") : record.items[0]) ?? record.items[0];
  if (!first) return null;
  const ws = { server: record.server.id, workspace: record.workspace.id };
  // Done: the result, where it went. Not finished: the originals, where they still are.
  const open =
    record.direction === "to_workspace"
      ? done
        ? { kind: "workspacePage" as const, ...ws, page: first.destId }
        : { kind: "page" as const, path: first.sourcePath }
      : done && first.destPath
        ? { kind: "page" as const, path: first.destPath }
        : { kind: "workspacePage" as const, ...ws, page: first.sourceId };
  return { kind: done ? "transferDone" : "transferFailed", transferId: record.id, mode: record.mode, where, pages, open };
}

/** The event for an import that ended: complete, or with errors (a report or a thrown error); null when cancelled. */
export function importEvent(jobId: string, folder: string, report: ImportReport | null): NotificationEvent | null {
  if (report?.state === "cancelled") return null;
  const pages = report?.imported.pages ?? 0;
  return report?.state === "completed" ? { kind: "importDone", jobId, folder, pages } : { kind: "importFailed", jobId, folder, pages };
}
