/**
 * Phase 4 acceptance (docs/architecture/implementation-plan.md): the real desktop UI in Chromium, on the real Rust
 * host (`thoth-host-stdio` through the dev bridge), with the FAKE Claude Code CLI (`--agent-search-dir`), so no
 * model is called. Runs are driven through the mascot's prompt bubble; the review is the review tab; the history and
 * settings are in Settings → Thoth assistant. Pick a page → start → streamed transcript → review → apply exact bytes
 * on disk; then cancel.
 * The fake records what it was given: only the picked page in its working directory, that directory as its cwd,
 * the policy's argument list, and no argument or environment variable naming the vault.
 *
 * The same with the FAKE Codex CLI, picked in the bubble: its argument list is exactly the policy's (Codex's own
 * sandbox with Thoth's permission profile, approvals that never prompt, no bypass, no web search, no spending limit),
 * cancel stops its whole process tree, and its edit to a read-only workspace page is discarded.
 *
 * Also: the whole Private Space as context; a workspace page (on the in-memory protocol test server, over real HTTP
 * through the host) as read-only context whose edit is discarded; a review that survives a real restart of the host
 * and the app and is then applied; and a run that used up its budget.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newStableId } from "@thoth/domain";
import { FAKE_CLAUDE_DIR, FAKE_CODEX_DIR, alive, fakeRecord, waitDead } from "../helpers/agent.ts";
import { EDITOR_TOKEN, LOCKED_WORKSPACE, MAIN_WORKSPACE, startTestServer, type TestServer } from "../protocol/test-server.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { buildAll } from "./setup.ts";
import { REPO } from "../ports/harness.ts";
import { axe, bubble, mascot, openAssistantSettings, openBubble, openReview, picker, pickOnly, writeAndStart } from "./assistant.ts";

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let data: string;
let bridge: Bridge;
const PLAN = "# Plan\n\nWe have a cat.\n";

test.beforeAll(async () => {
  built = await buildAll();
});

/** The bridge to the real Rust host; a second call (after the first bridge was closed) is a restart of the app's host. */
function bridgeOptions(): Parameters<typeof startBridge>[0] {
  return {
    dist: built.dist,
    bridgeDir: built.bridgeDir,
    host: {
      binary: built.binary,
      pickVault: vault,
      dataDir: data,
      agentSearchDirs: [FAKE_CLAUDE_DIR, FAKE_CODEX_DIR],
      // Neither may reach the CLI: Thoth's own variables, and anything naming the open vault.
      env: { THOTH_E2E_SECRET: "do-not-pass", NOTES_FOR_E2E: join(vault, "Notes") },
    },
  };
}

