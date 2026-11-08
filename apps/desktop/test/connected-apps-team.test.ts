/**
 * A workspace's Team memory for connected apps (ADR-0052 rule 8), against a fake workspace client: the window reads the
 * memory pages of the Team memory folder, works out an agent's memory as in a Private Space, and sends it to the server
 * as a proposal from the page's revision; the server's refusals reach the app in the codes it knows.
 */
import { describe, expect, it } from "vitest";
import type { McpRequest } from "@thoth/platform";
import type { TeamMemoryPropose, TeamMemoryProposal } from "@thoth/workspace-protocol";
import { ProblemError } from "@thoth/workspace-client";
import { answerRequest } from "../src/features/connected-apps/answer.ts";
import type { TeamClient } from "../src/features/connected-apps/team.ts";
import type { Vault } from "@thoth/local-store";

const NOW = new Date("2026-11-08T03:00:00Z");
const TEA = "---\nkind: preference\ntitle: Tea\nsource: Cursor\nupdated: 2026-11-01T10:00:00+07:00\ntopic: drink\ncertainty: inferred\n---\nThe team drinks tea.\n";
const PLAN = "---\nkind: work\nupdated: 2025-01-01T10:00:00+07:00\ncertainty: stated\n---\nLaunch in March.\n";

function fakeClient(options: { folder?: string | null; fail?: ProblemError } = {}) {
  const pages: Record<string, { title: string; markdown: string; revision: string }> = { p1: { title: "Tea", markdown: TEA, revision: "r1" }, p2: { title: "Launch plan", markdown: PLAN, revision: "r2" } };
  const proposed: TeamMemoryPropose[] = [];
  const folder = options.folder === undefined ? "f1" : options.folder;
  const client = {
    getTeamMemory: async () => ({ review: true, folderId: folder }),
    getTree: async () => ({
      nodes: [
        { id: "f1", parentId: null, title: "Team memory", kind: "folder" as const, revisionId: "rf", updatedAt: "2026-11-01T00:00:00Z" },
        ...Object.entries(pages).map(([id, p]) => ({ id, parentId: "f1", title: p.title, kind: "page" as const, revisionId: p.revision, updatedAt: "2026-11-01T00:00:00Z" })),
        { id: "x", parentId: null, title: "Elsewhere", kind: "page" as const, revisionId: "rx", updatedAt: "2026-11-01T00:00:00Z" },
      ],
      changeCursor: "c",
    }),
    getPage: async (_ws: string, id: string) => ({ markdown: pages[id]!.markdown, revision: { id: pages[id]!.revision } }),
    proposeTeamMemory: async (_ws: string, memory: TeamMemoryPropose): Promise<TeamMemoryProposal> => {
      if (options.fail) throw options.fail;
      proposed.push(memory);
      return { id: "mem_1", status: "pending", agent: memory.agent, authorId: "u1", authorName: "Ploy", title: memory.title, pageId: memory.pageId ?? null, baseRevision: memory.baseRevision ?? null, createdAt: NOW.toISOString(), expiresAt: null, settledAt: null, settledBy: null, settledByName: null, appliedRevision: null };
    },
  } as unknown as TeamClient;
  return { client, proposed };
}

const base = { id: "q", owner: "main", root: "workspace:srv/ws", space: "Studio" } as const;
const target = { server: "srv", workspace: "ws" };
const ask = (client: TeamClient, request: Omit<McpRequest, "id" | "owner" | "root" | "space">) =>
  answerRequest({} as Vault, { ...base, ...request } as McpRequest, { now: () => NOW, team: () => client });

