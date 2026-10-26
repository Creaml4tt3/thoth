// @vitest-environment jsdom
// Several workspaces per account in the desktop app (ADR-0025): "New workspace on …" in a server's sidebar section
// header and in the palette, Rename… and Delete… in the workspace row's menu next to Members…, the count near the
// limit and Recently deleted under the server's workspaces, and nothing on a server without workspace-management.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { axeViolations } from "../../../tests/helpers/axe.ts";
import { FakeServers } from "../../../tests/helpers/fake-servers.ts";
import { ALPHA, seed } from "./support/fixtures.ts";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { cleanup, openApp, screen, waitFor, within } from "./support/render.tsx";

const dirs = tempDirs();
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

let root: string;
beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA });
});

const CAPS = ["search", "transfers", "attachments", "page-order", "page-kind", "members", "workspace-management"];

async function workspace(options: { role?: "owner" | "editor" | "viewer"; capabilities?: string[]; limit?: number } = {}) {
  const servers = new FakeServers();
  servers.connect({ url: "http://127.0.0.1:8080", name: "Team server", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" }, capabilities: options.capabilities ?? CAPS, limits: { maxWorkspacesPerAccount: options.limit ?? 3 } });
  const server = [...(await servers.list())][0]!.id;
  const ws = servers.addWorkspace(server, { name: "Design", role: options.role ?? "owner" });
  servers.writeAsOther(ws, { title: "Roadmap", markdown: "# Roadmap\n\nQ1.\n" });
  const app = await openApp(root, { autosaveMs: 0 }, createNodePlatform({ vault: root, servers }));
  const list = await screen.findByRole("tree", { name: "Workspaces on Team server" });
  return { app, servers, server, ws, list, all: () => servers.workspaces.get(server) ?? [] };
}

describe("workspaces on the desktop", () => {
  it("New workspace from the server section's header: created, opened in the sidebar, focused", async () => {
    const { app, all } = await workspace();
    const section = screen.getByRole("region", { name: /Team server/ });
    await app.user.click(within(section).getByRole("button", { name: "New workspace on Team server" }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace on Team server" });
    expect(within(dialog).getByText("You own 1 of 3 workspaces this server allows.")).toBeTruthy();
    expect(await axeViolations(dialog)).toEqual([]);
    await app.user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Research{Enter}");
    const row = await screen.findByRole("treeitem", { name: /^Research/ });
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(all().find((w) => w.name === "Research")?.role).toBe("owner");
    expect(within(section).getByText("2 of 3 workspaces")).toBeTruthy();
  });

  it("the palette opens New workspace and Recently deleted", async () => {
    const { app, servers, server } = await workspace();
    const old = servers.addWorkspace(server, { id: "ws_old", name: "Archive", role: "owner" });
    old.deletedAt = "2026-10-22T09:00:00.000Z";
    await app.user.keyboard("{Control>}k{/Control}");
    await app.user.keyboard("> new workspace");
    await app.user.click(await screen.findByRole("option", { name: /^New workspace…/ }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace on Team server" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^New workspace/ })).toBeNull());
    await app.user.keyboard("{Control>}k{/Control}");
    await app.user.keyboard("> recently deleted");
    await app.user.click(await screen.findByRole("option", { name: /^Recently deleted workspaces…/ }));
    const deleted = await screen.findByRole("dialog", { name: "Recently deleted on Team server" });
    expect(await within(deleted).findByRole("button", { name: "Restore Archive" })).toBeTruthy();
  });

  it("Rename… and Delete… sit next to Members… in the row's menu, by keyboard (Shift+F10)", async () => {
    const { app, ws, list } = await workspace();
    const row = within(list).getByRole("treeitem", { name: /^Design/ });
    row.focus();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    const menu = await screen.findByRole("menu", { name: "Actions for Design" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.replace("F2", ""))).toEqual(["Members…", "Rename…", "Delete…", "New page", "New folder"]);
    await app.user.click(within(menu).getByRole("menuitem", { name: /Rename…/ }));
    const rename = await screen.findByRole("dialog", { name: "Rename “Design”" });
    const field = within(rename).getByRole("textbox", { name: "New name" });
    await app.user.clear(field);
    await app.user.type(field, "Product{Enter}");
    await waitFor(() => expect(within(list).getByRole("treeitem", { name: /^Product/ })).toBeTruthy());
    expect(ws.name).toBe("Product");

    const renamed = within(list).getByRole("treeitem", { name: /^Product/ });
    renamed.focus();
    fireEvent.keyDown(renamed, { key: "F10", shiftKey: true });
    await app.user.click(within(await screen.findByRole("menu", { name: "Actions for Product" })).getByRole("menuitem", { name: "Delete…" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete “Product”?" });
    await app.user.type(within(confirm).getByRole("textbox", { name: /type the workspace's name/ }), "Product{Enter}");
    await waitFor(() => expect(screen.queryByRole("treeitem", { name: /^Product/ })).toBeNull());
    expect(ws.deletedAt).not.toBeNull();
    expect(await screen.findByRole("button", { name: "Recently deleted (1)" })).toBeTruthy();
  });

  it("offers nothing new on a server without workspace-management, and no Rename… or Delete… to editors", async () => {
    await workspace({ capabilities: ["search", "page-order", "page-kind", "members"] });
    expect(screen.queryByRole("button", { name: "New workspace on Team server" })).toBeNull();
    cleanup();
    const { list } = await workspace({ role: "editor" });
    expect(screen.getByRole("button", { name: "New workspace on Team server" })).toBeTruthy();
    fireEvent.contextMenu(within(list).getByRole("treeitem", { name: /^Design/ }));
    const menu = await screen.findByRole("menu", { name: "Actions for Design" });
    expect(within(menu).queryByRole("menuitem", { name: /Rename…|Delete…/ })).toBeNull();
  });
});
