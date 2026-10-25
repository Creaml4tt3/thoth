// @vitest-environment jsdom
/**
 * The Agent Hub UI (Phase 4) on the Node test host with the fake Claude Code and Codex CLIs: the agent picker,
 * detection with fix instructions (including Codex's sandbox check), Codex without a spending limit,
 * picking pages, start, the streamed transcript, review with per-file approval, apply (exact bytes on disk), the
 * conflict path with a kept copy, cancel, and the sidebar's "Ask an agent…". Never a real model.
 */
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";
import { FAKE_CLAUDE_DIR, FAKE_CODEX_DIR, fakeRecord } from "../../../tests/helpers/agent.ts";
import { FakeServers, type FakeWorkspace } from "../../../tests/helpers/fake-servers.ts";
import { AGENT_SETTINGS_KEY } from "../src/features/agents/settings.ts";
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

async function open(searchDirs = [FAKE_CLAUDE_DIR], servers?: FakeServers): Promise<Harness> {
  const app = await openApp(root, {}, createNodePlatform({ vault: root, ...(servers ? { servers } : {}), agents: { dataDir: data, searchDirs } }));
  await screen.findByRole("tree", { name: "Pages in this Private Space" });
  await app.user.click(screen.getByRole("button", { name: "Agent Hub" }));
  await screen.findByRole("heading", { level: 1, name: "Agent Hub" });
  return app;
}

const status = () => screen.getByTestId("agent-status");

/** Types the task (userEvent types "{" as a key descriptor; directives have none, but paste keeps the text exact) and starts. */
async function writeAndStart(app: Harness, prompt: string) {
  await app.user.click(screen.getByRole("textbox", { name: "Task" }));
  await app.user.paste(prompt);
  await app.user.click(screen.getByRole("button", { name: "Start" }));
}

async function startTask(app: Harness, pages: string[], prompt: string) {
  await waitFor(() => expect(status().dataset["state"]).toBe("ready"));
  const picker = screen.getByRole("group", { name: "Pages for the agent" });
  for (const name of pages) await app.user.click(await within(picker).findByRole("checkbox", { name }));
  await writeAndStart(app, prompt);
}

/** The run's working directory, once the host has made it. */
async function workDir(): Promise<string> {
  let runs: string[] = [];
  await waitFor(async () => {
    runs = await readdir(join(data, "agent-runs")).catch(() => []);
    expect(runs.length).toBe(1);
  });
  return join(data, "agent-runs", runs[0]!, "work");
}

