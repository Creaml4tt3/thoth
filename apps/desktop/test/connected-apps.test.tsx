// @vitest-environment jsdom
/**
 * Connected apps (ADR-0021) in the desktop app, against a fake host: Settings → Connected apps (the switch, the
 * Private Spaces shared, the apps and their self-reported names, "Copy the setup", the request log), the Allow / Deny
 * question when a new app connects, and a window answering an app's request from its open Vault.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DEFAULT_DAILY, dailyPath } from "@thoth/local-store";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { FakeConnectedApps, SIDECAR, SOCKET } from "./support/connected-apps.ts";
import { setLangPreference } from "../src/strings/index.ts";

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
    apps.state = { ...apps.state, enabled: true, listening: true, apps: [{ name: "Claude", allowed: true, decidedAt: "2026-10-25T08:00:00Z", propose: null }, { name: "<b>Cursor</b>", allowed: false, decidedAt: "2026-10-25T08:00:00Z", propose: null }] };
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
    expect(section.getAllByRole("status").map((s) => s.textContent)).toContain("Copied.");
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
    const decided = [{ name: "Claude", allowed: true, decidedAt: "2026-10-25T08:00:00Z", propose: null }];
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

describe("Agents' memory (ADR-0052)", () => {
  it("asks which folder agents use when Memory holds pages of the user's own, and keeps their answer", async () => {
    apps.state = { ...apps.state, enabled: true, listening: true, spaces: [root] };
    const app = await open();
    const shown = app.platform.connections[0]!.root;
    apps.asksForFolder(shown);
    const dialog = within(await screen.findByRole("dialog", { name: "Which folder should agents use for memory?" }));
    expect(dialog.getByText(/already has a folder called Memory/)).toBeTruthy();
    const field = dialog.getByRole("textbox", { name: "Folder for agents' memory" }) as HTMLInputElement;
    expect(field.value).toBe("Agent memory");
    // The top level or a hidden folder is refused before the host is asked.
    await app.user.clear(field);
    await app.user.type(field, ".hidden");
    await app.user.click(dialog.getByRole("button", { name: "Use this folder" }));
    expect((await dialog.findByRole("alert")).textContent).toMatch(/not the top level or a hidden folder/);
    expect(apps.calls.some((c) => c[0] === "memoryFolder")).toBe(false);
    await app.user.clear(field);
    await app.user.type(field, "/AI/Memory/");
    await app.user.click(dialog.getByRole("button", { name: "Use this folder" }));
    expect(apps.calls).toContainEqual(["memoryFolder", shown, "AI/Memory"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("“Use Memory anyway” is an answer too, and a question for another Private Space is not shown here", async () => {
    apps.state = { ...apps.state, enabled: true, listening: true, spaces: [root] };
    const app = await open();
    apps.asksForFolder("/elsewhere");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
    apps.asksForFolder(app.platform.connections[0]!.root);
    await app.user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Use Memory anyway" }));
    expect(apps.calls).toContainEqual(["memoryFolder", app.platform.connections[0]!.root, "Memory"]);
  });

  it("Settings has the switch for every app, one per app, and shows each shared Private Space's memory folder", async () => {
    apps.state = {
      ...apps.state,
      enabled: true,
      listening: true,
      spaces: [root],
      memoryFolders: { [root]: "AI/Memory" },
      apps: [{ name: "Claude", allowed: true, decidedAt: "2026-11-07T09:00:00Z", propose: null, remember: true }],
    };
    const app = await open();
    const section = await openSettings(app);
    expect(section.getByText("Memory folder: AI/Memory")).toBeTruthy();
    const all = section.getByRole("switch", { name: "Agents save memories without asking" });
    expect(checked(all)).toBe(true);
    const claude = within(section.getByRole("listitem", { name: "Claude" })).getByRole("switch", { name: "Save memories without asking" });
    expect(checked(claude)).toBe(true);
    await app.user.click(claude);
    expect(apps.calls).toContainEqual(["mayRemember", "Claude", false]);
    await app.user.click(all);
    expect(apps.calls).toContainEqual(["configure", { memories: false }]);
    // With the global switch off, the per-app one has nothing to say.
    await waitFor(() => expect(within(section.getByRole("listitem", { name: "Claude" })).queryByRole("switch", { name: "Save memories without asking" })).toBeNull());
  });
});

describe("Skills (ADR-0052 rule 7)", () => {
  it("links this Private Space's skills from Settings, says what it did, and keeps them up to date", async () => {
    await mkdir(join(root, "Skills/weekly-update"), { recursive: true });
    await writeFile(join(root, "Skills/weekly-update/SKILL.md"), "---\nname: weekly-update\ndescription: x\n---\n");
    const app = await open();
    const shown = app.platform.connections[0]!.root;
    apps.linkReport = { linked: ["review", "weekly-update"], skipped: ["taken"], folders: ["/Users/someone/.agents/skills"] };
    const section = await openSettings(app);
    const toggle = section.getByRole("switch", { name: "Use this Private Space's skills in Claude Code and Codex" });
    expect(checked(toggle)).toBe(false);
    await app.user.click(toggle);
    await waitFor(() => expect(checked(toggle)).toBe(true));
    expect(apps.calls).toContainEqual(["skillLinks", shown, true]);
    expect(section.getByText("Linked 2 skills: review, weekly-update. Not linked, because something with the same name is already there: taken.")).toBeTruthy();
    // The window then keeps the links up to date with its skills, without turning anything on or off.
    await waitFor(() => expect(apps.calls).toContainEqual(["skillLinks", shown]));

    await app.user.click(toggle);
    await waitFor(() => expect(checked(toggle)).toBe(false));
    expect(apps.calls).toContainEqual(["skillLinks", shown, false]);
    expect(section.getByText("The links are removed.")).toBeTruthy();
  });
});

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
    // The version a proposal is made from (ADR-0048): the page's content hash.
    expect((read.result.page as { hash?: string }).hash).toMatch(/^[0-9a-f]{64}$/);

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

  it("works out a memory, writes it when the host asks, recalls it and forgets it into the Trash (ADR-0052)", async () => {
    const { app, root: shown } = await seeded();
    const base = { owner: "main", root: shown, space: "Notes" } as const;
    apps.request({ ...base, id: "c1", tool: "memory_change", args: { op: "remember", text: "Put blockers first.", kind: "preference", topic: "updates/format", certainty: "stated", app: "Claude", folder: "Memory" } });
    const change = ((await answered("c1")) as { result: { op: string; path: string; after: string; baseHash: null } }).result;
    expect(change).toMatchObject({ op: "create", path: "Memory/updates-format.md", baseHash: null });
    expect(change.after).toContain("source: Claude");

    // Nothing is written until the host commits it.
    apps.request({ ...base, id: "q0", tool: "recall", args: { limit: 10, folder: "Memory" } });
    expect(((await answered("q0")) as { result: { total: number } }).result.total).toBe(0);
    apps.request({ ...base, id: "w1", tool: "memory_commit", args: { op: "write", path: change.path, text: change.after, expected: null, folder: "Memory" } });
    expect(await answered("w1")).toEqual({ result: { hash: expect.stringMatching(/^[0-9a-f]{64}$/) } });

    apps.request({ ...base, id: "q1", tool: "recall", args: { limit: 10, folder: "Memory" } });
    const recalled = ((await answered("q1")) as { result: { memories: { path: string; kind: string; text: string; stale: boolean; certainty: string }[] } }).result;
    expect(recalled.memories).toEqual([expect.objectContaining({ path: change.path, kind: "preference", text: "Put blockers first.", stale: false, certainty: "stated" })]);

    // A stated memory is not replaced by an inferred one, and the window says so by its code.
    apps.request({ ...base, id: "c2", tool: "memory_change", args: { op: "remember", text: "Maybe risks first.", kind: "preference", topic: "updates/format", certainty: "inferred", app: "Codex", folder: "Memory" } });
    expect(await answered("c2")).toEqual({ error: { code: "STATED", message: expect.stringContaining("Ask the user") } });
    // Never written outside the memory folder.
    apps.request({ ...base, id: "w2", tool: "memory_commit", args: { op: "write", path: "Plan.md", text: "x", expected: null, folder: "Memory" } });
    expect(await answered("w2")).toEqual({ error: { code: "BAD_ARGUMENT", message: expect.any(String) } });

    apps.request({ ...base, id: "c3", tool: "memory_change", args: { op: "forget", page: { path: change.path }, folder: "Memory" } });
    const forget = ((await answered("c3")) as { result: { op: string; baseHash: string } }).result;
    apps.request({ ...base, id: "t1", tool: "memory_commit", args: { op: "trash", path: change.path, expected: forget.baseHash, folder: "Memory" } });
    expect(await answered("t1")).toEqual({ result: {} });
    expect(app.platform.trashed).toEqual([change.path]);

    // What a folder holds, before the host records it: Thoth set this one up.
    apps.request({ ...base, id: "f1", tool: "memory_folder", args: { folder: "Memory" } });
    expect(await answered("f1")).toEqual({ result: { pages: 1, thoth: true } }); // About me
    apps.request({ ...base, id: "f2", tool: "memory_folder", args: { folder: ".thoth" } });
    expect(await answered("f2")).toEqual({ error: { code: "BAD_ARGUMENT", message: expect.any(String) } });
  });

  it("lists and reads skills, and names today's note or how it would start (ADR-0052)", async () => {
    await mkdir(join(root, "Skills/weekly-update/references"), { recursive: true });
    await writeFile(join(root, "Skills/weekly-update/SKILL.md"), "---\nname: weekly-update\ndescription: Writes the weekly\n  update.\n---\nBlockers first.\n");
    await writeFile(join(root, "Skills/weekly-update/references/style.md"), "Short lines.\n");
    await writeFile(join(root, "Skills/weekly-update/run.sh"), "echo hi\n");
    await mkdir(join(root, "Skills/notes-only"));
    await writeFile(join(root, "Skills/notes-only/README.md"), "Not a skill: no SKILL.md.\n");
    const { root: shown } = await seeded();
    const base = { owner: "main", root: shown, space: "Notes" } as const;

    apps.request({ ...base, id: "k1", tool: "list_skills", args: {} });
    expect(await answered("k1")).toEqual({ result: { skills: [{ name: "weekly-update", description: "Writes the weekly update.", path: "Skills/weekly-update/SKILL.md" }] } });
    apps.request({ ...base, id: "k2", tool: "get_skill", args: { name: "Weekly-Update" } });
    expect(await answered("k2")).toEqual({
      result: { skill: { name: "weekly-update", path: "Skills/weekly-update/SKILL.md", text: expect.stringContaining("Blockers first."), files: ["references/style.md", "run.sh"] } },
    });
    apps.request({ ...base, id: "k3", tool: "get_skill", args: { name: "weekly-update", file: "run.sh" } });
    expect(await answered("k3")).toMatchObject({ result: { skill: { path: "Skills/weekly-update/run.sh", text: "echo hi\n", files: ["references/style.md", "SKILL.md"] } } });
    for (const [id, args] of [["k4", { name: "notes-only" }], ["k5", { name: "weekly-update", file: "nope.md" }]] as const) {
      apps.request({ ...base, id, tool: "get_skill", args });
      expect(await answered(id)).toEqual({ result: { skill: null } });
    }

    // No note for today yet: where it goes and how it starts; nothing is written.
    const today = dailyPath(DEFAULT_DAILY, new Date());
    apps.request({ ...base, id: "d1", tool: "read_page", args: { today: true } });
    expect(await answered("d1")).toEqual({ result: { page: null, today: { path: today, markdown: expect.stringContaining(`# ${today.split("/").pop()!.replace(/\.md$/, "")}`) } } });
    await expect(readFile(join(root, today), "utf8")).rejects.toThrow();
    // Once it is there, it is read like any page.
    await mkdir(join(root, today, ".."), { recursive: true });
    await writeFile(join(root, today), "# Today\n\n- one\n");
    apps.request({ ...base, id: "d2", tool: "read_page", args: { today: true } });
    expect(await answered("d2")).toMatchObject({ result: { page: { path: today, markdown: "# Today\n\n- one\n" } } });
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
