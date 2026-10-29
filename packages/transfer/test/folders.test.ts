import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { folderMarkdown, folderNameForTitle, isFolderMarkdown, planInboundFolders, planOutboundFolders, type OperationRecord } from "../src/index.ts";
import { livePages, world, type World } from "./support.ts";

describe("folder helpers", () => {
  it("recognizes folder pages by their frontmatter only", () => {
    const id = "01890000-0000-7000-8000-000000000001";
    expect(folderMarkdown(id)).toBe(`---\nthoth_id: ${id}\nthoth_kind: folder\n---\n`);
    expect(isFolderMarkdown(folderMarkdown(id))).toBe(true);
    expect(isFolderMarkdown("---\nthoth_kind: page\n---\n# x\n")).toBe(false);
    expect(isFolderMarkdown("# thoth_kind: folder\n")).toBe(false);
    expect(isFolderMarkdown("---\nthoth_kind: folder\nthoth_kind: folder\n---\n")).toBe(false); // malformed
    expect(folderNameForTitle("a/b: c")).toBe("a-b- c");
  });

  it("plans the folders between the common folder (or a given base) and each page", () => {
    const plan = planOutboundFolders(["Work/A/x.md", "Work/A/B/y.md", "Work/z.md"]);
    expect(plan.base).toBe("Work");
    expect(plan.folders).toEqual([
      { path: "Work/A", parent: null },
      { path: "Work/A/B", parent: "Work/A" },
    ]);
    expect(Object.fromEntries(plan.parentOf)).toEqual({ "Work/A/x.md": "Work/A", "Work/A/B/y.md": "Work/A/B", "Work/z.md": null });
    // A whole folder selected: its parent is the base, so the folder itself travels.
    const whole = planOutboundFolders(["Work/A/x.md"], "Work");
    expect(whole.folders).toEqual([{ path: "Work/A", parent: null }]);
    expect(planOutboundFolders(["x.md", "y.md"]).folders).toEqual([]);
  });

  it("maps selected folder pages to folder chains", () => {
    const chains = planInboundFolders([
      { pageId: "f", parentId: null, title: "Team", folder: true },
      { pageId: "g", parentId: "f", title: "Q3/Q4", folder: true },
      { pageId: "p", parentId: "g", title: "Plan", folder: false },
      { pageId: "q", parentId: "not-selected", title: "Lone", folder: false },
      { pageId: "r", parentId: "p", title: "Under a page", folder: false },
    ]);
    expect(Object.fromEntries(chains)).toEqual({ f: [], g: ["Team"], p: ["Team", "Q3-Q4"], q: [], r: [] });
  });
});

