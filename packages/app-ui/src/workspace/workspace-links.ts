/**
 * Links in a workspace page (ADR-0049). A workspace has no paths, so links name pages and folders by ID:
 * `[[thoth:page/<id>|Title]]`, the form transfers already write (`@thoth/transfer` PAGE_LINK_PREFIX) and the share
 * renderer reads. They survive renames and moves; the chip shows the page's current title. A folder of a workspace is
 * a page marked as a folder, so a folder link is a page link whose target the tree draws as a folder. People come
 * from the members list the workspace list already carries (`Workspace.members`) and are offered after `@` only.
 *
 * Everything here comes from the tree and the workspace list the client already holds: no new request.
 */
import { PAGE_LINK_PREFIX, parseThothLink } from "@thoth/transfer";
import type { Member, TreeNode } from "@thoth/workspace-protocol";
import type { LinkLookup } from "../editor/links.ts";
import { rankCandidates, type Candidate, type LinkSuggester } from "../editor/link-suggest.ts";
import { workspaceAncestors } from "./tree.ts";

export interface WorkspaceLinkSource {
  nodes: readonly TreeNode[];
  isFolder(id: string): boolean;
  /** The open page: never offered. */
  page: string;
  /** Members to offer after `@`; null when the server does not tell them. */
  members: readonly Member[] | null;
}

const titleOf = (node: TreeNode): string => node.title || "Untitled";

/** `thoth:page/<id>` chips resolve to the page or folder with that ID in this workspace's tree. */
export function workspaceLinkLookup(source: Pick<WorkspaceLinkSource, "nodes" | "isFolder">): LinkLookup {
  const byId = new Map(source.nodes.map((n) => [n.id, n]));
  return {
    resolve(target) {
      const link = parseThothLink(target);
      const node = link?.kind === "page" ? byId.get(link.id) : undefined;
      if (!node) return { state: "unresolved" };
      return { state: "resolved", path: node.id, title: titleOf(node), ...(source.isFolder(node.id) ? { folder: true } : {}) };
    },
  };
}

export function workspaceLinkSuggester(source: WorkspaceLinkSource): LinkSuggester {
  const byId = new Map(source.nodes.map((n) => [n.id, n]));
  // Shown under each title: the folders above it, outermost first.
  const where = (id: string) =>
    workspaceAncestors(source.nodes, id)
      .reverse()
      .map((a) => (byId.has(a) ? titleOf(byId.get(a)!) : ""))
      .filter(Boolean)
      .join("/");
  const pages: Candidate[] = source.nodes
    .filter((n) => n.id !== source.page)
    .map((n) => {
      const title = titleOf(n);
      const folder = source.isFolder(n.id);
      return {
        item: { kind: folder ? "folder" : "page", path: n.id, title, folder: where(n.id), alias: null, target: `${PAGE_LINK_PREFIX}${n.id}`, label: title },
        fields: [[title, folder ? 1 : 0, null]],
        recency: Date.parse(n.updatedAt) || 0,
      };
    });
  const people: Candidate[] = (source.members ?? []).map((m) => ({
    item: { kind: "person", path: m.userId, title: m.displayName, folder: "", alias: null, target: m.userId },
    fields: [[m.displayName, 0, null]],
    recency: 0,
  }));
  return {
    people: people.length > 0,
    suggest: (raw, options) => rankCandidates(raw, options?.people ? [...pages, ...people] : pages),
  };
}
