// @vitest-environment jsdom
// Public read-only share links on the desktop (ADR-0023): "Share…" on a workspace page's menu and in the palette, the
// dialog (create with an expiry, copy, list, revoke), axe, and where it is hidden.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { axeViolations } from "../../../tests/helpers/axe.ts";
import { FakeServers, type FakeServerConfig, type FakeWorkspace } from "../../../tests/helpers/fake-servers.ts";
import { cleanup, openApp, screen, waitFor, within } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { ALPHA, seed } from "./support/fixtures.ts";

const dirs = tempDirs();
let root: string;

const SHARING = ["search", "transfers", "attachments", "page-order", "page-kind", "public-share"];
const LOCAL: FakeServerConfig = { url: "http://127.0.0.1:8080", name: "Team server", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" }, capabilities: SHARING };

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA });
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

async function workspace(options: { role?: "owner" | "editor" | "viewer"; capabilities?: string[] } = {}) {
  const servers = new FakeServers();
  servers.connect({ ...LOCAL, capabilities: options.capabilities ?? SHARING });
  const server = [...(await servers.list())][0]!.id;
  const ws: FakeWorkspace = servers.addWorkspace(server, { name: "Design", role: options.role ?? "editor" });
  const page = servers.writeAsOther(ws, { title: "Roadmap", markdown: "# Roadmap\n\nPlans.\n" });
  const app = await openApp(root, { autosaveMs: 0 }, createNodePlatform({ vault: root, servers }));
  const list = await screen.findByRole("tree", { name: "Workspaces on Team server" });
  await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
  const group = await within(list).findByRole("group", { name: "Pages in Design" });
  return { app, servers, ws, page, group };
}

describe("Share… on the desktop", () => {
  it("opens from the page's menu, creates a link, shows and copies its address, lists it and revokes it", async () => {
    const { app, ws, group } = await workspace();
    fireEvent.contextMenu(within(group).getByRole("treeitem", { name: "Roadmap" }));
    const menu = await screen.findByRole("menu", { name: "Actions for Roadmap" });
    expect(within(menu).getAllByRole("menuitem").at(-1)!.textContent).toBe("Share…");
    await app.user.click(within(menu).getByRole("menuitem", { name: "Share…" }));
    const dialog = await screen.findByRole("dialog", { name: "Share “Roadmap”" });

    await app.user.click(within(dialog).getByRole("radio", { name: "90 days" }));
    await app.user.click(within(dialog).getByRole("button", { name: "Create link" }));
    const field = (await within(dialog).findByRole("textbox", { name: "Public link" })) as HTMLInputElement;
    const link = ws.shares[0]!;
    expect(field.value).toBe(`http://127.0.0.1:8080/s/${link.token}`);
    expect(Math.round((Date.parse(link.expiresAt!) - Date.parse(link.createdAt)) / 86_400_000)).toBe(90);
    await app.user.click(within(dialog).getByRole("button", { name: "Copy link" }));
    expect(await navigator.clipboard.readText()).toBe(field.value);
    expect(await axeViolations(dialog)).toEqual([]);

    const active = within(dialog).getByRole("list", { name: "Active links" });
    await app.user.click(within(active).getByRole("button", { name: /^Revoke the link created / }));
    await waitFor(() => expect(link.revoked).toBe(true));
    expect(await within(dialog).findByText("No active links.")).toBeTruthy();
    await app.user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("is in the palette as “Share page…” when a workspace page is open", async () => {
    const { app, group } = await workspace();
    await app.user.click(within(group).getByRole("treeitem", { name: "Roadmap" }));
    await app.user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByRole("dialog", { name: "Search" });
    await app.user.keyboard("> share");
    await app.user.click(within(search).getByRole("option", { name: /^Share page…/ }));
    expect(await screen.findByRole("dialog", { name: "Share “Roadmap”" })).toBeTruthy();
  });

  it("has a Share… button in the page header that opens the same dialog", async () => {
    const { app, group } = await workspace();
    await app.user.click(within(group).getByRole("treeitem", { name: "Roadmap" }));
    const button = await screen.findByRole("button", { name: "Share…" });
    expect(button.getAttribute("data-tip")).toBe("Share…");
    await app.user.click(button);
    expect(await screen.findByRole("dialog", { name: "Share “Roadmap”" })).toBeTruthy();
  });

  it("has no header Share… button without public-share", async () => {
    const plain = await workspace({ capabilities: ["search", "page-order", "page-kind"] });
    await plain.app.user.click(within(plain.group).getByRole("treeitem", { name: "Roadmap" }));
    await screen.findByRole("button", { name: "Favorite" });
    expect(screen.queryByRole("button", { name: "Share…" })).toBeNull();
  });

  it("has no header Share… button for a viewer", async () => {
    const viewer = await workspace({ role: "viewer" });
    await viewer.app.user.click(within(viewer.group).getByRole("treeitem", { name: "Roadmap" }));
    await screen.findByRole("button", { name: "Favorite" });
    expect(screen.queryByRole("button", { name: "Share…" })).toBeNull();
  });

  it("is hidden when the server lacks public-share", async () => {
    const plain = await workspace({ capabilities: ["search", "page-order", "page-kind"] });
    fireEvent.contextMenu(within(plain.group).getByRole("treeitem", { name: "Roadmap" }));
    const menu = await screen.findByRole("menu", { name: "Actions for Roadmap" });
    expect(within(menu).queryByRole("menuitem", { name: "Share…" })).toBeNull();
    await plain.app.user.keyboard("{Escape}");
    await plain.app.user.click(within(plain.group).getByRole("treeitem", { name: "Roadmap" }));
    await plain.app.user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByRole("dialog", { name: "Search" });
    await plain.app.user.keyboard("> share");
    expect(within(search).queryByRole("option", { name: /^Share page/ })).toBeNull();
  });

  it("is hidden for a viewer", async () => {
    const viewer = await workspace({ role: "viewer" });
    await viewer.app.user.click(within(viewer.group).getByRole("treeitem", { name: "Roadmap" }));
    await viewer.app.user.keyboard("{Control>}k{/Control}");
    const again = await screen.findByRole("dialog", { name: "Search" });
    await viewer.app.user.keyboard("> share");
    expect(within(again).queryByRole("option", { name: /^Share page/ })).toBeNull();
    expect(viewer.servers.calls.some((c) => c.path.includes("share-links"))).toBe(false);
  });
});
