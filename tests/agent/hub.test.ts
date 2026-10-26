/**
 * Phase 4 acceptance (docs/architecture/implementation-plan.md): the Agent Hub end to end with the fake Claude Code
 * CLI, on the real Rust host (stdio harness, vault on Rust ports) and on the Node test host.
 *
 * - detection of a missing, present and signed-out CLI;
 * - start, stream and cancel (the whole process group);
 * - only the selected context is in the working directory, the CLI's cwd is that directory, and no argument or
 *   environment variable names the vault;
 * - proposed changes are never applied without approval, and exactly the approved bytes land;
 * - a page changed in the vault meanwhile is a conflict, never overwritten;
 * - untrusted output (`.thoth/`, symlinks) is never offered or written; recovery after a crash.
 */
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@thoth/domain";
import { AgentHub, createWorkspaceReader, LimitError, MAX_EXCERPT_CHARS, WorkspaceContextError, type AgentEvent, type AgentHost, type RunRecord, type StartTask } from "@thoth/agent-core";
import { NodeAgentHost } from "@thoth/agent-core/node";
import { createClaudeProvider } from "@thoth/agent-claude";
import { Vault } from "@thoth/local-store";
import { NodeSqlDriver, NodeVaultFs } from "@thoth/local-store/node";
import { openRemoteVault, remoteAgents } from "@thoth/platform/remote";
import type { StdioTransport } from "@thoth/platform/stdio";
import type { VaultConnection } from "@thoth/platform";
import { buildHarness, rustTransport, tempDir } from "../ports/harness.ts";
import { WorkspaceClient, type SendRequest, type SendResponse } from "@thoth/workspace-client";
import { FAKE_CLAUDE_DIR, fakeRecord, waitDead } from "../helpers/agent.ts";
import { FakeServers } from "../helpers/fake-servers.ts";

const ARGV = (JSON.parse(await readFile(join(FAKE_CLAUDE_DIR, "../fixtures/argv.json"), "utf8")) as { cases: { argv: string[] }[] }).cases[0]!.argv;
const PLAN = "# Plan\n\nWe have a cat. See ![pic](../Assets/pic.png).\n";
const PIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);

interface Env {
  root: string;
  data: string;
  vault: Vault;
  host: AgentHost;
  /** A fresh host on the same data folder, as after a restart. */
  restart(): Promise<AgentHost>;
  close(): Promise<void>;
}

/** Extra environment for the host process: a Thoth variable and one naming the vault, neither may reach the CLI. */
const leaky = (root: string) => ({ THOTH_AGENT_TEST_SECRET: "do-not-pass", NOTES_DIR_FOR_TEST: join(root, "Notes") });

async function seed(root: string) {
  await mkdir(join(root, "Notes"), { recursive: true });
  await mkdir(join(root, "Assets"), { recursive: true });
  await writeFile(join(root, "Notes/Plan.md"), PLAN);
  await writeFile(join(root, "Notes/Other.md"), "# Other\n");
  await writeFile(join(root, "Assets/pic.png"), PIC);
  await writeFile(join(root, "Assets/unused.png"), PIC);
  await writeFile(join(root, "Diary.md"), "# Diary\n\nPrivate.\n");
}

