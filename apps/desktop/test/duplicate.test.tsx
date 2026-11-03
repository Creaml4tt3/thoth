// @vitest-environment jsdom
// Duplicate, Duplicate structure only and Duplicate to… in the trees' menus (ADR-0047): the copy goes right below the
// original, is opened and named at once; a folder with pages asks first; a workspace copy checks the page limit,
// warns about team limits, and leaves nothing behind when it fails part-way.
import { fireEvent } from "@testing-library/react";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { axeViolations } from "../../../tests/helpers/axe.ts";
import { FakeServers, type FakeServerConfig } from "../../../tests/helpers/fake-servers.ts";
import { cleanup, openApp, screen, waitFor, within } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": BETA, "Notes/Plan.md": "# Plan\n\nSee [[Diary]].\n", "Notes/Old/Diary.md": "# Diary\n" });
});
afterEach(async () => {
  cleanup();
  localStorage.clear();
  await dirs.cleanup();
});

const exists = (path: string) =>
  access(join(root, path)).then(
    () => true,
    () => false,
  );
const tree = () => screen.findByRole("tree", { name: "Pages in this Private Space" });
const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent);
const said = async () => (await tree()).parentElement!.querySelector("[data-tree-said]")!.textContent;
const menuFor = async (name: string) => {
  fireEvent.contextMenu(within(await tree()).getByRole("treeitem", { name }));
  return screen.findByRole("menu");
};

