// @vitest-environment jsdom
// Rename, folders, drag and drop and keyboard order in the workspace tree (ADR-0016, Phase 3b AC 1, 8, 9).
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEvent, fireEvent } from "@testing-library/react";
import { requestMoveTo } from "@thoth/app-ui/order/move-to.ts";
import { spread } from "@thoth/app-ui/order/fractional.ts";
import { folderMarkdown, isFolderMarkdown } from "@thoth/app-ui/workspace/folders.ts";
import { cleanup, editorBox, openApp, screen, waitFor, within, caretAtEnd, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { FakeServers, type FakePage, type FakeServerConfig, type FakeWorkspace } from "../../../tests/helpers/fake-servers.ts";
import { ALPHA, seed } from "./support/fixtures.ts";
import { th } from "../src/strings/index.ts";
import { th as sharedTh } from "@thoth/app-ui/strings/index.ts";

const dirs = tempDirs();
let root: string;

const LOCAL: FakeServerConfig = { url: "http://127.0.0.1:8080", name: "Team server", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" } };

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA });
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

interface Seeded {
  title: string;
  position?: string | null;
  parent?: string;
  markdown?: string;
}

/** A signed-in server with one workspace "Design" holding the given pages. */
async function workspace(pages: Seeded[], options: { role?: "owner" | "editor" | "viewer"; config?: FakeServerConfig; autosaveMs?: number } = {}) {
  const servers = new FakeServers();
  const server = servers.connect(options.config ?? LOCAL);
  const ws: FakeWorkspace = servers.addWorkspace(server, { name: "Design", role: options.role ?? "editor" });
  const made = new Map<string, FakePage>();
  for (const p of pages) {
    made.set(
      p.title,
      servers.writeAsOther(ws, {
        title: p.title,
        markdown: p.markdown ?? `# ${p.title}\n\nBody of ${p.title}.\n`,
        ...(p.position !== undefined ? { position: p.position } : {}),
        ...(p.parent ? { parentId: made.get(p.parent)!.id } : {}),
      }),
    );
  }
  const app = await openApp(root, { autosaveMs: options.autosaveMs ?? 0 }, createNodePlatform({ vault: root, servers }));
  const list = await screen.findByRole("tree", { name: "Workspaces on Team server" });
  await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
  const group = await within(list).findByRole("group", { name: "Pages in Design" });
  return { app, servers, ws, server, list, group, made };
}

const names = (group: HTMLElement) => within(group).getAllByRole("treeitem").map((i) => i.textContent);
const moves = (servers: FakeServers) => servers.calls.filter((c) => c.method === "POST" && c.path.endsWith("/move"));
const said = (tree: HTMLElement) => tree.querySelector("[data-tree-said]")!.textContent;
const item = (group: HTMLElement, name: string) => within(group).getByRole("treeitem", { name });

