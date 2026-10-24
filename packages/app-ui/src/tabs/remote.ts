import { workspaceKey, type DirectoryState, type WorkspacePageRef } from "../workspace/directory.ts";

/** The title of a workspace page as the loaded tree knows it; null while the tree has not loaded. Titles are looked up live and never stored. */
export function remoteTitle(state: DirectoryState, ref: WorkspacePageRef): string | null {
  const title = state.trees[workspaceKey(ref.server, ref.workspace)]?.nodes.find((n) => n.id === ref.page)?.title;
  return title === undefined ? null : title;
}

/**
 * True only when the server has said the page is not there: its tree loaded without an error and does not list the
 * page, or the workspace list loaded and does not list the workspace. A tree that is still loading, an unreachable
 * server and a signed-out server are "not known", never "gone", so a restored tab is not closed by a bad moment.
 */
export function remoteGone(state: DirectoryState, ref: WorkspacePageRef): boolean {
  const entry = state.servers.find((s) => s.info.id === ref.server);
  if (!entry || entry.info.auth === "signed-out") return false;
  if (entry.workspaces && !entry.workspaces.some((w) => w.id === ref.workspace)) return true;
  const tree = state.trees[workspaceKey(ref.server, ref.workspace)];
  if (!tree || tree.loading || tree.error || tree.cursor === null) return false;
  return !tree.nodes.some((n) => n.id === ref.page);
}
