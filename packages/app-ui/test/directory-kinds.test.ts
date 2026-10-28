// How the app finds folder pages: from `kind` when the server lists `page-kind` (ADR-0017), by reading each page otherwise.
import { afterEach, describe, expect, it } from "vitest";
import type { Servers } from "@thoth/platform";
import { ServerDirectory, workspaceKey } from "../src/workspace/directory.ts";
import { folderMarkdown } from "../src/workspace/folders.ts";
import { FakeServers, type FakeServerConfig, type FakeWorkspace } from "../../../tests/helpers/fake-servers.ts";

const URL_ = "http://127.0.0.1:8080";
const BASE: FakeServerConfig = { url: URL_, name: "Team", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" } };
const NO_KIND = ["search", "transfers", "attachments", "page-order"];

const directories: ServerDirectory[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) d.dispose();
});

async function setup(config: Partial<FakeServerConfig> = {}) {
  const servers = new FakeServers();
  const server = servers.connect({ ...BASE, ...config });
  const ws = servers.addWorkspace(server, { name: "Design" });
  const directory = new ServerDirectory(servers as Servers, { pollMs: 0 });
  directories.push(directory);
  return { servers, server, ws, directory };
}

/** Pages made by another user: a folder holding a folder and two pages, one of them with malformed frontmatter. */
function seed(servers: FakeServers, ws: FakeWorkspace) {
  const top = servers.writeAsOther(ws, { title: "Research", markdown: folderMarkdown("x") });
  const inner = servers.writeAsOther(ws, { title: "Interviews", markdown: folderMarkdown("y"), parentId: top.id });
  const plain = servers.writeAsOther(ws, { title: "Plan", markdown: "# Plan\n", parentId: top.id });
  const broken = servers.writeAsOther(ws, { title: "Broken", markdown: "---\nthoth_kind: [folder\n---\n# Broken\n" });
  const bodyOnly = servers.writeAsOther(ws, { title: "Mention", markdown: "# thoth_kind: folder\n" });
  return { top, inner, plain, broken, bodyOnly };
}

const pageReads = (servers: FakeServers) => servers.calls.filter((c) => c.method === "GET" && /\/pages\/[^/]+$/.test(c.path));
/** Reads of ordinary pages. With `page-kind` only folder pages are read, once per revision, for their label color (0.2.6). */
const pageReadsBesides = (servers: FakeServers, directory: ServerDirectory, server: string, ws: FakeWorkspace) => {
  const kinds = directory.getState().trees[workspaceKey(server, ws.id)]!.kinds;
  return pageReads(servers).filter((c) => kinds[c.path.split("/").pop()!]?.folder !== true);
};
const seedIds = (directory: ServerDirectory, server: string, ws: FakeWorkspace, title: string) => directory.getState().trees[workspaceKey(server, ws.id)]!.nodes.find((n) => n.title === title)!.id;
const folders = (directory: ServerDirectory, server: string, ws: FakeWorkspace) => {
  const tree = directory.getState().trees[workspaceKey(server, ws.id)]!;
  return Object.fromEntries(tree.nodes.map((n) => [n.title, tree.kinds[n.id]?.folder === true]));
};

