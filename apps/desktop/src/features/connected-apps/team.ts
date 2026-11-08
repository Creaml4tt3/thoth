/**
 * A workspace's Team memory (ADR-0052 rule 8), for connected apps: the window reads the memory pages from the
 * workspace's server and sends an agent's memory there as a proposal, both as the signed-in user, so the server's roles
 * and hidden folders apply. The server keeps the proposal for review (or applies it at once when the workspace turned
 * review off); nothing is written to the Private Space.
 */
import { updateFrontmatter } from "@thoth/content";
import {
  MAX_MEMORY_BYTES,
  MemoryError,
  cleanMemoryText,
  cleanTags,
  localIso,
  matches,
  memoryTitleOf,
  parseMemory,
  readAtStart,
  rewriteMemory,
  sameMemoryTopic,
  statedMemoryError,
  type Memory,
} from "@thoth/local-store";
import type { McpMemoryChange, McpMemoryFilter, TeamTarget } from "@thoth/platform";
import type { WorkspaceClient } from "@thoth/workspace-client";
import { TEAM_MEMORY_FOLDER } from "@thoth/workspace-protocol";

/** What Team memory needs of a workspace client. */
export type TeamClient = Pick<WorkspaceClient, "getTeamMemory" | "getTree" | "getPage" | "proposeTeamMemory" | "listTeamMemoryProposals" | "getTeamMemoryProposal" | "settleTeamMemoryProposal" | "setTeamMemoryReview">;

/** The most memory pages read for one call. shortcut: every page is read each call; a cache by revision would be the upgrade if folders grow. */
const MAX_READ = 200;
const MAX_TITLE = 200;

interface TeamMemory extends Memory {
  pageId: string;
}

/** The memories in the workspace's Team memory folder (its direct pages), as the caller may see them. */
async function load(client: TeamClient, workspace: string): Promise<TeamMemory[]> {
  const { folderId } = await client.getTeamMemory(workspace);
  if (folderId === null) return [];
  const pages = (await client.getTree(workspace)).nodes.filter((n) => n.parentId === folderId && n.kind !== "folder").slice(0, MAX_READ);
  const read = await Promise.all(
    pages.map(async (node): Promise<TeamMemory | null> => {
      const page = await client.getPage(workspace, node.id).catch(() => null);
      if (!page) return null;
      const memory = parseMemory(`${TEAM_MEMORY_FOLDER}/${node.title}.md`, page.markdown, page.revision.id, { id: node.id, fileTime: node.updatedAt }, TEAM_MEMORY_FOLDER);
      return { ...memory, title: node.title, pageId: node.id };
    }),
  );
  return read.filter((m): m is TeamMemory => m !== null);
}

const newestFirst = (a: Memory, b: Memory) => Date.parse(b.updated) - Date.parse(a.updated) || a.path.localeCompare(b.path);

