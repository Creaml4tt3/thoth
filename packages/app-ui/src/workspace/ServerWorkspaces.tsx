import { useEffect, useState, useSyncExternalStore } from "react";
import type { Workspace } from "@thoth/workspace-protocol";
import { focusTreeItemSoon } from "../order/tree-keys.ts";
import { useStrings } from "../strings/index.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { DeletedWorkspacesDialog } from "./DeletedWorkspacesDialog.tsx";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog.tsx";
import { workspaceKey, type ServerDirectory } from "./directory.ts";
import { announceWorkspaces, clearWorkspaceAdmin, requestWorkspaceAdmin, usePendingServerAdmin, useWorkspaceAnnouncement } from "./workspace-admin-request.ts";

interface Props {
  directory: ServerDirectory;
  server: string;
  serverLabel: string;
}

/** Focuses a workspace's row in the sidebar once it is drawn (its tree id is `<server>\n<workspace>\n`). */
const focusWorkspaceRow = (server: string, workspace: string) => focusTreeItemSoon(`${workspaceKey(server, workspace)}\n`);

/**
 * The server-level workspace actions of a sidebar section (ADR-0025): the "New workspace on …" button for its header,
 * and the New workspace and Recently deleted dialogs, also when the palette asks for them. Nothing shows on a server
 * without `workspace-management`, or while signed out.
 */
export function ServerWorkspaceActions({ directory, server, serverLabel }: Props) {
  const t = useStrings().workspaces;
  const state = useSyncExternalStore(directory.subscribe, directory.getState, directory.getState);
  const [open, setOpen] = useState<"new" | "deleted" | null>(null);
  const capable = state.capabilities[server]?.includes("workspace-management") ?? false;
  const signedIn = state.servers.find((s) => s.info.id === server)?.workspaces != null;

  const said = useWorkspaceAnnouncement(server);
  const request = usePendingServerAdmin(server);
  useEffect(() => {
    if (!request) return;
    clearWorkspaceAdmin();
    if (capable && signedIn) setOpen(request.kind);
  }, [request, capable, signedIn]);

  if (!capable || !signedIn) return null;
  const opened = (ws: Workspace, text: string) => {
    setOpen(null);
    announceWorkspaces(server, text);
    focusWorkspaceRow(server, ws.id);
  };
  return (
    <>
      <IconButton icon="plus" className="sec-add" label={t.newOn(serverLabel)} onClick={() => setOpen("new")} />
      {open === "new" && <NewWorkspaceDialog directory={directory} server={server} serverLabel={serverLabel} onCreated={(ws) => opened(ws, t.created(ws.name))} onShowDeleted={() => setOpen("deleted")} onClose={() => setOpen(null)} />}
      {open === "deleted" && <DeletedWorkspacesDialog directory={directory} server={server} serverLabel={serverLabel} onClose={() => setOpen(null)} />}
      <span className="sr-only" aria-live="polite" aria-atomic="true" data-workspaces-said="">
        {said}
      </span>
    </>
  );
}

/**
 * Under a server's workspaces: how many the user owns of the limit, once near it ("2 of 3 workspaces"), and
 * "Recently deleted (n)" when there are deleted workspaces to restore. Nothing otherwise.
 */
export function ServerWorkspacesFooter({ directory, server }: Omit<Props, "serverLabel">) {
  const t = useStrings().workspaces;
  useSyncExternalStore(directory.subscribe, directory.getState, directory.getState);
  if (!directory.canManageWorkspaces(server)) return null;
  const { owned, deleted, limit } = directory.ownership(server);
  const near = limit !== undefined && owned >= limit - 1;
  if (!near && deleted === 0) return null;
  return (
    <div className="ws-footer">
      {near && <span className="ws-footer-usage">{t.usage(owned, limit)}</span>}
      {deleted > 0 && (
        <button type="button" className="sec-link" onClick={() => requestWorkspaceAdmin({ kind: "deleted", server })}>
          {t.recentlyDeletedCount(deleted)}
        </button>
      )}
    </div>
  );
}