test.beforeEach(async ({ page, context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-agent-")));
  vault = join(scratch, "Vault");
  data = join(scratch, "data");
  await mkdir(join(vault, "Notes"), { recursive: true });
  await writeFile(join(vault, "Notes/Plan.md"), PLAN);
  await writeFile(join(vault, "Notes/Ideas.md"), "# Ideas\n");
  await writeFile(join(vault, "Diary.md"), "# Diary\n\nPrivate.\n");
  bridge = await startBridge(bridgeOptions());
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  await expect(page.getByRole("tree", { name: "Pages in this Private Space" })).toBeVisible();
});

test.afterEach(async ({ page, context }) => {
  for (const open of context.pages()) await open.close().catch(() => undefined);
  void page;
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

async function workDir(): Promise<string> {
  await expect.poll(async () => (await readdir(join(data, "agent-runs")).catch(() => [])).length).toBe(1);
  return join(data, "agent-runs", (await readdir(join(data, "agent-runs")))[0]!, "work");
}

async function startTask(page: Page, prompt: string, check = false) {
  const b = await openBubble(page);
  await expect(b.locator('option[value="claude"]')).toHaveText("Claude Code · Ready, 2.1.310");
  await pickOnly(page, ["Plan"]);
  await expect(await picker(page)).toContainText("1 selected");
  await b.getByRole("textbox", { name: "Task" }).fill(prompt);
  if (check) await axe(page, "#mascot-bubble");
  await b.getByRole("button", { name: "Start" }).click();
}

test("pick a page, start, stream, review, apply: exact bytes on disk, and only the picked page was given", async ({ page }) => {
  await startTask(page, "Make it a dog.\n@replace Notes/Plan.md :: cat => dog\n@write Notes/Summary.md :: # Summary\\n", true);
  const log = bubble(page).getByRole("log", { name: "What the agent is doing" });
  await expect(log).toContainText("Editing Notes/Plan.md");
  await expect(log).toContainText("Done.");
  await expect(mascot(page)).toHaveAccessibleName("Thoth assistant, changes ready for review", { timeout: 15_000 });
  await axe(page, "#mascot-bubble");
  const review = await openReview(page);

  // What the CLI was given and saw.
  const work = await workDir();
  const record = await fakeRecord(work);
  expect(record.files).toEqual([
    { path: "Notes", kind: "directory" },
    { path: "Notes/Plan.md", kind: "file" },
  ]);
  expect(record.cwd).toBe(work);
  // The policy's argument list, plus the Agent Hub's default spending limit (US$1).
  expect(record.argv).toEqual([...JSON.parse(await readFile(join(FAKE_CLAUDE_DIR, "../fixtures/argv.json"), "utf8")).cases[0].argv, "--max-budget-usd", "1"]);
  expect(record.stdin).toContain("Make it a dog.");
  expect(Object.entries(record.env).filter(([k, v]) => /^THOTH_/i.test(k) || v.includes(vault))).toEqual([]);
  expect(record.argv.some((a) => a.includes(vault))).toBe(false);

  // Nothing is written before Apply; the diff shows the edit.
  expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe(PLAN);
  await expect(review.getByRole("group", { name: "Changes to Notes/Plan.md" })).toContainText("We have a dog.");
  await axe(page, ".agents");

  // Approve only the edit (keyboard: Space on the checkbox), then apply.
  await review.getByRole("checkbox", { name: "Apply the change to Notes/Summary.md" }).focus();
  await page.keyboard.press("Space");
  await review.getByRole("button", { name: "Apply 1 change" }).click();
  const results = page.getByRole("region", { name: "Result" });
  await expect(results).toContainText("Applied");
  await expect(results.getByRole("heading", { name: "Result" })).toBeFocused();
  expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe("# Plan\n\nWe have a dog.\n");
  await expect(readFile(join(vault, "Notes/Summary.md"), "utf8")).rejects.toThrow();
  expect(await readFile(join(vault, "Diary.md"), "utf8")).toBe("# Diary\n\nPrivate.\n");
  await expect.poll(async () => readdir(join(data, "agent-runs"))).toEqual([]);

  // The run is in the history and in the vault's metadata, without page text or agent output.
  await openAssistantSettings(page);
  await expect(page.getByRole("region", { name: "Earlier runs" })).toContainText("Make it a dog.");
  const [name] = await readdir(join(vault, ".thoth/agent/runs"));
  const saved = await readFile(join(vault, ".thoth/agent/runs", name!), "utf8");
  expect(JSON.parse(saved)).toMatchObject({ state: "applied", provider: { id: "claude", version: "2.1.310" }, context: [{ path: "Notes/Plan.md", via: "selected" }] });
  expect(saved).not.toContain("We have a");
});

test("cancel stops the CLI and everything it started, and changes nothing", async ({ page }) => {
  await startTask(page, "@replace Notes/Plan.md :: cat => dog\n@hang\n");
  const cancel = bubble(page).getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeVisible();
  const work = await workDir();
  let record = await fakeRecord(work);
  await expect.poll(async () => (record = await fakeRecord(work)).grandchild).not.toBeNull();
  expect(await alive(record.pid)).toBe(true);
  await cancel.click();
  await expect(bubble(page).getByText("Cancelled. Nothing in your Private Space was changed.")).toBeVisible({ timeout: 15_000 });
  await waitDead(record.pid);
  await waitDead(record.grandchild!);
  expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe(PLAN);
  await expect.poll(async () => readdir(join(data, "agent-runs"))).toEqual([]);
  await openAssistantSettings(page);
  await expect(page.getByRole("region", { name: "Earlier runs" })).toContainText("Cancelled");
});

/** Opens the bubble and picks Codex. */
async function pickCodex(page: Page) {
  const b = await openBubble(page, "codex");
  await expect(b.locator('option[value="codex"]')).toHaveText("Codex · Ready, 0.164.0");
  await b.getByRole("combobox", { name: "Agent" }).selectOption("codex");
  await expect(b).toContainText("Thoth runs it only inside Codex's own sandbox");
}

const CODEX_ARGV = async (): Promise<string[]> => JSON.parse(await readFile(join(FAKE_CODEX_DIR, "../fixtures/argv.json"), "utf8")).cases[0].argv;

test("Codex: pick it, start, stream, review, apply exact bytes; it runs only in its own sandbox, with no spending limit", async ({ page }) => {
  await pickCodex(page);
  const form = bubble(page);
  await form.getByText("Options").click();
  await expect(form.getByRole("combobox", { name: "Spending limit" })).toBeDisabled();
  await expect(form.getByRole("combobox", { name: "Spending limit" })).toHaveText("Not supported by Codex");
  await pickOnly(page, ["Plan"]);
  await form.getByRole("textbox", { name: "Task" }).fill("Make it a dog.\n@run ls\n@replace Notes/Plan.md :: cat => dog\n@write Notes/Summary.md :: # Summary\\n");
  await axe(page, "#mascot-bubble");
  await form.getByRole("button", { name: "Start" }).click();
  const log = bubble(page).getByRole("log", { name: "What the agent is doing" });
  await expect(log).toContainText("Running ls");
  await expect(log).toContainText("Editing Notes/Plan.md");
  await expect(log).toContainText("Tokens: 1,200 in (1,000 cached), 34 out");
  const review = await openReview(page);

  // What Codex was given: only the picked page, its folder as cwd, and exactly the policy's arguments.
  const work = await workDir();
  const record = await fakeRecord(work, 20_000, "codex");
  expect(record.files).toEqual([
    { path: "Notes", kind: "directory" },
    { path: "Notes/Plan.md", kind: "file" },
  ]);
  expect(record.cwd).toBe(work);
  expect(record.argv).toEqual(await CODEX_ARGV());
  const config = record.argv.filter((_, i) => record.argv[i - 1] === "-c");
  expect(config).toEqual(expect.arrayContaining(["approval_policy=never", "default_permissions=thoth", "permissions.thoth.filesystem.:workspace_roots=write", "permissions.thoth.network.enabled=false", "web_search=disabled"]));
  expect(record.argv).toEqual(expect.arrayContaining(["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config"]));
  for (const banned of ["--dangerously-bypass-approvals-and-sandbox", "--sandbox", "-s", "danger-full-access", "--add-dir", "--search", "--profile", "-p", "--max-budget-usd"]) expect(record.argv).not.toContain(banned);
  expect(record.argv.some((a) => a.includes("Make it a dog") || a.includes(vault))).toBe(false);
  expect(record.stdin).toContain("Make it a dog.");
  expect(Object.entries(record.env).filter(([k, v]) => /^THOTH_/i.test(k) || v.includes(vault))).toEqual([]);

  expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe(PLAN);
  await review.getByRole("checkbox", { name: "Apply the change to Notes/Summary.md" }).uncheck();
  await review.getByRole("button", { name: "Apply 1 change" }).click();
  await expect(page.getByRole("region", { name: "Result" })).toContainText("Applied");
  expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe("# Plan\n\nWe have a dog.\n");
  await expect(stat(join(vault, "Notes/Summary.md"))).rejects.toThrow();
  await expect.poll(async () => readdir(join(data, "agent-runs"))).toEqual([]);
  const settings = await openAssistantSettings(page);
  await expect(page.getByTestId("agent-status-codex")).toHaveText("Codex 0.164.0 is ready, with its sandbox. It uses your own Codex login; Thoth never sees it.");
  const row = page.getByRole("region", { name: "Earlier runs" }).getByRole("row", { name: /Make it a dog/ });
  await expect(row).toContainText("Codex");
  await expect(row).toContainText("1,234 tokens");
  const [name] = await readdir(join(vault, ".thoth/agent/runs"));
  expect(JSON.parse(await readFile(join(vault, ".thoth/agent/runs", name!), "utf8"))).toMatchObject({ state: "applied", provider: { id: "codex", name: "Codex", version: "0.164.0" }, outcome: { tokens: { input: 1200, output: 34 } } });
  void settings;
  await axe(page, '[data-testid="assistant-settings"]');
});

test("Codex: cancel stops it and everything it started, and changes nothing", async ({ page }) => {
  await pickCodex(page);
  await pickOnly(page, ["Plan"]);
  await writeAndStart(page, "@replace Notes/Plan.md :: cat => dog\n@hang\n");
  const cancel = bubble(page).getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeVisible();
  const work = await workDir();
  let record = await fakeRecord(work, 20_000, "codex");
  await expect.poll(async () => (record = await fakeRecord(work, 20_000, "codex")).grandchild).not.toBeNull();
  expect(await alive(record.pid)).toBe(true);
  expect(await alive(record.grandchild!)).toBe(true);
  await cancel.click();
  await expect(bubble(page).getByText("Cancelled. Nothing in your Private Space was changed.")).toBeVisible({ timeout: 15_000 });
  await waitDead(record.pid);
  await waitDead(record.grandchild!);
  expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe(PLAN);
  await expect.poll(async () => readdir(join(data, "agent-runs"))).toEqual([]);
});

test("the whole Private Space as context: the total first, every file copied, and each change still reviewed", async ({ page }) => {
  await openBubble(page);
  const group = await picker(page);
  await group.getByRole("checkbox", { name: "Whole Private Space" }).check();
  const bytes = [PLAN, "# Ideas\n", "# Diary\n\nPrivate.\n"].reduce((n, t) => n + Buffer.byteLength(t), 0);
  await expect(page.getByTestId("agent-total")).toHaveText(`3 files, ${bytes} B, will be copied for the agent`);
  await expect(group.getByRole("checkbox", { name: "Plan", exact: true })).toBeDisabled();
  await writeAndStart(page, "@replace Diary.md :: Private => Public\n@write Brand-new.md :: # New\\n");

  const review = await openReview(page);
  const work = await workDir();
  expect((await fakeRecord(work)).files.map((f) => f.path)).toEqual(["Diary.md", "Notes", "Notes/Ideas.md", "Notes/Plan.md"]);
  await expect(stat(join(work, ".thoth"))).rejects.toThrow();
  expect(await readFile(join(vault, "Diary.md"), "utf8")).toBe("# Diary\n\nPrivate.\n");
  await review.getByRole("checkbox", { name: "Apply the change to Brand-new.md" }).uncheck();
  await review.getByRole("button", { name: "Apply 1 change" }).click();
  await expect(page.getByRole("region", { name: "Result" })).toContainText("Applied");
  expect(await readFile(join(vault, "Diary.md"), "utf8")).toBe("# Diary\n\nPublic.\n");
  await expect(stat(join(vault, "Brand-new.md"))).rejects.toThrow();
  await axe(page, ".agents");
});

test.describe("workspace pages as read-only context", () => {
  let workspaceServer: TestServer;
  let specId: string;
  const SPEC = "# Spec\n\nRoadmap: ship in May.\n";

  test.beforeEach(async () => {
    workspaceServer = await startTestServer();
    specId = newStableId();
    const put = await fetch(`${workspaceServer.url}/api/v1/workspaces/${MAIN_WORKSPACE}/pages/${specId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${EDITOR_TOKEN}`, "content-type": "application/json", "if-none-match": "*" },
      body: JSON.stringify({ title: "Spec", markdown: SPEC }),
    });
    expect(put.status).toBe(201);
    await fetch(`${workspaceServer.url}/api/v1/workspaces/${LOCKED_WORKSPACE}/pages/${newStableId()}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${EDITOR_TOKEN}`, "content-type": "application/json", "if-none-match": "*" },
      body: JSON.stringify({ title: "Secret", markdown: "# Secret\n" }),
    });
  });

  test.afterEach(async () => {
    await workspaceServer.close();
  });

  async function signIn(page: Page) {
    await page.getByRole("button", { name: "Settings" }).click();
    const servers = page.getByRole("region", { name: "Servers" });
    await servers.getByRole("textbox", { name: "Server address" }).fill(workspaceServer.url);
    await servers.getByRole("button", { name: "Add server" }).click();
    const card = servers.getByRole("article");
    await card.getByRole("button", { name: "Use a personal access token" }).click();
    await card.getByLabel(/Personal access token/).fill(EDITOR_TOKEN);
    await card.getByRole("button", { name: "Sign in with token" }).click();
    await expect(card.getByTestId("server-account")).toHaveText(/Signed in as/, { timeout: 15_000 });
  }

  const specNow = async () => (await (await fetch(`${workspaceServer.url}/api/v1/workspaces/${MAIN_WORKSPACE}/pages/${specId}`, { headers: { authorization: `Bearer ${EDITOR_TOKEN}` } })).json()) as { markdown: string; revision: { id: string } };

  test("a page the user may copy out is given read-only: the agent's edit to it is discarded, and nothing is written to the vault or the server", async ({ page }) => {
    const before = await specNow();
    await signIn(page);
    await openBubble(page);
    await pickOnly(page, ["Plan"]);
    const group = page.getByRole("group", { name: "Workspace pages (read-only)" });
    // The workspace that forbids copying out is listed with the reason, and offers no page.
    const locked = group.locator("details", { hasText: "Locked" });
    await expect(locked).toContainText("This workspace does not allow its pages to be copied out.");
    await locked.locator("summary").click();
    await expect(locked.getByRole("checkbox")).toHaveCount(0);
    await group.locator("details", { hasText: "Main" }).locator("summary").click();
    await group.getByRole("checkbox", { name: "Spec" }).check();
    await expect(group).toContainText("1 workspace page added");
    await writeAndStart(page, ["Use the spec.", "@unlock workspace/Main/Spec.md", "@replace workspace/Main/Spec.md :: May => June", "@write workspace/Main/Extra.md :: # Extra\\n", "@replace Notes/Plan.md :: cat => dog"].join("\n"));

    const review = await openReview(page);
    // What the agent was given: the page as a read-only file, and told it is reference only.
    const work = await workDir();
    const record = await fakeRecord(work);
    expect(record.files.map((f) => f.path)).toEqual(expect.arrayContaining(["workspace", "workspace/Main", "workspace/Main/Spec.md"]));
    expect(record.stdin).toContain('the folder "workspace/" holds read-only copies of pages');
    expect(record.modes["workspace/Main/Spec.md"]! & 0o222).toBe(0); // read-only when the agent started
    expect(record.modes["Notes/Plan.md"]! & 0o200).not.toBe(0);
    // Its edits to the reference copies are shown as discarded and cannot be chosen.
    for (const name of ["Spec", "Extra"]) {
      const box = review.getByRole("checkbox", { name: `Apply the change to workspace/Main/${name}.md` });
      await expect(box).toBeDisabled();
      await expect(box).not.toBeChecked();
    }
    await expect(review).toContainText("Read-only workspace page: change discarded");
    await review.getByRole("button", { name: "Apply 1 change" }).click();
    const results = page.getByRole("region", { name: "Result" });
    await expect(results).toContainText("workspace/Main/Spec.mdRead-only workspace page: change discarded");
    await expect(results).toContainText("Notes/Plan.mdApplied");
    expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe("# Plan\n\nWe have a dog.\n");
    await expect(stat(join(vault, "workspace"))).rejects.toThrow();
    const after = await specNow();
    expect(after.markdown).toBe(SPEC);
    expect(after.revision.id).toBe(before.revision.id);
    // The saved record keeps where the reference copy came from, not its text.
    const [name] = await readdir(join(vault, ".thoth/agent/runs"));
    const saved = await readFile(join(vault, ".thoth/agent/runs", name!), "utf8");
    expect(JSON.parse(saved).context.find((c: { readOnly?: boolean }) => c.readOnly)).toMatchObject({ path: "workspace/Main/Spec.md", via: "workspace" });
    expect(saved).not.toContain("Roadmap");
    await axe(page, ".agents");
  });

  test("Codex: its edit to a read-only workspace page is discarded, and only the private page is applied", async ({ page }) => {
    const before = await specNow();
    await signIn(page);
    await pickCodex(page);
    await pickOnly(page, ["Plan"]);
    const group = page.getByRole("group", { name: "Workspace pages (read-only)" });
    await group.locator("details", { hasText: "Main" }).locator("summary").click();
    await group.getByRole("checkbox", { name: "Spec" }).check();
    await writeAndStart(page, ["Use the spec.", "@unlock workspace/Main/Spec.md", "@replace workspace/Main/Spec.md :: May => June", "@replace Notes/Plan.md :: cat => dog"].join("\n"));
    const review = await openReview(page);
    const record = await fakeRecord(await workDir(), 20_000, "codex");
    expect(record.modes["workspace/Main/Spec.md"]! & 0o222).toBe(0);
    expect(record.stdin).toContain('the folder "workspace/" holds read-only copies of pages');
    const box = review.getByRole("checkbox", { name: "Apply the change to workspace/Main/Spec.md" });
    await expect(box).toBeDisabled();
    await expect(box).not.toBeChecked();
    await review.getByRole("button", { name: "Apply 1 change" }).click();
    const results = page.getByRole("region", { name: "Result" });
    await expect(results).toContainText("workspace/Main/Spec.mdRead-only workspace page: change discarded");
    await expect(results).toContainText("Notes/Plan.mdApplied");
    expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe("# Plan\n\nWe have a dog.\n");
    await expect(stat(join(vault, "workspace"))).rejects.toThrow();
    const after = await specNow();
    expect(after.markdown).toBe(SPEC);
    expect(after.revision.id).toBe(before.revision.id);
  });
});

