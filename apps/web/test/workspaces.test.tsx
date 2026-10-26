// @vitest-environment jsdom
// Several workspaces per account in the web client (ADR-0025): "New workspace…" from the sidebar header and the
// palette, the count near the limit and the limit itself, Rename… and Delete… (with the name typed) from the workspace
// row, and Recently deleted with Restore and Delete permanently. Hidden when the server lacks workspace-management.
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { axeViolations } from "../../../tests/helpers/axe.ts";
import { FakeWebServer } from "./support/fake-web-server.ts";
import { cleanup, fakeBrowser, screen, signInThroughUi, waitFor, within, type FakeBrowser } from "./support/render.tsx";

afterEach(() => cleanup());

const CAPS = ["search", "transfers", "attachments", "page-order", "page-kind", "members", "invite-links", "workspace-management"];

async function signedIn(options: { capabilities?: string[]; role?: "owner" | "editor" | "viewer"; limit?: number } = {}) {
  const server = new FakeWebServer({ capabilities: options.capabilities ?? CAPS, limits: { maxPagesPerWorkspace: 200, maxWorkspacesPerAccount: options.limit ?? 3, idempotencyWindowSeconds: 86400 } });
  const ws = server.workspace("Notes", options.role ?? "owner");
  const page = server.servers.writeAsOther(ws, { title: "Field notes", markdown: "# Field notes\n\nHello.\n" });
  const browser = fakeBrowser(server);
  await signInThroughUi(browser);
  await screen.findByRole("treeitem", { name: /^Notes/ });
  return Object.assign(browser, { ws, page });
}

async function palette(browser: FakeBrowser, what: string) {
  await browser.user.keyboard("{Control>}k{/Control}");
  const dialog = await screen.findByRole("dialog", { name: "Search" });
  await browser.user.keyboard(`> ${what}`);
  return dialog;
}

const allWorkspaces = (browser: FakeBrowser) => browser.server.servers.workspaces.get(browser.server.handle) ?? [];

describe("New workspace… in the web client", () => {
  it("creates a workspace from the sidebar header: it appears, opens, takes focus, and the count is shown", async () => {
    const browser = await signedIn();
    await browser.user.click(screen.getByRole("button", { name: /^New workspace on / }));
    const dialog = await screen.findByRole("dialog", { name: /^New workspace on / });
    expect(within(dialog).getByText("You own 1 of 3 workspaces this server allows.")).toBeTruthy();
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    expect(document.activeElement).toBe(name);
    // An empty name is not sent.
    await browser.user.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    expect(within(dialog).getByRole("alert").textContent).toBe("Give it a name.");
    expect(await axeViolations(dialog)).toEqual([]);
    await browser.user.type(name, "  Design  ");
    await browser.user.click(within(dialog).getByRole("checkbox", { name: "Do not allow copying or moving pages out of it" }));
    await browser.user.keyboard("{Enter}");
    const row = await screen.findByRole("treeitem", { name: /^Design/ });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^New workspace/ })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const made = allWorkspaces(browser).find((w) => w.name === "Design")!;
    expect([made.role, made.exportRestricted]).toEqual(["owner", true]);
    const create = browser.server.servers.calls.find((c) => c.method === "POST" && c.path === "/api/v1/workspaces")!;
    expect(create.headers?.["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(document.querySelector("[data-workspaces-said]")?.textContent).toBe("Created Design.");
    // 2 of 3: near the limit, so the sidebar says so.
    expect(screen.getByText("2 of 3 workspaces")).toBeTruthy();
  });

  it("at the limit, says so and does not offer Create; Recently deleted counts and is one click away", async () => {
    const browser = await signedIn({ limit: 2 });
    const old = browser.server.servers.addWorkspace(browser.server.handle, { id: "ws_old", name: "Old", role: "owner" });
    old.deletedAt = "2026-10-22T09:00:00.000Z";
    await browser.user.click(screen.getByRole("button", { name: /^New workspace on / }));
    const dialog = await screen.findByRole("dialog", { name: /^New workspace on / });
    await within(dialog).findByText(/You already own 2 workspaces, the most this server allows/);
    expect(within(dialog).getByText(/This counts 1 recently deleted workspace/)).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Create workspace" }) as HTMLButtonElement).disabled).toBe(true);
    await browser.user.click(within(dialog).getByRole("button", { name: "Recently deleted (1)" }));
    expect(await screen.findByRole("dialog", { name: /^Recently deleted on / })).toBeTruthy();
  });

  it("shows the server's refusal over the limit as an alert and keeps the dialog", async () => {
    const browser = await signedIn({ limit: 2 });
    // Another client made one meanwhile: the app still thinks there is room.
    await browser.user.click(screen.getByRole("button", { name: /^New workspace on / }));
    const dialog = await screen.findByRole("dialog", { name: /^New workspace on / });
    browser.server.servers.addWorkspace(browser.server.handle, { id: "ws_elsewhere", name: "Elsewhere", role: "owner" });
    await browser.user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Third{Enter}");
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/You already own 2 workspaces/);
    expect(allWorkspaces(browser).some((w) => w.name === "Third")).toBe(false);
  });

  it("is in the palette", async () => {
    const browser = await signedIn();
    const search = await palette(browser, "new workspace");
    await browser.user.click(within(search).getByRole("option", { name: /^New workspace…/ }));
    expect(await screen.findByRole("dialog", { name: /^New workspace on / })).toBeTruthy();
  });
});

