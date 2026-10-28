// @vitest-environment jsdom
// Delete… in the trees' menus: a Private Space page or folder goes to the system Trash, a workspace page (and every
// page under it) is deleted on the server. Both ask first, with Cancel focused; Cancel deletes nothing.
import { fireEvent } from "@testing-library/react";
import { access } from "node:fs/promises";
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
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": BETA, "Notes/Plan.md": "# Plan\n", "Notes/Old/Diary.md": "# Diary\n" });
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
const menuFor = async (name: string) => {
  fireEvent.contextMenu(within(await tree()).getByRole("treeitem", { name }));
  return screen.findByRole("menu");
};

describe("Delete… in the Private Space", () => {
  it("asks first, with Cancel focused, and Cancel deletes nothing", async () => {
    const app = await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    const item = within(await menuFor("Beta")).getByRole("menuitem", { name: "Delete…" });
    expect(item.className).toContain("ctx-danger");
    await app.user.click(item);
    const dialog = await screen.findByRole("dialog", { name: "Delete “Beta”?" });
    // jsdom's user agent is neither macOS nor Windows: the Linux name.
    expect(dialog.textContent).toContain("This page moves to the Trash. You can put it back from there.");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
    expect(await axeViolations(dialog)).toEqual([]);
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(app.platform.trashed).toEqual([]);
    expect(await exists("Beta.md")).toBe(true);
  });

  it("moves a page to the Trash, closes its tab and drops it from the tree", async () => {
    const app = await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    await app.user.keyboard("{Control>}");
    await app.user.click(within(await tree()).getByRole("treeitem", { name: "Beta" }));
    await app.user.keyboard("{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta"]));
    await app.user.click(within(await menuFor("Beta")).getByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete “Beta”?" });
    await app.user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(app.platform.trashed).toEqual(["Beta.md"]);
    expect(await exists("Beta.md")).toBe(false);
    await waitFor(async () => expect(within(await tree()).queryByRole("treeitem", { name: "Beta" })).toBeNull());
    expect(tabNames()).toEqual(["Alpha"]);
  });

  it("moves a folder and everything in it, and says how many pages go", async () => {
    const app = await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    await app.user.click(within(await menuFor("Notes")).getByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete “Notes”?" });
    expect(dialog.textContent).toContain("This folder and everything in it, including 2 pages, move to the Trash.");
    await app.user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(app.platform.trashed).toEqual(["Notes"]);
    expect(await exists("Notes")).toBe(false);
    await waitFor(async () => expect(within(await tree()).queryByRole("treeitem", { name: "Notes" })).toBeNull());
  });

  it("keeps the dialog open and says why when the Trash refuses", async () => {
    const app = await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    app.platform.connections[0]!.trash = async () => {
      throw new Error("The Trash is full.");
    };
    await app.user.click(within(await menuFor("Beta")).getByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete “Beta”?" });
    await app.user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe("Could not delete: The Trash is full."));
    expect(await exists("Beta.md")).toBe(true);
  });
});

const LOCAL: FakeServerConfig = { url: "http://127.0.0.1:8080", name: "Team server", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" }, capabilities: ["search", "page-order", "page-kind"] };

async function workspace(role: "editor" | "viewer" = "editor") {
  const servers = new FakeServers();
  servers.connect(LOCAL);
  const server = [...(await servers.list())][0]!.id;
  const ws = servers.addWorkspace(server, { name: "Design", role });
  const roadmap = servers.writeAsOther(ws, { title: "Roadmap", markdown: "# Roadmap\n" });
  const q1 = servers.writeAsOther(ws, { title: "Q1", markdown: "# Q1\n", parentId: roadmap.id });
  const jan = servers.writeAsOther(ws, { title: "January", markdown: "# January\n", parentId: q1.id });
  servers.writeAsOther(ws, { title: "Notes", markdown: "# Notes\n" });
  const app = await openApp(root, { autosaveMs: 0 }, createNodePlatform({ vault: root, servers }));
  const list = await screen.findByRole("tree", { name: "Workspaces on Team server" });
  await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
  const group = await within(list).findByRole("group", { name: "Pages in Design" });
  return { app, servers, ws, group, ids: { roadmap: roadmap.id, q1: q1.id, jan: jan.id } };
}

describe("Delete… in a workspace", () => {
  it("deletes a page and every page under it, deepest first, for everyone", async () => {
    const { app, servers, ws, group, ids } = await workspace();
    fireEvent.contextMenu(within(group).getByRole("treeitem", { name: /^Roadmap/ }));
    await app.user.click(within(await screen.findByRole("menu", { name: "Actions for Roadmap" })).getByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete “Roadmap”?" });
    expect(dialog.textContent).toContain("This page and the 2 pages inside it are deleted for everyone in this workspace.");
    await app.user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const deletes = servers.calls.filter((c) => c.method === "DELETE").map((c) => c.path.split("/").pop());
    expect(deletes).toEqual([ids.jan, ids.q1, ids.roadmap]);
    expect([...ws.pages.values()].filter((p) => !p.deleted).map((p) => p.title)).toEqual(["Notes"]);
    await waitFor(() => expect(within(group).queryByRole("treeitem", { name: /^Roadmap/ })).toBeNull());
    expect(within(group).getByRole("treeitem", { name: /^Notes/ })).toBeTruthy();
  });

  it("is not offered to a viewer", async () => {
    const { group } = await workspace("viewer");
    fireEvent.contextMenu(within(group).getByRole("treeitem", { name: /^Roadmap/ }));
    const menu = await screen.findByRole("menu", { name: "Actions for Roadmap" }).catch(() => null);
    expect(menu ? within(menu).queryByRole("menuitem", { name: "Delete…" }) : null).toBeNull();
  });
});
