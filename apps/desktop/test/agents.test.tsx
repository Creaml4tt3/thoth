// @vitest-environment jsdom
/**
 * The assistant's agent runs (Phase 4, now driven from the mascot) on the Node test host with the fake Claude Code and
 * Codex CLIs: the agent select in the prompt bubble, detection with fix instructions in Settings → Thoth assistant
 * (including Codex's sandbox check), Codex without a spending limit, picking context, start, the streamed transcript in
 * the bubble, the review tab with per-file approval, apply (exact bytes on disk), the conflict path with a kept copy,
 * cancel, the sidebar's "Ask Thoth…", the history and the settings. Never a real model.
 */
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, editorBox, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";
import { FAKE_CLAUDE_DIR, FAKE_CODEX_DIR, fakeRecord } from "../../../tests/helpers/agent.ts";
import { FakeServers, type FakeWorkspace } from "../../../tests/helpers/fake-servers.ts";
import { AGENT_SETTINGS_KEY, DEFAULT_AGENT_SETTINGS } from "../src/features/agents/settings.ts";
import { excerptAllowed, type Excerpt } from "../src/features/agents/service.ts";
import type { ServerDirectory } from "@thoth/app-ui/workspace/directory.ts";
import { setLangPreference } from "../src/strings/index.ts";

const dirs = tempDirs();
let root: string;
let data: string;
const PLAN = "# Plan\n\nWe have a cat.\n";

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  data = await dirs.dir("thoth-ui-agent-data-");
  await seed(root, { "Notes/Plan.md": PLAN, "Notes/Ideas.md": "# Ideas\n", "Diary.md": "# Diary\n" });
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  setLangPreference("system");
  await dirs.cleanup();
});

const MASCOT = /^Thoth assistant/;
const mascot = () => screen.getByRole("button", { name: MASCOT });
const mascotState = () => screen.getByTestId("mascot").dataset["state"];
const bubble = () => screen.getByRole("dialog", { name: "Ask Thoth" });
const agentSelect = () => screen.getByRole("combobox", { name: "Agent" }) as HTMLSelectElement;
const optionOf = (id: string) => agentSelect().querySelector<HTMLOptionElement>(`option[value="${id}"]`)!;

/** Opens the app with agents, waits for the first page, and opens the mascot's bubble. */
async function open(searchDirs = [FAKE_CLAUDE_DIR], servers?: FakeServers): Promise<Harness> {
  // Start on the first page, whatever tab an earlier window of the test left open.
  for (const key of Object.keys(localStorage)) if (key.startsWith("thoth.desktop.tabs.")) localStorage.removeItem(key);
  const app = await openApp(root, {}, createNodePlatform({ vault: root, ...(servers ? { servers } : {}), agents: { dataDir: data, searchDirs } }));
  await screen.findByRole("tree", { name: "Pages in this Private Space" });
  await editorBox();
  await app.user.click(await screen.findByRole("button", { name: MASCOT }));
  await screen.findByRole("dialog", { name: "Ask Thoth" });
  return app;
}

async function ready(id = "claude") {
  await waitFor(() => expect(optionOf(id).dataset["state"]).toBe("ready"));
}

/** The context picker inside the bubble ("+"). */
async function picker(app: Harness): Promise<HTMLElement> {
  const shown = screen.queryByRole("group", { name: "Pages for the agent" });
  if (shown) return shown;
  await app.user.click(within(bubble()).getByRole("button", { name: "Add context" }));
  return screen.findByRole("group", { name: "Pages for the agent" });
}

/** Only these pages: the current page the bubble added by default is cleared first. */
async function pickOnly(app: Harness, pages: string[]) {
  const group = await picker(app);
  const clear = within(group).queryByRole("button", { name: "Clear" });
  if (clear) await app.user.click(clear);
  for (const name of pages) await app.user.click(await within(group).findByRole("checkbox", { name }));
}

/** Types the task (userEvent types "{" as a key descriptor; directives have none, but paste keeps the text exact) and starts. */
async function writeAndStart(app: Harness, prompt: string) {
  await app.user.click(within(bubble()).getByRole("textbox", { name: "Task" }));
  await app.user.paste(prompt);
  await app.user.click(within(bubble()).getByRole("button", { name: "Start" }));
}

async function startTask(app: Harness, pages: string[], prompt: string) {
  await ready();
  await pickOnly(app, pages);
  await writeAndStart(app, prompt);
}

/** Waits for the run to reach review, then opens the review tab from the bubble. */
async function openReview(app: Harness): Promise<HTMLElement> {
  await app.user.click(await within(bubble()).findByRole("button", { name: "Review the changes" }, { timeout: 15_000 }));
  return screen.findByRole("region", { name: "Review the changes" });
}

/** Settings → Thoth assistant. */
async function openAssistantSettings(app: Harness, name = "Settings"): Promise<HTMLElement> {
  if (screen.queryByRole("dialog", { name: "Ask Thoth" })) await app.user.keyboard("{Escape}");
  await app.user.click(screen.getAllByRole("button", { name })[0]!);
  return screen.findByTestId("assistant-settings");
}

const status = (id = "claude") => screen.getByTestId(`agent-status-${id}`);

/** The run's working directory, once the host has made it. */
async function workDir(): Promise<string> {
  let runs: string[] = [];
  await waitFor(async () => {
    runs = await readdir(join(data, "agent-runs")).catch(() => []);
    expect(runs.length).toBe(1);
  });
  return join(data, "agent-runs", runs[0]!, "work");
}

