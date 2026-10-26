// @vitest-environment jsdom
// Favorites and pinned tabs in the web client (ADR-0027): workspace pages starred from the page's header and the tree,
// listed first in the sidebar, kept in this browser per account and never sent; a pinned tab that Alt+W leaves open.
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { WORKSPACE_FAVORITES_KEY } from "@thoth/app-ui/favorites/workspace-favorites.ts";
import { FakeWebServer } from "./support/fake-web-server.ts";
import { cleanup, editorBox, fakeBrowser, open, screen, signInThroughUi, waitFor, within } from "./support/render.tsx";

afterEach(() => cleanup());

const row = (name: string) => screen.findByRole("treeitem", { name });
const region = () => screen.queryByRole("region", { name: "Favorites" });
const favoriteNames = () => [...(region()?.querySelectorAll(".fav-item .tree-label") ?? [])].map((el) => el.textContent);
const tabNames = () => screen.queryAllByRole("tab").map((t) => t.getAttribute("aria-label") ?? t.textContent);

async function signedIn(local = new Map<string, string>()) {
  const server = new FakeWebServer();
  const ws = server.workspace("Notes", "viewer");
  const pages = ["Alpha", "Beta"].map((title) => server.servers.writeAsOther(ws, { title, markdown: `# ${title}\n\nBody of ${title}.\n` }));
  const browser = fakeBrowser(server, { local });
  await signInThroughUi(browser);
  return { browser, server, ws, pages, local };
}

describe("Favorites in the web client", () => {
  it("stars a page from its header and the tree; the list is first, opens pages, is kept in this browser and survives a reload", async () => {
    const { browser, server, ws, pages, local } = await signedIn();
    expect(region()).toBeNull();
    await browser.user.click(await row("Alpha"));
    await editorBox();
    const starButton = await screen.findByRole("button", { name: "Favorite" });
    const writes = server.servers.calls.length;
    await browser.user.click(starButton);
    await waitFor(() => expect(favoriteNames()).toEqual(["Alpha"]));
    expect(starButton.getAttribute("aria-pressed")).toBe("true");
    fireEvent.contextMenu(await row("Beta"));
    await browser.user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Add to Favorites" }));
    await waitFor(() => expect(favoriteNames()).toEqual(["Alpha", "Beta"]));
    expect(server.servers.calls.slice(writes).filter((c) => c.method !== "GET")).toEqual([]);
    expect(JSON.parse(local.get(WORKSPACE_FAVORITES_KEY)!).lists[0]).toEqual({ server: browser.env.server, account: "usr_ada", workspace: ws.id, pages: [pages[0]!.id, pages[1]!.id] });
    // The list is above the workspaces.
    const nav = screen.getByRole("navigation", { name: "Pages" });
    expect(nav.firstElementChild).toBe(region());
    await browser.user.click(within(region()!).getByRole("button", { name: /^Beta/ }));
    await waitFor(() => expect(tabNames()).toEqual(["Beta"]));

    cleanup();
    open(browser);
    await waitFor(() => expect(favoriteNames()).toEqual(["Alpha", "Beta"]));
  });
});

describe("pinned tabs in the web client", () => {
  it("Pin tab keeps it first and compact, and Alt+W does not close it", async () => {
    const { browser } = await signedIn();
    await browser.user.click(await row("Alpha"));
    await browser.user.keyboard("{Control>}");
    await browser.user.click(await row("Beta"));
    await browser.user.keyboard("{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta"]));
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Beta" }), { clientX: 10, clientY: 10 });
    await browser.user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Pin tab/ }));
    await waitFor(() => expect(tabNames()).toEqual(["Beta, pinned", "Alpha"]));
    await browser.user.click(screen.getByRole("tab", { name: "Beta, pinned" }));
    await browser.user.keyboard("{Alt>}w{/Alt}");
    await waitFor(() => expect(document.querySelector("[data-tabs-said]")?.textContent).toBe("Pinned tab: unpin it to close it"));
    expect(tabNames()).toEqual(["Beta, pinned", "Alpha"]);
  });
});