test("a review that was waiting when the app closed comes back after a real restart and is applied from its saved copy", async ({ page, context }) => {
  await openBubble(page);
  await pickOnly(page, ["Plan"]);
  await writeAndStart(page, "Make it a dog.\n@replace Notes/Plan.md :: cat => dog\n@write Notes/Summary.md :: # Summary\\n");
  await expect(bubble(page).getByRole("button", { name: "Review the changes" })).toBeVisible({ timeout: 15_000 });
  const [recordName] = await readdir(join(vault, ".thoth/agent/runs"));
  expect(JSON.parse(await readFile(join(vault, ".thoth/agent/runs", recordName!), "utf8")).state).toBe("review");

  // The app closes (the host is stopped and its working directories go) and starts again.
  await page.close();
  await bridge.close();
  await expect.poll(async () => readdir(join(data, "agent-runs")).catch(() => [])).toEqual([]);
  bridge = await startBridge(bridgeOptions());
  const again = await context.newPage();
  await again.addInitScript(bridge.initScript);
  await again.goto(bridge.url);
  await again.getByRole("button", { name: /choose or create a private space/i }).click();
  await expect(again.getByRole("tree", { name: "Pages in this Private Space" })).toBeVisible();

  // The mascot asks for the waiting review.
  await expect(mascot(again)).toHaveAccessibleName("Thoth assistant, changes ready for review", { timeout: 15_000 });
  await openAssistantSettings(again);
  await expect(again.getByTestId("agent-awaiting")).toHaveText("1 run is waiting for your review. Open it under Earlier runs, or click the mascot.");
  const history = again.getByRole("region", { name: "Earlier runs" });
  const row = history.getByRole("row", { name: /Make it a dog/ });
  await expect(row).toContainText("Awaiting review");
  expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe(PLAN);
  await row.getByRole("button", { name: /Review the changes/ }).click();

  const review = again.getByRole("region", { name: "Review the changes" });
  await expect(review.getByRole("group", { name: "Changes to Notes/Plan.md" })).toContainText("We have a dog.");
  await review.getByRole("checkbox", { name: "Apply the change to Notes/Summary.md" }).uncheck();
  await review.getByRole("button", { name: "Apply 1 change" }).click();
  await expect(again.getByRole("region", { name: "Result" })).toContainText("Applied");
  expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe("# Plan\n\nWe have a dog.\n");
  await expect(stat(join(vault, "Notes/Summary.md"))).rejects.toThrow();
  expect(JSON.parse(await readFile(join(vault, ".thoth/agent/runs", recordName!), "utf8")).state).toBe("applied");
  // The saved transcript and diffs open from the history, and live in the app data folder only.
  await openAssistantSettings(again);
  await history.getByRole("row", { name: /Make it a dog/ }).getByRole("button", { name: /Open transcript and changes/ }).click();
  const detail = again.getByRole("region", { name: "Saved details of this run" });
  await expect(detail.getByRole("log", { name: "What the agent did" })).toContainText("Editing Notes/Plan.md");
  await expect(detail.getByRole("group", { name: "Changes to Notes/Plan.md" })).toContainText("We have a cat.");
  expect((await readdir(join(data, "agent-history"))).length).toBe(1);
});

