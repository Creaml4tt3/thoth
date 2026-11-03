/**
 * Duplicate in a workspace (ADR-0047): a page or folder and every page below it, copied in the same workspace with
 * new page ids. Each copy is a plain create (`If-None-Match: *`), so nothing existing is ever replaced. Links between
 * pages of the copied set point at the copies (the transfer link rewriting, `classifyBetween`); links to any other
 * page, and images (`thoth:attachment/<id>`, the same attachment), stay as written. Earlier versions, share links and
 * team limits are not copied. A failure part-way deletes what was created, newest first, then throws.
 */
import { PAGE_TITLE_MAX, type PageResource, type TreeNode } from "@thoth/workspace-protocol";
import { newStableId } from "@thoth/domain";
import type { WorkspaceClient } from "@thoth/workspace-client";
import { applyRewrites, classifyBetween, withOwnId, withSubPages } from "@thoth/transfer";
import { folderColorOf, folderMarkdown, isFolderMarkdown, withFolderColor } from "./folders.ts";
import { renameInMarkdown } from "./workspace-store.ts";

/** The copy would not fit in the workspace's page limit (`maxPagesPerWorkspace`). */
export class DuplicateQuota extends Error {
  readonly limit: number;
  readonly current: number;
  readonly adding: number;
  constructor(limit: number, current: number, adding: number) {
    super(`This workspace is limited to ${limit} pages`);
    this.name = "DuplicateQuota";
    this.limit = limit;
    this.current = current;
    this.adding = adding;
  }
}

export interface WorkspaceDuplicate {
  workspace: string;
  /** The workspace's tree as the client has it. */
  nodes: readonly TreeNode[];
  /** The page or folder to copy; the pages below it come with it. */
  rootId: string;
  /** Where the copy goes (null: the top level). */
  parentId: string | null;
  /** The copy's title ("Roadmap (copy)"); the pages below keep theirs. */
  title: string;
  /** Each page keeps only its title; folder pages keep their folder frontmatter and color. */
  structureOnly: boolean;
  /** `page-order`: the pages below keep their positions (relative to each other, which is all that changes). */
  ordered: boolean;
  /** `maxPagesPerWorkspace`, when the server sets one. */
  maxPages?: number;
  newId?: () => string;
}

type Client = Pick<WorkspaceClient, "getPage" | "putPage" | "deletePage">;

/** The ids that are copied, parents first: the root and every page below it. */
export const duplicatedIds = (nodes: readonly TreeNode[], rootId: string): string[] => withSubPages(nodes, [rootId]);

/** The Markdown of one copy. */
export function copyMarkdown(page: Pick<PageResource, "markdown">, newId: string, ids: ReadonlyMap<string, string>, options: { structureOnly: boolean; title?: string }): string {
  const folder = isFolderMarkdown(page.markdown);
  if (options.structureOnly) return folder ? withFolderColor(folderMarkdown(newId), folderColorOf(page.markdown)) : "";
  const linked = applyRewrites(page.markdown, classifyBetween("", page.markdown, ids, new Map()), { labelBareWikilinks: false });
  const own = withOwnId(linked, newId);
  return options.title === undefined ? own : renameInMarkdown(own, options.title);
}

/** Copies the page or folder; returns the pages created, parents first (the copy of the root first). */
export async function duplicateInWorkspace(client: Client, input: WorkspaceDuplicate): Promise<PageResource[]> {
  const ids = duplicatedIds(input.nodes, input.rootId);
  if (input.maxPages !== undefined && input.nodes.length + ids.length > input.maxPages) throw new DuplicateQuota(input.maxPages, input.nodes.length, ids.length);
  const newId = input.newId ?? (() => newStableId());
  const mapped = new Map(ids.map((id) => [id, newId()]));
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const created: PageResource[] = [];
  try {
    for (const id of ids) {
      const page = await client.getPage(input.workspace, id);
      const root = id === input.rootId;
      const copyId = mapped.get(id)!;
      const title = root ? input.title.slice(0, PAGE_TITLE_MAX) : page.metadata.title;
      const position = byId.get(id)?.position;
      const made = await client.putPage(
        input.workspace,
        copyId,
        {
          title,
          markdown: copyMarkdown(page, copyId, mapped, { structureOnly: input.structureOnly, ...(root ? { title } : {}) }),
          parentId: root ? input.parentId : mapped.get(page.metadata.parentId!)!,
          // The root's place among its new siblings is set afterwards (`ServerDirectory.movePage`).
          ...(input.ordered && !root && position ? { position } : {}),
        },
        null,
      );
      created.push(made);
    }
    return created;
  } catch (error) {
    await undoCreated(client, input.workspace, created);
    throw error;
  }
}

/** Deletes pages this duplicate created, newest first (children before their parent). A page already gone is fine. */
export async function undoCreated(client: Pick<WorkspaceClient, "deletePage">, workspace: string, created: readonly PageResource[]): Promise<void> {
  for (const page of [...created].reverse()) {
    try {
      await client.deletePage(workspace, page.id, page.revision.id);
    } catch {
      // Already gone is fine. shortcut: a copy that cannot be deleted now stays (it shows in the tree); no retry queue.
    }
  }
}
