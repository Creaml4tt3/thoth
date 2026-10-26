// @vitest-environment jsdom
/**
 * Drag and drop between the Private Space tree and a workspace tree (ADR-0006, amendment of 2026-10-26). A drop
 * across spaces opens the transfer dialog prefilled (direction, pages, workspace or folder, Copy or with Alt/Option
 * Move); the dialog still previews and waits for the person. Refused targets show no indicator and say why. Within
 * one tree a drag works as before.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEvent, fireEvent } from "@testing-library/react";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { FakeServers, type FakeServerConfig, type FakeWorkspace } from "../../../tests/helpers/fake-servers.ts";
import { seed } from "./support/fixtures.ts";
import { isFolderMarkdown } from "@thoth/app-ui/workspace/folders.ts";

const dirs = tempDirs();
let root: string;

const TEAM: FakeServerConfig = { url: "https://team.example", name: "Team", account: { id: "usr_me", displayName: "Ada" } };

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, {
    "Plan.md": "# Plan\n\nSee [[Notes]].\n",
    "Diary.md": "# Diary\n",
    "Projects/Notes.md": "# Notes\n\nBack to [[Plan]].\n",
    "Projects/Spec.md": "# Spec\n",
  });
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

interface Options {
  role?: "owner" | "editor" | "viewer";
  exportRestricted?: boolean;
  capabilities?: string[];
}

/** A signed-in server "Team" with the workspaces "Archive" (owner) and "Studio" (as given), Studio holding "Board" and "Roadmap". */
async function start(options: Options = {}) {
  const servers = new FakeServers();
  const server = servers.connect({ ...TEAM, ...(options.capabilities ? { capabilities: options.capabilities } : {}) });
  const archive = servers.addWorkspace(server, { name: "Archive", role: "owner" });
  const ws = servers.addWorkspace(server, { name: "Studio", role: options.role ?? "owner", ...(options.exportRestricted ? { exportRestricted: true } : {}) });
  const board = servers.writeAsOther(ws, { title: "Board", markdown: "# Board\n" });
  const roadmap = servers.writeAsOther(ws, { title: "Roadmap", markdown: "# Roadmap\n\nไทย\n" });
  const app = await openApp(root, {}, createNodePlatform({ vault: root, servers }));
  const local = await screen.findByRole("tree", { name: "Pages in this Private Space" });
  const list = await screen.findByRole("tree", { name: "Workspaces on Team" });
  return { app, servers, server, ws, archive, board, roadmap, local, list };
}

const live = (ws: FakeWorkspace) => [...ws.pages.values()].filter((p) => !p.deleted);
const row = (tree: HTMLElement, name: string | RegExp) => within(tree).getByRole("treeitem", { name });
/** The Private Space header (its name and the Local badge). */
const header = () => within(screen.getByRole("complementary")).getByText("Local").closest(".sec") as HTMLElement;
const badge = () => document.querySelector(".space-drag-badge");

async function expand(app: Harness, list: HTMLElement) {
  await app.user.click(row(list, /^Studio/));
  return within(list).findByRole("group", { name: "Pages in Studio" });
}

function dataTransfer() {
  const store = new Map<string, string>();
  return { setData: (type: string, value: string) => void store.set(type, value), getData: (type: string) => store.get(type) ?? "", effectAllowed: "", dropEffect: "", types: [] as string[] };
}

/** jsdom has no DragEvent: the pointer position and Alt are put on the event by hand. */
function fire(target: HTMLElement, type: "dragEnter" | "dragOver" | "drop", data: object, options: { alt?: boolean; at?: number } = {}) {
  target.getBoundingClientRect = () => ({ top: 0, height: 100, left: 0, width: 200, bottom: 100, right: 200, x: 0, y: 0, toJSON: () => ({}) });
  const event = createEvent[type](target, { dataTransfer: data });
  Object.defineProperty(event, "clientY", { value: (options.at ?? 0.5) * 100 });
  Object.defineProperty(event, "clientX", { value: 100 });
  Object.defineProperty(event, "altKey", { value: options.alt ?? false });
  fireEvent(target, event);
  return event;
}

/** Starts a drag on `source` and holds it over `target`; returns what the drop would do and a way to finish. */
function hold(source: HTMLElement, target: HTMLElement, options: { alt?: boolean; at?: number } = {}) {
  const data = dataTransfer();
  fireEvent.dragStart(source, { dataTransfer: data });
  fire(target, "dragEnter", data, options);
  const over = fire(target, "dragOver", data, options);
  return {
    accepted: over.defaultPrevented,
    effect: data.dropEffect,
    drop() {
      fire(target, "drop", data, options);
      fireEvent.dragEnd(source, { dataTransfer: data });
    },
    cancel() {
      fireEvent.dragEnd(source, { dataTransfer: data });
    },
  };
}

