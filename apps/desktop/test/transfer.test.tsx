// @vitest-environment jsdom
/**
 * The desktop transfer UI (Phase 3): select pages in the Private Space tree, preview where they go and who
 * can see them, copy or move, see an honest result; the reverse from a workspace page; export restriction;
 * startup recovery. The engine itself is covered in packages/transfer; here the fake host and fake server
 * stand behind the real UI.
 */
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { FakeServers, type FakeServerConfig, type FakeWorkspace } from "../../../tests/helpers/fake-servers.ts";
import { seed } from "./support/fixtures.ts";
import { en, th } from "../src/strings/index.ts";
import { problemText } from "../src/features/transfer/TransferDialog.tsx";

const dirs = tempDirs();
let root: string;

const TEAM: FakeServerConfig = { url: "https://team.example", name: "Team", account: { id: "usr_me", displayName: "Ada" } };

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, {
    "Plan.md": "# Plan\n\nSee [[Notes]] and [[Nowhere]].\n",
    "Notes.md": "# Notes\n\nBack to [[Plan]].\n",
    "Diary.md": "# Diary\n",
  });
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

async function start(setup: (servers: FakeServers) => { ws: FakeWorkspace; server: string }) {
  const servers = new FakeServers();
  const { ws, server } = setup(servers);
  const app = await openApp(root, {}, createNodePlatform({ vault: root, servers }));
  await screen.findByRole("tree", { name: "Pages in this Private Space" });
  await screen.findByRole("tree", { name: /^Workspaces on / });
  return { app, servers, ws, server };
}

const team = (options: { exportRestricted?: boolean; capabilities?: string[] } = {}) => (servers: FakeServers) => {
  const server = servers.connect({ ...TEAM, ...(options.capabilities ? { capabilities: options.capabilities } : {}) });
  const ws = servers.addWorkspace(server, {
    name: "Studio",
    ...(options.exportRestricted ? { exportRestricted: true } : {}),
    members: [
      { userId: "usr_me", displayName: "Ada", role: "owner" },
      { userId: "u2", displayName: "Grace", role: "viewer" },
    ],
    role: "owner",
  });
  return { ws, server };
};

async function selectPages(app: Harness, titles: string[]) {
  await app.user.click(screen.getByRole("button", { name: "Select pages" }));
  const tree = screen.getByRole("tree", { name: "Pages in this Private Space" });
  for (const box of within(tree).getAllByRole("checkbox")) if ((box as HTMLInputElement).checked) await app.user.click(box);
  for (const title of titles) await app.user.click(within(tree).getByRole("checkbox", { name: `Select ${title}` }));
}

const live = (ws: FakeWorkspace) => [...ws.pages.values()].filter((p) => !p.deleted);

