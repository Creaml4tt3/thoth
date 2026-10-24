/**
 * Folders in transfers (ADR-0016 rule 3). Workspaces have no folders, only pages that hold pages; a page whose
 * frontmatter says `thoth_kind: folder` is shown as a folder. So a Private Space folder becomes such a folder
 * page in a workspace, and a folder page becomes a vault folder when it comes back. A folder page carries no
 * text of its own: only its identity and kind.
 */
import { parseFrontmatter } from "@thoth/content";
import { basename, dirname } from "@thoth/domain";
import { fileNameForTitle } from "./links.ts";

export const FOLDER_KIND = "folder";

/** True for a folder page: frontmatter `thoth_kind: folder`. Malformed frontmatter is not a folder. */
export function isFolderMarkdown(markdown: string): boolean {
  const parsed = parseFrontmatter(markdown);
  return parsed.error === undefined && parsed.data["thoth_kind"] === FOLDER_KIND;
}

/** The whole Markdown of a folder page. */
export function folderMarkdown(id: string): string {
  return `---\nthoth_id: ${id}\nthoth_kind: ${FOLDER_KIND}\n---\n`;
}

/** A safe vault folder name for a folder page's title (the file-name rules, without `.md`). */
export function folderNameForTitle(title: string): string {
  return fileNameForTitle(title).replace(/\.md$/, "");
}

export interface OutboundFolders {
  /** The vault folder the selection is taken relative to; it does not travel itself. */
  base: string;
  /** Folders that become folder pages, parents first. `parent` null means the destination parent. */
  folders: { path: string; parent: string | null }[];
  /** For each selected page path: the planned folder that holds it, or null. */
  parentOf: Map<string, string | null>;
}

/** The deepest folder that holds every path ("" is the vault root). */
function commonFolder(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  let parts = dirname(paths[0]!).split("/").filter(Boolean);
  for (const path of paths.slice(1)) {
    const other = dirname(path).split("/").filter(Boolean);
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join("/");
}

/**
 * Which folders travel with a Private → Workspace selection: every folder strictly below `base` (by default the
 * deepest folder holding every selected page) on the way to a selected page.
 */
export function planOutboundFolders(paths: readonly string[], base?: string): OutboundFolders {
  const root = base ?? commonFolder(paths);
  const under = (path: string) => root === "" || path.startsWith(`${root}/`);
  const set = new Set<string>();
  const parentOf = new Map<string, string | null>();
  for (const path of paths) {
    if (!under(path)) {
      parentOf.set(path, null);
      continue;
    }
    const rest = (root === "" ? dirname(path) : dirname(path).slice(root.length + 1)).split("/").filter(Boolean);
    let at = root;
    for (const part of rest) {
      at = at === "" ? part : `${at}/${part}`;
      set.add(at);
    }
    parentOf.set(path, rest.length > 0 ? at : null);
  }
  const folders = [...set]
    .sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => ({ path, parent: set.has(dirname(path)) ? dirname(path) : null }));
  return { base: root, folders, parentOf };
}

/** The display name of a planned folder: its last path segment. */
export const folderTitle = (path: string): string => basename(path);

/**
 * For each selected workspace page: the chain of selected folder pages above it (outermost first), as safe
 * folder names. A folder that is not selected breaks the chain: the pages under it land at the top.
 */
export function planInboundFolders(pages: readonly { pageId: string; parentId: string | null; title: string; folder: boolean }[]): Map<string, string[]> {
  const byId = new Map(pages.map((p) => [p.pageId, p]));
  const out = new Map<string, string[]>();
  for (const page of pages) {
    const chain: string[] = [];
    const seen = new Set<string>([page.pageId]);
    let parent = page.parentId === null ? undefined : byId.get(page.parentId);
    while (parent && parent.folder && !seen.has(parent.pageId)) {
      seen.add(parent.pageId);
      chain.unshift(folderNameForTitle(parent.title));
      parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
    }
    out.set(page.pageId, chain);
  }
  return out;
}
