// @vitest-environment jsdom
/**
 * Copy and move between two workspaces in the desktop app (ADR-0006, amendment of 2026-10-27): from a page's
 * right-click menu, the page header and the palette, through the transfer dialog with its destination picker and
 * preview. The drag between two workspace trees is in cross-space-dnd.test.tsx; the engine in packages/transfer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { FakeServers, type FakeServerConfig, type FakeWorkspace } from "../../../tests/helpers/fake-servers.ts";
import { seed } from "./support/fixtures.ts";
import { en, th } from "../src/strings/index.ts";
import { problemText } from "../src/features/transfer/TransferDialog.tsx";
import { transferEvent } from "../src/features/notifications/sources.ts";
import type { OperationRecord } from "@thoth/transfer";

const dirs = tempDirs();
let root: string;

const TEAM: FakeServerConfig = { url: "https://team.example", name: "Team", account: { id: "usr_me", displayName: "Ada" } };
const OTHER: FakeServerConfig = { url: "https://other.example", name: "Other", account: { id: "usr_me", displayName: "Ada" } };

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Diary.md": "# Diary\n" });
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

interface Options {
  /** The source workspace "Studio" on Team. */
  role?: "owner" | "editor" | "viewer";
  exportRestricted?: boolean;
  /** The destination "Archive": on Other (default) or none. */
  archive?: boolean;
}

async function start(options: Options = {}) {
  const servers = new FakeServers();
  const team = servers.connect(TEAM);
  const ws = servers.addWorkspace(team, { id: "ws_studio", name: "Studio", role: options.role ?? "owner", ...(options.exportRestricted ? { exportRestricted: true } : {}) });
  const other = options.archive === false ? null : servers.connect(OTHER);
  const archive = other ? servers.addWorkspace(other, { id: "ws_archive", name: "Archive", role: "owner" }) : null;
  const roadmap = servers.writeAsOther(ws, { title: "Roadmap", markdown: "# Roadmap\n\nไทย\n" });
  servers.writeAsOther(ws, { title: "Milestones", markdown: "# Milestones\n", parentId: roadmap.id });
  const app = await openApp(root, {}, createNodePlatform({ vault: root, servers }));
  await screen.findByRole("tree", { name: "Pages in this Private Space" });
  const list = await screen.findByRole("tree", { name: "Workspaces on Team" });
  return { app, servers, ws, archive, roadmap, list };
}

const live = (ws: FakeWorkspace) => [...ws.pages.values()].filter((p) => !p.deleted);

async function menuOf(app: Harness, list: HTMLElement, name: string) {
  await app.user.click(within(list).getByRole("treeitem", { name: /^Studio/ }));
  fireEvent.contextMenu(await within(list).findByRole("treeitem", { name }));
  return screen.findByRole("menu", { name: `Actions for ${name}` });
}

const startButton = (dialog: HTMLElement, name: "Copy" | "Move") => within(dialog).getByRole("button", { name }) as HTMLButtonElement;

