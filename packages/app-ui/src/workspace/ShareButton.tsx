import { useSyncExternalStore } from "react";
import { roleCan } from "@thoth/workspace-protocol";
import { useStrings } from "../strings/index.ts";
import { IconButton } from "../ui/IconButton.tsx";
import type { ServerDirectory, WorkspacePageRef } from "./directory.ts";
import { requestShare } from "./share-request.ts";

/**
 * "Share…" in a workspace page's header (ADR-0023): shown exactly when the tree's own "Share…" is (a writer, on a
 * server that lists `public-share`), and it asks that tree to open its share dialog, like the palette does.
 */
export function ShareButton({ directory, target }: { directory: ServerDirectory; target: WorkspacePageRef }) {
  const state = useSyncExternalStore(directory.subscribe, directory.getState);
  const t = useStrings().tree;
  const role = state.servers.find((s) => s.info.id === target.server)?.workspaces?.find((w) => w.id === target.workspace)?.role;
  if (!role || !roleCan(role, "write") || !(state.capabilities[target.server]?.includes("public-share") ?? false)) return null;
  return <IconButton icon="share" label={t.share} onClick={() => requestShare({ server: target.server, workspace: target.workspace, page: target.page })} />;
}