describe("Agent Hub", () => {
  it("says the CLI is missing, where it looked and how to fix it", async () => {
    const app = await open([join(data, "empty")]);
    await waitFor(() => expect(status().dataset["state"]).toBe("missing"));
    expect(status().textContent).toBe("Claude Code is not installed, or Thoth cannot find it.");
    const section = screen.getByRole("region", { name: "Claude Code" });
    expect(section.textContent).toContain(join(data, "empty"));
    expect(section.textContent).toContain("brew install --cask claude-code");
    expect(screen.getByRole("button", { name: "Start" })).toHaveProperty("disabled", true);
    await app.user.click(within(section).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(status().dataset["state"]).toBe("missing"));
    expect(screen.getByRole("note").textContent).toBe("The agent runs with your user permissions. Thoth limits what it is given, not what it can do.");
  });

  it("runs a task on the picked page, streams it, and applies only the approved change, byte for byte", async () => {
    const app = await open();
    expect(status().textContent).toBe("Claude Code 2.1.310 is ready. It uses your own Claude login; Thoth never sees it.");
    await startTask(app, ["Plan"], "Make it a dog.\n@replace Notes/Plan.md :: cat => dog\n@write Notes/Summary.md :: # Summary\\n");

    const review = await screen.findByRole("region", { name: "Review the changes" }, { timeout: 15_000 });
    const log = screen.getByRole("log", { name: "What the agent is doing" });
    expect(log.textContent).toContain("Editing Notes/Plan.md");
    expect(log.textContent).toContain("Writing Notes/Summary.md");
    expect(log.textContent).toContain("Done.");
    expect(log.textContent).toContain("Estimated cost: US$0.0012");

    // The working directory held only the picked page.
    expect((await fakeRecord(await workDir())).files).toEqual([
      { path: "Notes", kind: "directory" },
      { path: "Notes/Plan.md", kind: "file" },
    ]);

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
    await waitFor(async () => expect(await readdir(join(data, "agent-runs"))).toEqual([]));

    const history = screen.getByRole("region", { name: "Earlier runs" });
    await waitFor(() => expect(history.textContent).toContain("Applied"));
    expect(history.textContent).toContain("Make it a dog.");
    await app.user.click(within(results).getByRole("button", { name: "Open Notes/Plan.md" }));
    await screen.findByRole("textbox", { name: /page content/i });
  });

  it("discard writes nothing, and nothing can be applied without a choice", async () => {
    const app = await open();
    await startTask(app, ["Plan"], "@replace Notes/Plan.md :: cat => fox\n");
    const review = await screen.findByRole("region", { name: "Review the changes" }, { timeout: 15_000 });
    await app.user.click(within(review).getByRole("checkbox", { name: "Apply the change to Notes/Plan.md" }));
    expect(within(review).getByRole("button", { name: "Apply 0 changes" })).toHaveProperty("disabled", true);
    await app.user.click(within(review).getByRole("button", { name: "Discard all" }));
    expect((await screen.findByRole("region", { name: "Result" })).textContent).toContain("All changes were discarded. Nothing was written.");
    expect(await app.read("Notes/Plan.md")).toBe(PLAN);
  });

  it("a page edited meanwhile is a conflict, never overwritten; the agent's version can be kept as a copy", async () => {
    const app = await open();
    await startTask(app, ["Notes (folder, 2 pages)"], "@sleep 300\n@replace Notes/Plan.md :: cat => dog\n");
    await fakeRecord(await workDir());
    await app.external("Notes/Plan.md", "# Plan\n\nMine now.\n");
    const review = await screen.findByRole("region", { name: "Review the changes" }, { timeout: 15_000 });
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

  it("cancel stops the run and changes nothing", async () => {
    const app = await open();
    await startTask(app, ["Plan"], "@replace Notes/Plan.md :: cat => dog\n@hang\n");
    const cancel = await screen.findByRole("button", { name: "Cancel" }, { timeout: 15_000 });
    await waitFor(async () => expect((await fakeRecord(await workDir())).grandchild).not.toBeNull());
    await app.user.click(cancel);
    expect((await screen.findByText("Cancelled. Nothing in your Private Space was changed.", undefined, { timeout: 15_000 })).className).toBe("alert");
    expect(await app.read("Notes/Plan.md")).toBe(PLAN);
    await waitFor(async () => expect(await readdir(join(data, "agent-runs"))).toEqual([]));
    await app.user.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByRole("group", { name: "Pages for the agent" }).textContent).toContain("1 selected");
  });

  it("explains a CLI that is not signed in when the run says so", async () => {
    const app = await open();
    await startTask(app, ["Plan"], "@not-logged-in\n");
    expect((await screen.findByText(/stopped with an error/, undefined, { timeout: 15_000 })).parentElement!.textContent).toContain("Claude Code is not signed in. Run claude in a terminal and sign in, then try again.");
  });

  it("takes the pages picked in the sidebar ('Ask an agent…')", async () => {
    const app = await openApp(root, {}, createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } }));
    const tree = await screen.findByRole("tree", { name: "Pages in this Private Space" });
    await app.user.click(screen.getByRole("button", { name: "Select pages" }));
    for (const box of within(tree).getAllByRole("checkbox")) if ((box as HTMLInputElement).checked) await app.user.click(box);
    await app.user.click(within(tree).getByRole("checkbox", { name: "Select Diary" }));
    await app.user.click(screen.getByRole("button", { name: "Ask an agent…" }));
    const picker = await screen.findByRole("group", { name: "Pages for the agent" });
    expect(((await within(picker).findByRole("checkbox", { name: "Diary" })) as HTMLInputElement).checked).toBe(true);
    expect(picker.textContent).toContain("1 selected");
  });

  it("is not offered where the host cannot run agents", async () => {
    await openApp(root);
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    expect(screen.queryByRole("button", { name: "Agent Hub" })).toBeNull();
  });

  it("speaks Thai", async () => {
    setLangPreference("th");
    const app = await openApp(root, {}, createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } }));
    await screen.findByRole("tree", { name: "หน้าใน Private Space นี้" });
    await app.user.click(screen.getByRole("button", { name: "Agent Hub" }));
    await waitFor(() => expect(status().dataset["state"]).toBe("ready"));
    expect(screen.getByRole("note").textContent).toBe("เอเจนต์ทำงานด้วยสิทธิ์ผู้ใช้ของคุณ Thoth จำกัดสิ่งที่ส่งให้เอเจนต์ ไม่ได้จำกัดสิ่งที่เอเจนต์ทำได้");
    expect(screen.getByRole("button", { name: "เริ่ม" })).toBeTruthy();
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

