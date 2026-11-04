import { workspaceKey, type DirectoryState, type WorkspacePageRef } from "../workspace/directory.ts";
import type { TimelineSource } from "./TimelineView.tsx";
import { workspaceTimelineItems } from "./timeline.ts";

/**
 * One Timeline source per workspace the person can open (ADR-0051 rule 16), from the directory's trees, which hold
 * only the pages the reader may see. Tags and dates are offered only on a server that lists `page-tags`.
 */
export function workspaceTimelineSources(
  state: DirectoryState,
  options: { untitled: string; expand(server: string, workspace: string): void; open(ref: WorkspacePageRef, o: { newTab: boolean }): void; label?(server: string, workspace: string): string },
): TimelineSource[] {
  return state.servers.flatMap((entry) =>
    entry.info.auth === "signed-out"
      ? []
      : (entry.workspaces ?? []).map((ws): TimelineSource => {
          const tree = state.trees[workspaceKey(entry.info.id, ws.id)];
          return {
            id: `w:${workspaceKey(entry.info.id, ws.id)}`,
            label: options.label?.(entry.info.id, ws.id) ?? ws.name,
            items: !tree || (tree.loading && tree.nodes.length === 0) ? null : workspaceTimelineItems(tree.nodes, { untitled: options.untitled, isFolder: (id) => tree.kinds[id]?.folder === true }),
            tags: state.capabilities[entry.info.id]?.includes("page-tags") ?? false,
            error: tree?.error ?? null,
            load: () => options.expand(entry.info.id, ws.id),
            open: (item, o) => options.open({ server: entry.info.id, workspace: ws.id, page: item.id }, o),
          };
        }),
  );
}
