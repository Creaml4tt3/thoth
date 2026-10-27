// @vitest-environment jsdom
/**
 * Connected apps (ADR-0021) in the desktop app, against a fake host: Settings → Connected apps (the switch, the
 * Private Spaces shared, the apps and their self-reported names, "Copy the setup", the request log), the Allow / Deny
 * question when a new app connects, and a window answering an app's request from its open Vault.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectedApps, ConnectedAppsLogEntry, ConnectedAppsSettings, McpAnswer, McpRequest } from "@thoth/platform";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { setLangPreference } from "../src/strings/index.ts";

const SIDECAR = "/Applications/Thoth.app/Contents/MacOS/thoth-mcp";
const SOCKET = "/Users/someone/Library/Application Support/com.thothnotes.desktop/mcp/thoth.sock";

class FakeConnectedApps implements ConnectedApps {
  state: ConnectedAppsSettings = { available: true, enabled: false, listening: false, error: null, spaces: [], apps: [], pending: [], setup: { command: SIDECAR, args: ["--socket", SOCKET] } };
  calls: unknown[][] = [];
  answers: { id: string; answer: McpAnswer }[] = [];
  entries: ConnectedAppsLogEntry[] = [];
  private readonly requests = new Set<(r: McpRequest) => void>();
  private readonly pendings = new Set<(apps: string[]) => void>();

  private copy = () => structuredClone(this.state);
  async settings() {
    return this.copy();
  }
  async configure(change: { enabled?: boolean; spaces?: string[] }) {
    this.calls.push(["configure", change]);
    if (change.enabled !== undefined) Object.assign(this.state, { enabled: change.enabled, listening: change.enabled });
    if (change.spaces) this.state.spaces = change.spaces;
    return this.copy();
  }
  async decide(app: string, allow: boolean) {
    this.calls.push(["decide", app, allow]);
    this.state.apps = [...this.state.apps.filter((a) => a.name !== app), { name: app, allowed: allow, decidedAt: "2026-10-26T09:00:00Z" }];
    this.state.pending = this.state.pending.filter((p) => p !== app);
    this.emitPending();
    return this.copy();
  }
  async forget(app: string) {
    this.calls.push(["forget", app]);
    this.state.apps = this.state.apps.filter((a) => a.name !== app);
    return this.copy();
  }
  async log() {
    return this.entries;
  }
  async answer(id: string, answer: McpAnswer) {
    this.answers.push({ id, answer });
  }
  async onRequest(listener: (r: McpRequest) => void) {
    this.requests.add(listener);
    return () => void this.requests.delete(listener);
  }
  async onPending(listener: (apps: string[]) => void) {
    this.pendings.add(listener);
    return () => void this.pendings.delete(listener);
  }
  /** An app connects for the first time. */
  connect(app: string) {
    this.state.pending = [...this.state.pending, app];
    this.emitPending();
  }
  emitPending() {
    for (const l of [...this.pendings]) l([...this.state.pending]);
  }
  request(r: McpRequest) {
    for (const l of [...this.requests]) l(r);
  }
}

const dirs = tempDirs();
let root: string;
let apps: FakeConnectedApps;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  apps = new FakeConnectedApps();
  await writeFile(join(root, "Plan.md"), "---\nthoth_id: 0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b\n---\n# Plan\n\nแผนงานปีหน้า and the budget.\n\n![[chart.png]]\n");
  await writeFile(join(root, "chart.png"), new Uint8Array([137, 80, 78, 71]));
  await writeFile(join(root, "Log.md"), "# Log\n\nSee [[Plan]].\n");
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  setLangPreference("system");
  await dirs.cleanup();
});

async function open(): Promise<Harness> {
  const platform = createNodePlatform({ vault: root, connectedApps: apps });
  const app = await openApp(root, {}, platform);
  await screen.findByRole("tree");
  return app;
}

async function openSettings(app: Harness) {
  await app.user.click(screen.getAllByRole("button", { name: "Settings" })[0]!);
  return within(await screen.findByTestId("connected-apps-settings"));
}

