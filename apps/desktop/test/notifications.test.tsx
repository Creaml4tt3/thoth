// @vitest-environment jsdom
/**
 * Notifications on the desktop (ADR-0018): every event kind lands in the bell's list; agent runs go through the
 * mascot (its state, its announcement and a short message bubble); a system notification is shown only while the
 * window is in the background and only for the kinds switched on in Settings → Notifications.
 */
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportSource } from "@thoth/importer-core";
import type { NotificationKind, SystemNotification, SystemNotifier } from "@thoth/app-ui/notifications/core.ts";
import { cleanup, editorBox, caretAtEnd, paragraph, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { nodeOpenImportSource } from "./support/import-source.ts";
import { ALPHA, seed } from "./support/fixtures.ts";
import { FakeServers, type FakeServerConfig } from "../../../tests/helpers/fake-servers.ts";
import { FAKE_CLAUDE_DIR } from "../../../tests/helpers/agent.ts";
import type { OpenImportSource } from "../src/features/import/open-source.ts";
import { NOTIFICATION_PREFS_KEY } from "../src/features/notifications/prefs.ts";
import { setLangPreference } from "../src/strings/index.ts";

const dirs = tempDirs();
let root: string;
let data: string;
let shown: SystemNotification[];
let notifier: SystemNotifier & { show: ReturnType<typeof vi.fn> };

const PLAN = "# Plan\n\nWe have a cat.\n";
const FIXTURE = resolve(import.meta.dirname, "../../../tests/fixtures/obsidian-vault");

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  data = await dirs.dir("thoth-ui-notify-data-");
  shown = [];
  notifier = { kind: "system", show: vi.fn(async (n: SystemNotification) => (shown.push(n), true)) };
  setForeground();
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  setLangPreference("system");
  setForeground();
  await dirs.cleanup();
});

/** The window loses focus (as when another app is in front), or gets it back. */
function setBackground() {
  window.dispatchEvent(new Event("blur"));
}
function setForeground() {
  window.dispatchEvent(new Event("focus"));
}

const bell = () => screen.getByRole("button", { name: /^Notifications/ });
const panel = () => screen.getByRole("dialog", { name: "Notifications" });
const MASCOT = /^Thoth assistant/;
const mascotState = () => screen.getByTestId("mascot").dataset["state"];
const bubble = () => screen.getByRole("dialog", { name: "Ask Thoth" });

async function openList(app: Harness): Promise<HTMLElement> {
  if (!screen.queryByRole("dialog", { name: "Notifications" })) await app.user.click(bell());
  return panel();
}
let lastPanelText = "";
const panelText = () => lastPanelText;
async function entryTitles(app: Harness): Promise<string[]> {
  const list = await openList(app);
  const titles = [...list.querySelectorAll(".notif-title")].map((e) => e.textContent ?? "");
  lastPanelText = list.textContent ?? "";
  await app.user.keyboard("{Escape}");
  return titles;
}