describe("the assistant's runs", () => {
  it("says the CLI is missing, where it looked and how to fix it", async () => {
    const app = await open([join(data, "empty")]);
    await waitFor(() => expect(optionOf("claude").dataset["state"]).toBe("missing"));
    expect(optionOf("claude").textContent).toBe("Claude Code · Not found");
    expect(within(bubble()).getByRole("button", { name: "Start" })).toHaveProperty("disabled", true);
    expect(within(bubble()).getByTestId("bubble-agent-status").textContent).toContain("Not found");
    await openAssistantSettings(app);
    await waitFor(() => expect(status().dataset["state"]).toBe("missing"));
    expect(status().textContent).toBe("Claude Code is not installed, or Thoth cannot find it.");
    const section = screen.getByRole("region", { name: "Claude Code" });
    expect(section.textContent).toContain(join(data, "empty"));
    expect(section.textContent).toContain("brew install --cask claude-code");
    await app.user.click(within(section).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(status().dataset["state"]).toBe("missing"));
    expect(screen.getByRole("note").textContent).toContain("The agent runs with your user permissions. Thoth limits what it is given, not what it can do.");
  });

  it("runs a task from the bubble on the picked page, streams it, and applies only the approved change, byte for byte", async () => {
    const app = await open();
    await ready();
    // The current page is the default context.
    expect(within(bubble()).getByRole("list", { name: "Context" }).textContent).toContain("Diary");
    await openAssistantSettings(app);
    await waitFor(() => expect(status().textContent).toBe("Claude Code 2.1.310 is ready. It uses your own Claude login; Thoth never sees it."));
    await app.user.click(mascot());
    await screen.findByRole("dialog", { name: "Ask Thoth" });
    await startTask(app, ["Plan"], "Make it a dog.\n@replace Notes/Plan.md :: cat => dog\n@write Notes/Summary.md :: # Summary\\n");
    await waitFor(() => expect(mascotState()).toBe("review"), { timeout: 15_000 });
    const log = within(bubble()).getByRole("log", { name: "What the agent is doing" });
    expect(log.textContent).toContain("Editing Notes/Plan.md");
    expect(log.textContent).toContain("Writing Notes/Summary.md");
    expect(log.textContent).toContain("Done.");
    expect(log.textContent).toContain("Estimated cost: US$0.0012");

    // The working directory held only the picked page.
    expect((await fakeRecord(await workDir())).files).toEqual([
      { path: "Notes", kind: "directory" },
      { path: "Notes/Plan.md", kind: "file" },
    ]);

    const review = await openReview(app);
    expect(screen.queryByRole("dialog", { name: "Ask Thoth" })).toBeNull();
    const plan = within(review).getByRole("checkbox", { name: "Apply the change to Notes/Plan.md" });
    const summary = within(review).getByRole("checkbox", { name: "Apply the change to Notes/Summary.md" });
    expect([(plan as HTMLInputElement).checked, (summary as HTMLInputElement).checked]).toEqual([true, true]);
    const diff = within(review).getByRole("group", { name: "Changes to Notes/Plan.md" });
    expect([...diff.querySelectorAll("[data-kind=del]")].map((l) => l.textContent)).toEqual(["-We have a cat."]);
    expect([...diff.querySelectorAll("[data-kind=add]")].map((l) => l.textContent)).toEqual(["+We have a dog."]);
    // Nothing is written before Apply.
    expect(await app.read("Notes/Plan.md")).toBe(PLAN);

    await app.user.click(summary);
    await app.user.click(within(review).getByRole("button", { name: "Apply 1 change" }));
    const results = await screen.findByRole("region", { name: "Result" });
    expect(await app.read("Notes/Plan.md")).toBe("# Plan\n\nWe have a dog.\n");
    await expect(stat(join(root, "Notes/Summary.md"))).rejects.toThrow();
    expect(results.textContent).toContain("Notes/Plan.mdApplied");
    expect(results.textContent).toContain("Notes/Summary.mdNot applied (not selected)");
    expect(document.activeElement).toBe(within(results).getByRole("heading", { name: "Result" }));
    expect(mascotState()).toBe("done");
    await waitFor(async () => expect(await readdir(join(data, "agent-runs"))).toEqual([]));

    await app.user.click(within(results).getByRole("button", { name: "Open Notes/Plan.md" }));
    await screen.findByRole("textbox", { name: /page content/i });
    await openAssistantSettings(app);
    const history = screen.getByRole("region", { name: "Earlier runs" });
    await waitFor(() => expect(history.textContent).toContain("Applied"));
    expect(history.textContent).toContain("Make it a dog.");
  });

  it("discard writes nothing, and nothing can be applied without a choice", async () => {
    const app = await open();
    await startTask(app, ["Plan"], "@replace Notes/Plan.md :: cat => fox\n");
    const review = await openReview(app);
    await app.user.click(within(review).getByRole("checkbox", { name: "Apply the change to Notes/Plan.md" }));
    expect(within(review).getByRole("button", { name: "Apply 0 changes" })).toHaveProperty("disabled", true);
    await app.user.click(within(review).getByRole("button", { name: "Discard all" }));
    expect((await screen.findByRole("region", { name: "Result" })).textContent).toContain("All changes were discarded. Nothing was written.");
    expect(await app.read("Notes/Plan.md")).toBe(PLAN);
    // Discarding is not a success: the mascot does not celebrate.
    expect(mascotState()).not.toBe("done");
  });

  it("a page edited meanwhile is a conflict, never overwritten; the agent's version can be kept as a copy", async () => {
    const app = await open();
    await startTask(app, ["Notes (folder, 2 pages)"], "@sleep 300\n@replace Notes/Plan.md :: cat => dog\n");
    await fakeRecord(await workDir());
    await app.external("Notes/Plan.md", "# Plan\n\nMine now.\n");
    const review = await openReview(app);
    expect(review.textContent).toContain("This changed in your Private Space after the agent started.");
    await app.user.click(within(review).getByRole("button", { name: "Apply 1 change" }));
    const results = await screen.findByRole("region", { name: "Result" });
    expect(results.textContent).toContain("Not applied: it changed in your Private Space since the run started. Your version was kept.");
    expect(await app.read("Notes/Plan.md")).toBe("# Plan\n\nMine now.\n");
    await app.user.click(within(results).getByRole("button", { name: "Keep the agent's version as a copy" }));
    await waitFor(() => expect(results.textContent).toMatch(/kept as Notes\/Plan \(conflict \d{4}-\d{2}-\d{2} \d{4}\)\.md/));
    const copy = (await readdir(join(root, "Notes"))).find((n) => n.startsWith("Plan (conflict"))!;
    expect(await readFile(join(root, "Notes", copy), "utf8")).toBe("# Plan\n\nWe have a dog.\n");
  });

  it("cancel stops the run from the bubble and changes nothing", async () => {
    const app = await open();
    await startTask(app, ["Plan"], "@replace Notes/Plan.md :: cat => dog\n@hang\n");
    const cancel = await within(bubble()).findByRole("button", { name: "Cancel" }, { timeout: 15_000 });
    expect(mascotState()).toBe("working");
    expect(mascot().getAttribute("aria-label")).toBe("Thoth assistant, working");
    await waitFor(async () => expect((await fakeRecord(await workDir())).grandchild).not.toBeNull());
    await waitFor(() => expect(cancel).toHaveProperty("disabled", false));
    await app.user.click(cancel);
    expect((await within(bubble()).findByText("Cancelled. Nothing in your Private Space was changed.", undefined, { timeout: 15_000 })).className).toBe("alert");
    expect(await app.read("Notes/Plan.md")).toBe(PLAN);
    await waitFor(async () => expect(await readdir(join(data, "agent-runs"))).toEqual([]));
    await app.user.click(within(bubble()).getByRole("button", { name: "New task" }));
    expect((await picker(app)).textContent).toContain("1 selected");
  });

  it("explains a CLI that is not signed in when the run says so, and the mascot shows the error", async () => {
    const app = await open();
    await startTask(app, ["Plan"], "@not-logged-in\n");
    expect((await within(bubble()).findByText(/stopped with an error/, undefined, { timeout: 15_000 })).parentElement!.textContent).toContain("Claude Code is not signed in. Run claude in a terminal and sign in, then try again.");
    expect(mascotState()).toBe("error");
    expect(screen.getByTestId("mascot-live").textContent).toBe("Thoth assistant: the run stopped with an error.");
    // A new task clears it.
    await app.user.click(within(bubble()).getByRole("button", { name: "New task" }));
    expect(mascotState()).toBe("listening");
  });

  it("takes the pages picked in the sidebar ('Ask Thoth…')", async () => {
    const app = await openApp(root, {}, createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } }));
    const tree = await screen.findByRole("tree", { name: "Pages in this Private Space" });
    await app.user.click(screen.getByRole("button", { name: "Select pages" }));
    for (const box of within(tree).getAllByRole("checkbox")) if ((box as HTMLInputElement).checked) await app.user.click(box);
    await app.user.click(within(tree).getByRole("checkbox", { name: "Select Diary" }));
    await app.user.click(screen.getByRole("button", { name: "Ask Thoth…" }));
    await screen.findByRole("dialog", { name: "Ask Thoth" });
    expect(within(bubble()).getByRole("list", { name: "Context" }).textContent).toContain("Diary");
    const group = await picker(app);
    expect(((await within(group).findByRole("checkbox", { name: "Diary" })) as HTMLInputElement).checked).toBe(true);
    expect(group.textContent).toContain("1 selected");
  });

  it("is not offered where the host cannot run agents", async () => {
    await openApp(root);
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    expect(screen.queryByRole("button", { name: MASCOT })).toBeNull();
    expect(screen.queryByTestId("assistant-settings")).toBeNull();
  });

  it("speaks Thai", async () => {
    setLangPreference("th");
    const app = await openApp(root, {}, createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } }));
    await screen.findByRole("tree", { name: "หน้าใน Private Space นี้" });
    await app.user.click(screen.getByRole("button", { name: /^ผู้ช่วย Thoth, / }));
    const dialog = await screen.findByRole("dialog", { name: "ถาม Thoth" });
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "เอเจนต์" }).querySelector("option")!.dataset["state"]).toBe("ready"));
    expect(within(dialog).getByRole("button", { name: "เริ่ม" })).toBeTruthy();
    expect(within(dialog).getByText("เอเจนต์ทำงานด้วยสิทธิ์ผู้ใช้ของคุณ Thoth จำกัดสิ่งที่ส่งให้เอเจนต์ ไม่ได้จำกัดสิ่งที่เอเจนต์ทำได้")).toBeTruthy();
  });
});

