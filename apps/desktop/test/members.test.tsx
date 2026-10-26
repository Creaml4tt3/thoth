// @vitest-environment jsdom
// Workspace members and invite links on the desktop (ADR-0024): "Members…" on the workspace row (button and menu) and
// in the palette; the dialog for owners (roles, remove, invite links) and for everyone else (read-only, leave); the
// one-owner refusal; a departed workspace disappearing; and Settings → Servers → "Join with an invite link".
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { axeViolations } from "../../../tests/helpers/axe.ts";
import { FakeServers, type FakeServerConfig, type FakeWorkspace } from "../../../tests/helpers/fake-servers.ts";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { ALPHA, seed } from "./support/fixtures.ts";

const dirs = tempDirs();
let root: string;

const CAPS = ["search", "transfers", "attachments", "page-order", "page-kind", "public-share", "members", "invite-links"];
const LOCAL: FakeServerConfig = { url: "http://127.0.0.1:8080", name: "Team server", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" }, capabilities: CAPS };
const TEAM = (role: "owner" | "editor" | "viewer") => [
  { userId: "usr_me", displayName: "Ada", role },
  { userId: "usr_bo", displayName: "Bo", role: "editor" as const },
  { userId: "usr_cy", displayName: "Cy", role: "viewer" as const },
];

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA });
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

async function workspace(options: { role?: "owner" | "editor" | "viewer"; capabilities?: string[]; members?: FakeWorkspace["members"]; config?: Partial<FakeServerConfig> } = {}) {
  const servers = new FakeServers();
  const role = options.role ?? "owner";
  servers.connect({ ...LOCAL, capabilities: options.capabilities ?? CAPS, ...options.config });
  const server = [...(await servers.list())][0]!.id;
  const ws = servers.addWorkspace(server, { name: "Design", role, members: options.members ?? TEAM(role) });
  servers.writeAsOther(ws, { title: "Roadmap", markdown: "# Roadmap\n\nPlans.\n" });
  const app = await openApp(root, { autosaveMs: 0 }, createNodePlatform({ vault: root, servers }));
  const list = await screen.findByRole("tree", { name: "Workspaces on Team server" });
  return { app, servers, server, ws, list };
}

async function openMembers(app: Harness) {
  await app.user.click(await screen.findByRole("button", { name: "Members of Design" }));
  return screen.findByRole("dialog", { name: "Members of “Design”" });
}

const rowOf = (dialog: HTMLElement, name: RegExp) => within(within(dialog).getByRole("list", { name: "Members" })).getAllByRole("listitem").find((li) => name.test(li.textContent ?? ""))!;

