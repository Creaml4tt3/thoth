// @vitest-environment jsdom
// Favorites and pinned tabs in the desktop app (ADR-0027): the star in a page's header, the tree's menu, the Favorites
// section (first, hidden while empty), opening, reordering, restart and rename; workspace pages kept in this app only;
// pinned tabs from the tab's menu, Cmd/Ctrl+W leaving them, and the restart.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAVORITES_PATH } from "@thoth/local-store";
import { WORKSPACE_FAVORITES_KEY } from "@thoth/app-ui/favorites/workspace-favorites.ts";
import { cleanup, editorBox, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";
import { FakeServers, type FakeServerConfig } from "../../../tests/helpers/fake-servers.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": BETA, "Gamma.md": "# Gamma\n\nThe third page.\n" });
});
afterEach(async () => {
  cleanup();
  localStorage.clear();
  await dirs.cleanup();
});

const tree = () => screen.findByRole("tree", { name: "Pages in this Private Space" });
const row = async (name: string) => within(await tree()).getByRole("treeitem", { name });
const star = () => screen.findByRole("button", { name: "Favorite" });
const favoritesRegion = () => screen.queryByRole("region", { name: "Favorites" });
const favoriteNames = () => [...(favoritesRegion()?.querySelectorAll(".fav-item .tree-label") ?? [])].map((el) => el.textContent);
const favoriteRow = (name: string) => within(favoritesRegion()!).getByRole("button", { name: new RegExp(`^${name}`) });
const sectionNames = () => [...document.querySelectorAll<HTMLElement>(".side-section")].map((el) => el.getAttribute("aria-label"));
const tabs = () => screen.queryAllByRole("tab");
const tabNames = () => tabs().map((t) => t.getAttribute("aria-label") ?? t.textContent);
const current = () => tabs().find((t) => t.getAttribute("aria-selected") === "true");
const storedIds = async () => (JSON.parse(await readFile(join(root, FAVORITES_PATH), "utf8")) as { pages: string[] }).pages;

async function start(platform?: ReturnType<typeof createNodePlatform>): Promise<Harness> {
  const app = await openApp(root, {}, platform ?? createNodePlatform({ vault: root }));
  await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
  await editorBox();
  return app;
}

