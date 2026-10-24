import type { PageSummary } from "@thoth/domain";
import { basename } from "@thoth/domain";
import { emptyOrder, orderChildren, type OrderRecord } from "@thoth/local-store";

export interface FolderNode {
  kind: "folder";
  /** Vault path of the folder. */
  path: string;
  name: string;
  children: TreeNode[];
}
export interface PageNode {
  kind: "page";
  path: string;
  title: string;
}
export type TreeNode = FolderNode | PageNode;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The name a node has in `.thoth/order.json` and on disk: a page's file name (with extension), a folder's name. */
export const nodeName = (node: TreeNode): string => (node.kind === "folder" ? node.name : basename(node.path));

/** A–Z: folders first, then pages, each sorted naturally. The order for everything the order record does not list. */
const alphabetical = (a: TreeNode, b: TreeNode): number =>
  a.kind === b.kind ? collator.compare(a.kind === "folder" ? a.name : a.title, b.kind === "folder" ? b.name : b.title) : a.kind === "folder" ? -1 : 1;

export interface BuildOptions {
  /** Folders that hold no pages (they still show, and can be dropped into). */
  folders?: readonly string[];
  /** The order people gave (ADR-0016 rule 4). Missing or empty: A–Z. */
  order?: OrderRecord;
}

/**
 * Groups pages by folder. Each folder lists the names the order record puts first, in that order, then everything
 * else A–Z (folders before pages). A stale name in the record is ignored.
 */
export function buildTree(pages: readonly PageSummary[], options: BuildOptions = {}): TreeNode[] {
  const order = options.order ?? emptyOrder();
  const root: FolderNode = { kind: "folder", path: "", name: "", children: [] };
  const folders = new Map<string, FolderNode>([["", root]]);
  const folderFor = (path: string): FolderNode => {
    const existing = folders.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const node: FolderNode = { kind: "folder", path, name: path.slice(slash + 1), children: [] };
    folderFor(slash === -1 ? "" : path.slice(0, slash)).children.push(node);
    folders.set(path, node);
    return node;
  };
  for (const folder of options.folders ?? []) if (folder !== "") folderFor(folder);
  for (const page of pages) {
    const slash = page.path.lastIndexOf("/");
    folderFor(slash === -1 ? "" : page.path.slice(0, slash)).children.push({ kind: "page", path: page.path, title: page.title });
  }
  const sort = (node: FolderNode): void => {
    node.children = orderChildren(node.path, node.children, nodeName, alphabetical, order);
    for (const child of node.children) if (child.kind === "folder") sort(child);
  };
  sort(root);
  return root.children;
}

/** Every ancestor folder of a page path, outermost first. */
export function ancestorFolders(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** The folder node at `path` ("" is the root, given as the top-level list). */
export function childrenAt(tree: readonly TreeNode[], folder: string): readonly TreeNode[] {
  if (folder === "") return tree;
  const walk = (list: readonly TreeNode[]): readonly TreeNode[] | null => {
    for (const node of list) {
      if (node.kind !== "folder") continue;
      if (node.path === folder) return node.children;
      if (folder.startsWith(`${node.path}/`)) return walk(node.children);
    }
    return null;
  };
  return walk(tree) ?? [];
}

/** Every folder in the tree, with its depth, in display order. */
export function listFolders(tree: readonly TreeNode[]): { path: string; name: string; depth: number }[] {
  const out: { path: string; name: string; depth: number }[] = [];
  const walk = (list: readonly TreeNode[], depth: number) => {
    for (const node of list) {
      if (node.kind !== "folder") continue;
      out.push({ path: node.path, name: node.name, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}