test("a run that used up its spending limit says so, and its work so far can be reviewed", async ({ page }) => {
  const b = await openBubble(page);
  await pickOnly(page, ["Plan"]);
  // This run only: 5 minutes and US$0.25 (the host checks both before it starts anything).
  await b.getByText("Options").click();
  await b.getByRole("combobox", { name: "Time limit" }).selectOption("5");
  await b.getByRole("combobox", { name: "Spending limit" }).selectOption("0.25");
  await writeAndStart(page, "@replace Notes/Plan.md :: cat => dog\n@budget\n");
  await expect(b.getByTestId("agent-stopped")).toHaveText("Stopped at the spending limit (US$0.25). What the agent did before then can still be reviewed.", { timeout: 15_000 });
  await expect(b.getByRole("log", { name: "What the agent is doing" })).toContainText("The spending limit was reached.");
  const review = await openReview(page);
  const record = await fakeRecord(await workDir());
  expect(record.argv.slice(record.argv.indexOf("--max-budget-usd"))).toEqual(["--max-budget-usd", "0.25"]);
  const [name] = await readdir(join(vault, ".thoth/agent/runs"));
  expect(JSON.parse(await readFile(join(vault, ".thoth/agent/runs", name!), "utf8"))).toMatchObject({ task: { maxBudgetUsd: 0.25, timeoutMs: 300_000 }, outcome: { stoppedBy: "budget" } });
  await review.getByRole("button", { name: "Discard all" }).click();
  await expect(page.getByRole("region", { name: "Result" })).toBeVisible();
  await openAssistantSettings(page);
  await expect(page.getByRole("region", { name: "Earlier runs" })).toContainText("Stopped at the spending limit");
  expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe(PLAN);
});