describe("Agent Hub: context", () => {
  it("can give the whole Private Space: the total is shown first, and every change still goes through review", async () => {
    const app = await open();
    await waitFor(() => expect(status().dataset["state"]).toBe("ready"));
    const picker = screen.getByRole("group", { name: "Pages for the agent" });
    await app.user.click(within(picker).getByRole("checkbox", { name: "Whole Private Space" }));
    const size = Buffer.byteLength(PLAN) + Buffer.byteLength("# Ideas\n") + Buffer.byteLength("# Diary\n");
    await waitFor(() => expect(screen.getByTestId("agent-total").textContent).toBe(`3 files, ${size} B, will be copied for the agent`));
    expect(picker.textContent).toContain("The whole Private Space is included.");
    // Everything is shown as included, and nothing can be unpicked one by one.
    for (const name of ["Plan", "Ideas", "Diary"]) {
      const box = within(picker).getByRole("checkbox", { name }) as HTMLInputElement;
      expect([box.checked, box.disabled]).toEqual([true, true]);
    }
    await writeAndStart(app, "Rename it.\n@replace Diary.md :: Diary => Journal\n@write Brand-new.md :: # New\\n");
    const review = await screen.findByRole("region", { name: "Review the changes" }, { timeout: 15_000 });
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
    await waitFor(() => expect(status().dataset["state"]).toBe("ready"));
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
    await app.user.click(within(group).getByRole("button", { name: "Remove Spec" }));
    expect(group.textContent).not.toContain("1 workspace page added");
  });

  it("gives a workspace page read-only: an edit to it is shown as discarded, never offered, never written anywhere", async () => {
    const { servers, open: team } = teamServers();
    const app = await open([FAKE_CLAUDE_DIR], servers);
    await waitFor(() => expect(status().dataset["state"]).toBe("ready"));
    const group = await screen.findByRole("group", { name: "Workspace pages (read-only)" });
    await app.user.click(await within(group).findByText("Team Docs"));
    await app.user.click(await within(group).findByRole("checkbox", { name: "Spec" }));
    await app.user.click(within(screen.getByRole("group", { name: "Pages for the agent" })).getByRole("checkbox", { name: "Plan" }));
    await writeAndStart(app, ["@unlock workspace/Team Docs/Spec.md", "@replace workspace/Team Docs/Spec.md :: May => June", "@write workspace/Team Docs/New.md :: # New\\n", "@replace Notes/Plan.md :: cat => dog"].join("\n"));

    const review = await screen.findByRole("region", { name: "Review the changes" }, { timeout: 15_000 });
    const spec = within(review).getByRole("checkbox", { name: "Apply the change to workspace/Team Docs/Spec.md" }) as HTMLInputElement;
    expect([spec.checked, spec.disabled]).toEqual([false, true]);
    const row = spec.closest("li")!;
    expect(row.dataset["problem"]).toBe("read_only");
    expect(row.textContent).toContain("Read-only workspace page: change discarded");
    expect(within(review).getByRole("checkbox", { name: "Apply the change to workspace/Team Docs/New.md" })).toHaveProperty("disabled", true);
    expect(within(review).getByRole("checkbox", { name: "Apply the change to Notes/Plan.md" })).toHaveProperty("checked", true);
    expect(within(review).getByRole("button", { name: "Apply 1 change" })).toBeTruthy();

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
    await waitFor(() => expect(status().dataset["state"]).toBe("ready"));
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
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
  });
});

