import { workspaceKey, type DirectoryState, type WorkspacePageRef } from "../workspace/directory.ts";
import type { HomeRow } from "./HomeView.tsx";

/**
 * What a Home row shows for a workspace page (ADR-0029), from the loaded tree as tab labels do: its title, its
 * workspace's name and the folder it is in. While the tree has not loaded the row says so (`pending`) and is muted.
 */
export function workspaceRow(state: DirectoryState, ref: WorkspacePageRef, words: { untitled: string; pending: string }): Omit<HomeRow, "id" | "open"> {
  const entry = state.servers.find((s) => s.info.id === ref.server);
  const workspace = entry?.workspaces?.find((w) => w.id === ref.workspace);
  const nodes = state.trees[workspaceKey(ref.server, ref.workspace)]?.nodes ?? [];
  const node = nodes.find((n) => n.id === ref.page);
  const parent = node?.parentId ? nodes.find((n) => n.id === node.parentId) : undefined;
  return {
    title: node ? node.title || words.untitled : words.pending,
    space: workspace?.name ?? entry?.info.label ?? "",
    ...(parent ? { folder: parent.title || words.untitled } : {}),
    ...(node ? {} : { unavailable: true }),
  };
}

/** The folder part of a Private Space path ("Notes/Plan.md" is in "Notes"); undefined at the top level. */
export const folderOf = (path: string): string | undefined => {
  const at = path.lastIndexOf("/");
  return at > 0 ? path.slice(0, at) : undefined;
};