describe("Duplicate in the Private Space", () => {
  it("copies a page right below it, opens the copy and puts its name into rename", async () => {
    const app = await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    await app.user.click(within(await menuFor("Beta")).getByRole("menuitem", { name: "Duplicate" }));
    await waitFor(async () => expect(await exists("Beta (copy).md")).toBe(true));
    expect(await readFile(join(root, "Beta (copy).md"), "utf8")).toBe("# Beta (copy)\n\nBeta links back to [[Alpha]].\n");
    expect(await screen.findByRole("textbox", { name: "Rename Beta (copy)" })).toBeTruthy();
    await waitFor(() => expect(tabNames()).toContain("Beta (copy)"));
    await waitFor(async () => expect(await said()).toBe("Duplicated Beta"));
    // Right below the original.
    await app.user.keyboard("{Escape}");
    const rows = within(await tree()).getAllByRole("treeitem").map((r) => r.textContent);
    expect(rows.indexOf("Beta (copy)")).toBe(rows.indexOf("Beta") + 1);
  });

  it("Cmd/Ctrl+Shift+D on the focused row duplicates it; a second copy is “(copy 2)”", async () => {
    const app = await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    within(await tree()).getByRole("treeitem", { name: "Beta" }).focus();
    await app.user.keyboard("{Control>}{Shift>}d{/Shift}{/Control}");
    await waitFor(async () => expect(await exists("Beta (copy).md")).toBe(true));
    await app.user.keyboard("{Escape}");
    await app.user.click(within(await menuFor("Beta")).getByRole("menuitem", { name: "Duplicate" }));
    await waitFor(async () => expect(await exists("Beta (copy 2).md")).toBe(true));
  });

  it("asks first for a folder with pages, then copies it with everything in it", async () => {
    const app = await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    await app.user.click(within(await menuFor("Notes")).getByRole("menuitem", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate Notes and its 2 pages?" });
    expect(dialog.textContent).toContain("The copy goes right below it");
    expect(await axeViolations(dialog)).toEqual([]);
    await app.user.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await readFile(join(root, "Notes (copy)/Plan.md"), "utf8")).toBe("# Plan\n\nSee [[Notes (copy)/Old/Diary|Diary]].\n");
    expect(await exists("Notes (copy)/Old/Diary.md")).toBe(true);
    expect(await screen.findByRole("textbox", { name: "Rename Notes (copy)" })).toBeTruthy();
  });

  it("Duplicate structure only keeps each page's title", async () => {
    const app = await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    await app.user.click(within(await menuFor("Notes")).getByRole("menuitem", { name: "Duplicate structure only" }));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate Notes and its 2 pages?" });
    expect(dialog.textContent).toContain("each page keeps only its title");
    await app.user.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await waitFor(async () => expect(await exists("Notes (copy)/Plan.md")).toBe(true));
    expect(await readFile(join(root, "Notes (copy)/Plan.md"), "utf8")).toMatch(/^---\nthoth_id: \S+\n---\n# Plan\n$/);
  });

  it("“Duplicate page” in the command palette duplicates the open page", async () => {
    const app = await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    await app.user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Search" });
    await app.user.keyboard("> Duplicate page");
    expect(within(palette).getByRole("option", { name: /^Duplicate page/ }).textContent).toContain("Ctrl+Shift+D");
    await app.user.keyboard("{Enter}");
    await waitFor(async () => expect(await exists("Alpha (copy).md")).toBe(true));
    await waitFor(() => expect(tabNames()).toContain("Alpha (copy)"));
  });

  it("Duplicate to… puts the copy in the folder picked", async () => {
    const app = await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    await app.user.click(within(await menuFor("Beta")).getByRole("menuitem", { name: "Duplicate to…" }));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate “Beta” to…" });
    expect(await axeViolations(dialog)).toEqual([]);
    await app.user.selectOptions(within(dialog).getByRole("listbox", { name: "Put the copy in" }), "Notes");
    await app.user.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await exists("Notes/Beta (copy).md")).toBe(true);
    expect(await exists("Beta.md")).toBe(true);
  });
});

const CAPS = ["search", "page-order", "page-kind"];
const LOCAL: FakeServerConfig = { url: "http://127.0.0.1:8080", name: "Team server", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" }, capabilities: CAPS };

async function workspace(options: { role?: "owner" | "manager" | "editor" | "viewer"; capabilities?: string[]; limits?: Record<string, number> } = {}) {
  const servers = new FakeServers();
  servers.connect({ ...LOCAL, capabilities: options.capabilities ?? CAPS, ...(options.limits ? { limits: options.limits } : {}) });
  const server = [...(await servers.list())][0]!.id;
  const ws = servers.addWorkspace(server, { name: "Design", role: options.role ?? "editor" });
  const roadmap = servers.writeAsOther(ws, { title: "Roadmap", markdown: "# Roadmap\n", position: "a" });
  const q1 = servers.writeAsOther(ws, { title: "Q1", markdown: "# Q1\n", parentId: roadmap.id, position: "a" });
  servers.writeAsOther(ws, { title: "January", markdown: `# January\n\nSee [Q1](thoth:page/${q1.id}).\n`, parentId: q1.id, position: "a" });
  servers.writeAsOther(ws, { title: "Notes", markdown: "# Notes\n", position: "b" });
  const app = await openApp(root, { autosaveMs: 0 }, createNodePlatform({ vault: root, servers }));
  const list = await screen.findByRole("tree", { name: "Workspaces on Team server" });
  await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
  const group = await within(list).findByRole("group", { name: "Pages in Design" });
  return { app, servers, ws, list, group, ids: { roadmap: roadmap.id, q1: q1.id } };
}
const live = (ws: { pages: Map<string, { title: string; deleted: boolean }> }) => [...ws.pages.values()].filter((p) => !p.deleted).map((p) => p.title);
const openMenu = async (group: HTMLElement, name: RegExp, title: string) => {
  fireEvent.contextMenu(within(group).getByRole("treeitem", { name }));
  return screen.findByRole("menu", { name: `Actions for ${title}` });
};

describe("Duplicate in a workspace", () => {
  it("copies a page and the pages under it, after asking, with links inside pointing at the copies", async () => {
    const { app, ws, group, list, ids } = await workspace();
    await app.user.click(within(await openMenu(group, /^Roadmap/, "Roadmap")).getByRole("menuitem", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate Roadmap and its 2 pages?" });
    expect(await axeViolations(dialog)).toEqual([]);
    await app.user.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(live(ws)).toEqual(["Roadmap", "Q1", "January", "Notes", "Roadmap (copy)", "Q1", "January"]);
    const pages = [...ws.pages.values()];
    const copy = pages.find((p) => p.title === "Roadmap (copy)")!;
    const q1Copy = pages.find((p) => p.title === "Q1" && p.parentId === copy.id)!;
    const janCopy = pages.find((p) => p.title === "January" && p.parentId === q1Copy.id)!;
    expect(copy.markdown).toBe("# Roadmap (copy)\n");
    expect(janCopy.markdown).toBe(`# January\n\nSee [Q1](thoth:page/${q1Copy.id}).\n`);
    expect(janCopy.markdown).not.toContain(ids.q1);
    // Right below the original, and named at once.
    expect(copy.parentId).toBeNull();
    expect(copy.position! > "a" && copy.position! < "b").toBe(true);
    expect(await within(list).findByRole("textbox", { name: "Rename Roadmap (copy)" })).toBeTruthy();
    await waitFor(() => expect(list.querySelector("[data-tree-said]")!.textContent).toBe("Duplicated Roadmap"));
  });

  it("is not offered to a viewer", async () => {
    const { group } = await workspace({ role: "viewer" });
    const menu = await openMenu(group, /^Roadmap/, "Roadmap").catch(() => null);
    expect(menu ? within(menu).queryByRole("menuitem", { name: /^Duplicate/ }) : null).toBeNull();
  });

  it("refuses a copy that does not fit in the page limit, and writes nothing", async () => {
    const { app, servers, ws, group } = await workspace({ limits: { maxPagesPerWorkspace: 6 } });
    await app.user.click(within(await openMenu(group, /^Roadmap/, "Roadmap")).getByRole("menuitem", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate Roadmap and its 2 pages?" });
    await app.user.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("The copy does not fit: this workspace is limited to 6 pages, 4 are in use and the copy needs 3. Nothing was copied.");
    expect(servers.calls.filter((c) => c.method === "PUT")).toEqual([]);
    expect(live(ws)).toHaveLength(4);
  });

  it("deletes what it made, newest first, when a write fails part-way", async () => {
    const { app, servers, ws, group } = await workspace();
    let puts = 0;
    servers.beforeCall = (args) => {
      if (args.method === "PUT" && ++puts === 3) throw new Error("The network went away.");
    };
    await app.user.click(within(await openMenu(group, /^Roadmap/, "Roadmap")).getByRole("menuitem", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate Roadmap and its 2 pages?" });
    await app.user.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Could not duplicate: The network went away. Nothing was copied.");
    const made = servers.calls.filter((c) => c.method === "PUT").slice(0, 2).map((c) => c.path.split("/").pop());
    expect(servers.calls.filter((c) => c.method === "DELETE").map((c) => c.path.split("/").pop())).toEqual(made.reverse());
    expect(live(ws)).toEqual(["Roadmap", "Q1", "January", "Notes"]);
  });

  it("warns an owner that a copy of a team-limited page is visible to everyone, but not inside the same limited folder", async () => {
    const { app, ws, group, ids } = await workspace({ role: "owner", capabilities: [...CAPS, "teams"] });
    ws.visibility.set(ids.roadmap, ["team_1"]);
    await app.user.click(within(await openMenu(group, /^Roadmap/, "Roadmap")).getByRole("menuitem", { name: "Duplicate structure only" }));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate Roadmap and its 2 pages?" });
    expect(dialog.textContent).toContain("it will be visible to everyone in this workspace");
    await app.user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    // Q1 is limited by Roadmap above it: a copy next to it stays inside Roadmap; one at the top level does not.
    await app.user.click(within(group).getByRole("treeitem", { name: /^Roadmap/ }));
    await within(group).findByRole("treeitem", { name: /^Q1/ });
    await app.user.click(within(await openMenu(group, /^Q1/, "Q1")).getByRole("menuitem", { name: "Duplicate to…" }));
    const picker = await screen.findByRole("dialog", { name: "Duplicate “Q1” to…" });
    expect(picker.textContent).not.toContain("visible to everyone");
    await app.user.selectOptions(within(picker).getByRole("listbox", { name: "Put the copy in" }), "");
    expect(picker.textContent).toContain("visible to everyone");
    expect(await axeViolations(picker)).toEqual([]);
  });

  it("warns a manager when a page inside the copied folder is team-limited, even though the folder is not", async () => {
    const { app, ws, group, ids } = await workspace({ role: "manager", capabilities: [...CAPS, "teams"] });
    ws.visibility.set(ids.q1, ["team_1"]);
    await app.user.click(within(await openMenu(group, /^Roadmap/, "Roadmap")).getByRole("menuitem", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate Roadmap and its 2 pages?" });
    expect(dialog.textContent).toContain("Only some teams can see some of the pages inside.");
    expect(dialog.textContent).not.toContain("Only some teams can see the original.");
  });

  it("tells an editor, who cannot see team limits, that the copy keeps none", async () => {
    const { app, group } = await workspace({ role: "editor", capabilities: [...CAPS, "teams"] });
    await app.user.click(within(await openMenu(group, /^Notes/, "Notes")).getByRole("menuitem", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate Notes?" });
    expect(dialog.textContent).toContain("The copy keeps no team limits.");
  });
});