describe("agent runs", () => {
  async function openAgents(options: Record<string, unknown> = {}) {
    await seed(root, { "Notes/Plan.md": PLAN, "Diary.md": "# Diary\n" });
    const app = await openApp(root, { notifier, messageMs: 400, ...options }, createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } }));
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    await editorBox();
    return app;
  }
  async function start(app: Harness, prompt: string) {
    if (!screen.queryByRole("dialog", { name: "Ask Thoth" })) await app.user.click(screen.getByRole("button", { name: MASCOT }));
    await screen.findByRole("dialog", { name: "Ask Thoth" });
    const select = within(bubble()).getByRole("combobox", { name: "Agent" }) as HTMLSelectElement;
    await waitFor(() => expect(select.querySelector("option")!.dataset["state"]).toBe("ready"));
    await app.user.click(within(bubble()).getByRole("button", { name: "Add context" }));
    const group = await screen.findByRole("group", { name: "Pages for the agent" });
    const clear = within(group).queryByRole("button", { name: "Clear" });
    if (clear) await app.user.click(clear);
    await app.user.click(await within(group).findByRole("checkbox", { name: "Plan" }));
    await app.user.click(within(bubble()).getByRole("textbox", { name: "Task" }));
    await app.user.paste(prompt);
    await app.user.click(within(bubble()).getByRole("button", { name: "Start" }));
    // The bubble is closed (a click on the mascot) and the person goes to another app while it runs.
    await within(bubble()).findByRole("button", { name: "Cancel" });
    await app.user.click(screen.getByRole("button", { name: MASCOT }));
    expect(screen.queryByRole("dialog", { name: "Ask Thoth" })).toBeNull();
    setBackground();
  }

  it("a run ready for review: one entry, a system notification in the background, the mascot's message, and nothing of the task or the output", async () => {
    const app = await openAgents();
    await start(app, "SECRET-TASK rewrite it\n@say SECRET-OUTPUT\n@replace Notes/Plan.md :: cat => dog\n");
    await waitFor(() => expect(mascotState()).toBe("review"), { timeout: 15_000 });
    await waitFor(() => expect(shown).toEqual([{ title: "Changes ready for review", body: "Claude Code · Plan" }]));
    expect(bell().getAttribute("aria-label")).toBe("Notifications, 1 unread");
    // The mascot says it (its state and its announcement), the bell does not say it again.
    expect(screen.getByTestId("mascot-live").textContent).toBe("Thoth assistant: the changes are ready for your review.");
    expect(screen.getByTestId("notification-live").textContent).toBe("");
    // A short message by the mascot that takes no focus.
    const message = await screen.findByRole("button", { name: "Changes ready for review" });
    expect(message.closest("[data-testid=mascot-message]")).toBeTruthy();
    expect(document.activeElement).not.toBe(message);
    // The task is the person's own words: the sidebar's Assistant section lists it (as Settings' history does). Nothing
    // else on screen carries it, and nothing carries the output.
    const rest = document.body.cloneNode(true) as HTMLElement;
    rest.querySelector('[data-section="agents"]')?.remove();
    expect(rest.textContent).not.toContain("SECRET");
    expect(document.body.textContent).not.toContain("SECRET-OUTPUT");
    expect(JSON.stringify(shown)).not.toContain("SECRET");

    // Clicking the message opens the review, and the entry is read.
    setForeground();
    await app.user.click(message);
    await screen.findByRole("region", { name: "Review the changes" });
    expect(bell().getAttribute("aria-label")).toBe("Notifications");
  });

  it("the mascot's message closes by itself", async () => {
    const app = await openAgents();
    await start(app, "@replace Notes/Plan.md :: cat => dog\n");
    await screen.findByTestId("mascot-message", {}, { timeout: 15_000 });
    await waitFor(() => expect(screen.queryByTestId("mascot-message")).toBeNull(), { timeout: 3000 });
    // The entry stays in the list, and opens the review from there.
    const list = await openList(app);
    await app.user.click(within(list).getByRole("button", { name: /Changes ready for review/ }));
    await screen.findByRole("region", { name: "Review the changes" });
  });

  it("a run that finished without changes, and one that failed", async () => {
    const app = await openAgents();
    await start(app, "@sleep 200\n");
    await waitFor(() => expect(shown.map((n) => n.title)).toEqual(["The answer is ready"]), { timeout: 15_000 });
    setForeground();
    await app.user.click(screen.getByRole("button", { name: MASCOT }));
    await app.user.click(await within(bubble()).findByRole("button", { name: "New task" }));
    await start(app, "@not-logged-in\n");
    await waitFor(() => expect(shown.map((n) => n.title)).toEqual(["The answer is ready", "The run failed: Claude Code is not signed in"]), { timeout: 15_000 });
    expect(mascotState()).toBe("error");
    expect(await entryTitles(app)).toEqual(["The run failed: Claude Code is not signed in", "The answer is ready"]);
  });

  it("a run stopped at its spending limit", async () => {
    const app = await openAgents();
    await start(app, "@replace Notes/Plan.md :: cat => dog\n@budget\n");
    await waitFor(() => expect(shown).toEqual([{ title: "The run stopped at its spending limit", body: "Claude Code · Plan · its work so far can be reviewed" }]), { timeout: 15_000 });
    expect(await entryTitles(app)).toEqual(["The run stopped at its spending limit"]);
  });

  it("in the foreground: the entry and the mascot, no system notification", async () => {
    const app = await openAgents();
    await start(app, "@replace Notes/Plan.md :: cat => dog\n");
    setForeground();
    await waitFor(() => expect(mascotState()).toBe("review"), { timeout: 15_000 });
    await screen.findByTestId("mascot-message");
    expect(bell().getAttribute("aria-label")).toBe("Notifications, 1 unread");
    expect(notifier.show).not.toHaveBeenCalled();
  });

  it("with the mascot switched off, the bell says it instead", async () => {
    const app = await openAgents();
    await start(app, "@sleep 1500\n@replace Notes/Plan.md :: cat => dog\n");
    setForeground();
    // Switched off while the run works.
    await app.user.click(screen.getAllByRole("button", { name: "Settings" })[0]!);
    await app.user.click(await screen.findByRole("switch", { name: "Show the mascot" }));
    expect(screen.queryByTestId("mascot")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("notification-live").textContent).toBe("Changes ready for review. Claude Code · Plan"), { timeout: 15_000 });
    expect(screen.queryByTestId("mascot-message")).toBeNull();
  });
});