const runtimes: { name: string; open(root: string, search: string[]): Promise<Env> }[] = [
  {
    name: "Rust host",
    async open(root, search) {
      const data = await tempDir("thoth-agent-data-");
      const transports: StdioTransport[] = [];
      const connect = async () => {
        const t = await rustTransport({ allowRoots: [root], dataDir: data, agentSearchDirs: search, env: leaky(root) });
        transports.push(t);
        return t;
      };
      const transport = await connect();
      const connection: VaultConnection = await openRemoteVault(transport, root);
      const { vault } = await Vault.open({ fs: connection.fs, sql: connection.sql });
      return {
        root,
        data,
        vault,
        host: remoteAgents(transport),
        restart: async () => remoteAgents(await connect()),
        async close() {
          await vault.close();
          await connection.close();
          for (const t of transports) await t.close();
          await rm(data, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: "Node host",
    async open(root, search) {
      const data = await tempDir("thoth-agent-data-");
      Object.assign(process.env, leaky(root));
      const fs = new NodeVaultFs(root);
      await fs.mkdirp(".thoth");
      const { vault } = await Vault.open({ fs, sql: new NodeSqlDriver(join(root, ".thoth", "index.sqlite")) });
      const hosts: NodeAgentHost[] = [];
      const make = () => {
        const h = new NodeAgentHost({ dataDir: data, searchDirs: search, excludeRoots: () => [root] });
        hosts.push(h);
        return h;
      };
      return {
        root,
        data,
        vault,
        host: make(),
        restart: async () => make(),
        async close() {
          for (const h of hosts) await h.close();
          await vault.close();
          for (const key of Object.keys(leaky(root))) delete process.env[key];
          await rm(data, { recursive: true, force: true });
        },
      };
    },
  },
];

beforeAll(() => buildHarness(), 600_000);

describe.each(runtimes)("Agent Hub on the $name", (runtime) => {
  let root: string;
  let env: Env;
  let hub: AgentHub;
  let fake: FakeServers;
  let retention = 30;

  /** The workspace client the desktop would have: every request goes through the fake host, which authorizes it. */
  const reader = () =>
    createWorkspaceReader(
      (server) =>
        new WorkspaceClient(async (req: SendRequest): Promise<SendResponse> => {
          const result = await fake.call({ server, method: req.method, path: req.path, ...(req.query ? { query: req.query } : {}), ...(req.headers ? { headers: req.headers } : {}) }, req.body);
          return result as SendResponse;
        }),
    );
  const makeHub = (host: AgentHost, options: { now?: () => number } = {}) =>
    new AgentHub({ vault: env.vault, host, providers: [createClaudeProvider(host)], workspace: reader(), retentionDays: () => retention, transcriptFlushMs: 50, ...options });

  beforeEach(async () => {
    root = await tempDir("thoth-agent-vault-");
    await seed(root);
    env = await runtime.open(root, [FAKE_CLAUDE_DIR]);
    fake = new FakeServers();
    retention = 30;
    hub = makeHub(env.host);
  });

  afterEach(async () => {
    await hub.dispose();
    await env.close();
    delete process.env["FAKE_CLAUDE_LOGGED_OUT"];
    await rm(root, { recursive: true, force: true });
  });

  async function runTask(prompt: string, selection: string[] = ["Notes/Plan.md"], extra: Partial<StartTask> = {}, using: AgentHub = hub) {
    const events: AgentEvent[] = [];
    const before = new Set(await readdir(join(env.data, "agent-runs")).catch(() => [] as string[]));
    const started = await using.start({ provider: "claude", prompt, selection, ...extra }, (e) => events.push(e));
    const runDir = (await readdir(join(env.data, "agent-runs"))).find((n) => !before.has(n))!;
    const work = join(env.data, "agent-runs", runDir, "work");
    return { started, events, work, runDir: join(env.data, "agent-runs", runDir) };
  }

  it("detects a missing, a present and a signed-out CLI", async () => {
    expect(await hub.provider("claude").detect()).toMatchObject({ state: "ready", version: "2.1.310", path: join(FAKE_CLAUDE_DIR, "claude") });
    const empty = await tempDir("thoth-agent-nobin-");
    const missing = await runtime.open(root, [empty]);
    try {
      expect(await createClaudeProvider(missing.host).detect()).toEqual({ state: "missing", searched: [empty] });
    } finally {
      await missing.close();
      await rm(empty, { recursive: true, force: true });
    }
    process.env["FAKE_CLAUDE_LOGGED_OUT"] = "1";
    const out = await runtime.open(root, [FAKE_CLAUDE_DIR]);
    try {
      expect(await createClaudeProvider(out.host).detect()).toMatchObject({ state: "not_logged_in" });
      const other = new AgentHub({ vault: out.vault, host: out.host, providers: [createClaudeProvider(out.host)] });
      await expect(other.start({ provider: "claude", prompt: "x", selection: ["Diary.md"] })).rejects.toThrow(/not ready/);
    } finally {
      await out.close();
    }
  });

  it("quotes selected text to the CLI after the task, and keeps only the task in the run record", async () => {
    const quote = "We have a cat. ".repeat(300); // longer than the limit: cut to it
    const { started, work } = await runTask("Rewrite this.\n@sleep 300", ["Notes/Plan.md"], { excerpt: { text: quote, from: "Notes/Plan.md" } });
    const record = await fakeRecord(work); // before it ends: a run that proposed nothing deletes its folder
    const finished = await started.finished;
    expect(record.stdin.startsWith("Rewrite this.\n@sleep 300\n\nSelected text (from Notes/Plan.md):\n\"\"\"\n")).toBe(true);
    expect(record.stdin).toContain(`"""\n${quote.slice(0, MAX_EXCERPT_CHARS)}\n"""`);
    expect(record.stdin).not.toContain(quote.slice(0, MAX_EXCERPT_CHARS + 1));
    // No page text in the vault's record (spec §3.3): the task is the user's own words.
    expect(started.record.task.prompt).toBe("Rewrite this.\n@sleep 300");
    expect(finished.task.prompt).toBe("Rewrite this.\n@sleep 300");
    const saved = await readFile(join(root, ".thoth/agent/runs", `${finished.id}.json`), "utf8");
    expect(saved).not.toContain("We have a cat. We have");
  });

  it("stages only the selected context, streams, and applies exactly the approved bytes", async () => {
    const { started, events, work, runDir } = await runTask("Make it a dog.\n@replace Notes/Plan.md :: cat => dog\n@write Notes/Summary.md :: # Summary\\nDogs.\\n");
    expect(started.record.state).toBe("running");
    expect(started.record.context.map((c) => [c.path, c.via, c.hash])).toEqual([
      ["Assets/pic.png", "linked", sha256Hex(PIC)],
      ["Notes/Plan.md", "selected", sha256Hex(PLAN)],
    ]);
    const finished = await started.finished;

    // What the CLI saw.
    const record = await fakeRecord(work);
    expect(record.files).toEqual([
      { path: "Assets", kind: "directory" },
      { path: "Assets/pic.png", kind: "file" },
      { path: "Notes", kind: "directory" },
      { path: "Notes/Plan.md", kind: "file" },
    ]);
    expect(record.cwd).toBe(work);
    expect(record.argv).toEqual(ARGV);
    expect(record.stdin).toContain("Make it a dog.");
    expect(Object.keys(record.env).filter((k) => /^THOTH_/i.test(k))).toEqual([]);
    expect(Object.entries(record.env).filter(([, v]) => v.includes(root))).toEqual([]);
    expect(record.argv.filter((a) => a.includes(root))).toEqual([]);
    expect(record.env["PWD"]).toBe(work);

    // Streamed events, in order.
    expect(events.map((e) => e.type)).toEqual(["session", "tool", "tool", "text", "result", "exit"]);
    expect(events[1]).toMatchObject({ type: "tool", tool: "Edit", target: "Notes/Plan.md" });
    expect(events[2]).toMatchObject({ type: "tool", tool: "Write", target: "Notes/Summary.md" });
    expect(events.at(-1)).toEqual({ type: "exit", reason: "exited", code: 0, signal: null });

    // Review: nothing has touched the vault yet.
    expect(finished.state).toBe("review");
    expect(finished.outcome).toMatchObject({ reason: "exited", code: 0, ok: true, costUsd: 0.0012 });
    const changes = hub.changes(finished.id)!;
    expect(changes.map((c) => [c.path, c.change, c.stale, c.problem])).toEqual([
      ["Notes/Plan.md", "modified", false, undefined],
      ["Notes/Summary.md", "added", false, undefined],
    ]);
    expect(changes[0]!.before).toBe(PLAN);
    expect(changes[0]!.after).toBe(PLAN.replace("cat", "dog"));
    expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe(PLAN);
    await expect(stat(join(root, "Notes/Summary.md"))).rejects.toThrow();

    // Approve one of the two.
    const results = await hub.apply(finished.id, ["Notes/Plan.md"]);
    expect(results).toEqual([{ path: "Notes/Plan.md", result: "applied", hash: sha256Hex(PLAN.replace("cat", "dog")) }]);
    expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe("# Plan\n\nWe have a dog. See ![pic](../Assets/pic.png).\n");
    await expect(stat(join(root, "Notes/Summary.md"))).rejects.toThrow();
    expect(new Uint8Array(await readFile(join(root, "Assets/pic.png")))).toEqual(PIC);
    expect(await readFile(join(root, "Diary.md"), "utf8")).toBe("# Diary\n\nPrivate.\n");
    await expect(stat(runDir)).rejects.toThrow(); // the working directory is gone

    const [saved] = await hub.history();
    expect(saved).toMatchObject<Partial<RunRecord>>({ id: finished.id, state: "applied", provider: { id: "claude", name: "Claude Code", version: "2.1.310" }, task: { prompt: expect.stringContaining("Make it a dog.") } });
    expect(saved!.changes.map((c) => [c.path, c.decision, c.result])).toEqual([
      ["Notes/Plan.md", "approved", "applied"],
      ["Notes/Summary.md", "rejected", undefined],
    ]);
    // Metadata only: no page text and no agent output in the record.
    const raw = await readFile(join(root, ".thoth/agent/runs", `${finished.id}.json`), "utf8");
    expect(raw).not.toContain("We have a");
    expect(raw).not.toContain("Done.");
  });

  it("never applies anything without approval: discard writes nothing", async () => {
    const { started } = await runTask("@replace Notes/Plan.md :: cat => dog\n@delete Notes/Plan.md\n");
    const finished = await started.finished;
    expect(hub.changes(finished.id)!.map((c) => [c.path, c.change])).toEqual([["Notes/Plan.md", "deleted"]]);
    expect(await hub.apply(finished.id, [])).toEqual([]);
    expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe(PLAN);
    expect((await hub.history())[0]!.changes[0]).toMatchObject({ decision: "rejected" });

    const second = await (await runTask("@replace Notes/Plan.md :: cat => fox\n")).started.finished;
    await hub.discard(second.id);
    expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe(PLAN);
    expect((await hub.history())[0]).toMatchObject({ id: second.id, state: "discarded" });
    await expect(hub.apply(second.id, ["Notes/Plan.md"])).rejects.toThrow(/no changes waiting/);
  });

  it("a page changed in the vault since staging is a conflict, never an overwrite; the agent's version can be kept as a copy", async () => {
    const { started } = await runTask("@replace Notes/Plan.md :: cat => dog\n@delete Notes/Other.md\n", ["Notes"]);
    const finished = await started.finished;
    const edited = "# Plan\n\nEdited by me meanwhile.\n";
    await writeFile(join(root, "Notes/Plan.md"), edited);
    await writeFile(join(root, "Notes/Other.md"), "# Other, edited\n");
    const results = await hub.apply(finished.id, ["Notes/Plan.md", "Notes/Other.md"]);
    expect(results).toEqual([
      { path: "Notes/Other.md", result: "conflict" },
      { path: "Notes/Plan.md", result: "conflict" },
    ]);
    expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe(edited);
    expect(await readFile(join(root, "Notes/Other.md"), "utf8")).toBe("# Other, edited\n");

    const copy = await hub.saveCopy(finished.id, "Notes/Plan.md", (n) => `Notes/Plan (agent${n === 1 ? "" : ` ${n}`}).md`);
    expect(copy).toBe("Notes/Plan (agent).md");
    expect(await readFile(join(root, copy), "utf8")).toBe(PLAN.replace("cat", "dog"));
    expect((await hub.history())[0]!.changes.find((c) => c.path === "Notes/Plan.md")).toMatchObject({ result: "copied", copy });
  });

  it("marks a change stale when the vault page moved on before review", async () => {
    const { started, work } = await runTask("@sleep 400\n@replace Notes/Plan.md :: cat => dog\n");
    await fakeRecord(work);
    await writeFile(join(root, "Notes/Plan.md"), "# Plan\n\nChanged while the agent ran.\n");
    const finished = await started.finished;
    expect(hub.changes(finished.id)![0]).toMatchObject({ path: "Notes/Plan.md", stale: true, before: "# Plan\n\nChanged while the agent ran.\n" });
    expect(await hub.apply(finished.id, ["Notes/Plan.md"])).toEqual([{ path: "Notes/Plan.md", result: "conflict" }]);
  });

  it("cancel stops the CLI and its children, keeps the vault as it was, and deletes the working directory", async () => {
    const { started, work, runDir, events } = await runTask("@replace Notes/Plan.md :: cat => dog\n@hang\n");
    let record = await fakeRecord(work);
    while (record.grandchild === null) record = await fakeRecord(work);
    await hub.cancel(started.record.id);
    const finished = await started.finished;
    expect(finished.state).toBe("cancelled");
    expect(finished.outcome).toMatchObject({ reason: "cancelled", ok: false });
    expect(events.at(-1)).toMatchObject({ type: "exit", reason: "cancelled" });
    await waitDead(record.pid);
    await waitDead(record.grandchild!);
    await expect(stat(runDir)).rejects.toThrow();
    expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe(PLAN);
    expect((await hub.history())[0]).toMatchObject({ state: "cancelled", changes: [] });
  });

  it("never offers or writes untrusted output: .thoth/, symlinks, escapes", async () => {
    const { started } = await runTask(`@write .thoth/config.json :: {"evil":true}\n@mkdir sub/.Thoth\n@write sub/.Thoth/x.json :: {}\n@symlink Notes/link.md -> ${join(root, "Diary.md")}\n@write ../escape.md :: outside\n`);
    const finished = await started.finished;
    const changes = hub.changes(finished.id)!;
    expect(changes.map((c) => [c.path, c.problem])).toEqual([
      [".thoth", "reserved"],
      ["Notes/link.md", "symlink"],
      ["sub/.Thoth", "reserved"],
    ]);
    const config = await readFile(join(root, ".thoth/config.json"), "utf8");
    expect(await hub.apply(finished.id, changes.map((c) => c.path))).toEqual([]);
    expect(await readFile(join(root, ".thoth/config.json"), "utf8")).toBe(config);
    await expect(stat(join(root, "Notes/link.md"))).rejects.toThrow();
    await expect(stat(join(root, "escape.md"))).rejects.toThrow();
  });

  it("refuses a selection it cannot honour instead of staging less", async () => {
    await expect(hub.start({ provider: "claude", prompt: "x", selection: ["Nowhere.md"] })).rejects.toThrow(/not_found/);
    await expect(hub.start({ provider: "claude", prompt: "x", selection: [".thoth"] })).rejects.toThrow(/reserved/);
    await expect(hub.start({ provider: "claude", prompt: "x", selection: [] })).rejects.toThrow(/empty/);
    await expect(hub.start({ provider: "claude", prompt: "   ", selection: ["Diary.md"] })).rejects.toThrow(/Write a task/);
    expect(await readdir(join(env.data, "agent-runs")).catch(() => [])).toEqual([]);
    expect(await hub.history()).toEqual([]);
  });

  it("after a crash, recovery marks unfinished runs interrupted and deletes their working directories", async () => {
    const { started, runDir, work } = await runTask("@hang\n");
    await fakeRecord(work);
    // The app "crashes": a new session on the same vault and data folder.
    const host = await env.restart();
    const next = new AgentHub({ vault: env.vault, host, providers: [createClaudeProvider(host)] });
    await hub.cancel(started.record.id); // the old process would be gone with the old host
    await started.finished;
    const crashed = (await env.vault.readRecord(`.thoth/agent/runs/${started.record.id}.json`)) as RunRecord;
    await env.vault.writeRecord(`.thoth/agent/runs/${started.record.id}.json`, { ...crashed, state: "running" });
    await mkdir(join(env.data, "agent-runs", "run_0123456789abcdef0123456789abcdef", "work"), { recursive: true });
    const recovered = await next.recover();
    expect(recovered.interrupted).toEqual([started.record.id]);
    expect(recovered.swept).toBeGreaterThanOrEqual(1);
    expect((await next.history())[0]).toMatchObject({ id: started.record.id, state: "interrupted" });
    expect(await readdir(join(env.data, "agent-runs"))).toEqual([]);
    await expect(stat(runDir)).rejects.toThrow();
  });

  // ------------------------------------------------------------- conversations

  describe("conversations", () => {
    /** Runs a turn and returns what the fake CLI read on stdin (read before it ends: a run that changed nothing deletes its folder). */
    async function turn(prompt: string, extra: Partial<StartTask> = {}, using: AgentHub = hub) {
      const { started, work } = await runTask(`${prompt}\n@sleep 300`, ["Notes/Plan.md"], extra, using);
      const seen = await fakeRecord(work);
      const finished = await started.finished;
      return { record: finished, stdin: seen.stdin, argv: seen.argv };
    }
    const saved = (id: string) => readFile(join(root, ".thoth/agent/runs", `${id}.json`), "utf8");

    it("a follow-up quotes the earlier questions and answers, oldest first; the record keeps only the new question, the conversation and the turn; the flags do not change", async () => {
      const first = await turn("What is on the page?\n@answer A plan about a cat.");
      expect(first.record.conversation).toEqual({ id: first.record.id, turn: 1 });
      expect(first.stdin).not.toContain("Earlier turn");

      const second = await turn("Who owns the cat?\n@answer Nobody says.", { followUp: first.record.id });
      // The earlier question and answer came first, then the new question.
      const q1 = second.stdin.indexOf("What is on the page?");
      const a1 = second.stdin.indexOf("A plan about a cat.");
      const q2 = second.stdin.indexOf("Who owns the cat?");
      expect(q1).toBeGreaterThan(-1);
      expect(q1).toBeLessThan(a1);
      expect(a1).toBeLessThan(q2);
      expect(second.stdin.endsWith("--- End of earlier turns ---\n\nWho owns the cat?\n@answer Nobody says.\n@sleep 300")).toBe(true);
      // Only the earlier turn's own directives were quoted, not acted on: this turn answered for itself.
      expect(hub.answer(second.record.id)).toBe("Nobody says.");
      // The same flags as the first turn (no --resume, --continue or session id; the policy's fixture list).
      expect(first.argv).toEqual(ARGV);
      expect(second.argv).toEqual(first.argv);

      expect(second.record.task.prompt).toBe("Who owns the cat?\n@answer Nobody says.\n@sleep 300");
      expect(second.record.conversation).toEqual({ id: first.record.id, turn: 2, context: { earlier: 1, sent: 1, deleted: 0, notAllowed: 0 } });
      const raw = await saved(second.record.id);
      expect(raw).not.toContain("What is on the page?");
      expect(raw).not.toContain("A plan about a cat.");

      // Turn 3, asked from any turn of the conversation: both earlier turns, oldest first.
      const third = await turn("And its name?", { followUp: second.record.id });
      expect(third.stdin.indexOf("What is on the page?")).toBeLessThan(third.stdin.indexOf("Who owns the cat?"));
      expect(third.stdin.indexOf("Nobody says.")).toBeLessThan(third.stdin.indexOf("And its name?"));
      expect(third.record.conversation).toMatchObject({ id: first.record.id, turn: 3, context: { earlier: 2, sent: 2 } });
      const rawThird = await saved(third.record.id);
      for (const text of ["What is on the page?", "A plan about a cat.", "Who owns the cat?", "Nobody says."]) expect(rawThird).not.toContain(text);
    });

    it("after a restart the answers come from the local transcripts, and a turn whose transcript was deleted is left out", async () => {
      const first = await turn("First question?\n@answer First answer.");
      const second = await turn("Second question?\n@answer Second answer.", { followUp: first.record.id });
      await hub.dispose();
      const host = await env.restart();
      hub = makeHub(host);
      await host.history.delete(first.record.id);
      const third = await turn("Third question?", { followUp: second.record.id });
      expect(third.stdin).not.toContain("First question?");
      expect(third.stdin).not.toContain("First answer.");
      expect(third.stdin.indexOf("Second question?")).toBeLessThan(third.stdin.indexOf("Second answer."));
      expect(third.record.conversation).toEqual({ id: first.record.id, turn: 3, context: { earlier: 2, sent: 1, deleted: 1, notAllowed: 0 } });
    });

    it("keeps the newest turns that fit the prompt limit", async () => {
      // Two answers of 12 000 characters: with the new question only the newer fits in 20 000.
      const first = await turn("Oldest?\n@answer-long 12000");
      const second = await turn("Middle?\n@answer-long 12000", { followUp: first.record.id });
      const third = await turn("Newest?", { followUp: second.record.id });
      expect(third.stdin).not.toContain("Oldest?");
      expect(third.stdin).toContain("Middle?");
      expect(third.record.conversation?.context).toEqual({ earlier: 2, sent: 1, deleted: 0, notAllowed: 0 });
    });

    it("waits while the last turn runs or waits for review, and refuses a conversation it does not know", async () => {
      const running = await runTask("@sleep 800\n@replace Notes/Plan.md :: cat => dog\n");
      await expect(hub.start({ provider: "claude", prompt: "Next?", selection: ["Notes/Plan.md"], followUp: running.started.record.id })).rejects.toThrow(/still running|waiting for review/);
      const review = await running.started.finished;
      expect(review.state).toBe("review");
      await expect(hub.start({ provider: "claude", prompt: "Next?", selection: ["Notes/Plan.md"], followUp: review.id })).rejects.toThrow(/waiting for review/);
      await hub.discard(review.id);
      const next = await turn("Next?", { followUp: review.id });
      expect(next.record.conversation).toMatchObject({ id: review.id, turn: 2 });
      await expect(hub.start({ provider: "claude", prompt: "x", selection: ["Notes/Plan.md"], followUp: "01900000-0000-7000-8000-000000000000" })).rejects.toThrow(/not in the history/);
      expect(await readdir(join(env.data, "agent-runs")).catch(() => [])).toEqual([]);
    });

    it("continues an older run that has no conversation as its turn 1", async () => {
      const first = await turn("Old question?\n@answer Old answer.");
      const old = JSON.parse(await saved(first.record.id)) as RunRecord;
      delete old.conversation;
      await env.vault.writeRecord(`.thoth/agent/runs/${first.record.id}.json`, old);
      const next = await turn("New question?", { followUp: first.record.id });
      expect(next.stdin.indexOf("Old answer.")).toBeLessThan(next.stdin.indexOf("New question?"));
      expect(next.record.conversation).toMatchObject({ id: first.record.id, turn: 2 });
    });
  });
  // ------------------------------------------------------------------ context

  it("gives the whole Private Space when asked, without .thoth/, and the agent's edits still need approval", async () => {
    const { started, work } = await runTask("Tidy.\n@replace Diary.md :: Private => Tidy\n@write Brand-new.md :: # New\\n", [], { wholeSpace: true });
    expect(started.record.task.wholeSpace).toBe(true);
    expect(started.record.context.map((c) => [c.path, c.via])).toEqual([
      ["Assets/pic.png", "space"],
      ["Assets/unused.png", "space"],
      ["Diary.md", "space"],
      ["Notes/Other.md", "space"],
      ["Notes/Plan.md", "space"],
    ]);
    const finished = await started.finished;
    expect((await fakeRecord(work)).files.map((f) => f.path)).toEqual(["Assets", "Assets/pic.png", "Assets/unused.png", "Diary.md", "Notes", "Notes/Other.md", "Notes/Plan.md"]);
    expect(finished.state).toBe("review");
    expect(await readFile(join(root, "Diary.md"), "utf8")).toBe("# Diary\n\nPrivate.\n");
    expect(await hub.apply(finished.id, ["Diary.md"])).toEqual([{ path: "Diary.md", result: "applied", hash: sha256Hex("# Diary\n\nTidy.\n") }]);
    await expect(stat(join(root, "Brand-new.md"))).rejects.toThrow();
    expect(await readFile(join(root, "Diary.md"), "utf8")).toBe("# Diary\n\nTidy.\n");
  });

  it("respects the staging limits for the whole Private Space", async () => {
    const small = new AgentHub({ vault: env.vault, host: env.host, providers: [createClaudeProvider(env.host)], staging: { maxFiles: 3, maxFileBytes: 1000, maxTotalBytes: 1000 } });
    await expect(small.start({ provider: "claude", prompt: "x", selection: [], wholeSpace: true })).rejects.toMatchObject({ problem: { code: "too_many", limit: 3 } });
    expect(await readdir(join(env.data, "agent-runs")).catch(() => [])).toEqual([]);
  });

  describe("workspace pages", () => {
    let server: string;

    beforeEach(() => {
      server = fake.connect({ url: "http://127.0.0.1:9", tokens: ["t"] });
    });

    const team = () => {
      const ws = fake.addWorkspace(server, { id: "ws_team", name: "Team Docs", role: "viewer" });
      const spec = fake.writeAsOther(ws, { title: "Spec", markdown: "# Spec\n\nRoadmap: ship in May.\n" });
      const other = fake.writeAsOther(ws, { title: "Budget", markdown: "# Budget\n\n42.\n" });
      return { ws, spec, other, refs: [{ server, workspace: ws.id, page: spec.id }, { server, workspace: ws.id, page: other.id }] };
    };
    const writes = () => fake.calls.filter((c) => c.method !== "GET");

    it("are included read-only: a separate folder, no write permission, and the agent is told they are for reading", async () => {
      const { ws, spec, refs } = team();
      const { started, work } = await runTask("Summarize the spec.\n@say reading\n@sleep 300\n", ["Notes/Plan.md"], { workspacePages: refs });
      const record = await fakeRecord(work); // before it ends: a run that proposed nothing deletes its folder
      expect((await stat(join(work, "workspace/Team Docs/Spec.md"))).mode & 0o222).toBe(0);
      expect(await readFile(join(work, "workspace/Team Docs/Spec.md"), "utf8")).toBe("# Spec\n\nRoadmap: ship in May.\n");
      const finished = await started.finished;
      expect(started.record.context.map((c) => [c.path, c.via, c.readOnly ?? false])).toEqual([
        ["Assets/pic.png", "linked", false],
        ["Notes/Plan.md", "selected", false],
        ["workspace/Team Docs/Spec.md", "workspace", true],
        ["workspace/Team Docs/Budget.md", "workspace", true],
      ]);
      expect(started.record.context[2]).toMatchObject({ hash: sha256Hex("# Spec\n\nRoadmap: ship in May.\n"), workspace: { workspaceId: ws.id, workspaceName: "Team Docs", pageId: spec.id, title: "Spec", revisionId: spec.revisions.at(-1)!.id } });
      expect(record.files.map((f) => f.path)).toEqual(["Assets", "Assets/pic.png", "Notes", "Notes/Plan.md", "workspace", "workspace/Team Docs", "workspace/Team Docs/Budget.md", "workspace/Team Docs/Spec.md"]);
      // The task framing says the folder is reference only; the record keeps the user's own words.
      expect(record.stdin).toContain('the folder "workspace/" holds read-only copies of pages');
      expect(record.stdin).toContain("any change there is discarded");
      expect(record.stdin.endsWith("Task:\n\nSummarize the spec.\n@say reading\n@sleep 300")).toBe(true);
      expect(finished.task.prompt).toBe("Summarize the spec.\n@say reading\n@sleep 300");
      // Read with the user's access, and nothing was written to the server.
      expect(fake.calls.filter((c) => c.path.includes("/pages/")).map((c) => c.method)).toEqual(["GET", "GET"]);
      expect(writes()).toEqual([]);
    });

    it("a follow-up re-reads them with the person's access, and leaves out an earlier turn that had them when this turn is not given that workspace", async () => {
      const { refs } = team();
      const { started, work } = await runTask("What does the spec say?\n@answer Ship in May.\n@sleep 300", ["Notes/Plan.md"], { workspacePages: refs });
      await fakeRecord(work);
      const first = await started.finished;
      // With the workspace pages again: fetched again (GET), and the earlier turn is quoted.
      const again = await runTask("And the budget?\n@sleep 300", ["Notes/Plan.md"], { workspacePages: refs, followUp: first.id });
      const seen = await fakeRecord(again.work);
      const second = await again.started.finished;
      expect(seen.stdin).toContain("Ship in May.");
      expect(seen.stdin).toContain('the folder "workspace/" holds read-only copies of pages');
      expect(second.conversation?.context).toEqual({ earlier: 1, sent: 1, deleted: 0, notAllowed: 0 });
      expect(fake.calls.filter((c) => c.path.includes("/pages/")).map((c) => c.method)).toEqual(["GET", "GET", "GET", "GET"]);
      // Without them: the answers that may quote them stay out.
      const without = await runTask("Anything else?\n@sleep 300", ["Notes/Plan.md"], { followUp: second.id });
      const seenWithout = await fakeRecord(without.work);
      const third = await without.started.finished;
      expect(seenWithout.stdin).not.toContain("Ship in May.");
      expect(seenWithout.stdin).not.toContain("And the budget?");
      expect(third.conversation?.context).toEqual({ earlier: 2, sent: 0, deleted: 0, notAllowed: 2 });
      expect(writes()).toEqual([]);
    });

    it("an edit to one is blocked by its file mode, and if the agent works around that, discarded: never offered, never written anywhere", async () => {
      const { ws, refs } = team();
      // 1. Stopped by the file mode.
      const blocked = await runTask("@replace workspace/Team Docs/Spec.md :: May => June\n", ["Notes/Plan.md"], { workspacePages: refs });
      const first = await blocked.started.finished;
      expect(blocked.events.some((e) => e.type === "tool_error" && /permission denied/.test(e.message))).toBe(true);
      expect(first.state).toBe("done");

      // 2. The agent unlocks the file, edits one, deletes one, adds one, and also edits a Private Space page.
      const { started, events } = await runTask(
        [
          "@unlock workspace/Team Docs/Spec.md",
          "@replace workspace/Team Docs/Spec.md :: May => June",
          "@delete workspace/Team Docs/Budget.md",
          "@write workspace/Team Docs/Added.md :: # Added\\n",
          "@write workspace/Other Team/Page.md :: # Elsewhere\\n",
          "@replace Notes/Plan.md :: cat => dog",
        ].join("\n"),
        ["Notes/Plan.md"],
        { workspacePages: refs },
      );
      const finished = await started.finished;
      expect(events.some((e) => e.type === "tool_error")).toBe(false);
      expect(finished.state).toBe("review");
      const changes = hub.changes(finished.id)!;
      expect(changes.map((c) => [c.path, c.change, c.problem ?? "ok"])).toEqual([
        ["Notes/Plan.md", "modified", "ok"],
        ["workspace/Other Team/Page.md", "added", "read_only"],
        ["workspace/Team Docs/Added.md", "added", "read_only"],
        ["workspace/Team Docs/Budget.md", "deleted", "read_only"],
        ["workspace/Team Docs/Spec.md", "modified", "read_only"],
      ]);
      // Even when everything is approved, only the Private Space edit is applied.
      const results = await hub.apply(finished.id, changes.map((c) => c.path));
      expect(results.map((r) => [r.path, r.result])).toEqual([["Notes/Plan.md", "applied"]]);
      expect(await hub.history().then((h) => h[0]!.changes.map((c) => [c.path, c.decision, c.result ?? null, c.problem ?? null]))).toEqual([
        ["Notes/Plan.md", "approved", "applied", null],
        ["workspace/Other Team/Page.md", "rejected", null, "read_only"],
        ["workspace/Team Docs/Added.md", "rejected", null, "read_only"],
        ["workspace/Team Docs/Budget.md", "rejected", null, "read_only"],
        ["workspace/Team Docs/Spec.md", "rejected", null, "read_only"],
      ]);
      await expect(hub.saveCopy(finished.id, "workspace/Team Docs/Spec.md", (n) => `copy ${n}.md`)).rejects.toThrow(/conflicting change/);
      // Nowhere: not in the vault (no workspace folder, no copy), not on the server.
      await expect(stat(join(root, "workspace"))).rejects.toThrow();
      expect((await readdir(root)).sort()).toEqual([".thoth", "Assets", "Diary.md", "Notes"]);
      expect(await readdir(join(root, "Notes"))).toEqual(["Other.md", "Plan.md"]);
      expect(writes()).toEqual([]);
      expect([...ws.pages.values()].map((p) => [p.title, p.markdown])).toEqual([
        ["Spec", "# Spec\n\nRoadmap: ship in May.\n"],
        ["Budget", "# Budget\n\n42.\n"],
      ]);
    });

    it("cannot be added when the workspace forbids copying out, the user is not a member, the page is gone, or the server cannot be asked", async () => {
      const locked = fake.addWorkspace(server, { id: "ws_locked", name: "Locked", role: "owner", exportRestricted: true });
      const lockedPage = fake.writeAsOther(locked, { title: "Secret", markdown: "# Secret\n" });
      const open = fake.addWorkspace(server, { id: "ws_open", name: "Open", role: "viewer" });
      const openPage = fake.writeAsOther(open, { title: "Fine", markdown: "# Fine\n" });
      const refused = async (page: { server: string; workspace: string; page: string }) => {
        const error = await runTask("x", ["Notes/Plan.md"], { workspacePages: [page] }).then(() => null, (e: unknown) => e);
        expect(error).toBeInstanceOf(WorkspaceContextError);
        return (error as WorkspaceContextError).refusal;
      };
      expect(await refused({ server, workspace: locked.id, page: lockedPage.id })).toBe("export_restricted");
      expect(await refused({ server, workspace: "ws_nowhere", page: lockedPage.id })).toBe("not_found");
      expect(await refused({ server, workspace: open.id, page: "0190aaaa-0000-7000-8000-000000000000" })).toBe("not_found");
      // One refused page refuses the whole task, and nothing was created: no working directory, no record.
      expect(await refused({ server, workspace: locked.id, page: lockedPage.id })).toBe("export_restricted");
      fake.beforeCall = () => {
        throw new Error("offline");
      };
      expect(await refused({ server, workspace: open.id, page: openPage.id })).toBe("unavailable");
      fake.beforeCall = undefined;
      expect(await readdir(join(env.data, "agent-runs")).catch(() => [])).toEqual([]);
      expect(await hub.history()).toEqual([]);
      // The same page is fine once the user may use it.
      const fine = await runTask("x", ["Notes/Plan.md"], { workspacePages: [{ server, workspace: open.id, page: openPage.id }] });
      expect(fine.started.record.context.at(-1)).toMatchObject({ path: "workspace/Open/Fine.md", readOnly: true });
      await fine.started.finished;
    });

    it("are refused without a workspace reader", async () => {
      const { refs } = team();
      const plain = new AgentHub({ vault: env.vault, host: env.host, providers: [createClaudeProvider(env.host)] });
      await expect(plain.start({ provider: "claude", prompt: "x", selection: ["Notes/Plan.md"], workspacePages: refs })).rejects.toMatchObject({ refusal: "unavailable" });
    });
  });

  // ------------------------------------------------------------------- limits

  it("passes a time limit and a budget to the host and CLI, and refuses ones the host would refuse before staging anything", async () => {
    const { started, work } = await runTask("@sleep 300\n", ["Diary.md"], { maxBudgetUsd: 0.25, timeoutMs: 15 * 60_000 });
    const argv = (await fakeRecord(work)).argv; // before it ends: a run that proposed nothing deletes its folder
    await started.finished;
    expect(argv.slice(argv.indexOf("--max-budget-usd"))).toEqual(["--max-budget-usd", "0.25"]);
    expect(started.record.task).toMatchObject({ maxBudgetUsd: 0.25, timeoutMs: 15 * 60_000 });
    for (const bad of [{ maxBudgetUsd: 0 }, { maxBudgetUsd: 100.01 }, { maxBudgetUsd: Number.NaN }, { timeoutMs: 0 }, { timeoutMs: 999 }, { timeoutMs: 25 * 3600_000 }]) {
      await expect(hub.start({ provider: "claude", prompt: "x", selection: ["Diary.md"], ...bad })).rejects.toBeInstanceOf(LimitError);
    }
    expect((await hub.history()).length).toBe(1);
    // The host refuses too, whatever the webview sends.
    const { run } = await env.host.createRun("claude");
    try {
      for (const ms of [0, 500, 25 * 3600_000]) await expect(env.host.start(run, ARGV, new Uint8Array(), ms)).rejects.toMatchObject({ code: "BAD_ARGUMENT" });
    } finally {
      await env.host.dispose(run);
    }
  });

  it("shows a run that stopped at its time limit, and still lets its work be reviewed", async () => {
    const { started, events } = await runTask("@replace Notes/Plan.md :: cat => dog\n@hang\n", ["Notes/Plan.md"], { timeoutMs: 1000 });
    const finished = await started.finished;
    expect(events.at(-1)).toMatchObject({ type: "exit", reason: "timeout" });
    expect(finished.outcome).toMatchObject({ reason: "timeout", ok: false, stoppedBy: "time", error: { code: "timeout" } });
    expect(finished.state).toBe("review");
    expect(hub.changes(finished.id)!.map((c) => c.path)).toEqual(["Notes/Plan.md"]);
    expect((await hub.history())[0]!.outcome).toMatchObject({ stoppedBy: "time" });
  });

  it("shows a run that used up its budget, from the CLI's own result", async () => {
    const { started, events } = await runTask("@replace Notes/Plan.md :: cat => dog\n@budget\n", ["Notes/Plan.md"], { maxBudgetUsd: 0.25 });
    const finished = await started.finished;
    expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", code: "budget", message: "Reached maximum budget ($0.25)" }]);
    expect(finished.outcome).toMatchObject({ reason: "exited", code: 1, ok: false, stoppedBy: "budget", costUsd: 0.2501, error: { code: "budget", message: "Reached maximum budget ($0.25)" } });
    expect(finished.state).toBe("review");
    const nothing = await (await runTask("@budget\n", ["Notes/Plan.md"], { maxBudgetUsd: 0.5 })).started.finished;
    expect(nothing).toMatchObject({ state: "failed", outcome: { stoppedBy: "budget" } });
    // A run that is not stopped by a limit says nothing of the kind.
    expect((await (await runTask("x", ["Diary.md"])).started.finished).outcome?.stoppedBy).toBeUndefined();
  });

  // ------------------------------------------------------------------ history

  /** Every file under the vault that contains `needle`. */
  async function filesContaining(needle: string, dir = root): Promise<string[]> {
    const out: string[] = [];
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      if ((await stat(path)).isDirectory()) out.push(...(await filesContaining(needle, path)));
      else if ((await readFile(path)).includes(needle)) out.push(path);
    }
    return out;
  }

  it("keeps the transcript and the diffs in the app data folder only, never in the vault", async () => {
    const { started } = await runTask("Make it a dog.\n@say Reticulating splines\n@replace Notes/Plan.md :: cat => dog\n@write Notes/Summary.md :: # Summary\\n");
    const finished = await started.finished;
    await hub.apply(finished.id, ["Notes/Plan.md"]);
    const details = (await hub.details(finished.id))!;
    expect(details.events.map((e) => e.type)).toEqual(["session", "text", "tool", "tool", "text", "result", "exit"]);
    expect(details.events.find((e) => e.type === "text")).toEqual({ type: "text", text: "Reticulating splines" });
    expect(details.changes!.map((c) => [c.path, c.change, c.original, c.after])).toEqual([
      ["Notes/Plan.md", "modified", PLAN, PLAN.replace("cat", "dog")],
      ["Notes/Summary.md", "added", null, "# Summary\n"],
    ]);
    // Local only: in the data folder, nowhere in the vault (its records hold metadata, never output).
    expect(await readdir(join(env.data, "agent-history", finished.id))).toEqual(expect.arrayContaining(["transcript.jsonl", "review.json"]));
    expect(await filesContaining("Done.")).toEqual([]); // what the agent said
    expect(await filesContaining("transcript")).toEqual([]);
    expect(await readdir(join(root, ".thoth/agent/runs"))).toEqual([`${finished.id}.json`]);
    expect(await hub.detailsAvailable()).toEqual(new Map([[finished.id, { transcript: true, review: true }]]));
    expect((await hub.history())[0]!.outcome).toMatchObject({ model: "claude-fake-1", costUsd: 0.0012 });
  });

  it("keeps a run's answer for the session and in its local transcript, never in the vault's record", async () => {
    const answer = "This page is a plan.\nIt mentions a cat.";
    const finished = await (await runTask("What is on this page?\n@say Reading it now\n@answer This page is a plan.\\nIt mentions a cat.\n")).started.finished;
    expect(finished.state).toBe("done");
    // The run just finished: in memory. An earlier one: from its transcript.
    expect(hub.answer(finished.id)).toBe(answer);
    expect((await hub.details(finished.id))!.answer).toBe(answer);
    const later = makeHub(await env.restart());
    expect((await later.details(finished.id))!.answer).toBe(answer);
    await later.dispose();
    // Agent output never goes into the vault: the record has the task (here it holds the fake's directives, so the
    // words appear there once) and the outcome, not what the agent said.
    const file = join(root, ".thoth/agent/runs", `${finished.id}.json`);
    const saved = await readFile(file, "utf8");
    const prompt = JSON.stringify(finished.task.prompt);
    expect(saved).toContain(prompt);
    expect(saved.replace(prompt, "")).not.toContain("This page is a plan");
    expect(saved.replace(prompt, "")).not.toContain("Reading it now");
    expect(await filesContaining("It mentions a cat")).toEqual([file]);
  });

  it("a run that proposed nothing keeps only its transcript", async () => {
    const finished = await (await runTask("@say nothing to do\n", ["Diary.md"])).started.finished;
    expect(finished.state).toBe("done");
    expect(await readdir(join(env.data, "agent-history", finished.id))).toEqual(["transcript.jsonl"]);
    expect((await hub.details(finished.id))!.changes).toBeNull();
    expect(await hub.details("019e0000-0000-7000-8000-000000000001")).toBeNull();
  });

  /** A run that ended waiting for review, then the app "restarted": a new host and hub on the same folders. */
  async function awaitingReviewAfterRestart(prompt: string, selection: string[] = ["Notes/Plan.md"]) {
    const { started } = await runTask(prompt, selection);
    const finished = await started.finished;
    expect(finished.state).toBe("review");
    const shown = hub.changes(finished.id)!.map((c) => ({ path: c.path, change: c.change, before: c.before, after: c.after, stale: c.stale }));
    await hub.dispose(); // quitting deletes the working directory
    expect(await readdir(join(env.data, "agent-runs"))).toEqual([]);
    const host = await env.restart();
    const next = makeHub(host);
    return { id: finished.id, shown, next, host };
  }

  it("a run waiting for review is 'awaiting review' after a restart, not 'interrupted', and applying still uses compare-and-swap", async () => {
    const { id, shown, next } = await awaitingReviewAfterRestart("@replace Notes/Plan.md :: cat => dog\n@write Notes/Summary.md :: # Summary\\n");
    expect(await next.recover()).toMatchObject({ interrupted: [], awaitingReview: [id] });
    expect((await next.history())[0]).toMatchObject({ id, state: "review" });
    const reopened = (await next.reopen(id))!;
    expect(reopened.record.state).toBe("review");
    expect(reopened.changes.map((c) => ({ path: c.path, change: c.change, before: c.before, after: c.after, stale: c.stale }))).toEqual(shown);
    expect(await readdir(join(env.data, "agent-runs"))).toEqual([]);
    expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe(PLAN);

    const results = await next.apply(id, ["Notes/Plan.md", "Notes/Summary.md"]);
    expect(results.map((r) => [r.path, r.result])).toEqual([["Notes/Plan.md", "applied"], ["Notes/Summary.md", "applied"]]);
    expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe(PLAN.replace("cat", "dog"));
    expect(await readFile(join(root, "Notes/Summary.md"), "utf8")).toBe("# Summary\n");
    expect((await next.history())[0]).toMatchObject({ id, state: "applied" });
    // A second look finds nothing to review.
    await expect(next.apply(id, ["Notes/Plan.md"])).rejects.toThrow(/no changes waiting/);
    expect(await next.reopen(id)).toBeNull();
    await next.dispose();
  });

  it("after a restart a page edited meanwhile is a conflict against the staged hash, never overwritten", async () => {
    const { id, next } = await awaitingReviewAfterRestart("@replace Notes/Plan.md :: cat => dog\n@delete Notes/Other.md\n", ["Notes"]);
    await writeFile(join(root, "Notes/Plan.md"), "# Plan\n\nEdited while Thoth was closed.\n");
    await next.recover();
    const reopened = (await next.reopen(id))!;
    expect(reopened.changes.map((c) => [c.path, c.change, c.stale])).toEqual([
      ["Notes/Other.md", "deleted", false],
      ["Notes/Plan.md", "modified", true],
    ]);
    expect(reopened.changes[1]!.before).toBe("# Plan\n\nEdited while Thoth was closed.\n");
    const results = await next.apply(id, ["Notes/Plan.md", "Notes/Other.md"]);
    expect(results.map((r) => [r.path, r.result])).toEqual([["Notes/Other.md", "applied"], ["Notes/Plan.md", "conflict"]]);
    expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe("# Plan\n\nEdited while Thoth was closed.\n");
    await expect(stat(join(root, "Notes/Other.md"))).rejects.toThrow();
    // The agent's version can still be kept as a copy, from the stored file.
    expect(await next.saveCopy(id, "Notes/Plan.md", (n) => `Notes/Plan (agent${n}).md`)).toBe("Notes/Plan (agent1).md");
    expect(await readFile(join(root, "Notes/Plan (agent1).md"), "utf8")).toBe(PLAN.replace("cat", "dog"));
    await next.dispose();
  });

  it("a restart still marks a run 'interrupted' when it was not waiting for review, or its stored files are gone or damaged", async () => {
    const { id, next, host } = await awaitingReviewAfterRestart("@replace Notes/Plan.md :: cat => dog\n");
    await host.history.delete(id);
    expect(await next.recover()).toMatchObject({ interrupted: [id], awaitingReview: [] });
    expect((await next.history())[0]).toMatchObject({ id, state: "interrupted" });
    expect(await next.reopen(id)).toBeNull();

    // A stored proposal that no longer has the reviewed size is not trusted.
    const second = await awaitingReviewAfterRestart("@replace Notes/Plan.md :: cat => fox\n");
    const name = (await readdir(join(env.data, "agent-history", second.id))).find((n) => n.startsWith("after-"))!;
    await writeFile(join(env.data, "agent-history", second.id, name), "tampered, and a different size");
    expect(await second.next.recover()).toMatchObject({ interrupted: [second.id], awaitingReview: [] });
    await next.dispose();
    await second.next.dispose();
  });

  it("refuses to write bytes that changed after they were reviewed, even from the stored file", async () => {
    const { id, next } = await awaitingReviewAfterRestart("@replace Notes/Plan.md :: cat => dog\n");
    await next.recover();
    await next.reopen(id);
    const dir = join(env.data, "agent-history", id);
    const name = (await readdir(dir)).find((n) => n.startsWith("after-"))!;
    const original = await readFile(join(dir, name));
    await writeFile(join(dir, name), Buffer.from(original.toString("utf8").replace("dog", "cow"))); // same size, other bytes
    const results = await next.apply(id, ["Notes/Plan.md"]);
    expect(results).toEqual([{ path: "Notes/Plan.md", result: "failed", message: expect.stringContaining("changed in the agent's folder after it was reviewed") }]);
    expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe(PLAN);
    await next.dispose();
  });

  /** Moves a run's local files back in time, as if the run was `days` old. */
  async function age(id: string, days: number) {
    const dir = join(env.data, "agent-history", id);
    const when = new Date(Date.now() - days * 24 * 3600_000);
    for (const name of await readdir(dir)) await utimes(join(dir, name), when, when);
  }
  const kept = async () => (await readdir(join(env.data, "agent-history")).catch(() => [])).sort();

  it("prunes details by the retention setting: after each run and at start, never a run waiting for review; forever keeps all", async () => {
    const applied = await (await runTask("@replace Notes/Plan.md :: cat => dog\n")).started.finished;
    await hub.apply(applied.id, ["Notes/Plan.md"]);
    const waiting = await (await runTask("@replace Notes/Other.md :: Other => Another\n", ["Notes/Other.md"])).started.finished;
    expect(waiting.state).toBe("review");
    await age(applied.id, 40);
    await age(waiting.id, 40);

    retention = 0; // for ever
    expect(await hub.pruneDetails()).toBe(0);
    retention = 90;
    expect(await hub.pruneDetails()).toBe(0);
    retention = 30;
    // After each run: the next run's end prunes the old one (the waiting review is kept however old).
    const third = await (await runTask("x", ["Diary.md"])).started.finished;
    expect(await kept()).toEqual([waiting.id, third.id].sort());

    // At start: a fresh hub prunes too.
    retention = 7;
    await age(third.id, 10);
    const host = await env.restart();
    const next = makeHub(host);
    const recovered = await next.recover();
    expect(recovered.awaitingReview).toEqual([waiting.id]);
    expect(await kept()).toEqual([waiting.id]);
    // The metadata records stay.
    expect((await next.history()).map((r) => r.id).sort()).toEqual([applied.id, waiting.id, third.id].sort());
    await next.dispose();
  });

  it("'Delete history now' removes every run's details except one waiting for review, and keeps the records", async () => {
    const one = await (await runTask("@replace Notes/Plan.md :: cat => dog\n")).started.finished;
    await hub.discard(one.id);
    const two = await (await runTask("x", ["Diary.md"])).started.finished;
    const waiting = await (await runTask("@replace Notes/Other.md :: Other => Another\n", ["Notes/Other.md"])).started.finished;
    expect(await kept()).toEqual([one.id, two.id, waiting.id].sort());
    expect(await hub.clearDetails()).toBe(2);
    expect(await kept()).toEqual([waiting.id]);
    expect(await hub.details(one.id)).toBeNull();
    expect((await hub.history()).length).toBe(3);
    expect(await hub.apply(waiting.id, ["Notes/Other.md"])).toHaveLength(1);
    // Once reviewed it is history like the rest.
    expect(await hub.clearDetails()).toBe(1);
    expect(await hub.clearDetails()).toBe(0);
    expect(await kept()).toEqual([]);
  });

  it("the host's local details accept only a run's UUID and a flat file name, and replace files atomically", async () => {
    const id = "019e0000-0000-7000-8000-0000000000bb";
    const { history } = env.host;
    await history.write(id, "review.json", new TextEncoder().encode("{}"));
    await history.write(id, "review.json", new TextEncoder().encode("{\"v\":2}"));
    expect(new TextDecoder().decode(await history.read(id, "review.json"))).toBe("{\"v\":2}");
    expect((await history.list()).find((r) => r.id === id)).toMatchObject({ bytes: 7, files: [{ name: "review.json", size: 7 }] });
    for (const [badId, name] of [["../x", "a.bin"], [id, "../a.bin"], [id, "a/b"], [id, ".hidden"], ["run_0123456789abcdef0123456789abcdef", "a.bin"], [id.toUpperCase(), "a.bin"]] as const) {
      await expect(history.write(badId, name, new Uint8Array([1])), `${badId} ${name}`).rejects.toMatchObject({ code: "BAD_ARGUMENT" });
      await expect(history.read(badId, name)).rejects.toMatchObject({ code: "BAD_ARGUMENT" });
    }
    await expect(history.read(id, "missing.bin")).rejects.toMatchObject({ code: "ENOENT" });
    await history.delete(id);
    await history.delete(id);
    expect((await history.list()).find((r) => r.id === id)).toBeUndefined();
  });
});
