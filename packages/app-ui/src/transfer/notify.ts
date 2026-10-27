/** A settled transfer as a notification (ADR-0018): titles and names only. Shared by the desktop and the web client. */
import { basename, stripExtension } from "@thoth/domain";
import type { OperationRecord } from "@thoth/transfer";
import type { NotificationEvent } from "../notifications/core.ts";

const pageTitle = (path: string) => stripExtension(basename(path));

/** The event for a transfer that settled (done, failed or interrupted); null when it was undone. */
export function transferEvent(record: OperationRecord, interrupted: boolean): NotificationEvent | null {
  const done = !interrupted && (record.state === "done" || record.state === "destination_committed_source_cleanup_pending");
  if (!interrupted && !done && record.state !== "failed") return null;
  const where = record.direction === "from_workspace" ? null : record.workspace.name;
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
      : record.direction === "between_workspaces"
        ? done || !record.source
          ? { kind: "workspacePage" as const, ...ws, page: first.destId }
          : { kind: "workspacePage" as const, server: record.source.server.id, workspace: record.source.workspace.id, page: first.sourceId }
        : done && first.destPath
          ? { kind: "page" as const, path: first.destPath }
          : { kind: "workspacePage" as const, ...ws, page: first.sourceId };
  return { kind: done ? "transferDone" : "transferFailed", transferId: record.id, mode: record.mode, where, pages, open };
}