describe("transfers", () => {
  const TEAM: FakeServerConfig = { url: "https://team.example", name: "Team", account: { id: "usr_me", displayName: "Ada" } };
  async function openTeam() {
    await seed(root, { "Plan.md": "# Plan\n", "Notes.md": "# Notes\n" });
    const servers = new FakeServers();
    const server = servers.connect(TEAM);
    const ws = servers.addWorkspace(server, { name: "Studio", role: "owner" });
    const app = await openApp(root, { notifier }, createNodePlatform({ vault: root, servers }));
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    await screen.findByRole("tree", { name: /^Workspaces on / });
    return { app, servers, ws };
  }
  async function send(app: Harness, mode: "Copy" | "Move") {
    await app.user.click(screen.getByRole("button", { name: "Select pages" }));
    const tree = screen.getByRole("tree", { name: "Pages in this Private Space" });
    for (const box of within(tree).getAllByRole("checkbox")) if ((box as HTMLInputElement).checked) await app.user.click(box);
    await app.user.click(within(tree).getByRole("checkbox", { name: "Select Plan" }));
    await app.user.click(screen.getByRole("button", { name: `${mode} to workspace…` }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect((within(dialog).getByRole("button", { name: mode }) as HTMLButtonElement).disabled).toBe(false));
    setBackground();
    await app.user.click(within(dialog).getByRole("button", { name: mode }));
    return dialog;
  }

  it("a copy done: an entry that opens the copy, and a system notification", async () => {
    const { app, ws } = await openTeam();
    const dialog = await send(app, "Copy");
    await within(dialog).findByRole("status", {}, { timeout: 10_000 });
    await waitFor(() => expect(shown).toEqual([{ title: "Copied to Studio", body: "Plan" }]));
    await app.user.click(within(dialog).getAllByRole("button", { name: "Close" }).find((b) => b.classList.contains("btn"))!);
    setForeground();
    const list = await openList(app);
    await app.user.click(within(list).getByRole("button", { name: /Copied to Studio/ }));
    // The workspace's copy opens in the current tab (the tabs this window keeps name it).
    const copies = [...ws.pages.values()].filter((p) => p.title === "Plan");
    expect(copies).toHaveLength(1);
    const kept = () => Object.entries(localStorage).find(([key]) => key.startsWith("thoth.desktop.tabs."))?.[1] ?? "";
    await waitFor(() => expect(kept()).toContain(`"page":"${copies[0]!.id}"`));
    expect(kept()).toContain(`"k":"ws"`);
  });

  it("a move that did not finish", async () => {
    const { app, servers } = await openTeam();
    servers.beforeCall = (args) => {
      if (args.path.endsWith("/commit")) throw new Error("The network went away.");
    };
    const dialog = await send(app, "Move");
    await within(dialog).findByRole("alert", {}, { timeout: 10_000 });
    await waitFor(() => expect(shown).toEqual([{ title: "The move to Studio did not finish", body: "Plan" }]));
    // Not the server's message: only fixed words and names.
    expect(JSON.stringify(shown)).not.toContain("network");
    // The entry opens the original, which is still where it was.
    await app.user.click(within(dialog).getAllByRole("button", { name: "Close" }).find((b) => b.classList.contains("btn"))!);
    setForeground();
    const list = await openList(app);
    await app.user.click(within(list).getByRole("button", { name: /The move to Studio did not finish/ }));
    await waitFor(() => expect(screen.getByRole("tab", { selected: true }).textContent).toContain("Plan"));
  });
});

describe("imports", () => {
  async function runImport(open: OpenImportSource) {
    const platform = createNodePlatform({ vault: root });
    platform.pickedSource = FIXTURE;
    const app = await openApp(root, { notifier, openImportSource: open }, platform);
    await app.user.click(await screen.findByText(/import from notion or obsidian/i, { selector: "button" }));
    await app.user.click(await screen.findByRole("radio", { name: /obsidian/i }));
    await app.user.click(screen.getByRole("button", { name: "Continue" }));
    await app.user.click(screen.getByRole("button", { name: /i have it ready/i }));
    await app.user.click(screen.getByRole("button", { name: /choose folder/i }));
    await screen.findByText(/Preview of/);
    await app.user.click(screen.getByRole("button", { name: "Continue" }));
    await app.user.click(screen.getByRole("button", { name: "Continue" }));
    setBackground();
    await app.user.click(screen.getByRole("button", { name: /start import/i }));
    await screen.findByTestId("import-report", {}, { timeout: 15_000 });
    setForeground();
    return app;
  }

  /** Leaves the report for the shell (the imported folder opens), where the bell is. */
  async function toShell(app: Harness) {
    await app.user.click(within(screen.getByTestId("import-report")).getByRole("button", { name: /open imported folder/i }));
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
  }

  it("an import done", async () => {
    const app = await runImport(nodeOpenImportSource);
    await waitFor(() => expect(shown).toEqual([{ title: "Import complete", body: "11 pages in Imports/obsidian-vault" }]));
    await toShell(app);
    expect(await entryTitles(app)).toEqual(["Import complete"]);
    // The entry goes to the tab that shows the folder's first page, from a new tab, instead of opening it twice.
    const first = screen.getByRole("tab", { selected: true }).textContent;
    await app.user.keyboard("{Meta>}t{/Meta}");
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    await app.user.click(within(await openList(app)).getByRole("button", { name: /Import complete/ }));
    await waitFor(() => expect(screen.getByRole("tab", { selected: true }).textContent).toBe(first));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("an import that finished with errors", async () => {
    const failing: OpenImportSource = async (platform, kind, location) => {
      const opened = await nodeOpenImportSource(platform, kind, location);
      const inner = opened.source;
      const source = Object.create(inner, {
        read: { value: async (path: string) => (path.endsWith(".md") ? inner.read(path) : Promise.reject(new Error("SECRET disk error"))) },
      }) as ImportSource;
      return { source, provider: opened.provider };
    };
    const app = await runImport(failing);
    await waitFor(() => expect(shown.map((n) => n.title)).toEqual(["Import finished with errors"]));
    expect(JSON.stringify(shown)).not.toContain("SECRET");
    await toShell(app);
    expect(await entryTitles(app)).toEqual(["Import finished with errors"]);
    expect(panelText()).not.toContain("SECRET");
  });
});

describe("save conflicts", () => {
  it("an entry and, in the background, a system notification naming the page; the entry opens it", async () => {
    await seed(root, { "Alpha.md": ALPHA, "Beta.md": "# Beta\n" });
    const app = await openApp(root, { notifier });
    await app.user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: "Alpha" }));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("First paragraph stays exactly."));
    box.focus();
    caretAtEnd(paragraph(box, "First paragraph stays exactly."));
    await app.user.keyboard("!!");
    setBackground();
    await app.external("Alpha.md", ALPHA.replace("First paragraph stays exactly.", "SECRET rewritten elsewhere."));
    app.platform.emit({ paths: ["Alpha.md"] });
    await screen.findByRole("dialog", { name: /changed on disk/i });
    await waitFor(() => expect(shown).toEqual([{ title: "Alpha changed elsewhere while you were editing it", body: "Choose which version to keep." }]));
    expect(JSON.stringify(shown)).not.toContain("SECRET");
    await app.user.click(screen.getByRole("button", { name: /keep mine/i }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /changed on disk/i })).toBeNull());
    setForeground();
    await app.user.click(within(screen.getByRole("tree")).getByRole("treeitem", { name: "Beta" }));
    const list = await openList(app);
    expect(screen.getByTestId("notification-live").textContent).toBe("Alpha changed elsewhere while you were editing it. Choose which version to keep.");
    await app.user.click(within(list).getByRole("button", { name: /Alpha changed elsewhere/ }));
    await waitFor(() => expect(screen.getByRole("tab", { selected: true }).textContent).toContain("Alpha"));
    // It opened in a new tab: Beta, the page that was on screen, stays open beside it.
    const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabNames()).toEqual(["Beta", "Alpha"]);
    // Opened again from another tab, it goes to the tab that shows it instead of opening another.
    await app.user.click(screen.getByRole("tab", { name: "Beta" }));
    await waitFor(() => expect(screen.getByRole("tab", { selected: true }).textContent).toContain("Beta"));
    await app.user.click(within(await openList(app)).getByRole("button", { name: /Alpha changed elsewhere/ }));
    await waitFor(() => expect(screen.getByRole("tab", { selected: true }).textContent).toContain("Alpha"));
    expect(tabNames()).toEqual(["Beta", "Alpha"]);
  });
});

