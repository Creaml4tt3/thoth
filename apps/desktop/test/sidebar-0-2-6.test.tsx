// @vitest-environment jsdom
// 0.2.6: New page and New folder from a section's and a folder's right-click menu, Open in new tab, the folder New
// page and New folder go into (the last one clicked), folder label colors, and the space switcher on the logo row.
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { folderMarkdown, folderColorOf } from "@thoth/app-ui/workspace/folders.ts";
import { axeViolations } from "../../../tests/helpers/axe.ts";
import { FakeServers, type FakeServerConfig } from "../../../tests/helpers/fake-servers.ts";
import { cleanup, openApp, screen, waitFor, within } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";

const dirs = tempDirs();
let root: string;
const LOCAL: FakeServerConfig = { url: "http://127.0.0.1:8080", name: "Team server", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" } };

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": BETA, "Docs/Plan.md": "# Plan\n" });
});
afterEach(async () => {
  cleanup();
  localStorage.clear();
  await dirs.cleanup();
});

const tree = () => screen.findByRole("tree", { name: "Pages in this Private Space" });
const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent);
const menuItems = (menu: HTMLElement) => [...menu.querySelectorAll("[role^=menuitem]")].map((m) => m.textContent);

describe("right-click menus", () => {
  it("the Private Space header has New page and New folder, at the top level", async () => {
    const app = await openApp(root);
    await tree();
    const header = screen.getByRole("region", { name: /^Private Space/ }).querySelector(".sec")!;
    fireEvent.contextMenu(header);
    const menu = await screen.findByRole("menu", { name: /^Section:/ });
    expect(menuItems(menu).slice(0, 2)).toEqual(["New page", "New folder"]);
    await app.user.click(within(menu).getByRole("menuitem", { name: "New folder" }));
    await screen.findByRole("textbox", { name: "Rename Untitled folder" });
    await app.user.keyboard("{Escape}");
    expect(await app.read(".thoth/order.json").catch(() => "")).not.toContain("Docs/Untitled folder");
  });

  it("a folder's menu makes a page inside it, opens it and starts its rename", async () => {
    const app = await openApp(root);
    fireEvent.contextMenu(within(await tree()).getByRole("treeitem", { name: "Docs" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "New page inside" }));
    await screen.findByRole("textbox", { name: "Rename Untitled" });
    await waitFor(async () => expect(await app.read("Docs/Untitled.md")).toMatch(/# Untitled\n$/));
    await waitFor(() => expect(tabNames()).toContain("Untitled"));
  });

  it("Open in new tab opens the page next to the open one, keeping it", async () => {
    const app = await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    fireEvent.contextMenu(within(await tree()).getByRole("treeitem", { name: "Beta" }));
    await app.user.click(await screen.findByRole("menuitem", { name: /^Open in new tab/ }));
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta"]));
  });
});

describe("folder colors", () => {
  it("Color… sets one of eight colors (kept in .thoth/order.json, not in the folder), follows a rename, and None clears it", async () => {
    const app = await openApp(root);
    const docs = () => within(screen.getByRole("tree", { name: "Pages in this Private Space" })).getByRole("treeitem", { name: /^(Docs|Papers)$/ });
    fireEvent.contextMenu(within(await tree()).getByRole("treeitem", { name: "Docs" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Color…" }));
    const dialog = await screen.findByRole("dialog", { name: "Color for “Docs”" });
    const choices = within(dialog).getAllByRole("radio");
    expect(choices.map((c) => c.textContent)).toEqual(["Gray", "Brown", "Orange", "Yellow", "Green", "Blue", "Purple", "Red", "None"]);
    expect(within(dialog).getByRole("radio", { name: "None" }).getAttribute("aria-checked")).toBe("true");
    expect(await axeViolations(dialog)).toEqual([]);
    await app.user.click(within(dialog).getByRole("radio", { name: "Green" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(docs().querySelector(".tree-icon-folder")!.getAttribute("data-color")).toBe("green"));
    expect(JSON.parse(await app.read(".thoth/order.json")).colors).toEqual({ Docs: "green" });

    fireEvent.keyDown(docs(), { key: "F2" });
    const field = await screen.findByRole("textbox", { name: "Rename Docs" });
    await app.user.clear(field);
    await app.user.type(field, "Papers{Enter}");
    await waitFor(async () => expect(JSON.parse(await app.read(".thoth/order.json")).colors).toEqual({ Papers: "green" }));
    await waitFor(() => expect(docs().querySelector(".tree-icon-folder")!.getAttribute("data-color")).toBe("green"));

    fireEvent.contextMenu(docs());
    await app.user.click(await screen.findByRole("menuitem", { name: "Color…" }));
    await app.user.click(within(await screen.findByRole("dialog")).getByRole("radio", { name: "None" }));
    await waitFor(() => expect(docs().querySelector(".tree-icon-folder")!.hasAttribute("data-color")).toBe(false));
    expect(JSON.parse(await app.read(".thoth/order.json")).colors).toBeUndefined();
  });

  it("a workspace folder's color is written in the folder page, for every member", async () => {
    const servers = new FakeServers();
    const server = servers.connect(LOCAL);
    const ws = servers.addWorkspace(server, { name: "Design", role: "editor" });
    const id = "01890000-0000-7000-8000-000000000001";
    servers.writeAsOther(ws, { id, title: "Research", markdown: folderMarkdown(id) });
    const app = await openApp(root, {}, createNodePlatform({ vault: root, servers }));
    const list = await screen.findByRole("tree", { name: "Workspaces on Team server" });
    await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
    const group = await within(list).findByRole("group", { name: "Pages in Design" });
    const folder = within(group).getByRole("treeitem", { name: "Research" });
    await waitFor(() => expect(folder.getAttribute("data-kind")).toBe("folder"));
    fireEvent.contextMenu(folder);
    await app.user.click(await screen.findByRole("menuitem", { name: "Color…" }));
    await app.user.click(within(await screen.findByRole("dialog", { name: "Color for “Research”" })).getByRole("radio", { name: "Purple" }));
    await waitFor(() => expect(folderColorOf(ws.pages.get(id)!.markdown)).toBe("purple"));
    expect(ws.pages.get(id)!.markdown).toContain("thoth_kind: folder");
    await waitFor(() => expect(within(group).getByRole("treeitem", { name: "Research" }).querySelector(".tree-icon-folder")!.getAttribute("data-color")).toBe("purple"));
  });
});

describe("the space switcher", () => {
  it("names this Private Space, lists the recent ones (this one checked) and the workspaces, and opens another in place", async () => {
    const other = await dirs.dir();
    await seed(other, { "Elsewhere.md": "# Elsewhere\n" });
    const servers = new FakeServers();
    const server = servers.connect(LOCAL);
    servers.addWorkspace(server, { name: "Design" });
    const app = await openApp(root, {}, createNodePlatform({ vault: root, servers, recent: [other, root] }));
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    const button = within(screen.getByRole("complementary", { name: "Sidebar" })).getByRole("button", { name: /^Thoth, Private Space/ });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    await app.user.click(button);
    const menu = await screen.findByRole("menu", { name: "Switch space" });
    const spaces = within(menu).getAllByRole("menuitemradio");
    expect(spaces.map((s) => [s.textContent, s.getAttribute("aria-checked")])).toEqual([
      [root.split("/").pop(), "true"],
      [other.split("/").pop(), "false"],
    ]);
    expect(within(menu).getByRole("menuitem", { name: "Design" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /^All Private Spaces/ })).toBeTruthy();
    expect(await axeViolations(menu)).toEqual([]);

    await app.user.click(spaces[1]!);
    await waitFor(() => expect(within(screen.getByRole("tree", { name: "Pages in this Private Space" })).getByRole("treeitem", { name: "Elsewhere" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /choose or create a private space/i })).toBeNull();
  });

  it("a workspace in the menu opens it in the sidebar and puts focus on its row", async () => {
    const servers = new FakeServers();
    const server = servers.connect(LOCAL);
    const ws = servers.addWorkspace(server, { name: "Design" });
    servers.writeAsOther(ws, { title: "Plan", markdown: "# Plan\n" });
    const app = await openApp(root, {}, createNodePlatform({ vault: root, servers }));
    await screen.findByRole("tree", { name: "Workspaces on Team server" });
    await app.user.click(within(screen.getByRole("complementary", { name: "Sidebar" })).getByRole("button", { name: /^Thoth, Private Space/ }));
    await app.user.click(within(await screen.findByRole("menu", { name: "Switch space" })).getByRole("menuitem", { name: "Design" }));
    const row = within(screen.getByRole("tree", { name: "Workspaces on Team server" })).getByRole("treeitem", { name: /^Design/ });
    await waitFor(() => expect(document.activeElement).toBe(row));
    await waitFor(() => expect(row.getAttribute("aria-expanded")).toBe("true"));
    expect(await screen.findByRole("treeitem", { name: "Plan" })).toBeTruthy();
  });
});