describe("Members… for an owner", () => {
  it("lists everyone with their role, changes a role, and removes a member after asking", async () => {
    const { app, ws } = await workspace();
    const dialog = await openMembers(app);
    const list = await within(dialog).findByRole("list", { name: "Members" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    expect(rowOf(dialog, /^Ada/).textContent).toContain("(you)");
    const cy = within(rowOf(dialog, /^Cy/)).getByRole("combobox", { name: "Role of Cy" }) as HTMLSelectElement;
    expect(cy.value).toBe("viewer");
    await app.user.selectOptions(cy, "editor");
    await waitFor(() => expect(ws.members.find((m) => m.userId === "usr_cy")!.role).toBe("editor"));
    expect(await within(dialog).findByText("Cy is now Editor.")).toBeTruthy();

    await app.user.click(within(rowOf(dialog, /^Bo/)).getByRole("button", { name: "Remove Bo from the workspace" }));
    const confirm = within(dialog).getByRole("group", { name: "Remove Bo?" });
    expect(within(confirm).getByText(/lose access at once/)).toBeTruthy();
    await app.user.click(within(confirm).getByRole("button", { name: "Remove member" }));
    await waitFor(() => expect(ws.members.some((m) => m.userId === "usr_bo")).toBe(false));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    expect(within(dialog).getByRole("status").textContent).toBe("Bo was removed from the workspace.");
    expect(await axeViolations(dialog)).toEqual([]);
  });

  it("creates an invite link with a role, an expiry and a number of uses, copies it, lists it and revokes it", async () => {
    const { app, ws } = await workspace();
    const dialog = await openMembers(app);
    const invite = within(dialog).getByRole("region", { name: "Invite people" });
    expect((within(invite).getByRole("radio", { name: "Editor" }) as HTMLInputElement).checked).toBe(true);
    expect((within(invite).getByRole("radio", { name: "7 days" }) as HTMLInputElement).checked).toBe(true);
    expect((within(invite).getByRole("radio", { name: "1 person" }) as HTMLInputElement).checked).toBe(true);
    await app.user.click(within(invite).getByRole("radio", { name: "Viewer" }));
    await app.user.click(within(invite).getByRole("radio", { name: "30 days" }));
    await app.user.click(within(invite).getByRole("radio", { name: "5 people" }));
    await app.user.click(within(invite).getByRole("button", { name: "Create invite link" }));
    const field = (await within(invite).findByRole("textbox", { name: "Invite link" })) as HTMLInputElement;
    const link = ws.invites[0]!;
    expect(field.value).toBe(`http://127.0.0.1:8080/i/${link.token}`);
    expect([link.role, link.maxUses, Math.round((Date.parse(link.expiresAt) - Date.parse(link.createdAt)) / 86_400_000)]).toEqual(["viewer", 5, 30]);
    await app.user.click(within(invite).getByRole("button", { name: "Copy link" }));
    expect(await navigator.clipboard.readText()).toBe(field.value);
    const active = within(invite).getByRole("list", { name: "Active invite links" });
    await waitFor(() => expect(within(active).getAllByRole("listitem")).toHaveLength(1));
    expect(within(active).getByRole("listitem").textContent).toMatch(/^Viewer · 5 places left · stops working .* · by Ada/);
    expect(await axeViolations(dialog)).toEqual([]);
    await app.user.click(within(active).getByRole("button", { name: /^Revoke the viewer invite link/ }));
    await waitFor(() => expect(link.revoked).toBe(true));
    expect(await within(invite).findByText("No active invite links.")).toBeTruthy();
    expect(within(invite).queryByRole("textbox", { name: "Invite link" })).toBeNull();
  });

  it("offers no more uses than the member limit leaves room for", async () => {
    const { app } = await workspace({ config: { limits: { maxMembersPerWorkspace: 5 } } });
    const dialog = await openMembers(app);
    const invite = within(dialog).getByRole("region", { name: "Invite people" });
    await waitFor(() => expect((within(invite).getByRole("radio", { name: "5 people" }) as HTMLInputElement).disabled).toBe(true));
    expect((within(invite).getByRole("radio", { name: "10 people" }) as HTMLInputElement).disabled).toBe(true);
    expect((within(invite).getByRole("radio", { name: "1 person" }) as HTMLInputElement).disabled).toBe(false);
  });

  it("says why the last owner cannot leave", async () => {
    const { app, ws } = await workspace();
    const dialog = await openMembers(app);
    await within(dialog).findByRole("list", { name: "Members" });
    await app.user.click(within(dialog).getByRole("button", { name: "Leave workspace" }));
    await app.user.click(within(within(dialog).getByRole("group", { name: "Leave Design?" })).getByRole("button", { name: "Leave" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("A workspace needs at least one owner. Make someone else an owner first.");
    expect(ws.joined).toBe(true);
  });

  it("opens from the workspace row's menu (right click or the Menu key) and from the palette", async () => {
    const { app, list } = await workspace();
    const row = within(list).getByRole("treeitem", { name: /^Design/ });
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole("menu", { name: "Actions for Design" });
    await app.user.click(within(menu).getByRole("menuitem", { name: "Members…" }));
    expect(await screen.findByRole("dialog", { name: "Members of “Design”" })).toBeTruthy();
    await app.user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    row.focus();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu", { name: "Actions for Design" })).toBeTruthy();
    await app.user.keyboard("{Escape}");

    await app.user.click(row);
    const pages = await within(list).findByRole("group", { name: "Pages in Design" });
    await app.user.click(within(pages).getByRole("treeitem", { name: "Roadmap" }));
    await app.user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByRole("dialog", { name: "Search" });
    await app.user.keyboard("> members");
    await app.user.click(within(search).getByRole("option", { name: /^Members of Design…/ }));
    expect(await screen.findByRole("dialog", { name: "Members of “Design”" })).toBeTruthy();
  });
});

describe("Members… for editors and viewers", () => {
  it("shows the list read-only, without invite links, and lets them leave: the workspace and its open page go", async () => {
    const { app, ws, list, servers } = await workspace({ role: "viewer" });
    await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
    const pages = await within(list).findByRole("group", { name: "Pages in Design" });
    await app.user.click(within(pages).getByRole("treeitem", { name: "Roadmap" }));
    const dialog = await openMembers(app);
    await within(dialog).findByRole("list", { name: "Members" });
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /^Remove / })).toBeNull();
    expect(within(dialog).queryByRole("region", { name: "Invite people" })).toBeNull();
    expect(within(dialog).getByText("Only owners change roles and invite people.")).toBeTruthy();
    expect(rowOf(dialog, /^Bo/).textContent).toContain("Editor");
    expect(servers.calls.some((c) => c.path.includes("invite-links"))).toBe(false);
    expect(await axeViolations(dialog)).toEqual([]);

    await app.user.click(within(dialog).getByRole("button", { name: "Leave workspace" }));
    await app.user.click(within(within(dialog).getByRole("group", { name: "Leave Design?" })).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(ws.joined).toBe(false);
    await waitFor(() => expect(screen.queryByRole("treeitem", { name: /^Design/ })).toBeNull());
    expect(await screen.findByText("You no longer have access to this workspace")).toBeTruthy();
  });

  it("is not offered when the server lacks members", async () => {
    const { list } = await workspace({ capabilities: ["search", "page-order", "page-kind"] });
    await within(list).findByRole("treeitem", { name: /^Design/ });
    expect(screen.queryByRole("button", { name: "Members of Design" })).toBeNull();
    fireEvent.contextMenu(within(list).getByRole("treeitem", { name: /^Design/ }));
    const menu = await screen.findByRole("menu", { name: "Actions for Design" });
    expect(within(menu).queryByRole("menuitem", { name: "Members…" })).toBeNull();
  });
});

describe("Settings → Servers → Join with an invite link", () => {
  async function openJoin(app: Harness) {
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    return screen.findByRole("region", { name: "Join with an invite link" });
  }

  it("joins a workspace on a server the app knows, and it shows in the sidebar", async () => {
    const servers = new FakeServers();
    const server = servers.connect(LOCAL);
    servers.addWorkspace(server, { name: "Design", role: "owner" });
    const garden = servers.addWorkspace(server, { name: "Garden", role: "viewer", joined: false, members: [{ userId: "usr_gil", displayName: "Gil", role: "owner" }] });
    const token = servers.inviteAsOther(garden, { role: "editor" });
    const app = await openApp(root, { autosaveMs: 0 }, createNodePlatform({ vault: root, servers }));
    const region = await openJoin(app);
    await app.user.type(within(region).getByRole("textbox", { name: "Invite link" }), "https://example.org/s/nope");
    await app.user.click(within(region).getByRole("button", { name: "Join" }));
    expect((await within(region).findByRole("alert")).textContent).toMatch(/^That is not an invite link/);
    await app.user.clear(within(region).getByRole("textbox", { name: "Invite link" }));
    await app.user.type(within(region).getByRole("textbox", { name: "Invite link" }), `http://127.0.0.1:8080/i/${token}`);
    await app.user.click(within(region).getByRole("button", { name: "Join" }));
    expect((await within(region).findByRole("status")).textContent).toBe("You joined Garden as Editor. It is in the sidebar now.");
    expect(garden.joined).toBe(true);
    const list = await screen.findByRole("tree", { name: "Workspaces on Team server" });
    expect(await within(list).findByRole("treeitem", { name: /^Garden/ })).toBeTruthy();
    expect(await axeViolations(region)).toEqual([]);

    await app.user.clear(within(region).getByRole("textbox", { name: "Invite link" }));
    await app.user.type(within(region).getByRole("textbox", { name: "Invite link" }), `http://127.0.0.1:8080/i/${"x".repeat(32)}`);
    await app.user.click(within(region).getByRole("button", { name: "Join" }));
    expect((await within(region).findByRole("alert")).textContent).toMatch(/^This invite link does not work/);
  });

  it("adds an unknown server, asks to sign in first, and joins right after signing in", async () => {
    const servers = new FakeServers();
    const trial: FakeServerConfig = { url: "https://trial.example.com", name: "Thoth trial", providers: [{ id: "google", name: "Google" }], account: { id: "usr_me", displayName: "Ada" }, capabilities: CAPS };
    servers.define(trial);
    const app = await openApp(root, { autosaveMs: 0 }, createNodePlatform({ vault: root, servers }));
    const region = await openJoin(app);
    // The workspace exists on the server before the app knows the server (the fake host names it srv1 when it is added).
    const garden = servers.addWorkspace("srv1", { name: "Garden", role: "viewer", joined: false, members: [{ userId: "usr_gil", displayName: "Gil", role: "owner" }] });
    const token = servers.inviteAsOther(garden, { role: "viewer" });
    await app.user.type(within(region).getByRole("textbox", { name: "Invite link" }), `https://trial.example.com/i/${token}`);
    await app.user.click(within(region).getByRole("button", { name: "Join" }));
    expect(await within(region).findByText("Sign in to Thoth trial to join. Thoth joins right after you sign in.")).toBeTruthy();
    await app.user.click(within(region).getByRole("button", { name: "Sign in with Google" }));
    expect((await within(region).findByRole("status")).textContent).toBe("You joined Garden as Viewer. It is in the sidebar now.");
    expect(garden.joined).toBe(true);
  });
});
