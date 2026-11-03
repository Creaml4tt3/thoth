// Connections in a workspace (ADR-0050 rule 7) over a fake client: only pages in the reader's tree are listed, a page
// limited to teams they are not in (absent from their tree) never shows, a mention is linked by ID with its own words,
// and a server without search lists only links.
import { describe, expect, it } from "vitest";
import type { TreeNode } from "@thoth/workspace-protocol";
import { workspaceConnectionsSource } from "../src/workspace/workspace-connections.ts";

const ID = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const ATLAS = ID(1);
const NOTES = ID(2);
const INDEX = ID(3);
const HIDDEN = ID(4);
const ROADMAP = ID(5);

const node = (id: string, title: string): TreeNode => ({ id, parentId: null, title, revisionId: "r", updatedAt: "2026-11-04T00:00:00Z" });

function fakeClient() {
  const pages = new Map<string, { title: string; markdown: string; rev: number }>([
    [ATLAS, { title: "Atlas", markdown: `# Atlas\n\nSee [[thoth:page/${ROADMAP}|Roadmap]] and [[thoth:page/${HIDDEN}]].\n`, rev: 1 }],
    [NOTES, { title: "Notes", markdown: "# Notes\n\nWe talked about atlas.\n", rev: 1 }],
    [INDEX, { title: "Index", markdown: `# Index\n\n[[thoth:page/${ATLAS}]] Atlas.\n`, rev: 1 }],
    [HIDDEN, { title: "Secret plans", markdown: `Atlas [[thoth:page/${ATLAS}]]`, rev: 1 }],
    [ROADMAP, { title: "Roadmap", markdown: "# Roadmap\n", rev: 1 }],
  ]);
  const writes: { id: string; markdown: string; expected: string | null }[] = [];
  const resource = (id: string) => {
    const p = pages.get(id)!;
    return { id, markdown: p.markdown, revision: { id: `rev-${p.rev}` }, metadata: { title: p.title } };
  };
  const client = {
    async getPage(_w: string, id: string) {
      return resource(id) as never;
    },
    async putPage(_w: string, id: string, write: { markdown: string }, expected: string | null) {
      writes.push({ id, markdown: write.markdown, expected });
      const p = pages.get(id)!;
      p.markdown = write.markdown;
      p.rev++;
      return resource(id) as never;
    },
    // The real server leaves out pages the reader may not see; the source must not rely on that alone.
    async search(_w: string, request: { query: string }) {
      const q = request.query.toLowerCase();
      return { items: [...pages].filter(([, p]) => p.markdown.toLowerCase().includes(q)).map(([id, p]) => ({ pageId: id, title: p.title, revisionId: "r", snippet: "", score: 1 })), nextCursor: null } as never;
    },
  };
  return { client, writes, pages };
}

const visible = [node(ATLAS, "Atlas"), node(NOTES, "Notes"), node(INDEX, "Index"), node(ROADMAP, "Roadmap")];
const source = (client: ReturnType<typeof fakeClient>["client"], extra: { canSearch?: boolean; canWrite?: boolean } = {}) =>
  workspaceConnectionsSource({ client, workspace: "w", page: ATLAS, title: "Atlas", nodes: visible, canSearch: extra.canSearch ?? true, canWrite: extra.canWrite ?? true, tick: 0, open: () => undefined });

describe("workspace connections", () => {
  it("lists only pages in the reader's tree: a hidden page and its title never show", async () => {
    const { client } = fakeClient();
    const src = source(client);
    expect(await src.links()).toEqual([{ ref: ROADMAP, title: "Roadmap" }]);
    expect(await src.backlinks()).toEqual([{ ref: INDEX, title: "Index" }]);
    const { rows } = await src.mentions()!;
    expect(rows.map((r) => [r.page.title, r.mention.text])).toEqual([["Notes", "atlas"]]);
    expect(JSON.stringify([await src.links(), await src.backlinks(), rows])).not.toContain("Secret");
  });

  it("links a mention by ID, with the words as written, on the revision it read", async () => {
    const { client, writes, pages } = fakeClient();
    const src = source(client);
    const [row] = (await src.mentions()!).rows;
    expect(await src.link!(row!)).toBe("linked");
    expect(writes).toEqual([{ id: NOTES, markdown: `# Notes\n\nWe talked about [[thoth:page/${ATLAS}|atlas]].\n`, expected: "rev-1" }]);
    expect(pages.get(NOTES)!.title).toBe("Notes");
  });

  it("has no Link for a viewer, and only links without search", async () => {
    const { client } = fakeClient();
    expect(source(client, { canWrite: false }).link).toBeUndefined();
    const noSearch = source(client, { canSearch: false });
    expect(noSearch.backlinks()).toBeNull();
    expect(noSearch.mentions()).toBeNull();
    expect(await noSearch.links()).toHaveLength(1);
  });
});
