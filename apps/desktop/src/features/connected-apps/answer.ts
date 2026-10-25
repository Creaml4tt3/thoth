/**
 * A window's answer to a connected app's request (ADR-0021): the app's tool call, run on this window's open Vault.
 * The host checked the arguments and chose this window; only pages in the index are found (never `.thoth/`, an
 * attachment or a path outside the Private Space), and attachments are named, never read.
 */
import type { Vault } from "@thoth/local-store";
import type { McpAnswer, McpRequest } from "@thoth/platform";
import type { PageSummary } from "@thoth/domain";

class NotFound extends Error {}

export async function answerRequest(vault: Vault, request: McpRequest): Promise<McpAnswer> {
  try {
    return { result: await run(vault, request) };
  } catch (error) {
    if (error instanceof NotFound) return { error: { code: "NOT_FOUND", message: error.message } };
    return { error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } };
  }
}

async function run(vault: Vault, request: McpRequest): Promise<unknown> {
  switch (request.tool) {
    case "search": {
      const hits = await vault.search(request.args.query, request.args.limit);
      return { hits: hits.map((h) => ({ id: h.id, path: h.path, title: h.title, snippet: h.snippet })) };
    }
    case "list_pages": {
      const prefix = request.args.folder === "" ? "" : `${request.args.folder}/`;
      const pages = (await vault.listPages()).filter((p) => p.path.startsWith(prefix));
      return { pages: pages.slice(0, request.args.limit).map(summary), total: pages.length };
    }
    case "read_page": {
      const page = await find(vault, request, request.args);
      const read = await vault.readPage(page.path);
      const attachments = new Set((await vault.listAttachments()).map((a) => a.path));
      const linked = (await vault.outgoingLinks(page.path)).flatMap((l) => (l.targetPath !== null && attachments.has(l.targetPath) ? [l.targetPath] : []));
      return { page: { ...summary(page), markdown: read.source, attachments: [...new Set(linked)] } };
    }
    case "backlinks": {
      const page = await find(vault, request, request.args);
      const links = await vault.backlinks(page.path);
      return {
        page: summary(page),
        links: links.slice(0, request.args.limit).map((l) => ({ id: l.sourceId, path: l.sourcePath, title: l.sourceTitle, line: l.line })),
        total: links.length,
      };
    }
  }
}

function summary(page: PageSummary): { id: string; path: string; title: string } {
  return { id: page.id, path: page.path, title: page.title };
}

/** The indexed page named by path or stable id. */
async function find(vault: Vault, request: McpRequest, args: { path: string } | { id: string }): Promise<PageSummary> {
  const named = "path" in args ? args.path : args.id;
  let page: PageSummary | undefined;
  try {
    page = "path" in args ? await vault.pageByPath(args.path) : (await vault.listPages()).find((p) => p.id === args.id);
  } catch {
    page = undefined; // not a path a page can have
  }
  if (!page) throw new NotFound(`No page ${named} in ${request.space}`);
  return page;
}
