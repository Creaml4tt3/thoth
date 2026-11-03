/**
 * Connections for a workspace page (ADR-0050 rule 7). Everything comes from answers the server already filters for
 * the reader: the tree (pages they may see) and search (which leaves out hidden pages), so a page limited to teams the
 * reader is not in, and its title, never show here.
 */
import { parsePage } from "@thoth/content";
import { PAGE_LINK_PREFIX, parseThothLink } from "@thoth/transfer";
import { ProblemError, RevisionConflict, type WorkspaceClient } from "@thoth/workspace-client";
import type { ConnectedPage, ConnectionsSource, MentionRow } from "../connections/Connections.tsx";
import { findMentions, linkMention, wikilinkFor } from "../connections/mentions.ts";
import type { TreeNode } from "@thoth/workspace-protocol";

/** Backlink pages and mention candidates read (one request each for mentions). */
export const BACKLINK_PAGES = 50;
export const MENTION_PAGES = 20;

export interface WorkspaceConnectionsInput {
  client: Pick<WorkspaceClient, "getPage" | "putPage" | "search">;
  workspace: string;
  page: string;
  title: string;
  /** The reader's tree: only pages they may see. */
  nodes: readonly TreeNode[];
  /** The server lists `search`. */
  canSearch: boolean;
  /** The reader may write (not a viewer). */
  canWrite: boolean;
  tick: unknown;
  open: ConnectionsSource["open"];
  flushAll?: () => Promise<boolean>;
}

export function workspaceConnectionsSource(input: WorkspaceConnectionsInput): ConnectionsSource {
  const { client, workspace, page, title } = input;
  const visible = new Map(input.nodes.map((n) => [n.id, n]));
  const toPage = (id: string, fallback: string): ConnectedPage => ({ ref: id, title: visible.get(id)?.title || fallback || "Untitled" });
  const searchPages = async (query: string, limit: number) => {
    const { items } = await client.search(workspace, { query, limit });
    return items.filter((h) => h.pageId !== page && visible.has(h.pageId));
  };
  const linkingPages = async () => new Set((await searchPages(`${PAGE_LINK_PREFIX}${page}`, BACKLINK_PAGES)).map((h) => h.pageId));

  return {
    title,
    tick: input.tick,
    open: input.open,
    async links() {
      const { markdown } = await client.getPage(workspace, page);
      const ids = parsePage("page.md", markdown).references.flatMap((r) => {
        const link = r.syntax === "wikilink" || r.syntax === "markdown-link" ? parseThothLink(r.target) : undefined;
        return link?.kind === "page" && link.id !== page && visible.has(link.id) ? [link.id] : [];
      });
      return [...new Set(ids)].map((id) => toPage(id, ""));
    },
    backlinks: () =>
      input.canSearch
        ? searchPages(`${PAGE_LINK_PREFIX}${page}`, BACKLINK_PAGES).then((hits) => hits.map((h) => toPage(h.pageId, h.title)))
        : null,
    mentions: () => {
      if (!input.canSearch) return null;
      return (async () => {
        const linking = await linkingPages();
        const hits = (await searchPages(title.trim(), MENTION_PAGES)).filter((h) => !linking.has(h.pageId));
        const rows: MentionRow[] = [];
        for (const hit of hits) {
          const read = await client.getPage(workspace, hit.pageId).catch(() => null);
          if (!read) continue;
          for (const mention of findMentions(read.markdown, title)) rows.push({ page: toPage(hit.pageId, hit.title), mention });
        }
        return { rows, capped: false };
      })();
    },
    ...(input.canWrite
      ? {
          async link(row: MentionRow) {
            if (input.flushAll && !(await input.flushAll())) return "changed" as const;
            let current: { title: string } = { title: row.page.title };
            return linkMention(
              {
                async read() {
                  try {
                    const got = await client.getPage(workspace, row.page.ref);
                    current = { title: got.metadata.title };
                    return { source: got.markdown, hash: got.revision.id };
                  } catch (error) {
                    if (error instanceof ProblemError && error.status === 404) return null;
                    throw error;
                  }
                },
                // The page keeps its title and place: only its text changes.
                write: (markdown, expected) => client.putPage(workspace, row.page.ref, { title: current.title, markdown }, expected),
                isConflict: (e) => e instanceof RevisionConflict,
              },
              title,
              row.mention,
              // The mention's own words are the label: they are already in that page, so the link adds no title.
              (found) => wikilinkFor(`${PAGE_LINK_PREFIX}${page}`, found.text, found.inTable),
            );
          },
        }
      : {}),
  };
}