const parentSelect = (dialog: HTMLElement) => within(dialog).getByRole("combobox", { name: "Put the pages" }) as HTMLSelectElement;
const workspaceSelect = (dialog: HTMLElement) => within(dialog).getByRole("combobox", { name: "Workspace" }) as HTMLSelectElement;
const radio = (dialog: HTMLElement, name: string) => within(dialog).getByRole("radio", { name: new RegExp(`^${name}`) }) as HTMLInputElement;

describe("Private Space → workspace by drag and drop", () => {
  it("a page dropped on a workspace row opens the dialog for that workspace, Copy chosen; it copies only after confirming", async () => {
    const { app, servers, ws, local, list } = await start();
    const drag = hold(row(local, "Plan"), row(list, /^Studio/));
    expect(drag.accepted).toBe(true);
    expect(drag.effect).toBe("copy");
    expect(row(list, /^Studio/).getAttribute("data-drop")).toBe("inside");
    expect(badge()?.textContent).toBe("Copy to Studio…");
    drag.drop();
    expect(badge()).toBeNull();

    const dialog = await screen.findByRole("dialog", { name: "Copy 1 page to a workspace" });
    // Studio, not the first workspace in the list (Archive).
    expect(workspaceSelect(dialog).value).toContain(ws.id);
    expect(parentSelect(dialog).value).toBe("");
    expect(radio(dialog, "Copy").checked).toBe(true);
    await waitFor(() => expect(within(dialog).getByRole("region", { name: "Who can see it" }).textContent).toContain("Nothing has left this computer yet."));
    // The drop itself sent nothing.
    expect(servers.calls.filter((c) => c.method !== "GET")).toEqual([]);

    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(false));
    await app.user.click(within(dialog).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("1 page was copied to Studio."), { timeout: 10_000 });
    expect(live(ws).find((p) => p.title === "Plan")?.markdown).toContain("See [[Notes]].");
    expect(await app.read("Plan.md")).toContain("See [[Notes]].");
  });

  it("with Alt/Option held over a workspace page, it lands inside that page and Move is chosen", async () => {
    const { app, ws, board, local, list } = await start();
    const group = await expand(app, list);
    const drag = hold(row(local, "Diary"), row(group, "Board"), { alt: true });
    expect(drag.effect).toBe("move");
    expect(row(group, "Board").getAttribute("data-drop")).toBe("inside");
    expect(badge()?.textContent).toBe("Move to Studio…");
    drag.drop();

    const dialog = await screen.findByRole("dialog", { name: "Move 1 page to a workspace" });
    expect(radio(dialog, "Move").checked).toBe(true);
    await waitFor(() => expect(parentSelect(dialog).value).toBe(board.id));
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(false));
    await app.user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("1 page was moved to Studio."), { timeout: 10_000 });
    expect(live(ws).find((p) => p.title === "Diary")?.parentId).toBe(board.id);
    await expect(app.read("Diary.md")).rejects.toThrow();
  });

  it("a folder travels as a folder page with its pages", async () => {
    const { app, ws, local, list } = await start();
    hold(row(local, "Projects"), row(list, /^Studio/)).drop();
    const dialog = await screen.findByRole("dialog", { name: "Copy 2 pages to a workspace" });
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(false));
    await app.user.click(within(dialog).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("copied to Studio"), { timeout: 10_000 });
    const folder = live(ws).find((p) => p.title === "Projects")!;
    expect(isFolderMarkdown(folder.markdown)).toBe(true);
    expect(live(ws).filter((p) => p.parentId === folder.id).map((p) => p.title).sort()).toEqual(["Notes", "Spec"]);
  });

  it("dragging a selected page takes the whole selection; an unselected one only itself", async () => {
    const { app, local, list } = await start();
    await app.user.click(screen.getByRole("button", { name: "Select pages" }));
    for (const box of within(local).getAllByRole("checkbox")) if ((box as HTMLInputElement).checked) await app.user.click(box);
    await app.user.click(within(local).getByRole("checkbox", { name: "Select Plan" }));
    await app.user.click(within(local).getByRole("checkbox", { name: "Select Diary" }));
    const plan = within(local).getByRole("checkbox", { name: "Select Plan" }).closest("label")!;
    hold(plan, row(list, /^Studio/)).drop();
    expect(await screen.findByRole("dialog", { name: "Copy 2 pages to a workspace" })).toBeTruthy();
  });

  it("a viewer workspace refuses: no indicator, the drop is not accepted, and the pointer says why", async () => {
    const { local, list } = await start({ role: "viewer" });
    const drag = hold(row(local, "Plan"), row(list, /^Studio/));
    expect(drag.accepted).toBe(false);
    expect(document.querySelector("[data-drop]")).toBeNull();
    expect(badge()?.textContent).toBe("You are a viewer in Studio.");
    drag.drop();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a server without transfers refuses and says so", async () => {
    const { local, list } = await start({ capabilities: ["search"] });
    const drag = hold(row(local, "Plan"), row(list, /^Studio/));
    expect(drag.accepted).toBe(false);
    expect(badge()?.textContent).toBe("Team does not accept transfers.");
    drag.cancel();
    expect(badge()).toBeNull();
  });
});

