/**
 * Phase 4 acceptance (docs/architecture/implementation-plan.md): the real desktop UI in Chromium, on the real Rust
 * host (`thoth-host-stdio` through the dev bridge), with the FAKE Claude Code CLI (`--agent-search-dir`), so no
 * model is called. Pick a page → start → streamed transcript → review → apply exact bytes on disk; then cancel.
 * The fake records what it was given: only the picked page in its working directory, that directory as its cwd,
 * the policy's argument list, and no argument or environment variable naming the vault.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_CLAUDE_DIR, alive, fakeRecord, waitDead } from "../helpers/agent.ts";
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

test.beforeEach(async ({ page, context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-agent-")));
  vault = join(scratch, "Vault");
  data = join(scratch, "data");
  await mkdir(join(vault, "Notes"), { recursive: true });
  await writeFile(join(vault, "Notes/Plan.md"), PLAN);
  await writeFile(join(vault, "Notes/Ideas.md"), "# Ideas\n");
  await writeFile(join(vault, "Diary.md"), "# Diary\n\nPrivate.\n");
  bridge = await startBridge({
    dist: built.dist,
    bridgeDir: built.bridgeDir,
    host: {
      binary: built.binary,
      pickVault: vault,
      dataDir: data,
      agentSearchDirs: [FAKE_CLAUDE_DIR],
      // Neither may reach the CLI: Thoth's own variables, and anything naming the open vault.
      env: { THOTH_E2E_SECRET: "do-not-pass", NOTES_FOR_E2E: join(vault, "Notes") },
    },
  });
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  await expect(page.getByRole("tree", { name: "Pages in this Private Space" })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await page.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

async function workDir(): Promise<string> {
  await expect.poll(async () => (await readdir(join(data, "agent-runs")).catch(() => [])).length).toBe(1);
  return join(data, "agent-runs", (await readdir(join(data, "agent-runs")))[0]!, "work");
}

/** No serious or critical axe findings in the Agent Hub as it is now. */
async function axe(page: Page) {
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
  expect(record.argv).toEqual(JSON.parse(await readFile(join(FAKE_CLAUDE_DIR, "../fixtures/argv.json"), "utf8")).cases[0].argv);
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