describe("folders with the page-kind capability (ADR-0017)", () => {
  it("draws folders from the tree's kind and reads no ordinary page to find them", async () => {
    const { servers, server, ws, directory } = await setup();
    seed(servers, ws);
    await directory.loadWorkspaces(server);
    expect(directory.hasPageKinds(server)).toBe(true);
    await directory.loadTree(server, ws.id);
    expect(folders(directory, server, ws)).toEqual({ Research: true, Interviews: true, Plan: false, Broken: false, Mention: false });
    // The kinds are there as soon as the tree is, not after a round of reads.
    expect(directory.getState().trees[workspaceKey(server, ws.id)]!.loading).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pageReadsBesides(servers, directory, server, ws)).toEqual([]);
    // Each folder is read once, for its color, and its revision is not read again.
    expect(pageReads(servers)).toHaveLength(2);
    await directory.loadTree(server, ws.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pageReads(servers)).toHaveLength(2);
    expect(servers.calls.some((c) => c.path.endsWith("/tree"))).toBe(true);
  });

  it("knows the capability even when the tree is loaded before the workspaces are", async () => {
    const { servers, server, ws, directory } = await setup();
    seed(servers, ws);
    await directory.loadTree(server, ws.id);
    expect(folders(directory, server, ws)).toMatchObject({ Research: true, Plan: false });
    expect(pageReadsBesides(servers, directory, server, ws)).toEqual([]);
  });

  it("follows the change feed: a page that becomes a folder, a new folder and a deleted one, with no ordinary page read", async () => {
    const { servers, server, ws, directory } = await setup();
    const { plain, inner } = seed(servers, ws);
    await directory.loadTree(server, ws.id);
    servers.writeAsOther(ws, { id: plain.id, title: "Plan", markdown: folderMarkdown(plain.id) }); // edited elsewhere into a folder
    servers.writeAsOther(ws, { title: "Archive", markdown: folderMarkdown("z") });
    servers.deleteAsOther(ws, inner.id);
    await directory.pollWorkspace(server, ws.id);
    expect(folders(directory, server, ws)).toEqual({ Research: true, Plan: true, Broken: false, Mention: false, Archive: true });
    // And back: removing the marker makes it a page again.
    // Only folders are read (for their color, ADR-0035): never the pages Broken or Mention.
    const read = new Set(pageReads(servers).map((c) => c.path.split("/").pop()));
    for (const page of ["Broken", "Mention"]) expect(read.has(seedIds(directory, server, ws, page))).toBe(false);
    expect(read.has(seedIds(directory, server, ws, "Archive"))).toBe(true);
    servers.writeAsOther(ws, { id: plain.id, title: "Plan", markdown: "# Plan\n" });
    await directory.pollWorkspace(server, ws.id);
    expect(folders(directory, server, ws)["Plan"]).toBe(false);
  });

  it("a folder we create is known at once, and a rename reads only the page being renamed", async () => {
    const { servers, server, ws, directory } = await setup();
    await directory.loadTree(server, ws.id);
    const made = await directory.createFolder(server, ws.id, "Notes");
    expect(made.metadata.kind).toBe("folder");
    expect(folders(directory, server, ws)).toEqual({ Notes: true });
    await directory.renamePage(server, ws.id, made.id, "Ideas");
    expect(folders(directory, server, ws)).toEqual({ Ideas: true });
    expect(pageReads(servers)).toHaveLength(1);
    expect(pageReads(servers)[0]!.path).toContain(made.id);
  });

  it("keeps a folder a folder through a move", async () => {
    const { servers, server, ws, directory } = await setup();
    const { top, plain } = seed(servers, ws);
    await directory.loadTree(server, ws.id);
    await directory.movePage(server, ws.id, top.id, { parentId: null, index: 5 });
    await directory.movePage(server, ws.id, plain.id, { parentId: null, index: 0 });
    expect(folders(directory, server, ws)).toMatchObject({ Research: true, Plan: false });
    expect(pageReadsBesides(servers, directory, server, ws)).toEqual([]);
  });

  it("treats an unknown kind (null) as a page and does not go looking for it", async () => {
    const { servers, server, ws, directory } = await setup();
    seed(servers, ws);
    // A server that lists the capability but has not filled in older pages yet (before the backfill) answers null.
    const real = servers.call.bind(servers);
    servers.call = async (args, body) => {
      const res = await real(args, body);
      if (!args.path.endsWith("/tree")) return res;
      const page = JSON.parse(res.body) as { items: { kind?: string | null }[] };
      for (const item of page.items) item.kind = null;
      return { ...res, body: JSON.stringify(page) };
    };
    await directory.loadTree(server, ws.id);
    expect(Object.values(folders(directory, server, ws)).every((folder) => !folder)).toBe(true);
    expect(pageReadsBesides(servers, directory, server, ws)).toEqual([]);
  });
});

describe("folders without the page-kind capability (fallback)", () => {
  it("still reads each page once to find folders", async () => {
    const { servers, server, ws, directory } = await setup({ capabilities: NO_KIND });
    seed(servers, ws);
    await directory.loadWorkspaces(server);
    expect(directory.hasPageKinds(server)).toBe(false);
    await directory.loadTree(server, ws.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(folders(directory, server, ws)).toEqual({ Research: true, Interviews: true, Plan: false, Broken: false, Mention: false });
    expect(pageReads(servers)).toHaveLength(5);
    // The tree it got carries no kind at all.
    const tree = directory.getState().trees[workspaceKey(server, ws.id)]!;
    expect(tree.nodes.every((n) => n.kind === undefined)).toBe(true);
  });

  it("re-reads a page whose revision changed, and only that one", async () => {
    const { servers, server, ws, directory } = await setup({ capabilities: NO_KIND });
    const { plain } = seed(servers, ws);
    await directory.loadTree(server, ws.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = pageReads(servers).length;
    servers.writeAsOther(ws, { id: plain.id, title: "Plan", markdown: folderMarkdown(plain.id) });
    await directory.pollWorkspace(server, ws.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(folders(directory, server, ws)["Plan"]).toBe(true);
    expect(pageReads(servers)).toHaveLength(before + 1);
  });
});