/** Light or dark (the theme attribute the tokens key off). */
const theme = (page: Page, dark: boolean) => page.evaluate((night) => document.documentElement.setAttribute("data-theme", night ? "night" : "light"), dark);
const SHOTS = join(REPO, "tests", ".tmp", "agent-sessions");

/** An earlier run, as a past session left it: its record in the vault and its transcript in the app data folder. */
async function earlierRun(prompt: string, at: number): Promise<void> {
  const id = newStableId(at);
  await mkdir(join(vault, ".thoth/agent/runs"), { recursive: true });
  const record = { version: 1, id, provider: { id: "claude", name: "Claude Code", version: "2.1.310" }, task: { prompt }, context: [], state: "done", createdAt: at, updatedAt: at, outcome: { reason: "exited", code: 0, ok: true, costUsd: 0.002 }, changes: [] };
  await writeFile(join(vault, ".thoth/agent/runs", `${id}.json`), JSON.stringify(record, null, 2));
  await mkdir(join(data, "agent-history", id), { recursive: true });
  await writeFile(join(data, "agent-history", id, "transcript.jsonl"), [{ type: "text", text: `About ${prompt}` }, { type: "result", ok: true, text: `About ${prompt}` }].map((e) => JSON.stringify(e)).join("\n") + "\n");
}