describe("Rename… and Delete… of a workspace in the web client", () => {
  it("renames from the row's menu next to Members…, and with F2", async () => {
    const browser = await signedIn();
    const row = screen.getByRole("treeitem", { name: /^Notes/ });
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole("menu", { name: "Actions for Notes" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.replace("F2", ""))).toEqual(["Members…", "Rename…", "Delete…", "New page", "New folder"]);
    await browser.user.click(within(menu).getByRole("menuitem", { name: /Rename…/ }));
    const dialog = await screen.findByRole("dialog", { name: "Rename “Notes”" });
    const field = within(dialog).getByRole("textbox", { name: "New name" });
    await browser.user.clear(field);
    await browser.user.type(field, "Field work{Enter}");
    await waitFor(() => expect(screen.getByRole("treeitem", { name: /^Field work/ })).toBeTruthy());
    expect(browser.ws.name).toBe("Field work");
    // F2 on the row opens the same dialog.
    screen.getByRole("treeitem", { name: /^Field work/ }).focus();
    await browser.user.keyboard("{F2}");
    expect(await screen.findByRole("dialog", { name: "Rename “Field work”" })).toBeTruthy();
  });

  it("deletes only after the name is typed; the workspace leaves the sidebar, its open page says so, and it can be restored", async () => {
    const browser = await signedIn();
    await browser.user.click(screen.getByRole("treeitem", { name: "Field notes" }));
    const search = await palette(browser, "delete workspace");
    await browser.user.click(within(search).getByRole("option", { name: /^Delete workspace Notes…/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete “Notes”?" });
    expect(within(dialog).getByText(/For 30 days an owner can restore it/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Delete workspace" }) as HTMLButtonElement;
    const field = within(dialog).getByRole("textbox", { name: "To confirm, type the workspace's name: Notes" });
    expect(document.activeElement).toBe(field);
    expect(confirm.disabled).toBe(true);
    await browser.user.type(field, "Note");
    expect(confirm.disabled).toBe(true);
    await browser.user.type(field, "s");
    expect(confirm.disabled).toBe(false);
    expect(await axeViolations(dialog)).toEqual([]);
    await browser.user.click(confirm);
    await waitFor(() => expect(screen.queryByRole("treeitem", { name: /^Notes/ })).toBeNull());
    expect(browser.ws.deletedAt).not.toBeNull();
    expect(await screen.findByText("You no longer have access to this workspace")).toBeTruthy();
    expect(document.querySelector("[data-workspaces-said]")?.textContent).toBe("Deleted Notes. You can restore it for 30 days from Recently deleted.");
    // Recently deleted (1) under the workspaces: restore it.
    await browser.user.click(await screen.findByRole("button", { name: "Recently deleted (1)" }));
    const deleted = await screen.findByRole("dialog", { name: /^Recently deleted on / });
    const list = within(deleted).getByRole("list", { name: "Recently deleted workspaces" });
    expect(within(list).getByText(/^Deleted .* · can be restored until /)).toBeTruthy();
    expect(await axeViolations(deleted)).toEqual([]);
    await browser.user.click(within(list).getByRole("button", { name: "Restore Notes" }));
    expect(await screen.findByRole("treeitem", { name: /^Notes/ })).toBeTruthy();
    expect(within(deleted).getByRole("status").textContent).toBe("Restored Notes.");
    expect(within(deleted).getByText("No workspace was deleted in the last 30 days.")).toBeTruthy();
    expect(browser.ws.deletedAt).toBeNull();
  });

  it("deletes permanently from Recently deleted, after the name is typed", async () => {
    const browser = await signedIn();
    const old = browser.server.servers.addWorkspace(browser.server.handle, { id: "ws_old", name: "Old notes", role: "owner" });
    old.deletedAt = "2026-10-22T09:00:00.000Z";
    const search = await palette(browser, "recently deleted");
    await browser.user.click(within(search).getByRole("option", { name: /^Recently deleted workspaces…/ }));
    const dialog = await screen.findByRole("dialog", { name: /^Recently deleted on / });
    await browser.user.click(await within(dialog).findByRole("button", { name: "Delete Old notes permanently" }));
    const group = within(dialog).getByRole("group", { name: "Delete “Old notes” permanently?" });
    const field = within(group).getByRole("textbox", { name: "To confirm, type the workspace's name: Old notes" });
    expect(document.activeElement).toBe(field);
    await browser.user.type(field, "Old notes");
    await browser.user.click(within(group).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toBe("Old notes was deleted permanently."));
    expect(allWorkspaces(browser).some((w) => w.id === "ws_old")).toBe(false);
    expect(screen.queryByRole("button", { name: /^Recently deleted \(/ })).toBeNull();
  });

  it("offers editors neither Rename… nor Delete…", async () => {
    const browser = await signedIn({ role: "editor" });
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /^Notes/ }));
    const menu = await screen.findByRole("menu", { name: "Actions for Notes" });
    expect(within(menu).queryByRole("menuitem", { name: /Rename…|Delete…/ })).toBeNull();
    await browser.user.click(screen.getByRole("treeitem", { name: "Field notes" }));
    const search = await palette(browser, "workspace");
    expect(within(search).queryByRole("option", { name: /^(Rename|Delete) workspace/ })).toBeNull();
    // Anyone may create one.
    expect(within(search).getByRole("option", { name: /^New workspace…/ })).toBeTruthy();
  });

  it("is not offered when the server lacks workspace-management", async () => {
    const browser = await signedIn({ capabilities: ["search", "page-order", "page-kind", "members"] });
    expect(screen.queryByRole("button", { name: /^New workspace on / })).toBeNull();
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /^Notes/ }));
    const menu = await screen.findByRole("menu", { name: "Actions for Notes" });
    expect(within(menu).queryByRole("menuitem", { name: /Rename…|Delete…/ })).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    const search = await palette(browser, "workspace");
    expect(within(search).queryByRole("option", { name: /workspace…|workspaces…/ })).toBeNull();
    expect(browser.server.servers.calls.some((c) => c.path.includes("deleted-workspaces"))).toBe(false);
  });
});