/** A drag from `source` onto `target`, with the pointer `at` (0 = top edge, 1 = bottom edge) of the target row. */
function drag(source: HTMLElement, target: HTMLElement, at: number) {
  const dataTransfer = { setData: () => undefined, getData: () => "", effectAllowed: "", dropEffect: "" };
  target.getBoundingClientRect = () => ({ top: 0, height: 100, left: 0, width: 200, bottom: 100, right: 200, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.dragStart(source, { dataTransfer });
  over(target, "dragOver", at * 100, dataTransfer);
  const zone = target.getAttribute("data-drop");
  over(target, "drop", at * 100, dataTransfer);
  fireEvent.dragEnd(source, { dataTransfer });
  return zone;
}

/** jsdom has no DragEvent, so the pointer position is put on the event by hand. */
function over(target: HTMLElement, type: "dragOver" | "drop", clientY: number, dataTransfer: object) {
  const event = createEvent[type](target, { dataTransfer });
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(target, event);
}

const ALT_SHIFT = (key: "ArrowUp" | "ArrowDown") => `{Alt>}{Shift>}{${key}}{/Shift}{/Alt}`;

describe("workspace tree: order", () => {
  const trio: Seeded[] = [
    { title: "Alpha", position: "G" },
    { title: "Beta", position: "N" },
    { title: "Gamma", position: "U" },
  ];

  it("shows pages by their position, then the unpositioned ones A–Z", async () => {
    const { group } = await workspace([{ title: "Zed", position: "A" }, { title: "Mid" }, { title: "Abe" }, { title: "Yan", position: "B" }]);
    expect(names(group)).toEqual(["Zed", "Yan", "Abe", "Mid"]);
  });

  it("Alt+Shift+Down moves the focused page down and writes only that page's position", async () => {
    const { app, servers, list, group, made } = await workspace(trio);
    const alpha = item(group, "Alpha");
    alpha.focus();
    await app.user.keyboard(ALT_SHIFT("ArrowDown"));

    await waitFor(() => expect(names(group)).toEqual(["Beta", "Alpha", "Gamma"]));
    // One metadata-only call, no PUT (no new revision), the siblings' keys untouched.
    expect(moves(servers)).toHaveLength(1);
    expect(moves(servers)[0]!.path).toContain(made.get("Alpha")!.id);
    expect(servers.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(made.get("Beta")!.position).toBe("N");
    expect(made.get("Gamma")!.position).toBe("U");
    const key = made.get("Alpha")!.position!;
    expect(key > "N" && key < "U").toBe(true);
    // Focus stays on the moved page, and the move is announced.
    await waitFor(() => expect(document.activeElement).toBe(item(group, "Alpha")));
    expect(said(list)).toBe("Alpha moved to position 2 of 3");
  });

  it("Alt+Shift+Up moves up, and does nothing at the top", async () => {
    const { app, servers, group, made } = await workspace(trio);
    const gamma = item(group, "Gamma");
    gamma.focus();
    await app.user.keyboard(ALT_SHIFT("ArrowUp"));
    await waitFor(() => expect(names(group)).toEqual(["Alpha", "Gamma", "Beta"]));
    expect(moves(servers)).toHaveLength(1);
    expect(made.get("Gamma")!.position! > "G" && made.get("Gamma")!.position! < "N").toBe(true);

    item(group, "Alpha").focus();
    await app.user.keyboard(ALT_SHIFT("ArrowUp"));
    expect(moves(servers)).toHaveLength(1);
    expect(names(group)).toEqual(["Alpha", "Gamma", "Beta"]);
  });

  it("renumbers the siblings when their keys have no room (NoRoom)", async () => {
    const { app, servers, group, made } = await workspace([
      { title: "Alpha", position: "x" },
      { title: "Beta", position: "x0" },
      { title: "Gamma", position: "x00" },
      { title: "Delta", position: "y" },
    ]);
    item(group, "Delta").focus();
    await app.user.keyboard(ALT_SHIFT("ArrowUp")); // between "x0" and "x00": nothing fits

    await waitFor(() => expect(names(group)).toEqual(["Alpha", "Beta", "Delta", "Gamma"]));
    const keys = spread(4);
    expect(["Alpha", "Beta", "Delta", "Gamma"].map((t) => made.get(t)!.position)).toEqual(keys);
    // Every sibling got a fresh key, one metadata call each, still no new revisions.
    expect(moves(servers)).toHaveLength(4);
    expect(servers.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("drops a page before and after another (the indicator shows where), writing only the moved page", async () => {
    const { servers, group, made } = await workspace(trio);
    expect(drag(item(group, "Gamma"), item(group, "Alpha"), 0.1)).toBe("before");
    await waitFor(() => expect(names(group)).toEqual(["Gamma", "Alpha", "Beta"]));
    expect(moves(servers)).toHaveLength(1);
    expect(made.get("Gamma")!.position! < "G").toBe(true);

    expect(drag(item(group, "Gamma"), item(group, "Beta"), 0.9)).toBe("after");
    await waitFor(() => expect(names(group)).toEqual(["Alpha", "Beta", "Gamma"]));
    expect(moves(servers)).toHaveLength(2);
    expect(made.get("Alpha")!.position).toBe("G");
    expect(made.get("Beta")!.position).toBe("N");
  });

  it("drops into a page (the middle of its row) to nest it, and onto the workspace row to take it back to the top", async () => {
    const { servers, list, group, made } = await workspace(trio);
    expect(drag(item(group, "Gamma"), item(group, "Alpha"), 0.5)).toBe("inside");
    await waitFor(() => expect(made.get("Gamma")!.parentId).toBe(made.get("Alpha")!.id));
    expect(moves(servers)).toHaveLength(1);
    await waitFor(() => expect(item(group, "Alpha").getAttribute("aria-expanded")).toBe("true"));
    expect(names(group)).toEqual(["Alpha", "Gamma", "Beta"]);
    expect(item(group, "Gamma").getAttribute("aria-level")).toBe("3");

    drag(item(group, "Gamma"), within(list).getByRole("treeitem", { name: /^Design/ }), 0.5);
    await waitFor(() => expect(made.get("Gamma")!.parentId).toBeNull());
    expect(names(group)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("refuses to drop a page into itself or into its own sub-page", async () => {
    const { app, servers, group } = await workspace([{ title: "Parent", position: "G" }, { title: "Child", parent: "Parent" }]);
    await app.user.click(item(group, "Parent"));
    const child = await within(group).findByRole("treeitem", { name: "Child" });
    expect(drag(item(group, "Parent"), item(group, "Parent"), 0.5)).toBeNull();
    expect(drag(item(group, "Parent"), child, 0.5)).toBeNull();
    expect(moves(servers)).toHaveLength(0);
  });

  it("'Move to…' nests a page from code, the way the command palette will ask for it", async () => {
    const { app, servers, ws, server, group, made } = await workspace(trio);
    requestMoveTo({ kind: "workspace", server, workspace: ws.id, page: made.get("Gamma")!.id });
    const dialog = await screen.findByRole("dialog", { name: "Move “Gamma” to…" });
    const list = within(dialog).getByRole("listbox", { name: "Move into" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent?.trim())).toEqual(["Top level", "Alpha", "Beta"]);
    await app.user.selectOptions(list, made.get("Beta")!.id);
    await app.user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(made.get("Gamma")!.parentId).toBe(made.get("Beta")!.id));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(moves(servers)).toHaveLength(1);
    await waitFor(() => expect(names(group)).toEqual(["Alpha", "Beta", "Gamma"]));
  });

  it("'Move to…' is in the row's menu, and viewers get no menu, no rename and no drag", async () => {
    const { app, group } = await workspace(trio);
    fireEvent.contextMenu(item(group, "Beta"));
    const menu = await screen.findByRole("menu", { name: "Actions for Beta" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["RenameF2", "New page inside", "New folder inside", "Move up⌥⇧↑", "Move down⌥⇧↓", "Move to…"]);
    await app.user.click(within(menu).getByRole("menuitem", { name: /Move to/ }));
    expect(await screen.findByRole("dialog", { name: "Move “Beta” to…" })).toBeTruthy();
  });

  it("a viewer can neither rename nor move", async () => {
    const { app, servers, group } = await workspace(trio, { role: "viewer" });
    const beta = item(group, "Beta");
    expect(beta.getAttribute("draggable")).toBeNull();
    beta.focus();
    await app.user.keyboard("{F2}");
    await app.user.keyboard(ALT_SHIFT("ArrowUp"));
    fireEvent.contextMenu(beta);
    expect(screen.queryByRole("textbox", { name: /Rename/ })).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(moves(servers)).toHaveLength(0);
    expect(names(group)).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});

describe("workspace tree: a server without page-order", () => {
  const noOrder: FakeServerConfig = { ...LOCAL, capabilities: ["search", "transfers", "attachments"] };

  it("sorts A–Z, cannot reorder, and says so", async () => {
    const { app, servers, list, group } = await workspace([{ title: "Zed" }, { title: "Abe" }, { title: "Mid" }], { config: noOrder });
    expect(names(group)).toEqual(["Abe", "Mid", "Zed"]);
    expect(within(group).getByText(/cannot keep a custom order/i)).toBeTruthy();
    item(group, "Zed").focus();
    await app.user.keyboard(ALT_SHIFT("ArrowUp"));
    expect(names(group)).toEqual(["Abe", "Mid", "Zed"]);
    expect(said(list)).toMatch(/cannot keep a custom order/i);
    // The edges of a row are not drop places.
    expect(drag(item(group, "Zed"), item(group, "Abe"), 0.05)).toBeNull();
    expect(moves(servers)).toHaveLength(0);
    fireEvent.contextMenu(item(group, "Mid"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Move up/ }).hasAttribute("disabled")).toBe(true);
    expect(within(menu).getByRole("menuitem", { name: /Move down/ }).hasAttribute("disabled")).toBe(true);
  });

  it("still moves a page under another one, as a normal write that keeps its text (the protocol has no move route here)", async () => {
    const { servers, group, made } = await workspace([{ title: "Abe" }, { title: "Zed" }], { config: noOrder });
    const body = made.get("Zed")!.markdown;
    expect(drag(item(group, "Zed"), item(group, "Abe"), 0.5)).toBe("inside");
    await waitFor(() => expect(made.get("Zed")!.parentId).toBe(made.get("Abe")!.id));
    expect(moves(servers)).toHaveLength(0);
    const put = servers.calls.filter((c) => c.method === "PUT").at(-1)!;
    expect(put.headers?.["if-match"]).toBeDefined();
    expect(made.get("Zed")!.markdown).toBe(body);
    expect(made.get("Zed")!.title).toBe("Zed");
  });
});

describe("workspace tree: rename", () => {
  it("F2 renames the focused page in place, in the text and on the server", async () => {
    const { app, servers, group, made } = await workspace([{ title: "Plan" }, { title: "Other" }]);
    const plan = item(group, "Plan");
    plan.focus();
    await app.user.keyboard("{F2}");
    const input = await screen.findByRole("textbox", { name: "Rename Plan" });
    expect((input as HTMLInputElement).value).toBe("Plan");
    await app.user.keyboard("Roadmap{Enter}");

    await waitFor(() => expect(made.get("Plan")!.title).toBe("Roadmap"));
    expect(made.get("Plan")!.markdown).toBe("# Roadmap\n\nBody of Plan.\n");
    const put = servers.calls.filter((c) => c.method === "PUT").at(-1)!;
    expect(put.headers?.["if-match"]).toBeDefined();
    await waitFor(() => expect(names(group)).toEqual(["Other", "Roadmap"]));
    expect(screen.queryByRole("textbox", { name: /Rename/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(item(group, "Roadmap")));
  });

  it("Escape and an unchanged or empty name rename nothing", async () => {
    const { app, servers, group } = await workspace([{ title: "Plan" }]);
    item(group, "Plan").focus();
    await app.user.keyboard("{F2}");
    await screen.findByRole("textbox", { name: "Rename Plan" });
    await app.user.keyboard("Nope{Escape}");
    expect(screen.queryByRole("textbox", { name: /Rename/ })).toBeNull();
    item(group, "Plan").focus();
    await app.user.keyboard("{F2}");
    await screen.findByRole("textbox", { name: "Rename Plan" });
    await app.user.keyboard("{Backspace}{Enter}");
    expect(screen.queryByRole("textbox", { name: /Rename/ })).toBeNull();
    expect(servers.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(names(group)).toEqual(["Plan"]);
  });

  it("the row's menu has Rename, and a page open in the editor shows its new title", async () => {
    const { app, group, made } = await workspace([{ title: "Plan" }]);
    await app.user.click(item(group, "Plan"));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("Body of Plan."));

    fireEvent.contextMenu(item(group, "Plan"));
    await app.user.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    await screen.findByRole("textbox", { name: "Rename Plan" });
    await app.user.keyboard("Roadmap{Enter}");

    await waitFor(() => expect(made.get("Plan")!.title).toBe("Roadmap"));
    await waitFor(() => expect(box.textContent).toContain("Roadmap"));
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain("Roadmap");
  });

  it("a page whose text names no title is renamed on the server only", async () => {
    const { app, group, made } = await workspace([{ title: "Scratch", markdown: "Just some words.\n" }]);
    item(group, "Scratch").focus();
    await app.user.keyboard("{F2}");
    await screen.findByRole("textbox", { name: "Rename Scratch" });
    await app.user.keyboard("Notes{Enter}");
    await waitFor(() => expect(made.get("Scratch")!.title).toBe("Notes"));
    expect(made.get("Scratch")!.markdown).toBe("Just some words.\n");
  });

  it("a failed rename keeps the old name and says why", async () => {
    const { app, servers, group, made } = await workspace([{ title: "Plan" }]);
    servers.beforeCall = (args) => {
      if (args.method === "PUT") throw new Error("offline");
    };
    item(group, "Plan").focus();
    await app.user.keyboard("{F2}");
    await screen.findByRole("textbox", { name: "Rename Plan" });
    await app.user.keyboard("Roadmap{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not rename/);
    expect(made.get("Plan")!.title).toBe("Plan");
    expect(names(group)).toEqual(["Plan"]);
  });

  it("renaming from the page's own title (its first heading) updates the tree", async () => {
    const { app, group, made } = await workspace([{ title: "Plan" }], { autosaveMs: 60 });
    await app.user.click(item(group, "Plan"));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("Body of Plan."));
    box.focus();
    caretAtEnd(box.querySelector("h1")!);
    await app.user.keyboard(" v2");
    await waitFor(() => expect(made.get("Plan")!.title).toBe("Plan v2"), { timeout: 3000 });
    await waitFor(() => expect(names(group)).toEqual(["Plan v2"]));
  });
});

describe("workspace tree: folders", () => {
  it("New folder creates a folder page (thoth_kind: folder), shown as a folder and named in place", async () => {
    const { app, servers, ws, list, group } = await workspace([{ title: "Plan" }]);
    await app.user.click(within(list).getByRole("button", { name: "New folder in Design" }));

    const input = await screen.findByRole("textbox", { name: "Rename New folder" });
    const folder = [...ws.pages.values()].find((p) => p.title === "New folder")!;
    expect(folder.markdown).toBe(folderMarkdown(folder.id));
    expect(folder.markdown).toContain("thoth_kind: folder");
    expect(isFolderMarkdown(folder.markdown)).toBe(true);
    const put = servers.calls.find((c) => c.method === "PUT" && c.path.endsWith(folder.id))!;
    expect(put.headers).toMatchObject({ "if-none-match": "*" });

    await waitFor(() => expect(document.activeElement).toBe(input));
    await app.user.keyboard("Research{Enter}");
    await waitFor(() => expect(folder.title).toBe("Research"));
    expect(isFolderMarkdown(folder.markdown)).toBe(true); // renaming never touches the kind
    const row = await within(group).findByRole("treeitem", { name: "Research" });
    expect(row.getAttribute("data-kind")).toBe("folder");
  });

  it("'New folder inside' from a row's menu creates the folder under that page", async () => {
    const { app, ws, group } = await workspace([{ title: "Plan" }]);
    fireEvent.contextMenu(item(group, "Plan"));
    await app.user.click(await screen.findByRole("menuitem", { name: "New folder inside" }));
    await screen.findByRole("textbox", { name: "Rename New folder" });
    const folder = [...ws.pages.values()].find((p) => p.title === "New folder")!;
    expect(folder.parentId).toBe([...ws.pages.values()].find((p) => p.title === "Plan")!.id);
  });

  it("looks like a folder: icon that opens and closes, disclosure arrow, item count on hover, apart from pages", async () => {
    const folderPage = (id: string) => folderMarkdown(id);
    const servers = new FakeServers();
    const server = servers.connect(LOCAL);
    const ws = servers.addWorkspace(server, { name: "Design" });
    const id = "01890000-0000-7000-8000-000000000001";
    servers.writeAsOther(ws, { id, title: "Research", markdown: folderPage(id) });
    servers.writeAsOther(ws, { title: "Notes", markdown: "# Notes\n", parentId: id });
    servers.writeAsOther(ws, { title: "Ideas", markdown: "# Ideas\n", parentId: id });
    servers.writeAsOther(ws, { title: "Plan", markdown: "# Plan\n" });
    const app = await openApp(root, {}, createNodePlatform({ vault: root, servers }));
    const list = await screen.findByRole("tree", { name: "Workspaces on Team server" });
    await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
    const group = await within(list).findByRole("group", { name: "Pages in Design" });

    // The kind is read from the page's Markdown, so the row turns into a folder a moment after the tree loads.
    const folder = within(group).getByRole("treeitem", { name: "Research" });
    await waitFor(() => expect(folder.getAttribute("data-kind")).toBe("folder"));
    expect(folder.getAttribute("aria-expanded")).toBe("false");
    expect(folder.getAttribute("title")).toBe("Folder · 2 items");
    expect(folder.querySelector(".tree-icon-folder")).not.toBeNull();
    expect(folder.querySelector(".tree-icon-folder")!.hasAttribute("data-open")).toBe(false);
    expect(folder.querySelector(".tree-caret")).not.toBeNull();
    const plan = within(group).getByRole("treeitem", { name: "Plan" });
    expect(plan.getAttribute("data-kind")).toBe("page");
    expect(plan.querySelector(".tree-icon-folder")).toBeNull();
    expect(plan.hasAttribute("aria-expanded")).toBe(false);

    // A folder only opens and closes; it does not open an (empty) page in the editor.
    await app.user.click(folder);
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    expect(folder.querySelector(".tree-icon-folder")!.hasAttribute("data-open")).toBe(true);
    expect(within(group).getByRole("treeitem", { name: "Notes" })).toBeTruthy();
    expect(screen.queryByText("Workspace · Design")).toBeNull();
    // Keyboard: Left closes it again.
    folder.focus();
    await app.user.keyboard("{ArrowLeft}");
    expect(folder.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("workspace tree: keyboard and ARIA", () => {
  it("is a tree with one Tab stop, arrow keys, levels and set positions", async () => {
    const { app, group, list } = await workspace([{ title: "Parent", position: "G" }, { title: "Child", parent: "Parent" }, { title: "Other", position: "N" }]);
    expect(list.getAttribute("role")).toBe("tree");
    expect(list.getAttribute("aria-label")).toBe("Workspaces on Team server");
    const design = within(list).getByRole("treeitem", { name: /^Design/ });
    expect(design.getAttribute("aria-level")).toBe("1");
    expect(group.getAttribute("role")).toBe("group");
    const parent = item(group, "Parent");
    expect(parent.getAttribute("aria-level")).toBe("2");
    expect(parent.getAttribute("aria-posinset")).toBe("1");
    expect(parent.getAttribute("aria-setsize")).toBe("2");
    // One Tab stop in the tree.
    await waitFor(() => expect([...list.querySelectorAll('[role="treeitem"]')].filter((e) => e.getAttribute("tabindex") === "0")).toHaveLength(1));

    parent.focus();
    await app.user.keyboard("{ArrowRight}"); // opens the page's sub-pages
    expect(parent.getAttribute("aria-expanded")).toBe("true");
    await app.user.keyboard("{ArrowRight}"); // steps into them
    expect(document.activeElement).toBe(item(group, "Child"));
    expect(document.activeElement?.getAttribute("tabindex")).toBe("0");
    expect(parent.getAttribute("tabindex")).toBe("-1");
    await app.user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item(group, "Other"));
    await app.user.keyboard("{ArrowUp}{ArrowLeft}"); // back to Child, then out to its parent
    expect(document.activeElement).toBe(parent);
    await app.user.keyboard("{End}");
    expect(document.activeElement).toBe(item(group, "Other"));
    await app.user.keyboard("{Home}");
    expect(document.activeElement).toBe(design);
  });

  it("Enter opens the focused page", async () => {
    const { app, group } = await workspace([{ title: "Plan" }]);
    item(group, "Plan").focus();
    await app.user.keyboard("{Enter}");
    expect((await screen.findByRole("navigation", { name: "Breadcrumb" })).textContent).toContain("Plan");
  });
});

describe("Private Space tree", () => {
  const FILES = { "Alpha.md": "# Alpha\n\nSee [the beta](Beta.md).\n", "Beta.md": "# Beta\n", "Gamma.md": "# Gamma\n", "Docs/Notes.md": "# Notes\n" };

  async function open(files: Record<string, string> = FILES) {
    root = await dirs.dir();
    await seed(root, files);
    if (files === FILES) await mkdir(join(root, "Empty")); // a folder with nothing in it
    const app: Harness = await openApp(root);
    const tree = await screen.findByRole("tree", { name: "Pages in this Private Space" });
    // Folders without pages are listed from the vault a moment after the pages.
    if (files === FILES) await within(tree).findByRole("treeitem", { name: "Empty" });
    return { app, tree };
  }
  const rows = (tree: HTMLElement) => within(tree).getAllByRole("treeitem").map((i) => i.textContent);
  const orderFile = async (app: Harness) => JSON.parse(await app.read(".thoth/order.json")) as { version: 1; folders: Record<string, string[]> };

  it("lists folders first, then pages A–Z, until an order is given; empty folders show too", async () => {
    const { tree } = await open();
    expect(rows(tree)).toEqual(["Docs", "Empty", "Alpha", "Beta", "Gamma"]);
    const docs = within(tree).getByRole("treeitem", { name: "Docs" });
    expect(docs.getAttribute("title")).toBe("Folder · 1 item");
    expect(within(tree).getByRole("treeitem", { name: "Empty" }).getAttribute("title")).toBe("Folder · Empty");
    expect(docs.querySelector(".tree-icon-folder")).not.toBeNull();
    expect(docs.getAttribute("aria-expanded")).toBe("false");
  });

  it("Alt+Shift+Down reorders and records it in .thoth/order.json, without renaming a file", async () => {
    const { app, tree } = await open();
    const alpha = within(tree).getByRole("treeitem", { name: "Alpha" });
    alpha.focus();
    await app.user.keyboard(ALT_SHIFT("ArrowDown"));
    await waitFor(() => expect(rows(tree)).toEqual(["Docs", "Empty", "Beta", "Alpha", "Gamma"]));
    await waitFor(async () => expect((await orderFile(app))?.folders[""]).toEqual(["Docs", "Empty", "Beta.md", "Alpha.md", "Gamma.md"]));
  });

  it("keeps the order after the Private Space is opened again", async () => {
    const { app, tree } = await open();
    within(tree).getByRole("treeitem", { name: "Gamma" }).focus();
    await app.user.keyboard(ALT_SHIFT("ArrowUp") + ALT_SHIFT("ArrowUp"));
    await waitFor(() => expect(rows(tree)).toEqual(["Docs", "Empty", "Gamma", "Alpha", "Beta"]));
    cleanup();
    await openApp(root);
    const tree2 = await screen.findByRole("tree", { name: "Pages in this Private Space" });
    await waitFor(() => expect(rows(tree2)).toEqual(["Docs", "Empty", "Gamma", "Alpha", "Beta"]));
  });

  it("dropping a page on a folder moves the file into it, and links to it follow", async () => {
    const { app, tree } = await open();
    expect(drag(within(tree).getByRole("treeitem", { name: "Beta" }), within(tree).getByRole("treeitem", { name: "Docs" }), 0.5)).toBe("inside");

    await waitFor(async () => expect(await app.read("Docs/Beta.md")).toBe("# Beta\n"));
    await expect(app.read("Beta.md")).rejects.toThrow();
    // The link in Alpha.md was rewritten to the new place.
    await waitFor(async () => expect(await app.read("Alpha.md")).toBe("# Alpha\n\nSee [the beta](Docs/Beta.md).\n"));
    await waitFor(() => expect(within(tree).getByRole("treeitem", { name: "Docs" }).getAttribute("aria-expanded")).toBe("true"));
    await waitFor(() => expect(rows(tree)).toEqual(["Docs", "Notes", "Beta", "Empty", "Alpha", "Gamma"]));
    expect(await orderFile(app)).toMatchObject({ folders: { Docs: ["Notes.md", "Beta.md"] } });
  });

  it("drops a page before another one inside a folder: a move and a place in one", async () => {
    const { app, tree } = await open();
    await app.user.click(within(tree).getByRole("treeitem", { name: "Docs" }));
    const notes = await within(tree).findByRole("treeitem", { name: "Notes" });
    expect(drag(within(tree).getByRole("treeitem", { name: "Gamma" }), notes, 0.1)).toBe("before");
    await waitFor(async () => expect(await app.read("Docs/Gamma.md")).toBe("# Gamma\n"));
    // The order record is written just after the file moves.
    await waitFor(async () => expect(await orderFile(app)).toMatchObject({ folders: { Docs: ["Gamma.md", "Notes.md"] } }));
    await waitFor(() => expect(rows(tree)).toEqual(["Docs", "Gamma", "Notes", "Empty", "Alpha", "Beta"]));
  });

  it("drops onto the strip under the tree to move a page back to the top level", async () => {
    const { app, tree } = await open();
    await app.user.click(within(tree).getByRole("treeitem", { name: "Docs" }));
    const notes = await within(tree).findByRole("treeitem", { name: "Notes" });
    const dataTransfer = { setData: () => undefined, getData: () => "", effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(notes, { dataTransfer });
    const strip = await waitFor(() => {
      const el = tree.querySelector<HTMLElement>(".tree-root-drop");
      expect(el).not.toBeNull();
      return el!;
    });
    strip.getBoundingClientRect = () => ({ top: 0, height: 100, left: 0, width: 200, bottom: 100, right: 200, x: 0, y: 0, toJSON: () => ({}) });
    over(strip, "dragOver", 50, dataTransfer);
    over(strip, "drop", 50, dataTransfer);
    await waitFor(async () => expect(await app.read("Notes.md")).toBe("# Notes\n"));
    await waitFor(async () => expect((await orderFile(app)).folders[""]).toContain("Notes.md")); // the move has settled
    await waitFor(() => expect(rows(tree)).toContain("Notes"));
  });

  it("a name clash in the folder is reported and nothing moves", async () => {
    const { app, tree } = await open({ "Alpha.md": "# Alpha\n", "Docs/Alpha.md": "# Other alpha\n" });
    drag(within(tree).getByRole("treeitem", { name: "Alpha" }), within(tree).getByRole("treeitem", { name: "Docs" }), 0.5);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not move/);
    expect(await app.read("Alpha.md")).toBe("# Alpha\n");
    expect(await app.read("Docs/Alpha.md")).toBe("# Other alpha\n");
  });

  it("'Move to…' from code moves a page into a folder", async () => {
    const { app, tree } = await open();
    requestMoveTo({ kind: "private", path: "Gamma.md" });
    const dialog = await screen.findByRole("dialog", { name: "Move “Gamma” to…" });
    const list = within(dialog).getByRole("listbox", { name: "Move into" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent?.trim())).toEqual(["Top level", "Docs", "Empty"]);
    await app.user.selectOptions(list, "Empty");
    await app.user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(async () => expect(await app.read("Empty/Gamma.md")).toBe("# Gamma\n"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(within(tree).getByRole("treeitem", { name: "Empty" }).getAttribute("title")).toBe("Folder · 1 item"));
  });

  it("the open page follows when it is moved", async () => {
    const { app, tree } = await open();
    await app.user.click(within(tree).getByRole("treeitem", { name: "Beta" }));
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain("Beta"));
    drag(within(tree).getByRole("treeitem", { name: "Beta" }), within(tree).getByRole("treeitem", { name: "Docs" }), 0.5);
    await waitFor(async () => expect(await app.read("Docs/Beta.md")).toBe("# Beta\n"));
    await waitFor(() => expect(within(tree).getByRole("treeitem", { name: "Beta" }).getAttribute("aria-current")).toBe("page"));
    await waitFor(() => expect(rows(tree)).toEqual(["Docs", "Notes", "Beta", "Empty", "Alpha", "Gamma"])); // the move has settled
  });

  it("is a tree with arrow-key navigation, and a menu with Move to…", async () => {
    const { app, tree } = await open();
    const docs = within(tree).getByRole("treeitem", { name: "Docs" });
    expect(docs.getAttribute("aria-level")).toBe("1");
    docs.focus();
    await app.user.keyboard("{ArrowRight}");
    expect(docs.getAttribute("aria-expanded")).toBe("true");
    await app.user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(within(tree).getByRole("treeitem", { name: "Notes" }));
    expect(document.activeElement?.getAttribute("aria-level")).toBe("2");
    await app.user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(docs);
    await app.user.keyboard("{ArrowDown}{ArrowDown}");
    fireEvent.contextMenu(document.activeElement!);
    const menu = await screen.findByRole("menu");
    // The row is the "Empty" folder: Rename and New folder inside come first.
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["RenameF2", "New folder inside", "Move up⌥⇧↑", "Move down⌥⇧↓", "Move to…"]);
    await app.user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("in Thai", () => {
  afterEach(() => localStorage.removeItem("thoth.desktop.lang"));

  it("names the menu, the rename field, the folder and the announcements in Thai", async () => {
    localStorage.setItem("thoth.desktop.lang", "th");
    const servers = new FakeServers();
    const server = servers.connect(LOCAL);
    const ws = servers.addWorkspace(server, { name: "Design" });
    servers.writeAsOther(ws, { title: "Plan", markdown: "# Plan\n", position: "G" });
    servers.writeAsOther(ws, { title: "Other", markdown: "# Other\n", position: "N" });
    const app = await openApp(root, {}, createNodePlatform({ vault: root, servers }));
    const list = await screen.findByRole("tree", { name: th.servers.workspacesOn("Team server") });
    await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
    const group = await within(list).findByRole("group", { name: sharedTh.workspace.pagesIn("Design") });

    fireEvent.contextMenu(within(group).getByRole("treeitem", { name: "Plan" }));
    const menu = await screen.findByRole("menu", { name: sharedTh.tree.menuLabel("Plan") });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      `${sharedTh.tree.rename}F2`,
      sharedTh.tree.newPageInside,
      sharedTh.tree.newFolderInside,
      `${sharedTh.tree.moveUp}⌥⇧↑`,
      `${sharedTh.tree.moveDown}⌥⇧↓`,
      sharedTh.tree.moveTo,
    ]);
    await app.user.keyboard("{Escape}");

    within(group).getByRole("treeitem", { name: "Plan" }).focus();
    await app.user.keyboard(ALT_SHIFT("ArrowDown"));
    await waitFor(() => expect(list.querySelector("[data-tree-said]")!.textContent).toBe(sharedTh.tree.movedTo("Plan", 2, 2)));

    await app.user.click(within(list).getByRole("button", { name: sharedTh.tree.newFolderIn("Design") }));
    await screen.findByRole("textbox", { name: sharedTh.tree.renameLabel(sharedTh.tree.newFolderTitle) });
    await app.user.keyboard("{Escape}");
    const folder = await within(group).findByRole("treeitem", { name: sharedTh.tree.newFolderTitle });
    expect(folder.getAttribute("title")).toBe(`${sharedTh.tree.folder} · ${sharedTh.tree.itemCount(0)}`);
  });
});