/** The run records the app wrote into the Private Space, oldest first. */
async function savedRecords(): Promise<Record<string, any>[]> {
  const dir = join(root, ".thoth/agent/runs");
  const names = await readdir(dir).catch(() => [] as string[]);
  const all = await Promise.all(names.map(async (n) => JSON.parse(await readFile(join(dir, n), "utf8")) as Record<string, any>));
  return all.sort((a, b) => a["createdAt"] - b["createdAt"]);
}

/** A server with a workspace the user may copy pages out of, and one they may not. */
function teamServers(): { servers: FakeServers; open: FakeWorkspace; locked: FakeWorkspace } {
  const servers = new FakeServers();
  const id = servers.connect({ url: "http://127.0.0.1:8080", name: "Team server", tokens: ["t"], account: { id: "usr_me", displayName: "Ada" } });
  const open = servers.addWorkspace(id, { id: "ws_team", name: "Team Docs", role: "viewer" });
  servers.writeAsOther(open, { title: "Spec", markdown: "# Spec\n\nRoadmap: ship in May.\n" });
  const locked = servers.addWorkspace(id, { id: "ws_locked", name: "Locked", role: "owner", exportRestricted: true });
  servers.writeAsOther(locked, { title: "Secret", markdown: "# Secret\n" });
  return { servers, open, locked };
}

