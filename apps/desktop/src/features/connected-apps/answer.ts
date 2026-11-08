/**
 * A window's answer to a connected app's request (ADR-0021): the app's tool call, run on this window's open Vault.
 * The host checked the arguments and chose this window; only pages in the index are found (never `.thoth/`, an
 * attachment or a path outside the Private Space), and attachments are named, never read.
 *
 * Memory tools (ADR-0052) read and change only the memory folder the host names (`@thoth/local-store`'s memory module
 * checks it and the path again): a change is worked out first and written only when the host asks with `memory_commit`.
 */
import {
  MemoryError,
  ageDays,
  checkMemoryFolder,
  memoryFolderUse,
  commitForget,
  commitMemory,
  isStale,
  listMemories,
  planForget,
  planRemember,
  planUpdate,
  recallMemories,
  listSkills,
  readSkill,
  type Memory,
  type Vault,
} from "@thoth/local-store";
import type { McpAnswer, McpAnswerCode, McpRequest } from "@thoth/platform";
import type { PageSummary } from "@thoth/domain";
import { ProblemError } from "@thoth/workspace-client";
import { planToday } from "../shell/today.ts";
import { teamList, teamRecall, teamRemember, type TeamClient } from "./team.ts";

class NotFound extends Error {}

export interface AnswerOptions {
  /** Moves a file to the system Trash (`forget`); absent where there is none. */
  trash?: (path: string) => Promise<void>;
  /** The workspace client of a server the user is signed in to, for Team memory (ADR-0052 rule 8). */
  team?: (server: string) => TeamClient;
  now?: () => Date;
}

export async function answerRequest(vault: Vault, request: McpRequest, options: AnswerOptions = {}): Promise<McpAnswer> {
  try {
    return { result: await run(vault, request, options.now?.() ?? new Date(), options) };
  } catch (error) {
    if (error instanceof NotFound) return { error: { code: "NOT_FOUND", message: error.message } };
    if (error instanceof MemoryError) return { error: { code: error.code, message: error.message } };
    // A workspace server's refusal (Team memory), in the codes apps already know.
    if (error instanceof ProblemError) {
      const code = ({ forbidden: "DENIED", not_found: "NOT_FOUND", revision_conflict: "CONFLICT", payload_too_large: "TOO_LARGE", quota_exceeded: "TOO_MANY", unauthenticated: "DENIED" } as Record<string, McpAnswerCode>)[error.code];
      const message = error.code === "unauthenticated" ? "The user is signed out of this workspace's server in Thoth: ask them to sign in again" : error.message;
      return { error: { code: code ?? "INTERNAL", message } };
    }
    return { error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } };
  }
}

async function run(vault: Vault, request: McpRequest, now: Date, options: AnswerOptions): Promise<unknown> {
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
      let args = request.args;
      if ("today" in args) {
        const today = await planToday(vault, now);
        // Not there yet: the host proposes it as a new page, started as Today would start it.
        if (!today.existing) return { page: null, today: { path: today.path, markdown: today.text } };
        await vault.reconcile({ changed: [today.path] }).catch(() => undefined);
        args = { path: today.path };
      }
      const page = await find(vault, request, args);
      const read = await vault.readPage(page.path);
      const attachments = new Set((await vault.listAttachments()).map((a) => a.path));
      const linked = (await vault.outgoingLinks(page.path)).flatMap((l) => (l.targetPath !== null && attachments.has(l.targetPath) ? [l.targetPath] : []));
      // `hash`: the version a proposal is made from and checked against when applied (ADR-0048).
      return { page: { ...summary(page), markdown: read.source, hash: read.hash, attachments: [...new Set(linked)] } };
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
    case "recall": {
      const found = await recallMemories(vault, { ...request.args, folder: checkMemoryFolder(request.args.folder) }, now);
      return { about: found.about && memoryOut(found.about, now, true), memories: found.memories.map((m) => memoryOut(m, now, true)), total: found.total };
    }
    case "list_memories": {
      const found = await listMemories(vault, { ...request.args, folder: checkMemoryFolder(request.args.folder) });
      return { memories: found.memories.map((m) => memoryOut(m, now, false)), total: found.total };
    }
    case "memory_change": {
      const args = { ...request.args, folder: checkMemoryFolder(request.args.folder) };
      if (args.op === "remember") return planRemember(vault, args, now);
      if (args.op === "update") return planUpdate(vault, args, now);
      return planForget(vault, args.page, args.folder);
    }
    case "memory_commit": {
      const args = request.args;
      const folder = checkMemoryFolder(args.folder);
      if (args.op === "write") return { hash: await commitMemory(vault, args.path, args.text, args.expected, now, folder) };
      if (!options.trash) throw new Error("This window cannot move files to the Trash");
      await commitForget(vault, options.trash, args.path, args.expected, now, folder);
      return {};
    }
    case "memory_folder":
      return memoryFolderUse(vault, checkMemoryFolder(request.args.folder));
    case "team_recall":
    case "team_list":
    case "team_remember": {
      if (!options.team) throw new Error("This window cannot reach workspaces");
      const client = options.team(request.args.server);
      if (request.tool === "team_remember") return teamRemember(client, request.args, now);
      if (request.tool === "team_list") {
        const found = await teamList(client, request.args);
        return { memories: found.memories.map((m) => memoryOut(m, now, false)), total: found.total };
      }
      const found = await teamRecall(client, request.args, now);
      return { about: null, memories: found.memories.map((m) => memoryOut(m, now, true)), total: found.total };
    }
    case "list_skills":
      return { skills: await listSkills(vault) };
    case "get_skill":
      return { skill: await readSkill(vault, request.args.name, request.args.file) };
  }
}

/** A memory as the host builds answers from it; `text` only for recall. */
function memoryOut(m: Memory, now: Date, withText: boolean) {
  const out = {
    path: m.path,
    id: m.id,
    kind: m.kind,
    title: m.title,
    source: m.source,
    created: m.created,
    updated: m.updated,
    updatedBy: m.updatedBy,
    topic: m.topic,
    tags: m.tags,
    certainty: m.certainty,
    ageDays: ageDays(m, now),
    stale: isStale(m, now),
  };
  return withText ? { ...out, text: m.text } : out;
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