describe("Team memory for connected apps (ADR-0052 rule 8)", () => {
  it("recalls the memories of the Team memory folder, with the check-it hint, and lists them", async () => {
    const { client } = fakeClient();
    const recalled = (await ask(client, { tool: "team_recall", args: { ...target, limit: 10 } })) as { result: { about: null; memories: { path: string; title: string; stale: boolean; text: string }[]; total: number } };
    expect(recalled.result.total).toBe(2);
    expect(recalled.result.memories.map((m) => [m.title, m.stale])).toEqual([["Tea", false], ["Launch plan", true]]);
    expect(recalled.result.memories[0]!.text).toBe("The team drinks tea.");
    const found = (await ask(client, { tool: "team_recall", args: { ...target, query: "MARCH", limit: 10 } })) as { result: { memories: { title: string }[] } };
    expect(found.result.memories.map((m) => m.title)).toEqual(["Launch plan"]);
    const listed = (await ask(client, { tool: "team_list", args: { ...target, kind: "work", limit: 10 } })) as { result: { memories: { title: string; text?: string }[] } };
    expect(listed.result.memories).toEqual([expect.objectContaining({ title: "Launch plan" })]);
    expect(listed.result.memories[0]!.text).toBeUndefined();
    // No folder yet: nothing to recall.
    expect(await ask(fakeClient({ folder: null }).client, { tool: "team_recall", args: { ...target, limit: 10 } })).toEqual({ result: { about: null, memories: [], total: 0 } });
  });

  it("proposes a new memory, or a change from the page's revision for the same topic, never over a stated one", async () => {
    const { client, proposed } = fakeClient();
    const remember = (more: object) => ask(client, { tool: "team_remember", args: { ...target, op: "remember", text: "Standups are at ten.", kind: "work", certainty: "inferred", app: "Claude Code", ...more } as never });
    expect(await remember({ topic: "standup" })).toEqual({ result: { status: "pending", proposal: "mem_1", title: "Standups are at ten." } });
    expect(proposed[0]).toMatchObject({ agent: "Claude Code", title: "Standups are at ten." });
    expect(proposed[0]!.pageId).toBeUndefined();
    expect(proposed[0]!.markdown).toContain("source: Claude Code");

    expect(await remember({ topic: "Drink", text: "The team drinks green tea." })).toMatchObject({ result: { status: "pending" } });
    expect(proposed[1]).toMatchObject({ title: "Tea", pageId: "p1", baseRevision: "r1" });
    expect(proposed[1]!.markdown).toContain("The team drinks green tea.");

    const stated = await ask(client, { tool: "team_remember", args: { ...target, op: "update", page: { path: "Team memory/Launch plan.md" }, text: "Launch in April.", app: "Codex" } as never });
    expect(stated).toEqual({ error: { code: "STATED", message: expect.stringContaining("Ask the user") } });
    const ok = await ask(client, { tool: "team_remember", args: { ...target, op: "update", page: { id: "p2" }, text: "Launch in April.", certainty: "stated", app: "Codex" } as never });
    expect(ok).toMatchObject({ result: { title: "Launch plan" } });
    expect(proposed[2]).toMatchObject({ pageId: "p2", baseRevision: "r2" });
    expect(await ask(client, { tool: "team_remember", args: { ...target, op: "update", page: { id: "p2" }, text: "x", expected: "old", certainty: "stated", app: "Codex" } as never })).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await ask(client, { tool: "team_remember", args: { ...target, op: "update", page: { id: "nope" }, text: "x", app: "Codex" } as never })).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("passes the server's refusals on in the codes apps know", async () => {
    const problem = (code: string, status: number) => new ProblemError({ type: "about:blank", title: code, status, code, detail: `${code} here` } as never);
    for (const [code, status, want] of [["forbidden", 403, "DENIED"], ["quota_exceeded", 409, "TOO_MANY"], ["unauthenticated", 401, "DENIED"], ["internal_error", 500, "INTERNAL"]] as const) {
      const { client } = fakeClient({ fail: problem(code, status) });
      const answer = await ask(client, { tool: "team_remember", args: { ...target, op: "remember", text: "x", kind: "note", certainty: "inferred", app: "Codex" } as never });
      expect(answer, code).toMatchObject({ error: { code: want } });
    }
  });
});