test("a question gets its answer in the bubble, opens in a tab, is listed in the sidebar, and comes back after a restart", async ({ page, context }) => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const b = await openBubble(page);
  await pickOnly(page, ["Plan"]);
  await writeAndStart(page, "What content is on this page?\n@say Reading Notes/Plan.md\n@answer The page is a plan with one line: “We have a cat.”\\nNothing else is on it.\n");

  // The answer, as text with its line break; the "no changes" fact is a small line under it.
  const answer = b.getByRole("region", { name: "Answer" });
  await expect(answer.getByTestId("agent-answer")).toHaveText("The page is a plan with one line: “We have a cat.”\nNothing else is on it.", { timeout: 15_000 });
  expect(await answer.getByTestId("agent-answer").evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre-wrap");
  await expect(b.getByText("No pages were changed.")).toBeVisible();
  await expect(b.getByText("The agent finished without changing anything.")).toHaveCount(0);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await answer.getByRole("button", { name: "Copy answer" }).click();
  await expect(answer.getByRole("status")).toHaveText("Copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("The page is a plan with one line: “We have a cat.”\nNothing else is on it.");
  for (const dark of [false, true]) {
    await theme(page, dark);
    await axe(page, "#mascot-bubble");
    await page.screenshot({ path: join(SHOTS, `bubble-answer-${dark ? "dark" : "light"}.png`) });
  }
  await theme(page, false);
  // Agent output stays out of the vault.
  const [name] = await readdir(join(vault, ".thoth/agent/runs"));
  const saved = await readFile(join(vault, ".thoth/agent/runs", name!), "utf8");
  expect(saved.replace(JSON.stringify(JSON.parse(saved).task.prompt), "")).not.toContain("Nothing else is on it");

  // The icon opens the run's session tab, with the keyboard.
  await b.getByRole("button", { name: "Open in a tab" }).focus();
  await page.keyboard.press("Enter");
  await expect(bubble(page)).toBeHidden();
  await expect(page.getByRole("tab", { selected: true })).toHaveText("What content is on this page?");
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("heading", { level: 1 })).toHaveText("What content is on this page?");
  await expect(panel.getByRole("region", { name: "Answer" }).getByTestId("agent-answer")).toContainText("Nothing else is on it.");

  // The sidebar lists it, marked as the current tab's run.
  const section = page.getByRole("region", { name: "Assistant" });
  const row = section.getByRole("button", { name: /What content is on this page\?/ });
  await expect(row).toHaveAttribute("aria-current", "page");
  for (const dark of [false, true]) {
    await theme(page, dark);
    await axe(page, [".agents-session", ".agents-section"]);
    await page.screenshot({ path: join(SHOTS, `session-tab-${dark ? "dark" : "light"}.png`) });
  }
  await theme(page, false);

  // Earlier runs from another day, so the section has more than five.
  for (let i = 1; i <= 6; i++) await earlierRun(`Earlier question ${i}`, Date.now() - (10 - i) * 3_600_000);

  // The app closes and starts again on the same origin: the tab comes back, its answer read from the transcript.
  const port = Number(new URL(bridge.url).port);
  await page.close();
  await bridge.close();
  bridge = await startBridge({ ...bridgeOptions(), port });
  const again = await context.newPage();
  await again.addInitScript(bridge.initScript);
  await again.goto(bridge.url);
  await again.getByRole("button", { name: /choose or create a private space/i }).click();
  await expect(again.getByRole("tab", { selected: true })).toHaveText("What content is on this page?", { timeout: 15_000 });
  await expect(again.getByRole("tabpanel").getByRole("region", { name: "Answer" }).getByTestId("agent-answer")).toHaveText("The page is a plan with one line: “We have a cat.”\nNothing else is on it.");

  // Five shown, the rest behind "Show 2 more".
  const rows = again.getByRole("region", { name: "Assistant" }).locator(".agents-row");
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText("What content is on this page?");
  const more = again.getByRole("button", { name: "Show 2 more" });
  await more.click();
  await expect(rows).toHaveCount(7);
  await expect(again.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  for (const dark of [false, true]) {
    await theme(again, dark);
    await axe(again, ".agents-section");
    await again.locator(".sidebar").screenshot({ path: join(SHOTS, `sidebar-section-${dark ? "dark" : "light"}.png`) });
  }
  await theme(again, false);
  await rows.nth(6).click();
  await expect(again.getByRole("tab", { selected: true })).toHaveText("Earlier question 1");
  await expect(again.getByRole("tabpanel").getByTestId("agent-answer")).toHaveText("About Earlier question 1");
});

const CHAT_SHOTS = join(REPO, "tests", ".tmp", "agent-chat");

test("a follow-up in the session tab: the CLI is given the first question and answer, both turns show, and the conversation comes back after a restart", async ({ page, context }) => {
  test.setTimeout(240_000);
  await mkdir(CHAT_SHOTS, { recursive: true });
  const b = await openBubble(page);
  await pickOnly(page, ["Plan"]);
  await writeAndStart(page, "What content is on this page?\n@answer A plan with one line: “We have a cat.”\n");
  await expect(b.getByRole("region", { name: "Answer" }).getByTestId("agent-answer")).toHaveText("A plan with one line: “We have a cat.”", { timeout: 15_000 });
  const argvFirst = await (async () => {
    const [name] = await readdir(join(vault, ".thoth/agent/runs"));
    return JSON.parse(await readFile(join(vault, ".thoth/agent/runs", name!), "utf8")) as { id: string; conversation?: { id: string; turn: number } };
  })();
  expect(argvFirst.conversation).toEqual({ id: argvFirst.id, turn: 1 });
  for (const dark of [false, true]) {
    await theme(page, dark);
    await page.locator("#mascot-bubble").screenshot({ path: join(CHAT_SHOTS, `bubble-follow-up-${dark ? "dark" : "light"}.png`) });
  }
  await theme(page, false);

  // "Ask a follow-up" opens the session tab with the composer focused (keyboard all the way).
  await b.getByRole("button", { name: "Ask a follow-up" }).focus();
  await page.keyboard.press("Enter");
  await expect(bubble(page)).toBeHidden();
  const panel = page.getByRole("tabpanel");
  const composer = panel.getByRole("textbox", { name: "Ask a follow-up" });
  await expect(composer).toBeFocused();
  await expect(panel).toContainText("Same pages and settings as the last question: Claude Code, 1 page, the default model.");
  await page.keyboard.type("Who has the cat?");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("@sleep 1500");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("@echo-context");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");

  // While it runs, the next question waits.
  await expect(panel.getByRole("heading", { name: "Question 2" })).toBeVisible();
  await expect(panel.getByTestId("composer-blocked")).toHaveText("Wait for the answer before you ask more.");
  await expect(panel.getByRole("button", { name: "Send" })).toBeDisabled();
  // The fake CLI saw the first question and its answer before the new one, with the same arguments as the first turn.
  const work = await workDir();
  const seen = await fakeRecord(work);
  expect(seen.stdin.indexOf("What content is on this page?")).toBeGreaterThan(-1);
  expect(seen.stdin.indexOf("What content is on this page?")).toBeLessThan(seen.stdin.indexOf("A plan with one line"));
  expect(seen.stdin.indexOf("A plan with one line")).toBeLessThan(seen.stdin.indexOf("Who has the cat?"));
  expect(seen.argv).toEqual([...JSON.parse(await readFile(join(FAKE_CLAUDE_DIR, "../fixtures/argv.json"), "utf8")).cases[0].argv, "--max-budget-usd", "1"]);

  const answers = panel.getByTestId("agent-answer");
  await expect(answers).toHaveCount(2, { timeout: 15_000 });
  await expect(answers.nth(0)).toHaveText("A plan with one line: “We have a cat.”");
  await expect(answers.nth(1)).toHaveText("Earlier turns in my input: 1. The first question was: What content is on this page?");
  await expect(panel.getByTestId("turn-context")).toHaveText("The earlier question and its answer were sent with this one.");
  await expect(panel.getByTestId("composer-blocked")).toHaveCount(0);

  // The record of turn 2: its own question, the conversation and the turn; no earlier text.
  const names = await readdir(join(vault, ".thoth/agent/runs"));
  const saved = await Promise.all(names.map(async (n) => readFile(join(vault, ".thoth/agent/runs", n), "utf8")));
  const second = saved.map((s) => JSON.parse(s) as { task: { prompt: string }; conversation: { id: string; turn: number } }).find((r) => r.conversation.turn === 2)!;
  expect(second.conversation.id).toBe(argvFirst.id);
  expect(second.task.prompt).toBe("Who has the cat?\n@sleep 1500\n@echo-context");
  expect(saved.find((s) => (JSON.parse(s) as { conversation: { turn: number } }).conversation.turn === 2)).not.toContain("A plan with one line");

  // One sidebar row for the conversation, with its question count.
  const rows = page.getByRole("region", { name: "Assistant" }).locator(".agents-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("2 questions");
  for (const dark of [false, true]) {
    await theme(page, dark);
    await axe(page, [".agents-session", ".agents-section"]);
    await page.screenshot({ path: join(CHAT_SHOTS, `conversation-${dark ? "dark" : "light"}.png`) });
  }
  await theme(page, false);

  // Restart: the conversation comes back from the records and the local transcripts, and can go on.
  const port = Number(new URL(bridge.url).port);
  await page.close();
  await bridge.close();
  bridge = await startBridge({ ...bridgeOptions(), port });
  const again = await context.newPage();
  await again.addInitScript(bridge.initScript);
  await again.goto(bridge.url);
  await again.getByRole("button", { name: /choose or create a private space/i }).click();
  await expect(again.getByRole("tab", { selected: true })).toHaveText("What content is on this page?", { timeout: 15_000 });
  const restored = again.getByRole("tabpanel");
  await expect(restored.getByTestId("agent-answer")).toHaveCount(2);
  await expect(restored.getByTestId("agent-answer").nth(1)).toContainText("Earlier turns in my input: 1.");
  await restored.getByRole("textbox", { name: "Ask a follow-up" }).fill("@echo-context");
  await restored.getByRole("button", { name: "Send" }).click();
  await expect(restored.getByTestId("agent-answer")).toHaveCount(3, { timeout: 15_000 });
  await expect(restored.getByTestId("agent-answer").nth(2)).toHaveText("Earlier turns in my input: 2. The first question was: What content is on this page?");
  for (const dark of [false, true]) {
    await theme(again, dark);
    await axe(again, ".agents-session");
    await again.locator(".agents-composer").screenshot({ path: join(CHAT_SHOTS, `composer-${dark ? "dark" : "light"}.png`) });
  }
});

test("a long answer with long links never pushes the bubble sideways, and links into the run's copy read as page paths", async ({ page }) => {
  test.setTimeout(120_000);
  const b = await openBubble(page);
  await pickOnly(page, ["Plan"]);
  const work = "file:///Users/a/Library/Application%20Support/com.thothnotes.desktop/agent-runs/run_5b11accfe44550c4eeeb9c2bcfbce1c1/work";
  const long = `https://example.org/${"a".repeat(260)}`;
  await writeAndStart(page, `Can you make an image to put together with this content, and place it right under the heading of the page please?\n@answer I made an original SVG illustration and embedded it beneath the heading in [Plan.md](${work}/Notes/Plan.md).\\n\\nThe file: [bird-uric-acid.svg](${work}/Notes/bird-uric-acid.svg)\\n\\nSource: ${long}\n`);
  const text = b.getByTestId("agent-answer");
  await expect(text).toContainText("beneath the heading in Notes/Plan.md.", { timeout: 15_000 });
  await expect(text).toContainText("The file: Notes/bird-uric-acid.svg");
  await expect(text).not.toContainText("agent-runs");
  await expect(b.getByRole("button", { name: "New task" })).toBeFocused();

  // Nothing in the bubble is wider than it, so nothing scrolls it sideways and every line starts at its left edge.
  const layout = await b.evaluate((el) => {
    const body = el.querySelector(".bubble-body")!;
    const box = el.getBoundingClientRect();
    const starts = [...el.querySelectorAll(".bubble-prompt, .agents-answer, .bubble-actions")].map((n) => Math.round(n.getBoundingClientRect().left - box.left));
    const rights = [...el.querySelectorAll(".bubble-body *")].map((n) => Math.round(n.getBoundingClientRect().right - box.right));
    return { overflow: body.scrollWidth - body.clientWidth, scrolled: body.scrollLeft, starts, sticksOut: Math.max(...rights) };
  });
  expect(layout.overflow).toBeLessThanOrEqual(0);
  expect(layout.scrolled).toBe(0);
  for (const start of layout.starts) expect(start).toBeGreaterThanOrEqual(16);
  expect(layout.sticksOut).toBeLessThanOrEqual(0);
});