describe("Favorites of the Private Space", () => {
  it("has no Favorites section until a page is starred from its header; then it is first, and the star is pressed", async () => {
    const app = await start();
    expect(favoritesRegion()).toBeNull();
    const button = await star();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("data-tip")).toBe("Add to Favorites");
    await app.user.click(button);
    await waitFor(() => expect(favoriteNames()).toEqual(["Alpha"]));
    expect(sectionNames()[0]).toBe("Favorites");
    await waitFor(async () => expect((await star()).getAttribute("aria-pressed")).toBe("true"));
    expect(document.querySelector("[data-favorites-note]")?.textContent).toBe("Alpha added to Favorites");
    // By its stable id, written into the page (ADR-0003), not by its path.
    const [id] = await storedIds();
    expect(await app.read("Alpha.md")).toContain(`thoth_id: ${id}`);
  });

  it("stars from the tree's menu, opens from the section, and Cmd/Ctrl+click opens a new tab", async () => {
    const app = await start();
    fireEvent.contextMenu(await row("Gamma"));
    await app.user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Add to Favorites" }));
    await waitFor(() => expect(favoriteNames()).toEqual(["Gamma"]));
    await app.user.click(favoriteRow("Gamma"));
    await waitFor(() => expect(tabNames()).toEqual(["Gamma"]));
    expect(favoriteRow("Gamma").getAttribute("aria-current")).toBe("page");
    fireEvent.contextMenu(await row("Beta"));
    await app.user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Add to Favorites" }));
    await waitFor(() => expect(favoriteNames()).toEqual(["Gamma", "Beta"]));
    await app.user.keyboard("{Control>}");
    await app.user.click(favoriteRow("Beta"));
    await app.user.keyboard("{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Gamma", "Beta"]));
  });

  it("Alt+Shift+Up reorders, and the order, the favorites and a rename survive a restart", async () => {
    const app = await start();
    await app.user.click(await star()); // Alpha
    await app.user.click(await row("Beta"));
    await waitFor(() => expect(tabNames()).toEqual(["Beta"]));
    await app.user.keyboard("{Control>}d{/Control}"); // the shortcut stars the open page
    await waitFor(() => expect(favoriteNames()).toEqual(["Alpha", "Beta"]));
    favoriteRow("Beta").focus();
    await app.user.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
    await waitFor(() => expect(favoriteNames()).toEqual(["Beta", "Alpha"]));
    expect(document.querySelector("[data-favorites-said]")?.textContent).toBe("Beta moved to position 1 of 2");
    await waitFor(() => expect(document.activeElement).toBe(favoriteRow("Beta")));

    // Renamed in the tree: the favorite follows the page.
    (await row("Alpha")).focus();
    await app.user.keyboard("{F2}");
    const field = await screen.findByRole("textbox", { name: /Rename/ });
    await app.user.clear(field);
    await app.user.type(field, "Omega{Enter}");
    await waitFor(() => expect(within(screen.getByRole("tree", { name: "Pages in this Private Space" })).queryByRole("treeitem", { name: "Omega" })).not.toBeNull());
    await waitFor(() => expect(favoriteNames()).toEqual(["Beta", "Omega"]));

    cleanup();
    await openApp(root);
    await waitFor(() => expect(favoriteNames()).toEqual(["Beta", "Omega"]));
    expect(sectionNames()[0]).toBe("Favorites");
  });

  it("Remove from Favorites in a favorite's menu takes it out, and the section goes away with the last one", async () => {
    const app = await start();
    await app.user.click(await star());
    await waitFor(() => expect(favoriteNames()).toEqual(["Alpha"]));
    fireEvent.contextMenu(favoriteRow("Alpha"));
    const menu = await screen.findByRole("menu", { name: "Favorite: Alpha" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Open in new tabCtrl+Enter", "Move up⌥⇧↑", "Move down⌥⇧↓", "Remove from Favorites"]);
    await app.user.click(within(menu).getByRole("menuitem", { name: "Remove from Favorites" }));
    await waitFor(() => expect(favoritesRegion()).toBeNull());
    expect(await storedIds()).toEqual([]);
    expect((await star()).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("Favorites of workspace pages", () => {
  const TEAM: FakeServerConfig = { url: "http://127.0.0.1:8080", name: "Team server", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" } };

  it("are starred from the tree, listed with their workspace's name, kept in this app per account and never sent", async () => {
    const servers = new FakeServers();
    const server = servers.connect(TEAM);
    const ws = servers.addWorkspace(server, { name: "Design", role: "viewer" });
    const plan = servers.writeAsOther(ws, { title: "Plan", markdown: "# Plan\n\nThe plan.\n" });
    const app = await start(createNodePlatform({ vault: root, servers }));
    await app.user.click(await star()); // Alpha, Local
    const list = await screen.findByRole("tree", { name: "Workspaces on Team server" });
    await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
    const group = await within(list).findByRole("group", { name: "Pages in Design" });
    const before = servers.calls.length;
    fireEvent.contextMenu(within(group).getByRole("treeitem", { name: "Plan" }));
    await app.user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Add to Favorites" }));
    await waitFor(() => expect(favoriteNames()).toEqual(["Alpha", "Plan"]));
    expect([...favoritesRegion()!.querySelectorAll(".fav-hint")].map((el) => el.textContent)).toEqual(["Local", "Design"]);
    expect(JSON.parse(localStorage.getItem(WORKSPACE_FAVORITES_KEY)!)).toEqual({ v: 1, lists: [{ server: TEAM.url, account: "usr_me", workspace: ws.id, pages: [plan.id] }] });
    expect(servers.calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]); // nothing written to the server
    // A favorite moves only among those of its workspace: Plan stays after the Private Space's.
    favoriteRow("Plan").focus();
    await app.user.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
    expect(favoriteNames()).toEqual(["Alpha", "Plan"]);
    await app.user.click(favoriteRow("Plan"));
    await waitFor(() => expect(current()?.textContent).toBe("Plan"));
    expect((await star()).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("pinned tabs", () => {
  it("Pin tab in the tab's menu keeps it first and compact; Cmd/Ctrl+W leaves it and says why; a restart keeps it", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}");
    await app.user.click(await row("Beta"));
    await app.user.keyboard("{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta"]));
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Beta" }), { clientX: 10, clientY: 10 });
    await app.user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Pin tab/ }));
    await waitFor(() => expect(tabNames()).toEqual(["Beta, pinned", "Alpha"]));
    expect(screen.getByRole("tab", { name: "Beta, pinned" }).textContent).toBe("Be");
    await app.user.click(screen.getByRole("tab", { name: "Beta, pinned" }));
    await waitFor(() => expect(current()?.getAttribute("aria-label")).toBe("Beta, pinned"));
    await app.user.keyboard("{Control>}w{/Control}");
    await waitFor(() => expect(document.querySelector("[data-tabs-said]")?.textContent).toBe("Pinned tab: unpin it to close it"));
    expect(tabNames()).toEqual(["Beta, pinned", "Alpha"]);
    // The page stays in its pinned tab: a page opened from the tree goes to a new tab beside it.
    await app.user.click(await row("Gamma"));
    await waitFor(() => expect(tabNames()).toEqual(["Beta, pinned", "Gamma", "Alpha"]));

    cleanup();
    await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Beta, pinned", "Gamma", "Alpha"]));
    // Alt+Shift+P unpins the current tab (Gamma is current: it was open at the restart).
    await app.user.click(screen.getByRole("tab", { name: "Beta, pinned" }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "∏", code: "KeyP", altKey: true, shiftKey: true });
    await waitFor(() => expect(tabNames()).toEqual(["Beta", "Gamma", "Alpha"]));
  });
});
