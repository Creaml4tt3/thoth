/**
 * Phase 4 acceptance (docs/architecture/implementation-plan.md): the real desktop UI in Chromium, on the real Rust
 * host (`thoth-host-stdio` through the dev bridge), with the FAKE Claude Code CLI (`--agent-search-dir`), so no
 * model is called. Pick a page → start → streamed transcript → review → apply exact bytes on disk; then cancel.
 * The fake records what it was given: only the picked page in its working directory, that directory as its cwd,
 * the policy's argument list, and no argument or environment variable naming the vault.
 *
 * The same with the FAKE Codex CLI, picked in the Agent Hub: its argument list is exactly the policy's (Codex's own
 * sandbox with Thoth's permission profile, approvals that never prompt, no bypass, no web search, no spending limit),
 * cancel stops its whole process tree, and its edit to a read-only workspace page is discarded.
 *
 * Also: the whole Private Space as context; a workspace page (on the in-memory protocol test server, over real HTTP
 * through the host) as read-only context whose edit is discarded; a review that survives a real restart of the host
 * and the app and is then applied; and a run that used up its budget.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newStableId } from "@thoth/domain";
import { FAKE_CLAUDE_DIR, FAKE_CODEX_DIR, alive, fakeRecord, waitDead } from "../helpers/agent.ts";
import { EDITOR_TOKEN, LOCKED_WORKSPACE, MAIN_WORKSPACE, startTestServer, type TestServer } from "../protocol/test-server.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";

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

/** No serious or critical axe findings in the Agent Hub as it is now. */
async function axe(page: Page) {
  // A hovered primary button is drawn at 88% opacity, which axe reads as low contrast: park the pointer first.
  await page.mouse.move(0, 0);
  await settled(page);
  const bad = (await new AxeBuilder({ page }).include(".agents").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function startTask(page: Page, prompt: string, check = false) {
  await page.getByRole("button", { name: "Agent Hub" }).click();
  await expect(page.getByTestId("agent-status")).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await expect(page.getByTestId("agent-status")).toHaveText("Claude Code 2.1.310 is ready. It uses your own Claude login; Thoth never sees it.");
  const picker = page.getByRole("group", { name: "Pages for the agent" });
  await picker.getByRole("checkbox", { name: "Plan", exact: true }).check();
  await expect(picker).toContainText("1 selected");
  await page.getByRole("textbox", { name: "Task" }).fill(prompt);
  if (check) await axe(page);
  await page.getByRole("button", { name: "Start" }).click();
}

test("pick a page, start, stream, review, apply: exact bytes on disk, and only the picked page was given", async ({ page }) => {
  await startTask(page, "Make it a dog.\n@replace Notes/Plan.md :: cat => dog\n@write Notes/Summary.md :: # Summary\\n", true);
  const log = page.getByRole("log", { name: "What the agent is doing" });
  await expect(log).toContainText("Editing Notes/Plan.md");
  await expect(log).toContainText("Done.");
  const review = page.getByRole("region", { name: "Review the changes" });
  await expect(review).toBeVisible();

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
  await axe(page);

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
  await expect(page.getByRole("region", { name: "Earlier runs" })).toContainText("Make it a dog.");
  const [name] = await readdir(join(vault, ".thoth/agent/runs"));
  const saved = await readFile(join(vault, ".thoth/agent/runs", name!), "utf8");
  expect(JSON.parse(saved)).toMatchObject({ state: "applied", provider: { id: "claude", version: "2.1.310" }, context: [{ path: "Notes/Plan.md", via: "selected" }] });
  expect(saved).not.toContain("We have a");
});

test("cancel stops the CLI and everything it started, and changes nothing", async ({ page }) => {
  await startTask(page, "@replace Notes/Plan.md :: cat => dog\n@hang\n");
  const cancel = page.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeVisible();
  const work = await workDir();
  let record = await fakeRecord(work);
  await expect.poll(async () => (record = await fakeRecord(work)).grandchild).not.toBeNull();
  expect(await alive(record.pid)).toBe(true);
  await cancel.click();
  await expect(page.getByText("Cancelled. Nothing in your Private Space was changed.")).toBeVisible({ timeout: 15_000 });
  await waitDead(record.pid);
  await waitDead(record.grandchild!);
  expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe(PLAN);
  await expect.poll(async () => readdir(join(data, "agent-runs"))).toEqual([]);
  await expect(page.getByRole("region", { name: "Earlier runs" })).toContainText("Cancelled");
});

/** Opens the Agent Hub and picks Codex. */
async function pickCodex(page: Page) {
  await page.getByRole("button", { name: "Agent Hub" }).click();
  await expect(page.getByTestId("agent-short-codex")).toHaveText("Ready, 0.164.0", { timeout: 15_000 });
  await page.getByRole("group", { name: "Agent" }).getByRole("radio", { name: "Codex" }).check();
  await expect(page.getByTestId("agent-status")).toHaveText("Codex 0.164.0 is ready, with its sandbox. It uses your own Codex login; Thoth never sees it.");
}

const CODEX_ARGV = async (): Promise<string[]> => JSON.parse(await readFile(join(FAKE_CODEX_DIR, "../fixtures/argv.json"), "utf8")).cases[0].argv;

test("Codex: pick it, start, stream, review, apply exact bytes; it runs only in its own sandbox, with no spending limit", async ({ page }) => {
  await pickCodex(page);
  const form = page.getByRole("region", { name: "New task" });
  await expect(form.getByRole("combobox", { name: "Spending limit" })).toBeDisabled();
  await expect(form.getByRole("combobox", { name: "Spending limit" })).toHaveText("Not supported by Codex");
  await page.getByRole("group", { name: "Pages for the agent" }).getByRole("checkbox", { name: "Plan", exact: true }).check();
  await page.getByRole("textbox", { name: "Task" }).fill("Make it a dog.\n@run ls\n@replace Notes/Plan.md :: cat => dog\n@write Notes/Summary.md :: # Summary\\n");
  await axe(page);
  await page.getByRole("button", { name: "Start" }).click();
  const log = page.getByRole("log", { name: "What the agent is doing" });
  await expect(log).toContainText("Running ls");
  await expect(log).toContainText("Editing Notes/Plan.md");
  await expect(log).toContainText("Tokens: 1,200 in (1,000 cached), 34 out");
  const review = page.getByRole("region", { name: "Review the changes" });
  await expect(review).toBeVisible({ timeout: 15_000 });

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
  const row = page.getByRole("region", { name: "Earlier runs" }).getByRole("row", { name: /Make it a dog/ });
  await expect(row).toContainText("Codex");
  await expect(row).toContainText("1,234 tokens");
  const [name] = await readdir(join(vault, ".thoth/agent/runs"));
  expect(JSON.parse(await readFile(join(vault, ".thoth/agent/runs", name!), "utf8"))).toMatchObject({ state: "applied", provider: { id: "codex", name: "Codex", version: "0.164.0" }, outcome: { tokens: { input: 1200, output: 34 } } });
  await axe(page);
});

test("Codex: cancel stops it and everything it started, and changes nothing", async ({ page }) => {
  await pickCodex(page);
  await page.getByRole("group", { name: "Pages for the agent" }).getByRole("checkbox", { name: "Plan", exact: true }).check();
  await writeTask(page, "@replace Notes/Plan.md :: cat => dog\n@hang\n");
  const cancel = page.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeVisible();
  const work = await workDir();
  let record = await fakeRecord(work, 20_000, "codex");
  await expect.poll(async () => (record = await fakeRecord(work, 20_000, "codex")).grandchild).not.toBeNull();
  expect(await alive(record.pid)).toBe(true);
  expect(await alive(record.grandchild!)).toBe(true);
  await cancel.click();
  await expect(page.getByText("Cancelled. Nothing in your Private Space was changed.")).toBeVisible({ timeout: 15_000 });
  await waitDead(record.pid);
  await waitDead(record.grandchild!);
  expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe(PLAN);
  await expect.poll(async () => readdir(join(data, "agent-runs"))).toEqual([]);
});

async function openHub(page: Page) {
  await page.getByRole("button", { name: "Agent Hub" }).click();
  await expect(page.getByTestId("agent-status")).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
}

async function writeTask(page: Page, prompt: string) {
  await page.getByRole("textbox", { name: "Task" }).fill(prompt);
  await page.getByRole("button", { name: "Start" }).click();
}

test("the whole Private Space as context: the total first, every file copied, and each change still reviewed", async ({ page }) => {
  await openHub(page);
  const picker = page.getByRole("group", { name: "Pages for the agent" });
  await picker.getByRole("checkbox", { name: "Whole Private Space" }).check();
  const bytes = [PLAN, "# Ideas\n", "# Diary\n\nPrivate.\n"].reduce((n, t) => n + Buffer.byteLength(t), 0);
  await expect(page.getByTestId("agent-total")).toHaveText(`3 files, ${bytes} B, will be copied for the agent`);
  await expect(picker.getByRole("checkbox", { name: "Plan", exact: true })).toBeDisabled();
  await writeTask(page, "@replace Diary.md :: Private => Public\n@write Brand-new.md :: # New\\n");

  const review = page.getByRole("region", { name: "Review the changes" });
  await expect(review).toBeVisible({ timeout: 15_000 });
  const work = await workDir();
  expect((await fakeRecord(work)).files.map((f) => f.path)).toEqual(["Diary.md", "Notes", "Notes/Ideas.md", "Notes/Plan.md"]);
  await expect(stat(join(work, ".thoth"))).rejects.toThrow();
  expect(await readFile(join(vault, "Diary.md"), "utf8")).toBe("# Diary\n\nPrivate.\n");
  await review.getByRole("checkbox", { name: "Apply the change to Brand-new.md" }).uncheck();
  await review.getByRole("button", { name: "Apply 1 change" }).click();
  await expect(page.getByRole("region", { name: "Result" })).toContainText("Applied");
  expect(await readFile(join(vault, "Diary.md"), "utf8")).toBe("# Diary\n\nPublic.\n");
  await expect(stat(join(vault, "Brand-new.md"))).rejects.toThrow();
  await axe(page);
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
    await openHub(page);
    const group = page.getByRole("group", { name: "Workspace pages (read-only)" });
    // The workspace that forbids copying out is listed with the reason, and offers no page.
    const locked = group.locator("details", { hasText: "Locked" });
    await expect(locked).toContainText("This workspace does not allow its pages to be copied out.");
    await locked.locator("summary").click();
    await expect(locked.getByRole("checkbox")).toHaveCount(0);
    await group.locator("details", { hasText: "Main" }).locator("summary").click();
    await group.getByRole("checkbox", { name: "Spec" }).check();
    await expect(group).toContainText("1 workspace page added");
    await page.getByRole("group", { name: "Pages for the agent" }).getByRole("checkbox", { name: "Plan", exact: true }).check();
    await writeTask(page, ["Use the spec.", "@unlock workspace/Main/Spec.md", "@replace workspace/Main/Spec.md :: May => June", "@write workspace/Main/Extra.md :: # Extra\\n", "@replace Notes/Plan.md :: cat => dog"].join("\n"));

    const review = page.getByRole("region", { name: "Review the changes" });
    await expect(review).toBeVisible({ timeout: 15_000 });
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
    await axe(page);
  });

  test("Codex: its edit to a read-only workspace page is discarded, and only the private page is applied", async ({ page }) => {
    const before = await specNow();
    await signIn(page);
    await pickCodex(page);
    const group = page.getByRole("group", { name: "Workspace pages (read-only)" });
    await group.locator("details", { hasText: "Main" }).locator("summary").click();
    await group.getByRole("checkbox", { name: "Spec" }).check();
    await page.getByRole("group", { name: "Pages for the agent" }).getByRole("checkbox", { name: "Plan", exact: true }).check();
    await writeTask(page, ["Use the spec.", "@unlock workspace/Main/Spec.md", "@replace workspace/Main/Spec.md :: May => June", "@replace Notes/Plan.md :: cat => dog"].join("\n"));
    const review = page.getByRole("region", { name: "Review the changes" });
    await expect(review).toBeVisible({ timeout: 15_000 });
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
  await openHub(page);
  const picker = page.getByRole("group", { name: "Pages for the agent" });
  await picker.getByRole("checkbox", { name: "Plan", exact: true }).check();
  await writeTask(page, "Make it a dog.\n@replace Notes/Plan.md :: cat => dog\n@write Notes/Summary.md :: # Summary\\n");
  await expect(page.getByRole("region", { name: "Review the changes" })).toBeVisible({ timeout: 15_000 });
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

  await again.getByRole("button", { name: "Agent Hub" }).click();
  await expect(again.getByTestId("agent-awaiting")).toHaveText("1 run is waiting for your review. Open it under Earlier runs.");
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
  await history.getByRole("row", { name: /Make it a dog/ }).getByRole("button", { name: /Open transcript and changes/ }).click();
  const detail = again.getByRole("region", { name: "Saved details of this run" });
  await expect(detail.getByRole("log", { name: "What the agent did" })).toContainText("Editing Notes/Plan.md");
  await expect(detail.getByRole("group", { name: "Changes to Notes/Plan.md" })).toContainText("We have a cat.");
  expect((await readdir(join(data, "agent-history"))).length).toBe(1);
});

test("a run that used up its spending limit says so, and its work so far can be reviewed", async ({ page }) => {
  await openHub(page);
  await page.getByRole("group", { name: "Pages for the agent" }).getByRole("checkbox", { name: "Plan", exact: true }).check();
  // This run only: 5 minutes and US$0.25 (the host checks both before it starts anything).
  await page.getByRole("combobox", { name: "Time limit" }).first().selectOption("5");
  await page.getByRole("combobox", { name: "Spending limit" }).first().selectOption("0.25");
  await writeTask(page, "@replace Notes/Plan.md :: cat => dog\n@budget\n");
  const review = page.getByRole("region", { name: "Review the changes" });
  await expect(review).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("agent-stopped")).toHaveText("Stopped at the spending limit (US$0.25). What the agent did before then can still be reviewed.");
  await expect(page.getByRole("log", { name: "What the agent is doing" })).toContainText("The spending limit was reached.");
  const record = await fakeRecord(await workDir());
  expect(record.argv.slice(record.argv.indexOf("--max-budget-usd"))).toEqual(["--max-budget-usd", "0.25"]);
  const [name] = await readdir(join(vault, ".thoth/agent/runs"));
  expect(JSON.parse(await readFile(join(vault, ".thoth/agent/runs", name!), "utf8"))).toMatchObject({ task: { maxBudgetUsd: 0.25, timeoutMs: 300_000 }, outcome: { stoppedBy: "budget" } });
  await review.getByRole("button", { name: "Discard all" }).click();
  await expect(page.getByRole("region", { name: "Earlier runs" })).toContainText("Stopped at the spending limit");
  expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe(PLAN);
});
