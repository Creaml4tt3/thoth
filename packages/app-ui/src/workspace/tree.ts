import type { TreeNode } from "@thoth/workspace-protocol";
import { compareKeys, isKey } from "../order/fractional.ts";

export interface WorkspaceTreeItem {
  id: string;
  title: string;
  /** The page's sibling sort key; null when it has none (or the server does not keep order). */
  position: string | null;
  /** A folder page (`thoth_kind: folder`). */
  folder: boolean;
  children: WorkspaceTreeItem[];
}

export interface NestOptions {
  /** The server keeps page order (`page-order`). Without it every level is A–Z. Default true. */
  ordered?: boolean;
  /** Which pages are folder pages. */
  isFolder?: (id: string) => boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

interface Sortable {
  id: string;
  title: string;
  position?: string | null | undefined;
}

/**
 * Sibling order (protocol `page-order`): positioned pages first, by key as a byte string; then the others A–Z by
 * title; ties fall back to the id. With `ordered: false` positions are ignored.
 */
export function compareSiblings(a: Sortable, b: Sortable, ordered = true): number {
  const pa = ordered && isKey(a.position) ? a.position : null;
  const pb = ordered && isKey(b.position) ? b.position : null;
  if (pa !== null && pb !== null) {
    const c = compareKeys(pa, pb);
    if (c !== 0) return c;
  } else if (pa !== null) return -1;
  else if (pb !== null) return 1;
  return collator.compare(a.title, b.title) || compareKeys(a.id, b.id);
}

/** The pages directly under `parentId` (null: the top level), in display order. */
export function childrenOf(nodes: readonly TreeNode[], parentId: string | null, ordered = true): TreeNode[] {
  const known = new Set(nodes.map((n) => n.id));
  return nodes
    .filter((n) => (parentId === null ? n.parentId === null || n.parentId === n.id || !known.has(n.parentId) : n.parentId === parentId && n.id !== parentId))
    .sort((a, b) => compareSiblings(a, b, ordered));
}

/** Nests the protocol's adjacency list. A page whose parent is unknown (not readable, or not loaded) is shown at the top. */
export function nestWorkspaceTree(nodes: readonly TreeNode[], options: NestOptions = {}): WorkspaceTreeItem[] {
  const ordered = options.ordered ?? true;
  const items = new Map<string, WorkspaceTreeItem>(
    nodes.map((n) => [n.id, { id: n.id, title: n.title || "Untitled", position: isKey(n.position) ? n.position : null, folder: options.isFolder?.(n.id) ?? false, children: [] }]),
  );
  const roots: WorkspaceTreeItem[] = [];
  for (const node of nodes) {
    const item = items.get(node.id)!;
    const parent = node.parentId !== null && node.parentId !== node.id ? items.get(node.parentId) : undefined;
    (parent ? parent.children : roots).push(item);
  }
  const sort = (list: WorkspaceTreeItem[], seen: Set<string>): void => {
    list.sort((a, b) => compareSiblings(a, b, ordered));
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

/** True when `id` is `ancestor` or sits anywhere below it. */
export function isWithin(nodes: readonly TreeNode[], id: string, ancestor: string): boolean {
  return id === ancestor || workspaceAncestors(nodes, id).includes(ancestor);
}