describe("the assistant's runs: context", () => {
  it("can give the whole Private Space: the total is shown first, and every change still goes through review", async () => {
    const app = await open();
    await ready();
    const group = await picker(app);
    await app.user.click(within(group).getByRole("checkbox", { name: "Whole Private Space" }));
    const size = Buffer.byteLength(PLAN) + Buffer.byteLength("# Ideas\n") + Buffer.byteLength("# Diary\n");
    await waitFor(() => expect(screen.getByTestId("agent-total").textContent).toBe(`3 files, ${size} B, will be copied for the agent`));
    expect(group.textContent).toContain("The whole Private Space is included.");
    expect(within(bubble()).getByRole("list", { name: "Context" }).textContent).toContain("Whole Private Space");
    // Everything is shown as included, and nothing can be unpicked one by one.
    for (const name of ["Plan", "Ideas", "Diary"]) {
      const box = within(group).getByRole("checkbox", { name }) as HTMLInputElement;
      expect([box.checked, box.disabled]).toEqual([true, true]);
    }
    await writeAndStart(app, "Rename it.\n@replace Diary.md :: Diary => Journal\n@write Brand-new.md :: # New\\n");
    const review = await openReview(app);
    expect(await app.read("Diary.md")).toBe("# Diary\n");
    await app.user.click(within(review).getByRole("checkbox", { name: "Apply the change to Brand-new.md" }));
    await app.user.click(within(review).getByRole("button", { name: "Apply 1 change" }));
    await screen.findByRole("region", { name: "Result" });
    expect(await app.read("Diary.md")).toBe("# Journal\n");
    await expect(stat(join(root, "Brand-new.md"))).rejects.toThrow();
    expect((await savedRecords())[0]).toMatchObject({ task: { wholeSpace: true }, state: "applied" });
  });

  it("shows a workspace page's option only where copying pages out is allowed, and refuses the rest", async () => {
    const { servers } = teamServers();
    const app = await open([FAKE_CLAUDE_DIR], servers);
    await ready();
    await picker(app);
    const group = await screen.findByRole("group", { name: "Workspace pages (read-only)" });
    await within(group).findByText("Team Docs");
    // A workspace that forbids copying out says so and offers nothing; its pages are never even listed.
    const lockedBlock = within(group).getByText("Locked").closest("details")!;
    expect(lockedBlock.textContent).toContain("This workspace does not allow its pages to be copied out.");
    await app.user.click(within(group).getByText("Locked"));
    expect(within(lockedBlock).queryAllByRole("checkbox")).toEqual([]);
    expect(servers.calls.some((c) => c.path.includes("ws_locked/tree") || c.path.includes("ws_locked/pages"))).toBe(false);
    // The open one lists its pages once expanded.
    await app.user.click(within(group).getByText("Team Docs"));
    await app.user.click(await within(group).findByRole("checkbox", { name: "Spec" }));
    expect(group.textContent).toContain("1 workspace page added");
    expect(group.textContent).toContain("Spec (Team Docs, read-only)");
    expect(within(bubble()).getByRole("list", { name: "Context" }).textContent).toContain("Spec (read-only)");
    await app.user.click(within(group).getByRole("button", { name: "Remove Spec" }));
    expect(group.textContent).not.toContain("1 workspace page added");
  });

  it("gives a workspace page read-only: an edit to it is shown as discarded, never offered, never written anywhere", async () => {
    const { servers, open: team } = teamServers();
    const app = await open([FAKE_CLAUDE_DIR], servers);
    await ready();
    await pickOnly(app, ["Plan"]);
    const group = await screen.findByRole("group", { name: "Workspace pages (read-only)" });
    await app.user.click(await within(group).findByText("Team Docs"));
    await app.user.click(await within(group).findByRole("checkbox", { name: "Spec" }));
    await writeAndStart(app, ["@unlock workspace/Team Docs/Spec.md", "@replace workspace/Team Docs/Spec.md :: May => June", "@write workspace/Team Docs/New.md :: # New\\n", "@replace Notes/Plan.md :: cat => dog"].join("\n"));

    const review = await openReview(app);
    const spec = within(review).getByRole("checkbox", { name: "Apply the change to workspace/Team Docs/Spec.md" }) as HTMLInputElement;
    expect([spec.checked, spec.disabled]).toEqual([false, true]);
    const row = spec.closest("li")!;
    expect(row.dataset["problem"]).toBe("read_only");
    expect(row.textContent).toContain("Read-only workspace page: change discarded");
    expect(within(review).getByRole("checkbox", { name: "Apply the change to workspace/Team Docs/New.md" })).toHaveProperty("disabled", true);
    expect(within(review).getByRole("checkbox", { name: "Apply the change to Notes/Plan.md" })).toHaveProperty("checked", true);

    await app.user.click(within(review).getByRole("button", { name: "Apply 1 change" }));
    const results = await screen.findByRole("region", { name: "Result" });
    expect(results.textContent).toContain("workspace/Team Docs/Spec.mdRead-only workspace page: change discarded");
    expect(results.textContent).toContain("Notes/Plan.mdApplied");
    expect(await app.read("Notes/Plan.md")).toBe(PLAN.replace("cat", "dog"));
    await expect(stat(join(root, "workspace"))).rejects.toThrow();
    // The page was read, never written.
    expect(servers.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(team.pages.size).toBe(1);
    expect([...team.pages.values()][0]!.markdown).toBe("# Spec\n\nRoadmap: ship in May.\n");
    // The saved record names the origin of the reference copy, not its text.
    const [saved] = await savedRecords();
    expect(saved!["context"].find((c: any) => c.readOnly)).toMatchObject({ path: "workspace/Team Docs/Spec.md", via: "workspace", workspace: { workspaceName: "Team Docs", title: "Spec" } });
    expect(JSON.stringify(saved)).not.toContain("Roadmap");
  });

  it("refuses a workspace page when the workspace stops allowing it before the run starts", async () => {
    const { servers, open: team } = teamServers();
    const app = await open([FAKE_CLAUDE_DIR], servers);
    await ready();
    await pickOnly(app, []);
    const group = await screen.findByRole("group", { name: "Workspace pages (read-only)" });
    await app.user.click(await within(group).findByText("Team Docs"));
    await app.user.click(await within(group).findByRole("checkbox", { name: "Spec" }));
    team.exportRestricted = true; // an owner changed the rule meanwhile
    await writeAndStart(app, "Summarize.");
    const alert = await screen.findByTestId("agent-notice");
    expect(alert.dataset["kind"]).toBe("export_restricted");
    expect(alert.textContent).toBe("“Team Docs” does not allow its pages to be copied out, so they cannot be given to an agent.");
    // Nothing started or was copied.
    expect(await readdir(join(data, "agent-runs")).catch(() => [])).toEqual([]);
    expect(await savedRecords()).toEqual([]);
    expect(within(bubble()).getByRole("button", { name: "Start" })).toBeTruthy();
  });

  it("follows Permissions: what is switched off is not offered and cannot be started with", async () => {
    const { servers } = teamServers();
    const app = await open([FAKE_CLAUDE_DIR], servers);
    await ready();
    await openAssistantSettings(app);
    const perms = screen.getByRole("region", { name: "Permissions and limits" });
    await app.user.click(within(perms).getByRole("switch", { name: "Read-only workspace pages" }));
    await app.user.click(within(perms).getByRole("switch", { name: "Private Space pages and folders" }));
    expect(JSON.parse(localStorage.getItem(AGENT_SETTINGS_KEY)!)).toMatchObject({ allowPrivate: false, allowWholeSpace: true, allowWorkspace: false });
    await app.user.click(mascot());
    await screen.findByRole("dialog", { name: "Ask Thoth" });
    // The current page is not added, and the picker says why.
    expect(within(bubble()).getByRole("list", { name: "Context" }).textContent).toContain("Nothing yet");
    await app.user.click(within(bubble()).getByRole("button", { name: "Add context" }));
    expect(within(bubble()).getByText("Private Space pages are switched off in Settings → Thoth assistant → Permissions.")).toBeTruthy();
    expect(within(bubble()).getByText("Workspace pages are switched off in Settings → Thoth assistant → Permissions.")).toBeTruthy();
    // Only what is still allowed is offered: the whole Private Space, but no page list and no workspace pages.
    expect(within(bubble()).getByRole("checkbox", { name: /whole Private Space/i })).toBeTruthy();
    expect(within(bubble()).queryByRole("checkbox", { name: "Plan" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Workspace pages (read-only)" })).toBeNull();
    await writeAndStart(app, "Anything.");
    expect(within(bubble()).getByRole("alert").textContent).toContain("Pick at least one page or folder");
    expect(await readdir(join(data, "agent-runs")).catch(() => [])).toEqual([]);
  });

  it("quotes the text selected in the editor after the task", async () => {
    const app = await openApp(root, {}, createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } }));
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    const box = await editorBox();
    const heading = box.querySelector("h1")!;
    const range = document.createRange();
    range.selectNodeContents(heading);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    await app.user.keyboard("{Meta>}j{/Meta}");
    const dialog = await screen.findByRole("dialog", { name: "Ask Thoth" });
    expect(within(dialog).getByRole("list", { name: "Context" }).textContent).toContain("Selected text (1 word)");
    await ready();
    await writeAndStart(app, "Explain it.\n@sleep 300");
    // The CLI gets the quote; the run record in the Private Space keeps only the task (no page text in records).
    expect((await fakeRecord(await workDir())).stdin).toContain('Explain it.\n@sleep 300\n\nSelected text (from Diary.md):\n"""\nDiary\n"""');
    await within(bubble()).findByText("No pages were changed.", undefined, { timeout: 15_000 });
    expect((await savedRecords())[0]!["task"]["prompt"]).toBe("Explain it.\n@sleep 300");
  });

  it("gives selected text the rules of its page: Permissions, and a workspace's export rule", () => {
    const workspaces: Record<string, { role: string; exportRestricted: boolean }> = { open: { role: "editor", exportRestricted: false }, closed: { role: "editor", exportRestricted: true }, guest: { role: "none", exportRestricted: false } };
    const servers = { workspace: (_server: string, id: string) => workspaces[id] } as unknown as ServerDirectory;
    const from = (workspace: string): Excerpt => ({ text: "Roadmap", from: null, source: "workspace", server: "s", workspace });
    const on = DEFAULT_AGENT_SETTINGS;
    expect(excerptAllowed(from("open"), on, servers)).toBe(true);
    expect(excerptAllowed(from("closed"), on, servers)).toBe(false); // an exportRestricted workspace refuses it, as it refuses the page
    expect(excerptAllowed(from("guest"), on, servers)).toBe(false);
    expect(excerptAllowed(from("gone"), on, servers)).toBe(false);
    expect(excerptAllowed(from("open"), { ...on, allowWorkspace: false }, servers)).toBe(false);
    expect(excerptAllowed(from("open"), on, undefined)).toBe(false);
    const page: Excerpt = { text: "Diary", from: "Diary.md", source: "private" };
    expect(excerptAllowed(page, on, servers)).toBe(true);
    expect(excerptAllowed(page, { ...on, allowPrivate: false }, servers)).toBe(false);
  });

  it("does not offer selected text from a kind of page Permissions switch off", async () => {
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ allowPrivate: false }));
    const app = await openApp(root, {}, createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } }));
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    const range = document.createRange();
    range.selectNodeContents((await editorBox()).querySelector("h1")!);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    await app.user.keyboard("{Meta>}j{/Meta}");
    const dialog = await screen.findByRole("dialog", { name: "Ask Thoth" });
    expect(within(dialog).getByRole("list", { name: "Context" }).textContent).not.toContain("Selected text");
  });
});

