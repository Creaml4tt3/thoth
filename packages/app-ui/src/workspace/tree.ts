import type { TreeNode } from "@thoth/workspace-protocol";

export interface WorkspaceTreeItem {
  id: string;
  title: string;
  children: WorkspaceTreeItem[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Nests the protocol's adjacency list. A page whose parent is unknown (not readable, or not loaded) is shown at the top. */
export function nestWorkspaceTree(nodes: readonly TreeNode[]): WorkspaceTreeItem[] {
  const items = new Map<string, WorkspaceTreeItem>(nodes.map((n) => [n.id, { id: n.id, title: n.title || "Untitled", children: [] }]));
  const roots: WorkspaceTreeItem[] = [];
  for (const node of nodes) {
    const item = items.get(node.id)!;
    const parent = node.parentId !== null && node.parentId !== node.id ? items.get(node.parentId) : undefined;
    (parent ? parent.children : roots).push(item);
  }
  const sort = (list: WorkspaceTreeItem[], seen: Set<string>): void => {
    list.sort((a, b) => collator.compare(a.title, b.title));
    for (const item of list) {
      // A cycle in a hostile or broken tree must not hang the sidebar.
      if (seen.has(item.id)) item.children = [];
      seen.add(item.id);
      sort(item.children, seen);
    }
  };
  sort(roots, new Set());
  return roots;
}

/** Ids of every ancestor of `id`, nearest first. */
export function workspaceAncestors(nodes: readonly TreeNode[], id: string): string[] {
  const parent = new Map(nodes.map((n) => [n.id, n.parentId]));
  const out: string[] = [];
  let at = parent.get(id) ?? null;
  while (at !== null && !out.includes(at) && out.length < 1000) {
    out.push(at);
    at = parent.get(at) ?? null;
  }
  return out;
}
