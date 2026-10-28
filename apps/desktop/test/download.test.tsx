// @vitest-environment jsdom
// Download as Markdown on the desktop: the page header's button and "Download as Markdown…" in the trees' menus hand
// the page's text to the host's "Save as", named after the page. Not where a workspace keeps its pages in (ADR-0009).
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeServers, type FakeServerConfig } from "../../../tests/helpers/fake-servers.ts";
import { caretAtEnd, cleanup, editorBox, openApp, paragraph, screen, waitFor, within } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { ALPHA, seed } from "./support/fixtures.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Notes/Plan.md": "# Plan\n\n![map](map.png)\n" });
});
afterEach(async () => {
  cleanup();
  localStorage.clear();
  await dirs.cleanup();
});

/** A platform whose "Save as" records what it was given; `cancel` answers as if the person cancelled. */
function saving(options: { servers?: FakeServers; cancel?: boolean } = {}) {
  const platform = createNodePlatform({ vault: root, ...(options.servers ? { servers: options.servers } : {}) });
  const saved: { name: string; text: string }[] = [];
  platform.saveFile = async (name, bytes) => {
    if (options.cancel) return false;
    saved.push({ name, text: new TextDecoder().decode(bytes) });
    return true;
  };
  return { platform, saved };
}

/** What the download regions say (the page header's and each tree's). */
const said = () => [...document.querySelectorAll("[data-download-said]")].map((el) => el.textContent).join("");

describe("Download as Markdown in the Private Space", () => {
  it("saves the open page's file as it is, edits written first, named after the page", async () => {
    const { platform, saved } = saving();
    const app = await openApp(root, { autosaveMs: 0 }, platform);
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("First paragraph stays exactly."));
    box.focus();
    caretAtEnd(paragraph(box, "First paragraph stays exactly."));
    await app.user.keyboard(" Typed.");
    await app.user.click(screen.getByRole("button", { name: "Download as Markdown" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.name).toBe("Alpha.md");
    expect(saved[0]!.text).toBe(await app.read("Alpha.md"));
    expect(saved[0]!.text).toContain("Typed.");
    await waitFor(() => expect(said()).toBe("Saved Alpha.md"));
  });

  it("is in a page's menu and not in a folder's; a picture stays a link; cancelling says nothing", async () => {
    const { platform, saved } = saving();
    const app = await openApp(root, {}, platform);
    await editorBox();
    const tree = await screen.findByRole("tree", { name: "Pages in this Private Space" });
    fireEvent.contextMenu(within(tree).getByRole("treeitem", { name: "Notes" }));
    expect(within(await screen.findByRole("menu")).queryByRole("menuitem", { name: "Download as Markdown…" })).toBeNull();
    await app.user.keyboard("{Escape}");
    await app.user.click(within(tree).getByRole("treeitem", { name: "Notes" }));
    fireEvent.contextMenu(within(tree).getByRole("treeitem", { name: "Plan" }));
    await app.user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Download as Markdown…" }));
    await waitFor(() => expect(saved).toEqual([{ name: "Plan.md", text: "# Plan\n\n![map](map.png)\n" }]));

    const quiet = saving({ cancel: true });
    cleanup();
    await openApp(root, {}, quiet.platform);
    await editorBox();
    await app.user.click(screen.getByRole("button", { name: "Download as Markdown" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(said()).toBe("");
  });

  it("is not offered where the host cannot save files", async () => {
    await openApp(root);
    await editorBox();
    expect(screen.queryByRole("button", { name: "Download as Markdown" })).toBeNull();
  });
});

const LOCAL: FakeServerConfig = { url: "http://127.0.0.1:8080", name: "Team server", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" }, capabilities: ["search", "page-order", "page-kind"] };

async function workspace(exportRestricted: boolean) {
  const servers = new FakeServers();
  servers.connect(LOCAL);
  const server = [...(await servers.list())][0]!.id;
  const ws = servers.addWorkspace(server, { name: "Design", role: "viewer", exportRestricted });
  servers.writeAsOther(ws, { title: "Road: map?", markdown: "# Road: map?\n\nPlans.\n" });
  const { platform, saved } = saving({ servers });
  const app = await openApp(root, { autosaveMs: 0 }, platform);
  const list = await screen.findByRole("tree", { name: "Workspaces on Team server" });
  await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
  const group = await within(list).findByRole("group", { name: "Pages in Design" });
  return { app, group, saved };
}

describe("Download as Markdown in a workspace", () => {
  it("saves the page's text from the server, from the header and the menu, for a viewer too", async () => {
    const { app, group, saved } = await workspace(false);
    fireEvent.contextMenu(within(group).getByRole("treeitem", { name: "Road: map?" }));
    await app.user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Download as Markdown…" }));
    await waitFor(() => expect(saved).toEqual([{ name: "Road  map.md", text: "# Road: map?\n\nPlans.\n" }]));
    await app.user.click(within(group).getByRole("treeitem", { name: "Road: map?" }));
    await app.user.click(await screen.findByRole("button", { name: "Download as Markdown" }));
    await waitFor(() => expect(saved).toHaveLength(2));
  });

  it("is not offered where the workspace does not let its pages be copied out", async () => {
    const { app, group } = await workspace(true);
    await app.user.click(within(group).getByRole("treeitem", { name: "Road: map?" }));
    await editorBox();
    expect(screen.queryByRole("button", { name: "Download as Markdown" })).toBeNull();
    fireEvent.contextMenu(within(group).getByRole("treeitem", { name: "Road: map?" }));
    const menu = await screen.findByRole("menu").catch(() => null);
    expect(menu ? within(menu).queryByRole("menuitem", { name: "Download as Markdown…" }) : null).toBeNull();
  });
});