describe("the bell", () => {
  it("is in the sidebar, opens from the palette, and Esc returns focus", async () => {
    await seed(root, { "Alpha.md": ALPHA });
    const app = await openApp(root, { notifier });
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    expect(within(sidebar).getByRole("button", { name: "Notifications" })).toBe(bell());
    await app.user.keyboard("{Meta>}k{/Meta}");
    await app.user.keyboard(">notif");
    await app.user.keyboard("{Enter}");
    const list = await screen.findByRole("dialog", { name: "Notifications" });
    expect(list.textContent).toContain("Nothing yet.");
    await waitFor(() => expect(list.contains(document.activeElement)).toBe(true));
    await app.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(document.activeElement).toBe(bell());
  });
});

describe("Settings → Notifications", () => {
  const section = () => screen.getByRole("region", { name: "Notifications" });

  it("switches system notifications off for a kind, or all, and keeps the choice for the next window", async () => {
    await seed(root, { "Alpha.md": ALPHA });
    const withAgents = () => createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } });
    let app = await openApp(root, { notifier }, withAgents());
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    await app.user.click(screen.getAllByRole("button", { name: "Settings" })[0]!);
    const system = within(await screen.findByRole("region", { name: "Notifications" })).getByRole("switch", { name: "System notifications" }) as HTMLInputElement;
    expect(system.checked).toBe(true);
    const kinds = within(section()).getAllByRole("checkbox") as HTMLInputElement[];
    expect(kinds.map((k) => k.labels?.[0]?.textContent)).toEqual([
      "Changes ready for review",
      "Run finished",
      "Run failed",
      "Run stopped at a limit",
      "Copy or move done",
      "Copy or move did not finish",
      "Import done",
      "Import finished with errors",
      "Save conflict",
      // Not a system notification (ADR-0022): it decides whether a new version is added to the list under the bell.
      "Add a new version to the list under the bell",
    ]);
    expect(kinds.every((k) => k.checked)).toBe(true);
    await app.user.click(within(section()).getByRole("checkbox", { name: "Save conflict" }));
    const stored = JSON.parse(localStorage.getItem(NOTIFICATION_PREFS_KEY)!) as { system: boolean; kinds: Record<NotificationKind, boolean> };
    expect(stored.system).toBe(true);
    expect(stored.kinds.saveConflict).toBe(false);
    expect(stored.kinds.importDone).toBe(true);
    await app.user.click(system);
    // Per-kind choices wait while all are off. The switch for the list entry of a new version is not about them.
    for (const k of within(section()).getAllByRole("checkbox") as HTMLInputElement[]) expect(k.matches(":disabled")).toBe(k.labels?.[0]?.textContent !== "Add a new version to the list under the bell");
    expect(JSON.parse(localStorage.getItem(NOTIFICATION_PREFS_KEY)!).system).toBe(false);

    cleanup();
    app = await openApp(root, { notifier }, withAgents());
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    await app.user.click(screen.getAllByRole("button", { name: "Settings" })[0]!);
    await screen.findByRole("region", { name: "Notifications" });
    expect((within(section()).getByRole("switch", { name: "System notifications" }) as HTMLInputElement).checked).toBe(false);
    expect((within(section()).getByRole("checkbox", { name: "Save conflict" }) as HTMLInputElement).checked).toBe(false);
    expect(section().textContent).toContain("Only while Thoth is in the background");
  });

  it("a kind switched off is still listed in the app, but not shown by the system", async () => {
    localStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify({ system: true, kinds: { saveConflict: false } }));
    await seed(root, { "Alpha.md": ALPHA });
    const app = await openApp(root, { notifier });
    await app.user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: "Alpha" }));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("First paragraph stays exactly."));
    box.focus();
    caretAtEnd(paragraph(box, "First paragraph stays exactly."));
    await app.user.keyboard("!!");
    setBackground();
    await app.external("Alpha.md", ALPHA.replace("First paragraph stays exactly.", "Elsewhere."));
    app.platform.emit({ paths: ["Alpha.md"] });
    await screen.findByRole("dialog", { name: /changed on disk/i });
    await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Notifications, 1 unread"));
    expect(notifier.show).not.toHaveBeenCalled();
  });

  it("speaks Thai", async () => {
    setLangPreference("th");
    await seed(root, { "Alpha.md": ALPHA });
    const app = await openApp(root, { notifier });
    await screen.findByRole("tree", { name: "หน้าใน Private Space นี้" });
    expect(screen.getByRole("button", { name: "การแจ้งเตือน" })).toBeTruthy();
    await app.user.click(screen.getAllByRole("button", { name: "การตั้งค่า" })[0]!);
    const region = await screen.findByRole("region", { name: "การแจ้งเตือน" });
    expect(within(region).getByRole("switch", { name: "การแจ้งเตือนของระบบ" })).toBeTruthy();
  });
});