describe("Settings → Connected apps", () => {
  it("is off until switched on, and shares only the Private Spaces ticked", async () => {
    const app = await open();
    const section = await openSettings(app);
    const toggle = section.getByRole("switch", { name: "Let other apps read my notes" });
    expect(checked(toggle)).toBe(false);
    await app.user.click(toggle);
    await waitFor(() => expect(checked(toggle)).toBe(true));
    expect(apps.calls).toContainEqual(["configure", { enabled: true }]);

    const space = section.getByRole("checkbox", { name: new RegExp(root.split("/").pop()!) });
    expect(checked(space)).toBe(false);
    await app.user.click(space);
    await waitFor(() => expect(checked(space)).toBe(true));
    expect(apps.state.spaces).toEqual([apps.state.spaces[0]]);
    expect(apps.calls.at(-1)).toEqual(["configure", { spaces: [expect.stringContaining(root.split("/").pop()!)] }]);
    await app.user.click(space);
    await waitFor(() => expect(apps.state.spaces).toEqual([]));
  });

  it("lists the apps by the names they give, which it says are not checked, and revokes or removes one", async () => {
    apps.state = { ...apps.state, enabled: true, listening: true, apps: [{ name: "Claude", allowed: true, decidedAt: "2026-10-25T08:00:00Z" }, { name: "<b>Cursor</b>", allowed: false, decidedAt: "2026-10-25T08:00:00Z" }] };
    const app = await open();
    const section = await openSettings(app);
    expect(section.getByText(/Each app gives its own name.*Thoth cannot check it/)).toBeTruthy();
    const claude = within(section.getByRole("listitem", { name: "Claude" }));
    expect(claude.getByText("Allowed")).toBeTruthy();
    // A name is text, never markup.
    expect(section.getByRole("listitem", { name: "<b>Cursor</b>" })).toBeTruthy();
    await app.user.click(claude.getByRole("button", { name: "Revoke" }));
    expect(apps.calls).toContainEqual(["decide", "Claude", false]);
    await waitFor(() => expect(within(section.getByRole("listitem", { name: "Claude" })).getByText("Denied")).toBeTruthy());
    await app.user.click(within(section.getByRole("listitem", { name: "<b>Cursor</b>" })).getByRole("button", { name: "Remove" }));
    expect(apps.calls).toContainEqual(["forget", "<b>Cursor</b>"]);
    await waitFor(() => expect(section.queryByRole("listitem", { name: "<b>Cursor</b>" })).toBeNull());
  });

  it("copies the setup for Claude Desktop or Cursor, with the absolute path of thoth-mcp", async () => {
    const app = await open();
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const section = await openSettings(app);
    await app.user.click(section.getByRole("button", { name: "Copy the setup" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual({ mcpServers: { thoth: { command: SIDECAR, args: ["--socket", SOCKET] } } });
    expect(section.getByRole("status").textContent).toContain("Copied");
    expect(section.getByTestId("mcp-setup").textContent).toContain(SIDECAR);
  });

  it("shows the request log: when, which app, which tool and pages, and how it ended", async () => {
    apps.entries = [
      { time: "2026-10-26T09:30:00Z", app: "Claude", tool: "read_page", spaces: ["Notes"], paths: ["Plan.md"], ok: true },
      { time: "2026-10-26T09:29:00Z", app: "Cursor", tool: "search", spaces: [], paths: [], ok: false, error: "DENIED" },
    ];
    const app = await open();
    const section = await openSettings(app);
    await app.user.click(section.getByRole("button", { name: "Show requests" }));
    const table = within(await section.findByRole("table", { name: "Requests from connected apps" }));
    const rows = table.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Claude")).toBeTruthy();
    expect(within(rows[0]!).getByText("Plan.md")).toBeTruthy();
    expect(within(rows[1]!).getByText("Refused: not allowed")).toBeTruthy();
    expect(section.getByText(/never what a page says/)).toBeTruthy();
  });

  describe("after the app's identifier changed (ADR-0031)", () => {
    const decided = [{ name: "Claude", allowed: true, decidedAt: "2026-10-25T08:00:00Z" }];
    const notice = (section: ReturnType<typeof within>) => section.queryByRole("note", { name: "Copy the setup again" });

    it("tells someone who set up apps before to copy the setup again, once", async () => {
      apps.state = { ...apps.state, enabled: true, listening: true, apps: decided };
      let app = await open();
      let section = await openSettings(app);
      const shown = await section.findByRole("note", { name: "Copy the setup again" });
      expect(shown?.textContent).toMatch(/apps you set up before.*stop connecting.*copy the setup below/i);
      await app.user.click(within(shown!).getByRole("button", { name: "Got it" }));
      await waitFor(() => expect(notice(section)).toBeNull());
      // Not again, in this window or the next.
      cleanup();
      app = await open();
      section = await openSettings(app);
      expect(notice(section)).toBeNull();
    });

    it("copying the setup counts as having seen it", async () => {
      apps.state = { ...apps.state, enabled: true, listening: true, apps: decided };
      const app = await open();
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
      const section = await openSettings(app);
      await section.findByRole("note", { name: "Copy the setup again" });
      await app.user.click(section.getByRole("button", { name: "Copy the setup" }));
      await waitFor(() => expect(notice(section)).toBeNull());
    });

    it("is never shown to someone with no apps set up the first time they look", async () => {
      let app = await open();
      let section = await openSettings(app);
      expect(notice(section)).toBeNull();
      // An app connected later used the setup shown now: it is not told to copy it again.
      cleanup();
      apps.state = { ...apps.state, enabled: true, listening: true, apps: decided };
      app = await open();
      section = await openSettings(app);
      expect(section.getByRole("listitem", { name: "Claude" })).toBeTruthy();
      expect(notice(section)).toBeNull();
    });
  });

  it("says when Connected apps cannot be used on this computer", async () => {
    apps.state = { ...apps.state, available: false, setup: null };
    const app = await open();
    const section = await openSettings(app);
    expect(section.getByText(/not available on this computer yet/)).toBeTruthy();
    expect(section.queryByRole("switch")).toBeNull();
  });

  it("is in Thai too", async () => {
    setLangPreference("th");
    const platform = createNodePlatform({ vault: root, connectedApps: apps });
    const app = await openApp(root, {}, platform);
    await screen.findByRole("tree");
    await app.user.click(screen.getAllByRole("button", { name: "การตั้งค่า" })[0]!);
    const section = within(await screen.findByTestId("connected-apps-settings"));
    expect(section.getByRole("heading", { level: 2 }).textContent).toContain("แอปที่เชื่อมต่อ");
  });
});

describe("A new app asks to read", () => {
  it("is asked about in the window, and Allow is remembered by the host", async () => {
    apps.state = { ...apps.state, enabled: true, listening: true, spaces: [root] };
    await open();
    apps.connect("Claude Desktop");
    const dialog = within(await screen.findByRole("dialog", { name: "Let “Claude Desktop” read your notes?" }));
    expect(dialog.getByText(/search and read the pages of/)).toBeTruthy();
    expect(dialog.getByText(/cannot change anything/)).toBeTruthy();
    expect(dialog.getByText(/Apps name themselves/)).toBeTruthy();
    await userClick(dialog.getByRole("button", { name: "Allow" }));
    expect(apps.calls).toContainEqual(["decide", "Claude Desktop", true]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Deny is an answer too; the next app waiting is asked about after it", async () => {
    apps.state = { ...apps.state, enabled: true, listening: true, spaces: [root] };
    await open();
    apps.connect("One");
    apps.connect("Two");
    await userClick(within(await screen.findByRole("dialog", { name: "Let “One” read your notes?" })).getByRole("button", { name: "Deny" }));
    expect(apps.calls).toContainEqual(["decide", "One", false]);
    expect(await screen.findByRole("dialog", { name: "Let “Two” read your notes?" })).toBeTruthy();
  });

  it("closes when the question was answered in another window", async () => {
    await open();
    apps.connect("Zed");
    await screen.findByRole("dialog");
    apps.state.pending = [];
    apps.emitPending();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

const checked = (element: HTMLElement) => (element as HTMLInputElement).checked;

async function userClick(element: HTMLElement) {
  element.click();
  await Promise.resolve();
}

describe("A window answers from its open Vault", () => {
  async function seeded() {
    const app = await open();
    const connection = app.platform.connections[0]!;
    return { app, root: connection.root };
  }

  const answered = async (id: string) => {
    await waitFor(() => expect(apps.answers.find((a) => a.id === id)).toBeDefined());
    return apps.answers.find((a) => a.id === id)!.answer;
  };

  it("search, the page list, a page by path or id, and backlinks", async () => {
    const { root: shown } = await seeded();
    const base = { owner: "main", root: shown, space: "Notes" } as const;
    apps.request({ ...base, id: "s", tool: "search", args: { query: "แผน", limit: 10 } });
    expect(await answered("s")).toEqual({ result: { hits: [expect.objectContaining({ path: "Plan.md", title: "Plan", id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" })] } });

    apps.request({ ...base, id: "l", tool: "list_pages", args: { folder: "", limit: 1 } });
    expect(await answered("l")).toEqual({ result: { pages: [{ id: expect.any(String), path: "Log.md", title: "Log" }], total: 2 } });

    apps.request({ ...base, id: "r", tool: "read_page", args: { id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" } });
    const read = (await answered("r")) as { result: { page: { path: string; markdown: string; attachments: string[] } } };
    expect(read.result.page.path).toBe("Plan.md");
    expect(read.result.page.markdown).toContain("แผนงานปีหน้า");
    expect(read.result.page.attachments).toEqual(["chart.png"]);

    apps.request({ ...base, id: "b", tool: "backlinks", args: { path: "Plan.md", limit: 50 } });
    expect(await answered("b")).toEqual({ result: { page: { id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", path: "Plan.md", title: "Plan" }, links: [{ id: expect.any(String), path: "Log.md", title: "Log", line: 3 }], total: 1 } });
  });

  it("a page that is not there, an attachment or a folder outside it is not found", async () => {
    const { root: shown } = await seeded();
    const base = { owner: "main", root: shown, space: "Notes" } as const;
    for (const [id, path] of [["n1", "Nope.md"], ["n2", "chart.png"], ["n3", ".thoth/config.json"]] as const) {
      apps.request({ ...base, id, tool: "read_page", args: { path } });
      expect(await answered(id)).toEqual({ error: { code: "NOT_FOUND", message: `No page ${path} in Notes` } });
    }
  });

  it("answers only what was sent to this window, for its own Private Space", async () => {
    const { root: shown } = await seeded();
    apps.request({ owner: "space-other", root: shown, space: "Notes", id: "x1", tool: "list_pages", args: { folder: "", limit: 10 } });
    apps.request({ owner: "main", root: "/elsewhere", space: "Other", id: "x2", tool: "list_pages", args: { folder: "", limit: 10 } });
    apps.request({ owner: "main", root: shown, space: "Notes", id: "x3", tool: "list_pages", args: { folder: "", limit: 10 } });
    await answered("x3");
    expect(apps.answers.map((a) => a.id)).toEqual(["x3"]);
  });
});
