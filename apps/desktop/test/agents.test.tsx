// @vitest-environment jsdom
/**
 * The Agent Hub UI (Phase 4) on the Node test host with the fake Claude Code CLI: detection with fix instructions,
 * picking pages, start, the streamed transcript, review with per-file approval, apply (exact bytes on disk), the
 * conflict path with a kept copy, cancel, and the sidebar's "Ask an agent…". Never a real model.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";
import { FAKE_CLAUDE_DIR, fakeRecord } from "../../../tests/helpers/agent.ts";
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

async function open(searchDirs = [FAKE_CLAUDE_DIR]): Promise<Harness> {
  const app = await openApp(root, {}, createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs } }));
  await screen.findByRole("tree", { name: "Pages in this Private Space" });
  await app.user.click(screen.getByRole("button", { name: "Agent Hub" }));
  await screen.findByRole("heading", { level: 1, name: "Agent Hub" });
  return app;
}

const status = () => screen.getByTestId("agent-status");

async function startTask(app: Harness, pages: string[], prompt: string) {
  await waitFor(() => expect(status().dataset["state"]).toBe("ready"));
  const picker = screen.getByRole("group", { name: "Pages for the agent" });
  for (const name of pages) await app.user.click(await within(picker).findByRole("checkbox", { name }));
  // userEvent types "{" as a key descriptor; directives have none, but paste keeps the text exact.
  await app.user.click(screen.getByRole("textbox", { name: "Task" }));
  await app.user.paste(prompt);
  await app.user.click(screen.getByRole("button", { name: "Start" }));
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