describe("transfers with folders", () => {
  let w: World;
  afterEach(() => w?.close());

  it("Private → Workspace: folders become folder pages with the right parents; a move deletes the pages and the emptied folders", async () => {
    w = await world({ "Work/A/x.md": "# x\n", "Work/A/B/y.md": "# y\n", "Work/z.md": "# z\n" });
    const preview = await w.engine.previewToWorkspace({ server: w.server, workspace: w.ws.id, parentId: null, mode: "move", paths: ["Work/A/x.md", "Work/A/B/y.md", "Work/z.md"], attachments: false, base: "" });
    expect(preview.folders).toEqual(["Work", "Work/A", "Work/A/B"]);
    const done: OperationRecord = await w.engine.start(preview);
    expect(done.state).toBe("done");
    const remote = livePages(w.ws);
    const byTitle = new Map(remote.map((p) => [p.title, p]));
    expect([...byTitle.keys()].sort()).toEqual(["A", "B", "Work", "x", "y", "z"]);
    for (const name of ["Work", "A", "B"]) expect(isFolderMarkdown(byTitle.get(name)!.markdown)).toBe(true);
    expect(byTitle.get("Work")!.parentId).toBeNull();
    expect(byTitle.get("A")!.parentId).toBe(byTitle.get("Work")!.id);
    expect(byTitle.get("B")!.parentId).toBe(byTitle.get("A")!.id);
    expect(byTitle.get("x")!.parentId).toBe(byTitle.get("A")!.id);
    expect(byTitle.get("y")!.parentId).toBe(byTitle.get("B")!.id);
    expect(byTitle.get("z")!.parentId).toBe(byTitle.get("Work")!.id);
    // The pages left the vault, and the folders with them.
    expect(await w.exists("Work/A/x.md")).toBe(false);
    expect(await readdir(w.root)).not.toContain("Work");
    // Folder pages are not mapped to vault pages.
    expect((await w.vault.listExternalLocations()).length).toBe(3);
  });

  it("Private → Workspace: a moved folder goes with its pages, empty sub-folders too; one holding a kept page stays", async () => {
    w = await world({ "Work/x.md": "# x\n", "Work/y.md": "# y\n" });
    await w.vault.createFolder("Work/Empty");
    const sent = await w.engine.start(await w.engine.previewToWorkspace({ server: w.server, workspace: w.ws.id, parentId: null, mode: "move", paths: ["Work/x.md", "Work/y.md"], attachments: false, base: "" }));
    expect(sent.state).toBe("done");
    expect(await readdir(w.root)).not.toContain("Work");

    await w.close();
    w = await world({ "Work/x.md": "# x\n", "Work/y.md": "# y\n" });
    const preview = await w.engine.previewToWorkspace({ server: w.server, workspace: w.ws.id, parentId: null, mode: "move", paths: ["Work/x.md", "Work/y.md"], attachments: false, base: "" });
    const engine = await w.restart({ checkpoint: async (p) => (p === "after:commit" ? w.write("Work/y.md", "# y\n\nEdited meanwhile.\n") : undefined) });
    const kept = await engine.start(preview);
    expect(kept.state).toBe("destination_committed_source_cleanup_pending");
    expect(await readdir(join(w.root, "Work"))).toEqual(["y.md"]);
  });

  it("Workspace → Private: a folder page becomes a vault folder holding its pages; a move deletes all three on the server", async () => {
    w = await world({});
    const folder = w.servers.writeAsOther(w.ws, { id: "01890000-0000-7000-8000-0000000000f1", title: "Team notes", markdown: folderMarkdown("01890000-0000-7000-8000-0000000000f1") });
    const a = w.servers.writeAsOther(w.ws, { title: "Alpha", markdown: "# Alpha\n\nSee [[Beta]].\n", parentId: folder.id });
    const b = w.servers.writeAsOther(w.ws, { title: "Beta", markdown: "# Beta\n", parentId: folder.id });
    const preview = await w.engine.previewFromWorkspace({ server: w.server, workspace: w.ws.id, mode: "move", pageIds: [folder.id, a.id, b.id], folder: "Inbox" });
    expect(preview.problems).toEqual([]);
    expect(preview.pages.map((p) => [p.title, p.folder])).toEqual([["Team notes", true], ["Alpha", false], ["Beta", false]]);
    const done = await w.engine.start(preview);
    expect(done.state).toBe("done");
    expect(done.items.map((i) => i.destPath)).toEqual(["Inbox/Team notes", "Inbox/Team notes/Alpha.md", "Inbox/Team notes/Beta.md"]);
    expect((await readdir(join(w.root, "Inbox/Team notes"))).sort()).toEqual(["Alpha.md", "Beta.md"]);
    expect(await w.read("Inbox/Team notes/Beta.md")).toContain("# Beta");
    expect(livePages(w.ws)).toEqual([]);
    expect((await w.vault.listExternalLocations()).length).toBe(2);
  });

  it("Workspace → Private: a folder name already taken gets a number", async () => {
    w = await world({ "Team notes/Other.md": "# Other\n" });
    const folder = w.servers.writeAsOther(w.ws, { id: "01890000-0000-7000-8000-0000000000f2", title: "Team notes", markdown: folderMarkdown("01890000-0000-7000-8000-0000000000f2") });
    const a = w.servers.writeAsOther(w.ws, { title: "Alpha", markdown: "# Alpha\n", parentId: folder.id });
    const preview = await w.engine.previewFromWorkspace({ server: w.server, workspace: w.ws.id, mode: "copy", pageIds: [folder.id, a.id], folder: "" });
    const done = await w.engine.start(preview);
    expect(done.state).toBe("done");
    expect(done.items.map((i) => i.destPath)).toEqual(["Team notes 2", "Team notes 2/Alpha.md"]);
    expect(livePages(w.ws).length).toBe(2);
  });
});