/** Every word of `query` in the memory's title, text, topic or tags (case ignored). */
function found(memory: Memory, query: string): boolean {
  const haystack = [memory.title, memory.text, memory.topic ?? "", ...memory.tags].join("\n").toLocaleLowerCase();
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

/** `recall` in Team memory: with a query, the memories that have every word; without, what is read at the start first. */
export async function teamRecall(client: TeamClient, args: McpMemoryFilter & TeamTarget & { query?: string; limit: number }, now: Date) {
  let memories = (await load(client, args.workspace)).filter((m) => matches(m, args));
  memories = args.query ? memories.filter((m) => found(m, args.query!)).sort(newestFirst) : memories.sort((a, b) => Number(readAtStart(b, now)) - Number(readAtStart(a, now)) || newestFirst(a, b));
  return { about: null, memories: memories.slice(0, args.limit), total: memories.length };
}

export async function teamList(client: TeamClient, args: McpMemoryFilter & TeamTarget & { source?: string; limit: number }) {
  const memories = (await load(client, args.workspace)).filter((m) => matches(m, args)).sort(newestFirst);
  return { memories: memories.slice(0, args.limit), total: memories.length };
}

/**
 * `remember` and `update_memory` in Team memory: the page worked out as in a Private Space (the same frontmatter and
 * rules: one topic per memory, a stated memory never replaced by an inferred one), then sent to the server as a
 * proposal from the signed-in user, made from the page's revision.
 */
export async function teamRemember(client: TeamClient, args: McpMemoryChange & TeamTarget, now: Date): Promise<{ status: "pending" | "applied"; proposal: string; title: string }> {
  const memories = await load(client, args.workspace);
  const stamp = localIso(now);
  let proposal: { title: string; markdown: string; pageId?: string; baseRevision?: string };
  if (args.op === "remember") {
    const body = cleanMemoryText(args.text, MAX_MEMORY_BYTES);
    const topic = args.topic?.trim() || null;
    const title = (args.title?.trim() || memoryTitleOf(body)).slice(0, MAX_TITLE);
    const tags = args.tags === undefined ? undefined : cleanTags(args.tags);
    const existing = topic === null ? undefined : memories.find((m) => sameMemoryTopic(m.topic, topic));
    if (existing) {
      if (existing.certainty === "stated" && args.certainty !== "stated") throw statedMemoryError(existing.path);
      const page = await client.getPage(args.workspace, existing.pageId);
      const markdown = rewriteMemory(page.markdown, body, { kind: args.kind, updated: stamp, updated_by: args.app, ...(tags ? { tags: tags.length > 0 ? tags : undefined } : {}), certainty: args.certainty });
      proposal = { title: existing.title, markdown, pageId: existing.pageId, baseRevision: page.revision.id };
    } else {
      const fields: Record<string, unknown> = { kind: args.kind, title, source: args.app, created: stamp, updated: stamp, updated_by: args.app };
      if (topic) fields.topic = topic;
      if (tags && tags.length > 0) fields.tags = tags;
      fields.certainty = args.certainty;
      proposal = { title, markdown: updateFrontmatter(`${body}\n`, fields) };
    }
  } else if (args.op === "update") {
    const named = "path" in args.page ? args.page.path : args.page.id;
    const memory = memories.find((m) => ("path" in args.page ? m.path.toLowerCase() === args.page.path.toLowerCase() : m.pageId === args.page.id || m.id === args.page.id));
    if (!memory) throw new MemoryError("NOT_FOUND", `No memory ${named} in the Team memory folder`);
    const page = await client.getPage(args.workspace, memory.pageId);
    if (args.expected !== undefined && args.expected !== page.revision.id) throw new MemoryError("CONFLICT", `${memory.path} changed since version ${args.expected}: recall it again, then update it.`);
    if (memory.certainty === "stated" && args.certainty !== "stated") throw statedMemoryError(memory.path);
    let body = memory.text;
    if (args.text !== undefined) body = args.text;
    else
      for (const [n, r] of (args.replacements ?? []).entries()) {
        const at = body.indexOf(r.find);
        if (at === -1 || body.indexOf(r.find, at + 1) !== -1) throw new MemoryError("BAD_ARGUMENT", `replacements[${n}]: find must be in the memory exactly once: recall it again and copy the text`);
        body = body.slice(0, at) + r.replace + body.slice(at + r.find.length);
      }
    body = cleanMemoryText(body, MAX_MEMORY_BYTES);
    if (body === memory.text && args.certainty === undefined) throw new MemoryError("BAD_ARGUMENT", "That would not change the memory");
    const markdown = rewriteMemory(page.markdown, body, { updated: stamp, updated_by: args.app, ...(args.certainty ? { certainty: args.certainty } : {}) });
    proposal = { title: memory.title, markdown, pageId: memory.pageId, baseRevision: page.revision.id };
  } else {
    throw new MemoryError("BAD_ARGUMENT", "Team memories are not forgotten by apps");
  }
  const made = await client.proposeTeamMemory(args.workspace, { agent: args.app, ...proposal });
  return { status: made.status === "applied" ? "applied" : "pending", proposal: made.id, title: made.title };
}