describe("Agent Hub: limits and settings", () => {
  const select = (name: string, scope: HTMLElement = document.body) => within(scope).getByRole("combobox", { name }) as HTMLSelectElement;
  const newForm = () => screen.getByRole("region", { name: "New task" });
  const argvOf = async () => (await fakeRecord(await workDir())).argv;
  const budgetArg = (argv: string[]) => (argv.includes("--max-budget-usd") ? argv[argv.indexOf("--max-budget-usd") + 1] : null);

  it("starts with the settings' limits (30 minutes, US$1), and each run can override them in the form", async () => {
    const app = await open();
    await waitFor(() => expect(status().dataset["state"]).toBe("ready"));
    const form = screen.getByRole("region", { name: "New task" });
    expect(select("Time limit", form).selectedOptions[0]!.textContent).toBe("Default (30 minutes)");
    expect(select("Spending limit", form).selectedOptions[0]!.textContent).toBe("Default (US$1)");
    expect([...select("Time limit", form).options].map((o) => o.textContent)).toEqual(["Default (30 minutes)", "5 minutes", "15 minutes", "30 minutes", "60 minutes"]);
    expect([...select("Spending limit", form).options].map((o) => o.textContent)).toEqual(["Default (US$1)", "US$0.25", "US$0.50", "US$1", "US$2", "US$5", "No limit"]);

    await app.user.click(within(screen.getByRole("group", { name: "Pages for the agent" })).getByRole("checkbox", { name: "Diary" }));
    await writeAndStart(app, "@sleep 300\n");
    expect(budgetArg(await argvOf())).toBe("1");
    await screen.findByText("The agent finished without changing anything.", undefined, { timeout: 15_000 });
    expect((await savedRecords())[0]).toMatchObject({ task: { maxBudgetUsd: 1, timeoutMs: 30 * 60_000 } });

    // This run only: 5 minutes and US$0.25.
    await app.user.click(screen.getByRole("button", { name: "New task" }));
    await app.user.selectOptions(select("Time limit", newForm()), "5");
    await app.user.selectOptions(select("Spending limit", newForm()), "0.25");
    await writeAndStart(app, "@sleep 300\n");
    await waitFor(async () => expect(await readdir(join(data, "agent-runs"))).toHaveLength(1));
    expect(budgetArg(await argvOf())).toBe("0.25");
    await screen.findByText("The agent finished without changing anything.", undefined, { timeout: 15_000 });
    expect((await savedRecords())[1]).toMatchObject({ task: { maxBudgetUsd: 0.25, timeoutMs: 5 * 60_000 } });

    // No limit: the flag is not passed at all.
    await app.user.click(screen.getByRole("button", { name: "New task" }));
    await app.user.selectOptions(select("Spending limit", newForm()), "none");
    await writeAndStart(app, "@sleep 300\n");
    await waitFor(async () => expect(await readdir(join(data, "agent-runs"))).toHaveLength(1));
    expect(budgetArg(await argvOf())).toBeNull();
    await screen.findByText("The agent finished without changing anything.", undefined, { timeout: 15_000 });
    const last = (await savedRecords())[2]!;
    expect(last["task"]["maxBudgetUsd"]).toBeUndefined();
  });

  it("keeps the defaults in the Agent Hub settings, in the same place as other preferences, and uses them for the next run", async () => {
    const app = await open();
    const settings = await screen.findByRole("region", { name: "Agent Hub settings" });
    expect([select("Time limit", settings).value, select("Spending limit", settings).value, select("Keep run history for", settings).value]).toEqual(["30", "1", "30"]);
    expect([...select("Keep run history for", settings).options].map((o) => o.textContent)).toEqual(["7 days", "30 days", "90 days", "For ever"]);
    await app.user.selectOptions(select("Time limit", settings), "60");
    await app.user.selectOptions(select("Spending limit", settings), "none");
    await app.user.selectOptions(select("Keep run history for", settings), "0");
    expect(JSON.parse(localStorage.getItem(AGENT_SETTINGS_KEY)!)).toEqual({ provider: "claude", timeMinutes: 60, budgetUsd: null, retentionDays: 0 });
    const form = screen.getByRole("region", { name: "New task" });
    expect(select("Time limit", form).selectedOptions[0]!.textContent).toBe("Default (60 minutes)");
    expect(select("Spending limit", form).selectedOptions[0]!.textContent).toBe("Default (No limit)");

    await app.user.click(within(screen.getByRole("group", { name: "Pages for the agent" })).getByRole("checkbox", { name: "Diary" }));
    await waitFor(() => expect(status().dataset["state"]).toBe("ready"));
    await writeAndStart(app, "@sleep 300\n");
    await waitFor(async () => expect(await readdir(join(data, "agent-runs"))).toHaveLength(1));
    expect(budgetArg(await argvOf())).toBeNull();
    await screen.findByText("The agent finished without changing anything.", undefined, { timeout: 15_000 });
    expect((await savedRecords())[0]!["task"]["timeoutMs"]).toBe(60 * 60_000);

    // A new window reads them back; anything that is not an offered choice falls back to the default.
    cleanup();
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ timeMinutes: 61, budgetUsd: 9, retentionDays: 0 }));
    await open();
    const again = await screen.findByRole("region", { name: "Agent Hub settings" });
    expect([select("Time limit", again).value, select("Spending limit", again).value, select("Keep run history for", again).value]).toEqual(["30", "1", "0"]);
  });

  it("says when a run stopped at its spending limit, and the work done so far can still be reviewed", async () => {
    const app = await open();
    await startTask(app, ["Plan"], "@replace Notes/Plan.md :: cat => dog\n@budget\n");
    const review = await screen.findByRole("region", { name: "Review the changes" }, { timeout: 15_000 });
    const stopped = screen.getByTestId("agent-stopped");
    expect(stopped.dataset["stopped"]).toBe("budget");
    expect(stopped.textContent).toBe("Stopped at the spending limit (US$1). What the agent did before then can still be reviewed.");
    expect(screen.getByRole("log", { name: "What the agent is doing" }).textContent).toContain("The spending limit was reached.");
    expect(within(review).getByRole("checkbox", { name: "Apply the change to Notes/Plan.md" })).toBeTruthy();
    await app.user.click(within(review).getByRole("button", { name: "Discard all" }));
    await screen.findByRole("region", { name: "Result" });
    const history = screen.getByRole("region", { name: "Earlier runs" });
    await waitFor(() => expect(history.textContent).toContain("Stopped at the spending limit"));
    expect((await savedRecords())[0]).toMatchObject({ outcome: { stoppedBy: "budget", error: { code: "budget" } } });
  });

  it("shows a run that stopped at its time limit in the history", async () => {
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
    await open();
    const history = await screen.findByRole("region", { name: "Earlier runs" });
    const row = await within(history).findByRole("row", { name: /Rewrite everything/ });
    const cells = within(row).getAllByRole("cell").map((c) => c.textContent);
    expect(cells.slice(1, 6)).toEqual(["Rewrite everything", "Claude Code", "claude-haiku-5-5", "US$0.43", "Stopped at the time limit"]);
    expect(within(history).getAllByRole("columnheader").map((h) => h.textContent).slice(0, 6)).toEqual(["Date", "Task", "Agent", "Model", "Cost", "Outcome"]);
    // Nothing is saved for it locally, so there is nothing to open.
    expect(within(row).queryByRole("button")).toBeNull();
  });
});