describe("the assistant's runs: limits and settings", () => {
  const select = (name: string, scope: HTMLElement = document.body) => within(scope).getByRole("combobox", { name }) as HTMLSelectElement;
  const argvOf = async () => (await fakeRecord(await workDir())).argv;
  const budgetArg = (argv: string[]) => (argv.includes("--max-budget-usd") ? argv[argv.indexOf("--max-budget-usd") + 1] : null);
  async function options(app: Harness): Promise<HTMLElement> {
    const details = within(bubble()).getByText("Options").closest("details")!;
    if (!details.open) await app.user.click(within(bubble()).getByText("Options"));
    return details;
  }

  it("starts with the settings' limits (30 minutes, US$1), and each run can override them in the bubble's options", async () => {
    const app = await open();
    await ready();
    const form = await options(app);
    expect(select("Time limit", form).selectedOptions[0]!.textContent).toBe("Default (30 minutes)");
    expect(select("Spending limit", form).selectedOptions[0]!.textContent).toBe("Default (US$1)");
    expect([...select("Time limit", form).options].map((o) => o.textContent)).toEqual(["Default (30 minutes)", "5 minutes", "15 minutes", "30 minutes", "60 minutes"]);
    expect([...select("Spending limit", form).options].map((o) => o.textContent)).toEqual(["Default (US$1)", "US$0.25", "US$0.50", "US$1", "US$2", "US$5", "No limit"]);

    await pickOnly(app, ["Diary"]);
    await writeAndStart(app, "@sleep 300\n");
    expect(budgetArg(await argvOf())).toBe("1");
    await within(bubble()).findByText("No pages were changed.", undefined, { timeout: 15_000 });
    expect(mascotState()).toBe("done");
    expect((await savedRecords())[0]).toMatchObject({ task: { maxBudgetUsd: 1, timeoutMs: 30 * 60_000 } });

    // This run only: 5 minutes and US$0.25.
    await app.user.click(within(bubble()).getByRole("button", { name: "New task" }));
    await app.user.selectOptions(select("Time limit", await options(app)), "5");
    await app.user.selectOptions(select("Spending limit", await options(app)), "0.25");
    await writeAndStart(app, "@sleep 300\n");
    await waitFor(async () => expect(await readdir(join(data, "agent-runs"))).toHaveLength(1));
    expect(budgetArg(await argvOf())).toBe("0.25");
    await within(bubble()).findByText("No pages were changed.", undefined, { timeout: 15_000 });
    expect((await savedRecords())[1]).toMatchObject({ task: { maxBudgetUsd: 0.25, timeoutMs: 5 * 60_000 } });

    // No limit: the flag is not passed at all.
    await app.user.click(within(bubble()).getByRole("button", { name: "New task" }));
    await app.user.selectOptions(select("Spending limit", await options(app)), "none");
    await writeAndStart(app, "@sleep 300\n");
    await waitFor(async () => expect(await readdir(join(data, "agent-runs"))).toHaveLength(1));
    expect(budgetArg(await argvOf())).toBeNull();
    await within(bubble()).findByText("No pages were changed.", undefined, { timeout: 15_000 });
    const last = (await savedRecords())[2]!;
    expect(last["task"]["maxBudgetUsd"]).toBeUndefined();
  });

  it("keeps the defaults in Settings → Thoth assistant, with the other preferences, and uses them for the next run", async () => {
    const app = await open();
    await openAssistantSettings(app);
    const limits = screen.getByRole("region", { name: "Permissions and limits" });
    const history = screen.getByRole("region", { name: "Run history" });
    expect([select("Time limit", limits).value, select("Spending limit", limits).value, select("Keep run history for", history).value]).toEqual(["30", "1", "30"]);
    expect([...select("Keep run history for", history).options].map((o) => o.textContent)).toEqual(["7 days", "30 days", "90 days", "For ever"]);
    expect(limits.textContent).toContain("Codex has no spending limit of its own");
    await app.user.selectOptions(select("Time limit", limits), "60");
    await app.user.selectOptions(select("Spending limit", limits), "none");
    await app.user.selectOptions(select("Keep run history for", history), "0");
    expect(JSON.parse(localStorage.getItem(AGENT_SETTINGS_KEY)!)).toEqual({ provider: "claude", timeMinutes: 60, budgetUsd: null, retentionDays: 0, allowPrivate: true, allowWholeSpace: true, allowWorkspace: true });
    await app.user.click(mascot());
    await screen.findByRole("dialog", { name: "Ask Thoth" });
    const form = await options(app);
    expect(select("Time limit", form).selectedOptions[0]!.textContent).toBe("Default (60 minutes)");
    expect(select("Spending limit", form).selectedOptions[0]!.textContent).toBe("Default (No limit)");

    await ready();
    await pickOnly(app, ["Diary"]);
    await writeAndStart(app, "@sleep 300\n");
    await waitFor(async () => expect(await readdir(join(data, "agent-runs"))).toHaveLength(1));
    expect(budgetArg(await argvOf())).toBeNull();
    await within(bubble()).findByText("No pages were changed.", undefined, { timeout: 15_000 });
    expect((await savedRecords())[0]!["task"]["timeoutMs"]).toBe(60 * 60_000);

    // A new window reads them back; anything that is not an offered choice falls back to the default.
    cleanup();
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ timeMinutes: 61, budgetUsd: 9, retentionDays: 0 }));
    const again = await open();
    await openAssistantSettings(again);
    expect([select("Time limit", screen.getByRole("region", { name: "Permissions and limits" })).value, select("Spending limit", screen.getByRole("region", { name: "Permissions and limits" })).value, select("Keep run history for", screen.getByRole("region", { name: "Run history" })).value]).toEqual(["30", "1", "0"]);
  });

  it("says when a run stopped at its spending limit, and the work done so far can still be reviewed", async () => {
    const app = await open();
    await startTask(app, ["Plan"], "@replace Notes/Plan.md :: cat => dog\n@budget\n");
    await within(bubble()).findByRole("button", { name: "Review the changes" }, { timeout: 15_000 });
    expect(within(bubble()).getByTestId("agent-stopped").textContent).toBe("Stopped at the spending limit (US$1). What the agent did before then can still be reviewed.");
    expect(within(bubble()).getByRole("log", { name: "What the agent is doing" }).textContent).toContain("The spending limit was reached.");
    const review = await openReview(app);
    expect(screen.getByTestId("agent-stopped").dataset["stopped"]).toBe("budget");
    expect(within(review).getByRole("checkbox", { name: "Apply the change to Notes/Plan.md" })).toBeTruthy();
    await app.user.click(within(review).getByRole("button", { name: "Discard all" }));
    await screen.findByRole("region", { name: "Result" });
    await openAssistantSettings(app);
    const history = screen.getByRole("region", { name: "Earlier runs" });
    await waitFor(() => expect(history.textContent).toContain("Stopped at the spending limit"));
    expect((await savedRecords())[0]).toMatchObject({ outcome: { stoppedBy: "budget", error: { code: "budget" } } });
  });

  it("shows a run that stopped at its time limit in the history, and counts it in Usage", async () => {
    const id = "01a00000-0000-7000-8000-000000000001";
    const when = Date.UTC(2026, 9, 24, 9, 30);
    await seed(root, {
      [`.thoth/agent/runs/${id}.json`]: JSON.stringify({
        version: 1,
        id,
        provider: { id: "claude", name: "Claude Code", version: "2.1.310" },
        task: { prompt: "Rewrite everything", timeoutMs: 300_000 },
        context: [],
        state: "failed",
        createdAt: when,
        updatedAt: when,
        outcome: { reason: "timeout", code: null, ok: false, costUsd: 0.4321, model: "claude-haiku-5-5", stoppedBy: "time", error: { code: "timeout", message: "timeout" } },
        changes: [],
      }),
    });
    const app = await openApp(root, { now: () => new Date(when + 3_600_000) }, createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } }));
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    await openAssistantSettings(app);
    const history = await screen.findByRole("region", { name: "Earlier runs" });
    const row = await within(history).findByRole("row", { name: /Rewrite everything/ });
    const cells = within(row).getAllByRole("cell").map((c) => c.textContent);
    expect(cells.slice(1, 6)).toEqual(["Rewrite everything", "Claude Code", "claude-haiku-5-5", "US$0.43", "Stopped at the time limit"]);
    expect(within(history).getAllByRole("columnheader").map((h) => h.textContent).slice(0, 6)).toEqual(["Date", "Task", "Agent", "Model", "Cost", "Outcome"]);
    // Nothing is saved for it locally, so there is nothing to open.
    expect(within(row).queryByRole("button")).toBeNull();
    const usage = screen.getByRole("region", { name: "Usage" });
    expect(within(usage).getByRole("img").getAttribute("aria-label")).toContain("1 run in all");
    const table = within(usage).getByRole("table");
    expect(within(table).getAllByRole("row").at(-1)!.textContent).toBe("Total1US$0.430–");
  });
});

