// @vitest-environment jsdom
/**
 * The assistant's answers and sessions (ADR-0007, amendment of 2026-10-26), on the Node test host with the fake Claude
 * Code CLI: the bubble shows what the agent answered (plain text, copyable) with "No pages were changed" under it; an
 * "Open in a tab" icon opens the run's session tab (one tab per run); the sidebar's Assistant section lists the newest
 * five runs, expands to the rest and opens a run's tab; earlier runs read their answer back from the local transcript
 * (or say it was deleted); a run another window owns is shown read-only. Nothing calls a model.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, RunRecord } from "@thoth/agent-core";
import { newStableId } from "@thoth/domain";
import { cleanup, editorBox, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs, type NodePlatform } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";
import { FAKE_CLAUDE_DIR } from "../../../tests/helpers/agent.ts";
import { setLangPreference } from "../src/strings/index.ts";

const dirs = tempDirs();
let root: string;
let data: string;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  data = await dirs.dir("thoth-ui-sessions-data-");
  await seed(root, { "Notes/Plan.md": "# Plan\n\nWe have a cat.\n", "Diary.md": "# Diary\n" });
});
afterEach(async () => {
  cleanup();
  setLangPreference("system");
  await dirs.cleanup();
});

const MASCOT = /^Thoth assistant/;
const bubble = () => screen.getByRole("dialog", { name: "Ask Thoth" });
const sidebar = () => screen.getByRole("complementary", { name: "Sidebar" });
const section = () => within(sidebar()).findByRole("region", { name: "Assistant" });
const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent);
const currentTab = () => screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
const session = () => screen.getByRole("tabpanel");

function platform(extra: (p: NodePlatform) => void = () => undefined): NodePlatform {
  const p = createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } });
  extra(p);
  return p;
}

async function open(p = platform()): Promise<Harness> {
  const app = await openApp(root, {}, p);
  await screen.findByRole("tree", { name: "Pages in this Private Space" });
  await editorBox();
  return app;
}

async function ask(app: Harness, prompt: string) {
  await app.user.click(await screen.findByRole("button", { name: MASCOT }));
  const dialog = await screen.findByRole("dialog", { name: "Ask Thoth" });
  await waitFor(() => expect(dialog.querySelector<HTMLOptionElement>('option[value="claude"]')!.dataset["state"]).toBe("ready"));
  await app.user.click(within(dialog).getByRole("textbox", { name: "Task" }));
  await app.user.paste(prompt);
  await app.user.click(within(dialog).getByRole("button", { name: "Start" }));
}

/** A finished run as an earlier session left it: its record in the vault and, unless `transcript` is null, its local transcript. */
async function earlierRun(prompt: string, at: number, options: { state?: RunRecord["state"]; transcript?: AgentEvent[] | null } = {}): Promise<string> {
  const id = newStableId(at);
  const record: RunRecord = {
    version: 1,
    id,
    provider: { id: "claude", name: "Claude Code", version: "2.1.310" },
    task: { prompt, model: "sonnet" },
    context: [{ path: "Diary.md", hash: "0".repeat(64), size: 8, kind: "page", via: "selected" }],
    state: options.state ?? "done",
    createdAt: at,
    updatedAt: at,
    outcome: { reason: "exited", code: 0, ok: true, costUsd: 0.01, model: "claude-sonnet-x" },
    changes: [],
  };
  await mkdir(join(root, ".thoth/agent/runs"), { recursive: true });
  await writeFile(join(root, ".thoth/agent/runs", `${id}.json`), JSON.stringify(record, null, 2));
  const events = options.transcript === undefined ? [{ type: "session", tools: [] }, { type: "text", text: `Answer to ${prompt}` }, { type: "result", ok: true, text: `Answer to ${prompt}` }, { type: "exit", reason: "exited", code: 0, signal: null }] : options.transcript;
  if (events !== null) {
    await mkdir(join(data, "agent-history", id), { recursive: true });
    await writeFile(join(data, "agent-history", id, "transcript.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  return id;
}

describe("the answer", () => {
  it("shows what the agent answered in the bubble, as plain text with its line breaks, copyable, with 'No pages were changed' under it", async () => {
    const app = await open();
    await ask(app, "What is on this page?\n@answer It is a <b>diary</b>.\\nOne heading, no text.\n");
    const answer = await within(bubble()).findByRole("region", { name: "Answer" }, { timeout: 15_000 });
    const text = within(answer).getByTestId("agent-answer");
    expect(text.textContent).toBe("It is a <b>diary</b>.\nOne heading, no text.");
    // Text, never markup.
    expect(text.querySelector("b")).toBeNull();
    // Line breaks are kept by the style (jsdom does not load the stylesheet, so it is read here).
    expect(text.className).toBe("agents-answer-text");
    expect(await readFile(join(import.meta.dirname, "../src/features/agents/agents.css"), "utf8")).toMatch(/\.agents-answer-text \{ white-space: pre-wrap;/);
    expect(within(bubble()).getByText("No pages were changed.").className).toContain("muted");
    expect(within(bubble()).queryByText("The agent finished without changing anything.")).toBeNull();
    await app.user.click(within(answer).getByRole("button", { name: "Copy answer" }));
    expect(await navigator.clipboard.readText()).toBe("It is a <b>diary</b>.\nOne heading, no text.");
    expect(within(answer).getByRole("status").textContent).toBe("Copied.");
  });

  it("'Ask again' goes back to the form with the same task and context", async () => {
    const app = await open();
    await ask(app, "Summarise it.\n@answer Short.\n");
    await within(bubble()).findByRole("region", { name: "Answer" }, { timeout: 15_000 });
    await app.user.click(within(bubble()).getByRole("button", { name: "Ask again" }));
    expect((within(bubble()).getByRole("textbox", { name: "Task" }) as HTMLTextAreaElement).value).toBe("Summarise it.\n@answer Short.");
    expect(within(bubble()).getByRole("list", { name: "Context" }).textContent).toContain("Diary");
  });
});

describe("the session tab", () => {
  it("opens from the bubble's 'Open in a tab' icon, while running and after, one tab per run", async () => {
    const app = await open();
    await ask(app, "What is on this page?\n@sleep 400\n@answer A diary.\n");
    const icon = await within(bubble()).findByRole("button", { name: "Open in a tab" });
    expect(icon.getAttribute("data-tip")).toBe("Open in a tab");
    await app.user.click(icon);
    await waitFor(() => expect(currentTab()).toBe("What is on this page?"));
    expect(screen.queryByRole("dialog", { name: "Ask Thoth" })).toBeNull();
    // Live while it runs: the transcript and Cancel.
    expect(within(session()).getByRole("heading", { level: 1, name: "What is on this page?" })).toBeTruthy();
    expect(within(session()).getByRole("button", { name: "Cancel" })).toBeTruthy();
    // Then the answer, in the tab.
    const answer = await within(session()).findByRole("region", { name: "Answer" }, { timeout: 15_000 });
    expect(within(answer).getByTestId("agent-answer").textContent).toBe("A diary.");
    expect(within(session()).getByText("Claude Code", { exact: false })).toBeTruthy();
    expect(session().textContent).toContain("No changes");

    // Opening it again goes to the same tab.
    await app.user.click(screen.getByRole("tab", { name: "Diary" }));
    await app.user.click(screen.getByRole("button", { name: MASCOT }));
    await app.user.click(await within(bubble()).findByRole("button", { name: "Open in a tab" }));
    await waitFor(() => expect(currentTab()).toBe("What is on this page?"));
    expect(tabNames()).toEqual(["Diary", "What is on this page?"]);
  });

  it("comes back after a restart with the answer read from the local transcript", async () => {
    const app = await open();
    await ask(app, "What is on this page?\n@answer A diary, from the transcript.\n");
    await within(bubble()).findByRole("region", { name: "Answer" }, { timeout: 15_000 });
    await app.user.click(within(bubble()).getByRole("button", { name: "Open in a tab" }));
    await waitFor(() => expect(currentTab()).toBe("What is on this page?"));
    cleanup();
    await openApp(root, {}, platform());
    await waitFor(() => expect(currentTab()).toBe("What is on this page?"));
    const answer = await within(session()).findByRole("region", { name: "Answer" });
    expect(within(answer).getByTestId("agent-answer").textContent).toBe("A diary, from the transcript.");
  });

  it("says when the saved details were deleted under the history setting", async () => {
    await earlierRun("An old question", Date.now() - 60_000, { transcript: null });
    const app = await open();
    await app.user.click(await within(await section()).findByRole("button", { name: /An old question/ }));
    await waitFor(() => expect(currentTab()).toBe("An old question"));
    expect((await within(session()).findByTestId("agent-details-gone")).textContent).toBe("The answer and transcript of this run were deleted, as Settings → Thoth assistant → Run history says. The list of runs keeps the task and the outcome.");
    expect(within(session()).queryByRole("region", { name: "Answer" })).toBeNull();
  });

  it("is read-only for a run another window owns: no Cancel, and it says where to go", async () => {
    await earlierRun("Running elsewhere", Date.now() - 1000, { state: "running", transcript: [{ type: "session", tools: [] }, { type: "text", text: "Looking…" }] });
    // Another window has this Private Space open: this one does not recover (and so does not end) that window's run.
    const app = await open(platform((p) => p.sharedWith.push(root)));
    const row = await within(await section()).findByRole("button", { name: /Running elsewhere/ });
    expect(row.textContent).toContain("Running");
    await app.user.click(row);
    expect((await within(session()).findByTestId("agent-elsewhere")).textContent).toBe("This run belongs to another window. Follow it, cancel it or review its changes there.");
    expect(within(session()).queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});

describe("the Assistant section in the sidebar", () => {
  it("lists the five newest runs, expands to the rest and collapses again, and opens a run's tab", async () => {
    const now = Date.now();
    for (let i = 1; i <= 7; i++) await earlierRun(`Question ${i}\nwith more lines`, now - (8 - i) * 60_000);
    const app = await open();
    const list = await within(await section()).findByRole("list");
    const rows = () => within(list).getAllByRole("button").map((b) => b.querySelector(".agents-row-task")!.textContent);
    expect(rows()).toEqual(["Question 7", "Question 6", "Question 5", "Question 4", "Question 3"]);
    // It is one of the sidebar's reorderable sections, after the Private Space (ADR-0019 amendment).
    expect((await section()).getAttribute("data-section")).toBe("agents");
    expect(within(await section()).getByRole("button", { name: "Options for the section Assistant" })).toBeTruthy();
    const order = [...sidebar().querySelectorAll(".side-section")].map((el) => el.getAttribute("data-section"));
    expect(order[0]).toBe("private");
    expect(order[order.length - 1]).toBe("agents");
    const more = within(await section()).getByRole("button", { name: "Show 2 more" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await app.user.click(more);
    expect(rows()).toEqual(["Question 7", "Question 6", "Question 5", "Question 4", "Question 3", "Question 2", "Question 1"]);
    const less = within(await section()).getByRole("button", { name: "Show less" });
    expect(less.getAttribute("aria-expanded")).toBe("true");
    await app.user.click(less);
    expect(rows()).toHaveLength(5);

    await app.user.click(within(list).getByRole("button", { name: /Question 6/ }));
    await waitFor(() => expect(currentTab()).toBe("Question 6"));
    expect(within(list).getByRole("button", { name: /Question 6/ }).getAttribute("aria-current")).toBe("page");
    const answer = await within(session()).findByRole("region", { name: "Answer" });
    expect(within(answer).getByTestId("agent-answer").textContent).toBe("Answer to Question 6\nwith more lines");
    expect(session().textContent).toContain("Question 6\nwith more lines");
  });

  it("is not there without agents", async () => {
    await earlierRun("A question", Date.now() - 1000);
    await open(createNodePlatform({ vault: root }));
    expect(within(sidebar()).queryByRole("region", { name: "Assistant" })).toBeNull();
  });

  it("is not there before the first run, and a new run joins it, marked while it runs", async () => {
    const app = await open();
    expect(within(sidebar()).queryByRole("region", { name: "Assistant" })).toBeNull();
    await ask(app, "Fresh question\n@sleep 500\n");
    const row = await within(await section()).findByRole("button", { name: /Fresh question/ });
    await waitFor(() => expect(row.textContent).toContain("Running"));
    const region = await section();
    await waitFor(() => expect(within(region).getByRole("button", { name: /Fresh question/ }).textContent).not.toContain("Running"), { timeout: 15_000 });
  });

  it("speaks Thai", async () => {
    setLangPreference("th");
    for (let i = 0; i < 5; i++) await earlierRun(`ข้อ ${i}`, Date.now() - 10_000 + i);
    await earlierRun("คำถาม", Date.now() - 1000);
    await openApp(root, {}, platform());
    await screen.findByRole("tree", { name: "หน้าใน Private Space นี้" });
    const region = await screen.findByRole("region", { name: "ผู้ช่วย" });
    expect(within(region).getByRole("button", { name: /คำถาม/ }).textContent).toBe("คำถาม");
    expect(within(region).getByRole("button", { name: "แสดงเพิ่มอีก 1 รายการ" }).getAttribute("aria-expanded")).toBe("false");
  });
});