describe("Private Space → workspace", () => {
  it("previews destination, members and roles, link classification, then copies and says what happened", async () => {
    const { app, servers, ws } = await start(team());
    await selectPages(app, ["Plan", "Notes"]);
    expect(screen.getByRole("region", { name: "Select pages" }).textContent).toContain("2 selected");
    await app.user.click(screen.getByRole("button", { name: "Copy to workspace…" }));

    const dialog = await screen.findByRole("dialog", { name: "Copy 2 pages to a workspace" });
    expect((within(dialog).getByRole("combobox", { name: "Workspace" }) as HTMLSelectElement).value).toContain(ws.id);
    const preview = await within(dialog).findByRole("region", { name: "Who can see it" });
    await waitFor(() => expect(preview.textContent).toContain("Everyone in this workspace (2 members) can see these pages."));
    expect(preview.textContent).toContain("Grace");
    expect(preview.textContent).toContain("viewer");
    // Plan → Notes, Notes → Plan are included; Plan → Nowhere is unresolved.
    await waitFor(() => expect(preview.textContent).toMatch(/2\s*point to pages or files in this transfer/));
    expect(preview.textContent).toMatch(/1\s*point to nothing that exists/);
    expect(preview.textContent).toContain("Nothing has left this computer yet.");
    // A preview sends no write.
    expect(servers.calls.filter((c) => c.method !== "GET")).toEqual([]);

    await app.user.click(within(dialog).getByRole("button", { name: "Copy" }));
    const result = await within(dialog).findByRole("status", {}, { timeout: 10_000 });
    await waitFor(() => expect(result.textContent).toContain("2 pages were copied to Studio. Every page was checked at the destination."));
    expect(live(ws).map((p) => p.title).sort()).toEqual(["Notes", "Plan"]);
    expect(await app.read("Plan.md")).toContain("See [[Notes]] and [[Nowhere]].");
    // The action button, not the dialog's header close (both are named Close).
    const close = within(dialog).getAllByRole("button", { name: "Close" }).find((b) => b.classList.contains("btn"))!;
    expect(document.activeElement === close || dialog.contains(document.activeElement)).toBe(true);
    await app.user.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves, removing the originals; an original edited meanwhile is kept and reported as not finished", async () => {
    const { app, ws } = await start(team());
    await selectPages(app, ["Plan"]);
    await app.user.click(screen.getByRole("button", { name: "Move to workspace…" }));
    const dialog = await screen.findByRole("dialog", { name: "Move 1 page to a workspace" });
    await within(dialog).findByRole("region", { name: "Who can see it" });
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(false));
    await app.user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("1 page was moved to Studio."), { timeout: 10_000 });
    await expect(app.read("Plan.md")).rejects.toThrow();
    expect(live(ws).map((p) => p.title)).toEqual(["Plan"]);
  });

  it("explains a server without transfers and keeps the action off", async () => {
    const { app } = await start(team({ capabilities: ["search"] }));
    await selectPages(app, ["Diary"]);
    await app.user.click(screen.getByRole("button", { name: "Copy to workspace…" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("This server does not accept transfers"));
    expect((within(dialog).getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is keyboard reachable: focus starts in the dialog and Escape closes it", async () => {
    const { app } = await start(team());
    await selectPages(app, ["Diary"]);
    await app.user.click(screen.getByRole("button", { name: "Copy to workspace…" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await app.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("workspace → Private Space", () => {
  it("moves a workspace page into a Private Space folder chosen from the list; the server deletes it there", async () => {
    await mkdir(join(root, "From team"));
    const { app, servers, ws } = await start(team());
    servers.writeAsOther(ws, { title: "Roadmap", markdown: "# Roadmap\n\nไทย\n" });
    const list = screen.getByRole("tree", { name: /^Workspaces on / });
    await app.user.click(within(list).getByRole("treeitem", { name: /^Studio/ }));
    await app.user.click(await within(list).findByRole("treeitem", { name: "Roadmap" }));
    await app.user.click(await screen.findByRole("button", { name: "Move to Private Space…" }));
    const dialog = await screen.findByRole("dialog", { name: "Move “Roadmap” to your Private Space" });
    await app.user.selectOptions(within(dialog).getByRole("combobox", { name: "Put the pages" }), "From team");
    await waitFor(() => expect(within(dialog).getByRole("region", { name: "Who can see it" }).textContent).toContain("Nothing has been written to your Private Space yet."));
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(false));
    await app.user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("1 page was moved to your Private Space."), { timeout: 10_000 });
    expect(await app.read("From team/Roadmap.md")).toContain("ไทย");
    expect(live(ws)).toEqual([]);
  });

  it("an export-restricted workspace refuses, and the dialog explains why", async () => {
    const { app, servers, ws } = await start(team({ exportRestricted: true }));
    servers.writeAsOther(ws, { title: "Secret", markdown: "# Secret\n" });
    const list = screen.getByRole("tree", { name: /^Workspaces on / });
    await app.user.click(within(list).getByRole("treeitem", { name: /^Studio/ }));
    await app.user.click(await within(list).findByRole("treeitem", { name: "Secret" }));
    await app.user.click(await screen.findByRole("button", { name: "Copy to Private Space…" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("does not allow copying or moving its pages out"));
    expect((within(dialog).getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(true);
    expect(servers.calls.some((c) => c.path.endsWith("/transfers"))).toBe(false);
  });
});

describe("from the right-click menu", () => {
  const menuOf = async (tree: HTMLElement, name: string) => {
    fireEvent.contextMenu(await within(tree).findByRole("treeitem", { name }));
    return screen.findByRole("menu", { name: `Actions for ${name}` });
  };
  const viewerTeam = (servers: FakeServers) => {
    const server = servers.connect(TEAM);
    return { ws: servers.addWorkspace(server, { name: "Studio", role: "viewer" }), server };
  };

  it("a Private Space page and a folder copy or move to a workspace through the transfer dialog", async () => {
    await seed(root, { "Box/One.md": "# One\n", "Box/Two.md": "# Two\n" });
    const { app } = await start(team());
    const tree = screen.getByRole("tree", { name: "Pages in this Private Space" });
    let menu = await menuOf(tree, "Plan");
    expect(within(menu).getByRole("menuitem", { name: "Move to workspace…" })).toBeTruthy();
    await app.user.click(within(menu).getByRole("menuitem", { name: "Copy to workspace…" }));
    expect(await screen.findByRole("dialog", { name: "Copy 1 page to a workspace" })).toBeTruthy();
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    menu = await menuOf(tree, "Box");
    await app.user.click(within(menu).getByRole("menuitem", { name: "Move to workspace…" }));
    expect(await screen.findByRole("dialog", { name: "Move 2 pages to a workspace" })).toBeTruthy();
  });

  it("a Private Space menu has no workspace items when no workspace can be written to", async () => {
    await start(viewerTeam);
    const menu = await menuOf(screen.getByRole("tree", { name: "Pages in this Private Space" }), "Plan");
    expect(within(menu).queryByRole("menuitem", { name: /to workspace/ })).toBeNull();
  });

  it("a workspace page copies or moves to the Private Space for an owner", async () => {
    const { app, servers, ws } = await start(team());
    servers.writeAsOther(ws, { title: "Roadmap", markdown: "# Roadmap\n" });
    const list = screen.getByRole("tree", { name: /^Workspaces on / });
    await app.user.click(within(list).getByRole("treeitem", { name: /^Studio/ }));
    const menu = await menuOf(list, "Roadmap");
    expect(within(menu).getByRole("menuitem", { name: "Copy to Private Space…" })).toBeTruthy();
    await app.user.click(within(menu).getByRole("menuitem", { name: "Move to Private Space…" }));
    expect(await screen.findByRole("dialog", { name: "Move “Roadmap” to your Private Space" })).toBeTruthy();
  });

  it("a viewer's workspace page menu offers Copy to Private Space… but not Move", async () => {
    const { app, servers, ws } = await start(viewerTeam);
    servers.writeAsOther(ws, { title: "Roadmap", markdown: "# Roadmap\n" });
    const list = screen.getByRole("tree", { name: /^Workspaces on / });
    await app.user.click(within(list).getByRole("treeitem", { name: /^Studio/ }));
    const menu = await menuOf(list, "Roadmap");
    expect(within(menu).queryByRole("menuitem", { name: "Move to Private Space…" })).toBeNull();
    await app.user.click(within(menu).getByRole("menuitem", { name: "Copy to Private Space…" }));
    expect(await screen.findByRole("dialog", { name: "Copy “Roadmap” to your Private Space" })).toBeTruthy();
  });
});

describe("interruptions", () => {
  it("an interrupted move offers Try again; the original stays until the move finishes", async () => {
    const { app, servers, ws } = await start(team());
    let offline = true;
    servers.beforeCall = (args) => {
      if (offline && args.path.endsWith("/commit")) throw new Error("The network went away.");
    };
    await selectPages(app, ["Plan"]);
    await app.user.click(screen.getByRole("button", { name: "Move to workspace…" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(false));
    await app.user.click(within(dialog).getByRole("button", { name: "Move" }));
    const alert = await within(dialog).findByRole("alert", {}, { timeout: 10_000 });
    expect(alert.textContent).toContain("The transfer was interrupted");
    expect(alert.textContent).toContain("Your originals are safe.");
    expect(await app.read("Plan.md")).toContain("See [[Notes]]");
    expect(live(ws)).toEqual([]);
    offline = false;
    await app.user.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("1 page was moved to Studio."), { timeout: 10_000 });
    await expect(app.read("Plan.md")).rejects.toThrow();
  });

  it("an edited original is listed in the sidebar as kept until dismissed", async () => {
    const { app, servers, ws } = await start(team());
    // The user's editor saves Plan just after the server committed (synchronously, so it lands before finalize).
    servers.afterCall = (args) => {
      if (args.path.endsWith("/commit")) writeFileSync(join(root, "Plan.md"), "# Plan\n\nEdited at the last moment.\n");
    };
    await selectPages(app, ["Plan"]);
    await app.user.click(screen.getByRole("button", { name: "Move to workspace…" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(false));
    await app.user.click(within(dialog).getByRole("button", { name: "Move" }));
    const result = await within(dialog).findByRole("status", {}, { timeout: 10_000 });
    await waitFor(() => expect(result.textContent).toContain("Done, originals kept."));
    expect(result.textContent).toContain("the move is not finished");
    expect(result.textContent).toContain("Plan.md");
    expect(live(ws).map((p) => p.title)).toEqual(["Plan"]);
    expect(await app.read("Plan.md")).toContain("Edited at the last moment.");
    await app.user.click(within(dialog).getAllByRole("button", { name: "Close" }).find((b) => b.classList.contains("btn"))!);
    const pending = screen.getByRole("region", { name: "Moves with originals kept" });
    expect(pending.textContent).toContain("1 original kept · Studio");
    await app.user.click(within(pending).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Moves with originals kept" })).toBeNull());
  });
});

describe("strings", () => {
  it("every problem has text in English and Thai", () => {
    const problems = [
      { code: "no_transfers", message: "" },
      { code: "export_restricted" },
      { code: "forbidden", role: "viewer" },
      { code: "quota", limit: 10, current: 9, adding: 2 },
      { code: "page_too_large", path: "a.md", size: 2048, limit: 1024 },
      { code: "bad_folder", folder: "x" },
    ] as const;
    for (const p of problems) {
      expect(problemText(p, en.transfer)).not.toBe("");
      expect(problemText(p, th.transfer)).not.toBe(problemText(p, en.transfer));
    }
  });
});
