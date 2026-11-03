/**
 * Links in a workspace page (ADR-0049). A workspace has no paths, so links name pages and folders by ID:
 * `[[thoth:page/<id>|Title]]` (no `|Title` for a page that may be limited to teams, `linkTitles`), the form transfers already write (`@thoth/transfer` PAGE_LINK_PREFIX) and the share
 * renderer reads. They survive renames and moves; the chip shows the page's current title. A folder of a workspace is
 * a page marked as a folder, so a folder link is a page link whose target the tree draws as a folder. People come
 * from the members list the workspace list already carries (`Workspace.members`) and are offered after `@` only.
 *
 * Everything here comes from the tree and the workspace list the client already holds: no new request.
 */
import { PAGE_LINK_PREFIX, parseThothLink } from "@thoth/transfer";
import { roleCan, type Member, type Role, type TreeNode } from "@thoth/workspace-protocol";
import type { WorkspaceClient } from "@thoth/workspace-client";
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
  /** Whether a link to this page or folder may carry its title (`linkTitles`); absent: never. */
  titled?(id: string): boolean;
}

/**
 * Which links may carry the target's title (ADR-0049, owner decision 2026-11-02). A link's label is stored in the
 * linking page, which readers of that page (and its share link) see even when the target is limited to teams they are
 * not in (ADR-0042). So a link to a limited page is written `[[thoth:page/<id>]]`: readers who see the page get its
 * title from their own tree, others read "Page not available".
 * - `all`: nothing in the workspace can be limited (the server has no teams, or the workspace has none), or the writer
 *   is in no team and so cannot see a limited page.
 * - `except`: owners and managers, who see every page: titles except for pages limited themselves or below a limited
 *   folder (`limited` holds the pages limited themselves).
 * - `none`: an editor in a team (who cannot tell which of their pages are limited), or anything unknown or failed.
 */
export type LinkTitles = { kind: "all" } | { kind: "none" } | { kind: "except"; limited: ReadonlySet<string> };

export const NO_TITLES: LinkTitles = { kind: "none" };

export async function linkTitles(input: {
  client: Pick<WorkspaceClient, "listTeams" | "listTeamPages">;
  workspace: string;
  role: Role;
  /** The signed-in user's ID. */
  me: string | undefined;
  /** The server lists the `teams` capability; undefined while that is not known. */
  teams: boolean | undefined;
}): Promise<LinkTitles> {
  if (input.teams === false) return { kind: "all" };
  if (input.teams === undefined) return NO_TITLES;
  try {
    const teams = await input.client.listTeams(input.workspace);
    if (teams.length === 0) return { kind: "all" };
    if (roleCan(input.role, "manage")) {
      // One request per team (at most TEAMS_MAX) instead of one `getPageVisibility` per page of the tree.
      const lists = await Promise.all(teams.map((t) => input.client.listTeamPages(input.workspace, t.id)));
      return { kind: "except", limited: new Set(lists.flat().map((p) => p.pageId)) };
    }
    if (input.me === undefined || teams.some((t) => t.memberIds.includes(input.me!))) return NO_TITLES;
    return { kind: "all" };
  } catch {
    return NO_TITLES;
  }
}

/** `titled` for a `WorkspaceLinkSource`: whether a link to `id` may carry its title under `titles`. */
export function titledBy(titles: LinkTitles, nodes: readonly TreeNode[]): (id: string) => boolean {
  if (titles.kind !== "except") return () => titles.kind === "all";
  return (id) => !titles.limited.has(id) && !workspaceAncestors(nodes, id).some((a) => titles.limited.has(a));
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
        item: { kind: folder ? "folder" : "page", path: n.id, title, folder: where(n.id), alias: null, target: `${PAGE_LINK_PREFIX}${n.id}`, ...(source.titled?.(n.id) ? { label: title } : {}) },
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
