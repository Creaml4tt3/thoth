import type { PageSummary } from "@thoth/domain";

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

/** Groups pages by folder: folders first, then pages, each sorted naturally. */
export function buildTree(pages: readonly PageSummary[]): TreeNode[] {
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
  for (const page of pages) {
    const slash = page.path.lastIndexOf("/");
    folderFor(slash === -1 ? "" : page.path.slice(0, slash)).children.push({ kind: "page", path: page.path, title: page.title });
  }
  const sort = (node: FolderNode): void => {
    node.children.sort((a, b) => (a.kind === b.kind ? collator.compare(a.kind === "folder" ? a.name : a.title, b.kind === "folder" ? b.name : b.title) : a.kind === "folder" ? -1 : 1));
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