describe("the assistant's runs: history", () => {
  it("opens an earlier run's transcript and diffs from the local details, and says they stay on this computer", async () => {
    const app = await open();
    await startTask(app, ["Plan"], "Make it a dog.\n@replace Notes/Plan.md :: cat => dog\n");
    const review = await openReview(app);
    await app.user.click(within(review).getByRole("button", { name: "Apply 1 change" }));
    await screen.findByRole("region", { name: "Result" });
    await openAssistantSettings(app);
    const history = screen.getByRole("region", { name: "Earlier runs" });
    const row = await within(history).findByRole("row", { name: /Make it a dog\./ });
    await waitFor(() => expect(within(row).getAllByRole("cell").map((c) => c.textContent).slice(1, 6)).toEqual(["Make it a dog.", "Claude Code", "claude-fake-1", "US$0.0012", "Applied"]));
    await app.user.click(await within(row).findByRole("button", { name: /Open transcript and changes/ }));
    const detail = await screen.findByRole("region", { name: "Saved details of this run" });
    await waitFor(() => expect(within(detail).queryByText("Loading…")).toBeNull());
    expect(detail.textContent).toContain("Kept on this computer only, never in your Private Space.");
    expect(within(detail).getByRole("log", { name: "What the agent did" }).textContent).toContain("Editing Notes/Plan.md");
    const diff = within(detail).getByRole("group", { name: "Changes to Notes/Plan.md" });
    // The original is shown against the proposal even though the vault page has changed since.
    expect([...diff.querySelectorAll("[data-kind=del]")].map((l) => l.textContent)).toEqual(["-We have a cat."]);
    expect([...diff.querySelectorAll("[data-kind=add]")].map((l) => l.textContent)).toEqual(["+We have a dog."]);
    expect(await app.read("Notes/Plan.md")).toBe("# Plan\n\nWe have a dog.\n");
    await app.user.click(within(detail).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "Saved details of this run" })).toBeNull();
  });

  it("brings back a review that was waiting when Thoth closed: the mascot asks for it, and it applies with compare-and-swap", async () => {
    let app = await open();
    await startTask(app, ["Notes (folder, 2 pages)"], "@replace Notes/Plan.md :: cat => dog\n@replace Notes/Ideas.md :: Ideas => Plans\n");
    await within(bubble()).findByRole("button", { name: "Review the changes" }, { timeout: 15_000 });
    // Thoth closes with the review still open: its working directory goes, its saved copy stays.
    cleanup();
    await waitFor(async () => expect(await readdir(join(data, "agent-runs"))).toEqual([]));
    await app.external("Notes/Ideas.md", "# Ideas\n\nChanged while Thoth was closed.\n");

    app = await openApp(root, {}, createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } }));
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    await waitFor(() => expect(mascotState()).toBe("review"));
    expect(mascot().getAttribute("aria-label")).toBe("Thoth assistant, changes ready for review");
    await openAssistantSettings(app);
    expect(await screen.findByTestId("agent-awaiting")).toHaveProperty("textContent", "1 run is waiting for your review. Open it under Earlier runs, or click the mascot.");
    const history = screen.getByRole("region", { name: "Earlier runs" });
    const row = await within(history).findByRole("row", { name: /replace Notes\/Plan\.md/ });
    expect(within(row).getAllByRole("cell")[5]!.textContent).toBe("Awaiting review");
    expect((await savedRecords())[0]).toMatchObject({ state: "review" });
    // A click on the mascot opens it (the history's button does the same).
    await app.user.click(mascot());

    const review = await screen.findByRole("region", { name: "Review the changes" });
    const plan = within(review).getByRole("group", { name: "Changes to Notes/Plan.md" });
    expect([...plan.querySelectorAll("[data-kind=add]")].map((l) => l.textContent)).toEqual(["+We have a dog."]);
    expect(screen.getByRole("log", { name: "What the agent is doing" })).toBeTruthy(); // the stored transcript comes back too
    const ideas = within(review).getByRole("checkbox", { name: "Apply the change to Notes/Ideas.md" }).closest("li")!;
    expect(ideas.textContent).toContain("This changed in your Private Space after the agent started.");
    // Nothing was written by reopening.
    expect(await app.read("Notes/Plan.md")).toBe(PLAN);
    await app.user.click(within(review).getByRole("button", { name: "Apply 2 changes" }));
    const results = await screen.findByRole("region", { name: "Result" });
    expect(await app.read("Notes/Plan.md")).toBe(PLAN.replace("cat", "dog"));
    expect(await app.read("Notes/Ideas.md")).toBe("# Ideas\n\nChanged while Thoth was closed.\n");
    expect(results.textContent).toContain("Notes/Ideas.mdNot applied: it changed in your Private Space since the run started. Your version was kept.");
    expect(results.textContent).toContain("Notes/Plan.mdApplied");
    await waitFor(async () => expect((await savedRecords())[0]).toMatchObject({ state: "applied" }));
  });

  it("marks a run 'stopped when Thoth closed' when its saved copy is gone", async () => {
    let app = await open();
    await startTask(app, ["Plan"], "@replace Notes/Plan.md :: cat => dog\n");
    await within(bubble()).findByRole("button", { name: "Review the changes" }, { timeout: 15_000 });
    cleanup();
    const [id] = (await savedRecords()).map((r) => r["id"] as string);
    await rm(join(data, "agent-history", id!), { recursive: true });
    app = await openApp(root, {}, createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } }));
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    await openAssistantSettings(app);
    const history = await screen.findByRole("region", { name: "Earlier runs" });
    await waitFor(() => expect(history.textContent).toContain("Stopped when Thoth closed"));
    expect(screen.queryByTestId("agent-awaiting")).toBeNull();
    expect(within(history).queryByRole("button", { name: /Review the changes/ })).toBeNull();
    expect(mascotState()).not.toBe("review");
  });

  it("'Delete history now' removes the saved transcripts and diffs after a confirmation, and keeps the list of runs", async () => {
    const app = await open();
    await startTask(app, ["Plan"], "Make it a dog.\n@replace Notes/Plan.md :: cat => dog\n");
    const review = await openReview(app);
    await app.user.click(within(review).getByRole("button", { name: "Apply 1 change" }));
    await screen.findByRole("region", { name: "Result" });
    await openAssistantSettings(app);
    const history = screen.getByRole("region", { name: "Earlier runs" });
    await within(history).findByRole("button", { name: /Open transcript and changes/ });
    const [{ id }] = (await savedRecords()) as [{ id: string }];
    expect(await readdir(join(data, "agent-history", id))).not.toEqual([]);

    const settings = screen.getByRole("region", { name: "Run history" });
    await app.user.click(within(settings).getByRole("button", { name: "Delete history now" }));
    // Asked first; keeping is the way out.
    await app.user.click(within(settings).getByRole("button", { name: "Keep" }));
    expect(await readdir(join(data, "agent-history", id))).not.toEqual([]);
    await app.user.click(within(settings).getByRole("button", { name: "Delete history now" }));
    await app.user.click(within(settings).getByRole("button", { name: "Delete" }));
    expect((await screen.findByTestId("agent-cleared")).textContent).toBe("Deleted the saved details of 1 run.");
    await waitFor(() => expect(within(history).queryByRole("button", { name: /Open transcript and changes/ })).toBeNull());
    await expect(readdir(join(data, "agent-history", id))).rejects.toThrow();
    expect(history.textContent).toContain("Make it a dog.");
    expect(await savedRecords()).toHaveLength(1);
  });
});

