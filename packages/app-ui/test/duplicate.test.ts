// Duplicate in a workspace (ADR-0047), without a window: names, what is copied and in which order, links inside the
// copied set, structure only, the page limit, and the clean-up after a failure part-way.
import { describe, expect, it } from "vitest";
import { newStableId } from "@thoth/domain";
import type { PageResource, PageWrite, TreeNode } from "@thoth/workspace-protocol";
import { copyName } from "../src/order/duplicate.ts";
import { DuplicateQuota, duplicateInWorkspace } from "../src/workspace/duplicate.ts";
import { folderMarkdown, withFolderColor } from "../src/workspace/folders.ts";
import { en } from "../src/strings/en.ts";
import { th } from "../src/strings/th.ts";

describe("the copy's name", () => {
  it("is “(copy)”, then “(copy 2)”… in English and “(สำเนา)”… in Thai, skipping names that are taken", () => {
    const taken = new Set(["Plan (copy)", "Plan (copy 2)"]);
    expect(copyName((c) => !taken.has(c), (n) => en.tree.copyName("Plan", n))).toBe("Plan (copy 3)");
    expect(copyName(() => true, (n) => en.tree.copyName("Plan", n))).toBe("Plan (copy)");
    expect(copyName((c) => c !== "แผน (สำเนา)", (n) => th.tree.copyName("แผน", n))).toBe("แผน (สำเนา 2)");
    expect(() => copyName(() => false, (n) => en.tree.copyName("Plan", n))).toThrow();
  });
});

/** An in-memory workspace: pages by id, and every call made. */
function fakeWorkspace() {
  const pages = new Map<string, { markdown: string; title: string; parentId: string | null; position?: string; revision: number }>();
  const calls: string[] = [];
  let failOnPut: number | null = null;
  let puts = 0;
  const resource = (id: string): PageResource => {
    const p = pages.get(id)!;
    return {
      id,
      markdown: p.markdown,
      revision: { id: `${id}@${p.revision}`, contentHash: "h" } as PageResource["revision"],
      metadata: { workspaceId: "ws", parentId: p.parentId, title: p.title, ...(p.position ? { position: p.position } : {}) } as PageResource["metadata"],
    };
  };
  const client = {
    async getPage(_ws: string, id: string) {
      calls.push(`GET ${id}`);
      return resource(id);
    },
    async putPage(_ws: string, id: string, write: PageWrite, expected: string | null) {
      calls.push(`PUT ${id}`);
      if (expected !== null || pages.has(id)) throw new Error("would replace a page");
      if (++puts === failOnPut) throw new Error("The network went away.");
      pages.set(id, { markdown: write.markdown, title: write.title, parentId: write.parentId ?? null, ...(write.position ? { position: write.position } : {}), revision: 1 });
      return resource(id);
    },
    async deletePage(_ws: string, id: string, expected: string) {
      calls.push(`DELETE ${id}`);
      if (expected !== `${id}@${pages.get(id)?.revision}`) throw new Error("stale");
      pages.delete(id);
    },
  };
  const add = (title: string, markdown: string, parentId: string | null = null, position?: string) => {
    const id = newStableId();
    pages.set(id, { title, markdown, parentId, ...(position ? { position } : {}), revision: 1 });
    return id;
  };
  const nodes = (): TreeNode[] => [...pages].map(([id, p]) => ({ id, parentId: p.parentId, title: p.title, position: p.position ?? null, revisionId: `${id}@${p.revision}`, updatedAt: "2026-11-02T00:00:00Z" }));
  return { pages, calls, client, add, nodes, failOn: (n: number) => void (failOnPut = n) };
}