describe("from the right-click menu", () => {
  it("copies a page and its sub-page to a workspace on another server; the originals stay", async () => {
    const { app, ws, archive, list } = await start();
    const menu = await menuOf(app, list, "Roadmap");
    expect(within(menu).getByRole("menuitem", { name: "Move to another workspace…" })).toBeTruthy();
    await app.user.click(within(menu).getByRole("menuitem", { name: "Copy to another workspace…" }));
    const dialog = await screen.findByRole("dialog", { name: "Copy “Roadmap” to another workspace" });
    // Workspaces on two servers: each is named with its server; the source is not among them.
    const select = within(dialog).getByRole("combobox", { name: "Workspace" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Archive · Other"]);
    const preview = await within(dialog).findByRole("region", { name: "Who can see it" });
    await waitFor(() => expect(preview.textContent).toContain("Milestones"));
    expect(preview.textContent).toContain("From Studio");
    expect(preview.textContent).toContain("Nothing has been written to Archive yet.");
    await waitFor(() => expect(startButton(dialog, "Copy").disabled).toBe(false));
    await app.user.click(startButton(dialog, "Copy"));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("2 pages were copied to Archive. Every page was checked at the destination."), { timeout: 10_000 });
    expect(live(archive!).map((p) => p.title).sort()).toEqual(["Milestones", "Roadmap"]);
    expect(live(ws)).toHaveLength(2);
    // Open goes to the copy, in the other workspace.
    await app.user.click(within(dialog).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.queryAllByRole("tab").some((t) => t.getAttribute("aria-selected") === "true" && t.textContent?.includes("Roadmap"))).toBe(true));
  });

  it("a viewer of the source is offered Copy but not Move", async () => {
    const { app, list } = await start({ role: "viewer" });
    const menu = await menuOf(app, list, "Roadmap");
    expect(within(menu).getByRole("menuitem", { name: "Copy to another workspace…" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Move to another workspace…" })).toBeNull();
  });

  it("is not offered when there is no other workspace to write to", async () => {
    const { app, list } = await start({ archive: false });
    const menu = await menuOf(app, list, "Roadmap");
    expect(within(menu).queryByRole("menuitem", { name: /another workspace/ })).toBeNull();
  });

  it("an export-restricted source: the dialog says why and cannot start", async () => {
    const { app, servers, list } = await start({ exportRestricted: true });
    const menu = await menuOf(app, list, "Roadmap");
    await app.user.click(within(menu).getByRole("menuitem", { name: "Copy to another workspace…" }));
    const dialog = await screen.findByRole("dialog", { name: "Copy “Roadmap” to another workspace" });
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("This workspace does not allow copying or moving its pages out."));
    expect(startButton(dialog, "Copy").disabled).toBe(true);
    expect(servers.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("from the page header and the palette", () => {
  it("the header's button opens the dialog for the open page, and Move moves it", async () => {
    const { app, ws, archive, list } = await start();
    await app.user.click(within(list).getByRole("treeitem", { name: /^Studio/ }));
    await app.user.click(await within(list).findByRole("treeitem", { name: "Roadmap" }));
    await app.user.click(await screen.findByRole("button", { name: "Copy or move to another workspace…" }));
    const dialog = await screen.findByRole("dialog", { name: "Copy “Roadmap” to another workspace" });
    await app.user.click(within(dialog).getByRole("radio", { name: /^Move/ }));
    await waitFor(() => expect(startButton(dialog, "Move").disabled).toBe(false));
    await app.user.click(startButton(dialog, "Move"));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("2 pages were moved to Archive."), { timeout: 10_000 });
    expect(live(ws)).toEqual([]);
    expect(live(archive!).map((p) => p.title).sort()).toEqual(["Milestones", "Roadmap"]);
  });

  it("the palette offers Copy and Move page to another workspace while a workspace page is open", async () => {
    const { app, list } = await start();
    await app.user.click(within(list).getByRole("treeitem", { name: /^Studio/ }));
    await app.user.click(await within(list).findByRole("treeitem", { name: "Roadmap" }));
    await screen.findByRole("button", { name: "Copy or move to another workspace…" });
    await app.user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Search" });
    await app.user.keyboard("> another workspace");
    await waitFor(() => expect(within(palette).queryAllByRole("option").map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Copy page to another workspace…"), expect.stringContaining("Move page to another workspace…")])));
    await app.user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Copy “Roadmap” to another workspace" })).toBeTruthy();
  });
});

describe("notifications and strings", () => {
  const record = (patch: Partial<OperationRecord>): OperationRecord =>
    ({
      recordVersion: 1,
      id: "0190f0f0-0000-7000-8000-000000000001",
      kind: "transfer",
      direction: "between_workspaces",
      mode: "move",
      server: { id: "srv2", url: OTHER.url },
      workspace: { id: "ws_archive", name: "Archive" },
      source: { server: { id: "srv1", url: TEAM.url }, workspace: { id: "ws_studio", name: "Studio" }, operationId: "0190f0f0-0000-7000-8000-000000000002", known: true },
      state: "done",
      failedAt: null,
      destination: { parentId: null, folder: "" },
      items: [{ kind: "page", sourcePath: "Roadmap", sourceId: "pg_src", sourceHash: null, sourceRevision: null, destId: "pg_dst", destParentId: null, destPath: null, destHash: null, destRevision: null, title: "Roadmap", state: "source_deleted" }],
      attachments: [],
      links: { counts: { included: 0, already_at_destination: 0, left_at_source: 0, external: 0, unresolved: 0 }, rewritten: 0, flagged: [] },
      serverKnown: true,
      createdAt: "",
      updatedAt: "",
      error: null,
      ...patch,
    }) as OperationRecord;

  it("a finished transfer opens the result at the destination; an interrupted one the original at the source", () => {
    expect(transferEvent(record({}), false)).toMatchObject({ kind: "transferDone", where: "Archive", pages: ["Roadmap"], open: { kind: "workspacePage", server: "srv2", workspace: "ws_archive", page: "pg_dst" } });
    expect(transferEvent(record({ state: "commit_destination" }), true)).toMatchObject({ kind: "transferFailed", open: { kind: "workspacePage", server: "srv1", workspace: "ws_studio", page: "pg_src" } });
  });

  it("every new problem has text in English and Thai", () => {
    const problems = [{ code: "same_workspace" }, { code: "source_workspace_not_found" }, { code: "source_forbidden", role: "viewer" }, { code: "page_gone" }] as const;
    for (const p of problems) {
      expect(problemText(p, en.transfer)).not.toBe("");
      expect(problemText(p, th.transfer)).not.toBe(problemText(p, en.transfer));
    }
  });
});
