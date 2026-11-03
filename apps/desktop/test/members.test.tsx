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
const TEAM = (role: "owner" | "manager" | "editor" | "viewer") => [
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

async function workspace(options: { role?: "owner" | "manager" | "editor" | "viewer"; capabilities?: string[]; members?: FakeWorkspace["members"]; config?: Partial<FakeServerConfig> } = {}) {
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
    expect(within(dialog).getByText("Only owners and managers change roles and invite people.")).toBeTruthy();
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

// ADR-0042: teams in the members dialog, the Manager role, and "Visible to…" on a folder.
describe("Teams and Visible to…", () => {
  const TEAMS = [...CAPS, "teams"];

  it("lets a manager create a team, add a member, rename it and delete it", async () => {
    const { app, ws } = await workspace({ role: "manager", capabilities: TEAMS });
    const dialog = await openMembers(app);
    const teams = await within(dialog).findByRole("region", { name: "Teams" });
    expect(await within(teams).findByText("No teams yet.")).toBeTruthy();
    await app.user.type(within(teams).getByRole("textbox", { name: "New team name" }), "Finance");
    await app.user.click(within(teams).getByRole("button", { name: "Create team" }));
    await waitFor(() => expect(ws.teams.map((t) => t.name)).toEqual(["Finance"]));
    await app.user.click(await within(teams).findByRole("checkbox", { name: "Bo in Finance" }));
    await waitFor(() => expect(ws.teams[0]!.memberIds).toEqual(["usr_bo"]));
    expect(within(teams).getByRole("status").textContent).toBe("Changed the members of Finance.");
    const name = within(teams).getByRole("textbox", { name: "Name of Finance" });
    await app.user.clear(name);
    await app.user.type(name, "Money");
    await app.user.click(within(teams).getByRole("button", { name: "Rename team Finance" }));
    await waitFor(() => expect(ws.teams[0]!.name).toBe("Money"));
    expect(await axeViolations(dialog)).toEqual([]);
    // Deleting asks first and says which folders only this team saw (ADR-0043).
    const folder = [...ws.pages.values()][0]!;
    ws.visibility.set(folder.id, [ws.teams[0]!.id]);
    await app.user.click(within(teams).getByRole("button", { name: "Delete team Money" }));
    const confirm = await within(teams).findByRole("group", { name: "Delete team Money?" });
    expect(await within(confirm).findByText("Only owners and managers will see these, because no other team does:")).toBeTruthy();
    expect(within(confirm).getByText(folder.title)).toBeTruthy();
    expect(ws.teams).toHaveLength(1);
    expect(await axeViolations(dialog)).toEqual([]);
    // Cancel puts focus back on the button that asked, not on the page behind the dialog.
    await app.user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(within(teams).getByRole("button", { name: "Delete team Money" })));
    await app.user.click(within(teams).getByRole("button", { name: "Delete team Money" }));
    const again = await within(teams).findByRole("group", { name: "Delete team Money?" });
    await app.user.click(await within(again).findByRole("button", { name: "Delete team" }));
    await waitFor(() => expect(ws.teams).toEqual([]));
    expect(document.activeElement).toBe(within(teams).getByRole("heading", { name: "Teams" }));
  });

  it("lets a manager change roles up to Manager, remove members and invite people, but not touch owners (ADR-0043)", async () => {
    const members = [...TEAM("manager"), { userId: "usr_oz", displayName: "Oz", role: "owner" as const }];
    const { app, ws } = await workspace({ role: "manager", capabilities: TEAMS, members });
    const dialog = await openMembers(app);
    const bo = (await within(dialog).findByRole("combobox", { name: "Role of Bo" })) as HTMLSelectElement;
    expect([...bo.options].map((o) => o.value)).toEqual(["manager", "editor", "viewer"]);
    await app.user.selectOptions(bo, "manager");
    await waitFor(() => expect(ws.members.find((m) => m.userId === "usr_bo")!.role).toBe("manager"));
    expect(within(dialog).queryByRole("combobox", { name: "Role of Oz" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Remove Oz from the workspace" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Remove Cy from the workspace" })).toBeTruthy();
    expect(within(dialog).getByText("Only an owner can make someone an owner, or change or remove an owner.")).toBeTruthy();
    const invite = within(dialog).getByRole("region", { name: "Invite people" });
    await app.user.click(within(invite).getByRole("button", { name: "Create invite link" }));
    await waitFor(() => expect(ws.invites).toHaveLength(1));
  });

  it("shows teams read-only to an editor, and offers Manager in an owner's invite and role pickers", async () => {
    const { app: editorApp, ws } = await workspace({ role: "editor", capabilities: TEAMS });
    ws.teams.push({ id: "team_1", name: "Finance", memberIds: ["usr_bo"] });
    const dialog = await openMembers(editorApp);
    const teams = await within(dialog).findByRole("region", { name: "Teams" });
    expect(await within(teams).findByText("Bo")).toBeTruthy();
    expect(within(teams).queryByRole("button", { name: "Create team" })).toBeNull();
    expect(within(teams).queryByRole("checkbox")).toBeNull();
    cleanup();

    const { app } = await workspace({ capabilities: TEAMS });
    const owner = await openMembers(app);
    const invite = within(owner).getByRole("region", { name: "Invite people" });
    expect(within(invite).getByRole("radio", { name: "Manager" })).toBeTruthy();
    const cy = (await within(owner).findByRole("combobox", { name: "Role of Cy" })) as HTMLSelectElement;
    expect([...cy.options].map((o) => o.value)).toEqual(["owner", "manager", "editor", "viewer"]);
  });

  it("offers Visible to… on a folder to owners and managers only, and limits it to a team", async () => {
    const { app, ws, list } = await workspace({ role: "manager", capabilities: TEAMS });
    ws.teams.push({ id: "team_1", name: "Finance", memberIds: [] });
    await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
    const pages = await within(list).findByRole("group", { name: "Pages in Design" });
    fireEvent.contextMenu(within(pages).getByRole("treeitem", { name: "Roadmap" }));
    await app.user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Visible to…" }));
    const dialog = await screen.findByRole("dialog", { name: "Who sees “Roadmap”" });
    await app.user.click(await within(dialog).findByRole("radio", { name: "Only these teams" }));
    await app.user.click(within(dialog).getByRole("button", { name: "Save" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe("Choose at least one team.");
    const finance = within(dialog).getByRole("checkbox", { name: "Finance" });
    expect(finance.getAttribute("aria-invalid")).toBe("true"); // the error belongs to the team boxes (WCAG 3.3.1)
    expect(finance.getAttribute("aria-describedby")).toBe(alert.id);
    await app.user.click(finance);
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(finance.hasAttribute("aria-invalid")).toBe(false);
    expect(await axeViolations(dialog)).toEqual([]);
    await app.user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect([...ws.visibility.values()]).toEqual([["team_1"]]);
  });

  it("does not offer Visible to… to editors, nor on a server without teams", async () => {
    for (const options of [{ role: "editor" as const, capabilities: TEAMS }, { role: "owner" as const, capabilities: CAPS }]) {
      const { app, list } = await workspace(options);
      await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
      const pages = await within(list).findByRole("group", { name: "Pages in Design" });
      fireEvent.contextMenu(within(pages).getByRole("treeitem", { name: "Roadmap" }));
      const menu = await screen.findByRole("menu");
      expect(within(menu).queryByRole("menuitem", { name: "Visible to…" }), JSON.stringify(options)).toBeNull();
      await app.user.keyboard("{Escape}");
      // An older server: no Teams section either.
      if (options.capabilities === CAPS) expect(within(await openMembers(app)).queryByRole("region", { name: "Teams" })).toBeNull();
      cleanup();
    }
  });
});

describe("Trash… (ADR-0043)", () => {
  const TRASH = [...CAPS, "trash"];
  const openTrash = async (app: Harness, list: HTMLElement) => {
    fireEvent.contextMenu(within(list).getByRole("treeitem", { name: /^Design/ }));
    const menu = await screen.findByRole("menu", { name: "Actions for Design" });
    await app.user.click(within(menu).getByRole("menuitem", { name: "Trash…" }));
    return screen.findByRole("dialog", { name: "Trash of “Design”" });
  };
  const trashed = (ws: FakeWorkspace) => {
    const page = [...ws.pages.values()].find((p) => p.title === "Roadmap")!;
    page.deleted = true;
    page.deletedBy = "usr_me";
    return page;
  };

  it("lets an owner restore a deleted page, or delete one for good after asking", async () => {
    const { app, ws, list } = await workspace({ capabilities: TRASH });
    const page = trashed(ws);
    const dialog = await openTrash(app, list);
    const items = await within(dialog).findByRole("list", { name: "Deleted pages" });
    expect(within(items).getByRole("listitem").textContent).toMatch(/^Roadmap.*deleted .* by Ada · can be restored until/);
    expect(await axeViolations(dialog)).toEqual([]);
    await app.user.click(within(dialog).getByRole("button", { name: "Restore Roadmap" }));
    await waitFor(() => expect(page.deleted).toBe(false));
    expect(await within(dialog).findByText("The Trash is empty.")).toBeTruthy();
    expect(within(dialog).getByRole("status").textContent).toBe("Restored Roadmap.");

    trashed(ws);
    await app.user.click(within(dialog).getByRole("button", { name: "Done" }));
    const again = await openTrash(app, list);
    await app.user.click(await within(again).findByRole("button", { name: "Delete Roadmap for good" }));
    const ask = within(again).getByRole("group", { name: "Delete Roadmap for good?" });
    await app.user.click(within(ask).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(within(again).getByRole("button", { name: "Delete Roadmap for good" })));
    await app.user.click(within(again).getByRole("button", { name: "Delete Roadmap for good" }));
    const confirm = within(again).getByRole("group", { name: "Delete Roadmap for good?" });
    expect(within(confirm).getByText(/cannot be undone/)).toBeTruthy();
    await app.user.click(within(confirm).getByRole("button", { name: "Delete for good" }));
    await waitFor(() => expect(ws.pages.has(page.id)).toBe(false));
  });

  it("lets an editor restore but not delete for good, and gives viewers no Trash", async () => {
    const { app, ws, list } = await workspace({ role: "editor", capabilities: TRASH });
    trashed(ws);
    const dialog = await openTrash(app, list);
    expect(await within(dialog).findByRole("button", { name: "Restore Roadmap" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Delete Roadmap for good" })).toBeNull();
    cleanup();

    const viewer = await workspace({ role: "viewer", capabilities: TRASH });
    fireEvent.contextMenu(within(viewer.list).getByRole("treeitem", { name: /^Design/ }));
    const menu = await screen.findByRole("menu", { name: "Actions for Design" });
    expect(within(menu).queryByRole("menuitem", { name: "Trash…" })).toBeNull();
  });
});