describe("the assistant's runs: Thai", () => {
  it("speaks Thai in the context, limit, history and settings strings", async () => {
    setLangPreference("th");
    const { servers } = teamServers();
    const app = await openApp(root, {}, createNodePlatform({ vault: root, servers, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } }));
    await screen.findByRole("tree", { name: "หน้าใน Private Space นี้" });
    await app.user.click(screen.getByRole("button", { name: /^ผู้ช่วย Thoth, / }));
    const dialog = await screen.findByRole("dialog", { name: "ถาม Thoth" });
    await app.user.click(within(dialog).getByRole("button", { name: "เพิ่มบริบท" }));
    expect(screen.getByRole("checkbox", { name: "ทั้ง Private Space" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "หน้าจากเวิร์กสเปซ (อ่านอย่างเดียว)" })).toBeTruthy();
    await app.user.click(within(dialog).getByText("ตัวเลือก"));
    expect(within(dialog).getByRole("combobox", { name: "เวลาสูงสุด" })).toBeTruthy();
    expect(within(dialog).getByRole("combobox", { name: "วงเงินค่าใช้จ่าย" })).toHaveProperty("value", "default");
    await openAssistantSettings(app, "การตั้งค่า");
    const history = screen.getByRole("region", { name: "ประวัติการทำงาน" });
    expect(within(history).getByRole("combobox", { name: "เก็บประวัติการทำงานไว้" })).toBeTruthy();
    expect(within(history).getByRole("button", { name: "ลบประวัติตอนนี้" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "งานก่อนหน้า" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "สิทธิ์และขีดจำกัด" })).toBeTruthy();
  });
});