describe("duplicateInWorkspace", () => {
  const seed = () => {
    const w = fakeWorkspace();
    const folder = w.add("Projects", withFolderColor(folderMarkdown(newStableId()), "blue"));
    const plan = w.add("Plan", "", folder, "b");
    const notes = w.add("Notes", "", folder, "a");
    const outside = w.add("Outside", "# Outside\n");
    const image = newStableId();
    w.pages.get(plan)!.markdown = `# Plan\n\nSee [the notes](thoth:page/${notes}) and [[thoth:page/${outside}|Outside]].\n\n![chart](thoth:attachment/${image})\n`;
    w.pages.get(notes)!.markdown = `# Notes\n\nBack to [plan](thoth:page/${plan}).\n`;
    return { w, folder, plan, notes, outside, image };
  };

  it("copies a folder and everything in it, parents first, keeping order, color, and links inside the copied set", async () => {
    const { w, folder, plan, notes, outside, image } = seed();
    const made = await duplicateInWorkspace(w.client, { workspace: "ws", nodes: w.nodes(), rootId: folder, parentId: null, title: "Projects (copy)", structureOnly: false, ordered: true });
    expect(made.map((p) => p.metadata.title)).toEqual(["Projects (copy)", "Plan", "Notes"]);
    const [copy, planCopy, notesCopy] = made.map((p) => w.pages.get(p.id)!);
    expect(copy!.markdown).toContain("thoth_kind: folder");
    expect(copy!.markdown).toContain("thoth_color: blue");
    expect(copy!.markdown).toContain(`thoth_id: ${made[0]!.id}`);
    expect([planCopy!.parentId, notesCopy!.parentId]).toEqual([made[0]!.id, made[0]!.id]);
    // The pages inside keep their positions, so they sort as the originals do.
    expect([planCopy!.position, notesCopy!.position]).toEqual(["b", "a"]);
    // Inside the set: the copies. Outside, and the image: as written.
    expect(planCopy!.markdown).toBe(`# Plan\n\nSee [the notes](thoth:page/${made[2]!.id}) and [[thoth:page/${outside}|Outside]].\n\n![chart](thoth:attachment/${image})\n`);
    expect(notesCopy!.markdown).toBe(`# Notes\n\nBack to [plan](thoth:page/${made[1]!.id}).\n`);
    // The originals are untouched, and nothing was written over.
    expect(w.pages.get(plan)!.markdown).toContain(`thoth:page/${notes}`);
    expect(w.calls.filter((c) => c.startsWith("PUT")).every((c) => !w.calls.includes(`GET ${c.slice(4)}`))).toBe(true);
  });

  it("names the copy in its text too, when the text names the title", async () => {
    const w = fakeWorkspace();
    const page = w.add("Roadmap", "# Roadmap\n\nBody\n");
    const [copy] = await duplicateInWorkspace(w.client, { workspace: "ws", nodes: w.nodes(), rootId: page, parentId: null, title: "Roadmap (copy)", structureOnly: false, ordered: false });
    expect(w.pages.get(copy!.id)!.markdown).toBe("# Roadmap (copy)\n\nBody\n");
  });

  it("structure only: each page keeps only its title; folder pages keep their folder frontmatter and color", async () => {
    const { w, folder } = seed();
    const made = await duplicateInWorkspace(w.client, { workspace: "ws", nodes: w.nodes(), rootId: folder, parentId: null, title: "Projects (copy)", structureOnly: true, ordered: true });
    expect(made.map((p) => [p.metadata.title, w.pages.get(p.id)!.markdown])).toEqual([
      ["Projects (copy)", withFolderColor(folderMarkdown(made[0]!.id), "blue")],
      ["Plan", ""],
      ["Notes", ""],
    ]);
  });

  it("refuses a copy that does not fit in the page limit, before writing anything", async () => {
    const { w, folder } = seed();
    const run = duplicateInWorkspace(w.client, { workspace: "ws", nodes: w.nodes(), rootId: folder, parentId: null, title: "Projects (copy)", structureOnly: false, ordered: true, maxPages: 6 });
    await expect(run).rejects.toEqual(new DuplicateQuota(6, 4, 3));
    expect(w.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
  });

  it("deletes what it created, newest first, when a write fails part-way", async () => {
    const { w, folder } = seed();
    const before = [...w.pages.keys()];
    w.failOn(3);
    await expect(duplicateInWorkspace(w.client, { workspace: "ws", nodes: w.nodes(), rootId: folder, parentId: null, title: "Projects (copy)", structureOnly: false, ordered: true })).rejects.toThrow("The network went away.");
    const puts = w.calls.filter((c) => c.startsWith("PUT")).map((c) => c.slice(4));
    const deletes = w.calls.filter((c) => c.startsWith("DELETE")).map((c) => c.slice(7));
    expect(deletes).toEqual([puts[1], puts[0]]);
    expect([...w.pages.keys()]).toEqual(before);
  });
});