describe("Agent Hub: history", () => {
  it("opens an earlier run's transcript and diffs from the local details, and says they stay on this computer", async () => {
    const app = await open();
    await startTask(app, ["Plan"], "Make it a dog.\n@replace Notes/Plan.md :: cat => dog\n");
    const review = await screen.findByRole("region", { name: "Review the changes" }, { timeout: 15_000 });
    await app.user.click(within(review).getByRole("button", { name: "Apply 1 change" }));
    await screen.findByRole("region", { name: "Result" });
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

  it("brings back a review that was waiting when Thoth closed, applies it with compare-and-swap, and flags a page edited meanwhile", async () => {
    let app = await open();
    await startTask(app, ["Notes (folder, 2 pages)"], "@replace Notes/Plan.md :: cat => dog\n@replace Notes/Ideas.md :: Ideas => Plans\n");
    await screen.findByRole("region", { name: "Review the changes" }, { timeout: 15_000 });
    // Thoth closes with the review still open: its working directory goes, its saved copy stays.
    cleanup();
    await waitFor(async () => expect(await readdir(join(data, "agent-runs"))).toEqual([]));
    await app.external("Notes/Ideas.md", "# Ideas\n\nChanged while Thoth was closed.\n");

    app = await open();
    expect(await screen.findByTestId("agent-awaiting")).toHaveProperty("textContent", "1 run is waiting for your review. Open it under Earlier runs.");
    const history = screen.getByRole("region", { name: "Earlier runs" });
    const row = await within(history).findByRole("row", { name: /replace Notes\/Plan\.md/ });
    expect(within(row).getAllByRole("cell")[5]!.textContent).toBe("Awaiting review");
    expect((await savedRecords())[0]).toMatchObject({ state: "review" });
    await app.user.click(within(row).getByRole("button", { name: /Review the changes/ }));

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
    await screen.findByRole("region", { name: "Review the changes" }, { timeout: 15_000 });
    cleanup();
    const [id] = (await savedRecords()).map((r) => r["id"] as string);
    await rm(join(data, "agent-history", id!), { recursive: true });
    app = await open();
    const history = await screen.findByRole("region", { name: "Earlier runs" });
    await waitFor(() => expect(history.textContent).toContain("Stopped when Thoth closed"));
    expect(screen.queryByTestId("agent-awaiting")).toBeNull();
    expect(within(history).queryByRole("button", { name: /Review the changes/ })).toBeNull();
  });

  it("'Delete history now' removes the saved transcripts and diffs after a confirmation, and keeps the list of runs", async () => {
    const app = await open();
    await startTask(app, ["Plan"], "Make it a dog.\n@replace Notes/Plan.md :: cat => dog\n");
    const review = await screen.findByRole("region", { name: "Review the changes" }, { timeout: 15_000 });
    await app.user.click(within(review).getByRole("button", { name: "Apply 1 change" }));
    await screen.findByRole("region", { name: "Result" });
    const history = screen.getByRole("region", { name: "Earlier runs" });
    await within(history).findByRole("button", { name: /Open transcript and changes/ });
    const [{ id }] = (await savedRecords()) as [{ id: string }];
    expect(await readdir(join(data, "agent-history", id))).not.toEqual([]);

    const settings = screen.getByRole("region", { name: "Agent Hub settings" });
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

describe("Agent Hub: Thai", () => {
  it("speaks Thai in the new context, limit, history and settings strings", async () => {
    setLangPreference("th");
    const { servers } = teamServers();
    const app = await openApp(root, {}, createNodePlatform({ vault: root, servers, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } }));
    await screen.findByRole("tree", { name: "หน้าใน Private Space นี้" });
    await app.user.click(screen.getByRole("button", { name: "Agent Hub" }));
    await waitFor(() => expect(status().dataset["state"]).toBe("ready"));
    expect(screen.getByRole("checkbox", { name: "ทั้ง Private Space" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "หน้าจากเวิร์กสเปซ (อ่านอย่างเดียว)" })).toBeTruthy();
    const form = screen.getByRole("region", { name: "งานใหม่" });
    expect(within(form).getByRole("combobox", { name: "เวลาสูงสุด" })).toBeTruthy();
    expect(within(form).getByRole("combobox", { name: "วงเงินค่าใช้จ่าย" })).toHaveProperty("value", "default");
    const settings = screen.getByRole("region", { name: "การตั้งค่า Agent Hub" });
    expect(within(settings).getByRole("combobox", { name: "เก็บประวัติการทำงานไว้" })).toBeTruthy();
    expect(within(settings).getByRole("button", { name: "ลบประวัติตอนนี้" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "งานก่อนหน้า" })).toBeTruthy();
  });
});

describe("Agent Hub: Codex", () => {
  const codexArgv = async () => (JSON.parse(await readFile(join(FAKE_CODEX_DIR, "../fixtures/argv.json"), "utf8")) as { cases: { argv: string[] }[] }).cases[0]!.argv;

  it("offers Claude Code and Codex with each one's state, and runs Codex in its sandbox without a spending limit", async () => {
    const app = await open([FAKE_CODEX_DIR, FAKE_CLAUDE_DIR]);
    const agents = screen.getByRole("group", { name: "Agent" });
    await waitFor(() => expect(screen.getByTestId("agent-short-codex").textContent).toBe("Ready, 0.164.0"));
    expect(screen.getByTestId("agent-short-claude").textContent).toBe("Ready, 2.1.310");
    expect((within(agents).getByRole("radio", { name: "Claude Code" }) as HTMLInputElement).checked).toBe(true);
    await app.user.click(within(agents).getByRole("radio", { name: "Codex" }));
    expect(status().textContent).toBe("Codex 0.164.0 is ready, with its sandbox. It uses your own Codex login; Thoth never sees it.");
    expect(screen.getByRole("region", { name: "Codex" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("Thoth runs it only inside Codex's own sandbox");
    // No spending limit is offered for Codex, and none is passed.
    const budget = within(screen.getByRole("region", { name: "New task" })).getByRole("combobox", { name: "Spending limit" }) as HTMLSelectElement;
    expect(budget.disabled).toBe(true);
    expect(budget.textContent).toBe("Not supported by Codex");
    expect(screen.getByText("Codex has no spending limit of its own, so none is set. The time limit still applies.")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(AGENT_SETTINGS_KEY)!).provider).toBe("codex");

    await startTask(app, ["Plan"], "@run ls\n@replace Notes/Plan.md :: cat => dog\n@write Notes/Summary.md :: # Summary\\n");
    const review = await screen.findByRole("region", { name: "Review the changes" }, { timeout: 15_000 });
    const log = screen.getByRole("log", { name: "What the agent is doing" });
    expect(log.textContent).toContain("Started with Codex. Its commands and edits run in Codex's sandbox: this folder only, no network.");
    expect(log.textContent).toContain("Running ls");
    expect(log.textContent).toContain("Editing Notes/Plan.md");
    expect(log.textContent).toContain("Tokens: 1,200 in (1,000 cached), 34 out");
    expect((await fakeRecord(await workDir(), 20_000, "codex")).argv).toEqual(await codexArgv());

    await app.user.click(within(review).getByRole("checkbox", { name: "Apply the change to Notes/Summary.md" }));
    await app.user.click(within(review).getByRole("button", { name: "Apply 1 change" }));
    await screen.findByRole("region", { name: "Result" });
    expect(await app.read("Notes/Plan.md")).toBe("# Plan\n\nWe have a dog.\n");
    await expect(stat(join(root, "Notes/Summary.md"))).rejects.toThrow();
    const history = screen.getByRole("region", { name: "Earlier runs" });
    const row = await within(history).findByRole("row", { name: /@run ls/ });
    await waitFor(() => expect(within(row).getAllByRole("cell").map((c) => c.textContent).slice(2, 6)).toEqual(["Codex", "Default", "1,234 tokens", "Applied"]));
    // The picker is the remembered default next time.
    cleanup();
    await open([FAKE_CODEX_DIR, FAKE_CLAUDE_DIR]);
    expect((screen.getByRole("radio", { name: "Codex" }) as HTMLInputElement).checked).toBe(true);
  });

  it("will not run Codex where its sandbox does not start, and says how to fix it", async () => {
    process.env["FAKE_CODEX_NO_SANDBOX"] = "1";
    try {
      localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ provider: "codex" }));
      await open([FAKE_CODEX_DIR, FAKE_CLAUDE_DIR]);
      await waitFor(() => expect(status().dataset["state"]).toBe("sandbox_unavailable"));
      expect(status().textContent).toBe("Codex's sandbox does not work on this computer, so Thoth will not run Codex: without it, the commands Codex runs would have all your permissions. Codex said: Error: the sandbox could not be started (fake)");
      expect(screen.getByRole("region", { name: "Codex" }).textContent).toContain("install bubblewrap");
      expect(screen.getByTestId("agent-short-codex").textContent).toBe("No sandbox here");
      expect(screen.getByRole("button", { name: "Start" })).toHaveProperty("disabled", true);
      // Claude Code is still there to pick.
      expect(screen.getByTestId("agent-short-claude").textContent).toBe("Ready, 2.1.310");
    } finally {
      delete process.env["FAKE_CODEX_NO_SANDBOX"];
    }
  });

  it("speaks Thai for Codex too", async () => {
    setLangPreference("th");
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ provider: "codex" }));
    const app = await openApp(root, {}, createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CODEX_DIR] } }));
    await screen.findByRole("tree", { name: "หน้าใน Private Space นี้" });
    await app.user.click(screen.getByRole("button", { name: "Agent Hub" }));
    await waitFor(() => expect(status().dataset["state"]).toBe("ready"));
    expect(screen.getByRole("group", { name: "เอเจนต์" })).toBeTruthy();
    expect(status().textContent).toContain("Codex 0.164.0 พร้อมใช้งาน");
    expect(screen.getByTestId("agent-budget-unsupported").textContent).toBe("Codex ไม่รองรับ");
  });
});