describe("the assistant's runs: Codex", () => {
  const codexArgv = async () => (JSON.parse(await readFile(join(FAKE_CODEX_DIR, "../fixtures/argv.json"), "utf8")) as { cases: { argv: string[] }[] }).cases[0]!.argv;

  it("offers Claude Code and Codex with each one's state, and runs Codex in its sandbox without a spending limit", async () => {
    const app = await open([FAKE_CODEX_DIR, FAKE_CLAUDE_DIR]);
    await waitFor(() => expect(optionOf("codex").textContent).toBe("Codex · Ready, 0.164.0"));
    expect(optionOf("claude").textContent).toBe("Claude Code · Ready, 2.1.310");
    expect(agentSelect().value).toBe("claude");
    await app.user.selectOptions(agentSelect(), "codex");
    expect(within(bubble()).getByText(/Thoth runs it only inside Codex's own sandbox/)).toBeTruthy();
    // No spending limit is offered for Codex, and none is passed.
    await app.user.click(within(bubble()).getByText("Options"));
    const budget = within(bubble()).getByRole("combobox", { name: "Spending limit" }) as HTMLSelectElement;
    expect(budget.disabled).toBe(true);
    expect(budget.textContent).toBe("Not supported by Codex");
    expect(within(bubble()).getByText("Codex has no spending limit of its own, so none is set. The time limit still applies.")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(AGENT_SETTINGS_KEY)!).provider).toBe("codex");

    await pickOnly(app, ["Plan"]);
    await writeAndStart(app, "@run ls\n@replace Notes/Plan.md :: cat => dog\n@write Notes/Summary.md :: # Summary\\n");
    await within(bubble()).findByRole("button", { name: "Review the changes" }, { timeout: 15_000 });
    const log = within(bubble()).getByRole("log", { name: "What the agent is doing" });
    expect(log.textContent).toContain("Started with Codex. Its commands and edits run in Codex's sandbox: this folder only, no network.");
    expect(log.textContent).toContain("Running ls");
    expect(log.textContent).toContain("Editing Notes/Plan.md");
    expect(log.textContent).toContain("Tokens: 1,200 in (1,000 cached), 34 out");
    expect((await fakeRecord(await workDir(), 20_000, "codex")).argv).toEqual(await codexArgv());

    const review = await openReview(app);
    await app.user.click(within(review).getByRole("checkbox", { name: "Apply the change to Notes/Summary.md" }));
    await app.user.click(within(review).getByRole("button", { name: "Apply 1 change" }));
    await screen.findByRole("region", { name: "Result" });
    expect(await app.read("Notes/Plan.md")).toBe("# Plan\n\nWe have a dog.\n");
    await expect(stat(join(root, "Notes/Summary.md"))).rejects.toThrow();
    await openAssistantSettings(app);
    expect(status("codex").textContent).toBe("Codex 0.164.0 is ready, with its sandbox. It uses your own Codex login; Thoth never sees it.");
    expect(within(screen.getByRole("region", { name: "Codex" })).getByRole("list", { name: "Details" }).textContent).toBe("Version 0.164.0Signed inSandbox works");
    const history = screen.getByRole("region", { name: "Earlier runs" });
    const row = await within(history).findByRole("row", { name: /@run ls/ });
    await waitFor(() => expect(within(row).getAllByRole("cell").map((c) => c.textContent).slice(2, 6)).toEqual(["Codex", "Default", "1,234 tokens", "Applied"]));
    // The picked agent is the remembered default next time.
    cleanup();
    await open([FAKE_CODEX_DIR, FAKE_CLAUDE_DIR]);
    expect(agentSelect().value).toBe("codex");
  });

  it("will not run Codex where its sandbox does not start, and says how to fix it", async () => {
    process.env["FAKE_CODEX_NO_SANDBOX"] = "1";
    try {
      localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ provider: "codex" }));
      const app = await open([FAKE_CODEX_DIR, FAKE_CLAUDE_DIR]);
      await waitFor(() => expect(optionOf("codex").dataset["state"]).toBe("sandbox_unavailable"));
      expect(optionOf("codex").textContent).toBe("Codex · No sandbox here");
      expect(within(bubble()).getByRole("button", { name: "Start" })).toHaveProperty("disabled", true);
      // Claude Code is still there to pick.
      expect(optionOf("claude").textContent).toBe("Claude Code · Ready, 2.1.310");
      await openAssistantSettings(app);
      await waitFor(() => expect(status("codex").dataset["state"]).toBe("sandbox_unavailable"));
      expect(status("codex").textContent).toBe("Codex's sandbox does not work on this computer, so Thoth will not run Codex: without it, the commands Codex runs would have all your permissions. Codex said: Error: the sandbox could not be started (fake)");
      expect(screen.getByRole("region", { name: "Codex" }).textContent).toContain("install bubblewrap");
      expect(screen.getByRole("region", { name: "Codex" }).textContent).toContain("No sandbox");
    } finally {
      delete process.env["FAKE_CODEX_NO_SANDBOX"];
    }
  });

  it("speaks Thai for Codex too", async () => {
    setLangPreference("th");
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ provider: "codex" }));
    const app = await openApp(root, {}, createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CODEX_DIR] } }));
    await screen.findByRole("tree", { name: "หน้าใน Private Space นี้" });
    await app.user.click(screen.getByRole("button", { name: /^ผู้ช่วย Thoth, / }));
    const dialog = await screen.findByRole("dialog", { name: "ถาม Thoth" });
    const pick = within(dialog).getByRole("combobox", { name: "เอเจนต์" }) as HTMLSelectElement;
    await waitFor(() => expect(pick.querySelector<HTMLOptionElement>('option[value="codex"]')!.dataset["state"]).toBe("ready"));
    await app.user.click(within(dialog).getByText("ตัวเลือก"));
    expect(within(dialog).getByTestId("agent-budget-unsupported").textContent).toBe("Codex ไม่รองรับ");
    await openAssistantSettings(app, "การตั้งค่า");
    await waitFor(() => expect(status("codex").textContent).toContain("Codex 0.164.0 พร้อมใช้งาน"));
  });
});