describe("workspace → Private Space by drag and drop", () => {
  it("a workspace page dropped on the Private Space header opens the dialog for its top level", async () => {
    const { app, roadmap, local, list } = await start();
    const group = await expand(app, list);
    const drag = hold(row(group, "Roadmap"), header());
    expect(drag.accepted).toBe(true);
    expect(header().getAttribute("data-drop")).toBe("inside");
    expect(badge()?.textContent).toBe("Copy to Private Space…");
    drag.drop();
    const dialog = await screen.findByRole("dialog", { name: "Copy “Roadmap” to your Private Space" });
    expect((within(dialog).getByRole("textbox", { name: /Folder in your Private Space/ }) as HTMLInputElement).value).toBe("");
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(false));
    await app.user.click(within(dialog).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("copied to your Private Space"), { timeout: 10_000 });
    expect(await app.read("Roadmap.md")).toContain("ไทย");
    expect(roadmap.deleted).toBe(false);
    void local;
  });

  it("onto a Private Space folder (or a page in it) the folder is the destination; Alt/Option chooses Move", async () => {
    const { app, ws, local, list } = await start();
    const group = await expand(app, list);
    await app.user.click(row(local, "Projects"));
    const spec = await within(local).findByRole("treeitem", { name: "Spec" });
    // Over a page in the folder: the folder row is lit, not the page.
    const drag = hold(row(group, "Roadmap"), spec, { alt: true });
    expect(drag.accepted).toBe(true);
    expect(drag.effect).toBe("move");
    expect(row(local, "Projects").getAttribute("data-drop")).toBe("inside");
    expect(spec.hasAttribute("data-drop")).toBe(false);
    expect(badge()?.textContent).toBe("Move to Private Space…");
    drag.drop();
    const dialog = await screen.findByRole("dialog", { name: "Move “Roadmap” to your Private Space" });
    expect((within(dialog).getByRole("textbox", { name: /Folder in your Private Space/ }) as HTMLInputElement).value).toBe("Projects");
    expect(radio(dialog, "Move").checked).toBe(true);
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(false));
    await app.user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("1 page was moved to your Private Space."), { timeout: 10_000 });
    expect(await app.read("Projects/Roadmap.md")).toContain("ไทย");
    expect(live(ws).map((p) => p.title)).toEqual(["Board"]);
  });

  it("an export-restricted workspace refuses as a source, and says why", async () => {
    const { app, local, list } = await start({ exportRestricted: true });
    const group = await expand(app, list);
    const drag = hold(row(group, "Roadmap"), row(local, "Plan"));
    expect(drag.accepted).toBe(false);
    expect(document.querySelector("[data-drop]")).toBeNull();
    expect(badge()?.textContent).toBe("Studio does not allow copying or moving its pages out.");
    drag.drop();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a viewer's pages stay undraggable, as within the tree (they copy out with the page's own button)", async () => {
    const { app, list } = await start({ role: "viewer" });
    const group = await expand(app, list);
    expect(row(group, "Roadmap").getAttribute("draggable")).toBeNull();
    hold(row(group, "Roadmap"), header()).drop();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a page dragged to another workspace is not accepted there (no transfer between workspaces)", async () => {
    const { app, list } = await start();
    const group = await expand(app, list);
    const drag = hold(row(group, "Roadmap"), row(list, /^Archive/));
    expect(drag.accepted).toBe(false);
    expect(badge()).toBeNull();
    drag.drop();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("within one tree", () => {
  it("a Private Space drag still moves the file and opens no dialog", async () => {
    const { app, local } = await start();
    const drag = hold(row(local, "Plan"), row(local, "Projects"));
    expect(drag.effect).toBe("move");
    drag.drop();
    await waitFor(async () => expect(await app.read("Projects/Plan.md")).toContain("See [[Notes]]."));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a workspace drag still moves the page there and opens no dialog", async () => {
    const { app, servers, board, roadmap, list } = await start();
    const group = await expand(app, list);
    hold(row(group, "Roadmap"), row(group, "Board")).drop();
    await waitFor(() => expect(servers.calls.some((c) => c.method === "POST" && c.path.endsWith("/move"))).toBe(true));
    await waitFor(() => expect(roadmap.parentId).toBe(board.id));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
