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
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@thoth/domain";
import { AgentHub, type AgentEvent, type AgentHost, type RunRecord } from "@thoth/agent-core";
import { NodeAgentHost } from "@thoth/agent-core/node";
import { createClaudeProvider } from "@thoth/agent-claude";
import { Vault } from "@thoth/local-store";
import { NodeSqlDriver, NodeVaultFs } from "@thoth/local-store/node";
import { openRemoteVault, remoteAgents } from "@thoth/platform/remote";
import type { StdioTransport } from "@thoth/platform/stdio";
import type { VaultConnection } from "@thoth/platform";
import { buildHarness, rustTransport, tempDir } from "../ports/harness.ts";
import { FAKE_CLAUDE_DIR, fakeRecord, waitDead } from "../helpers/agent.ts";

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

  beforeEach(async () => {
    root = await tempDir("thoth-agent-vault-");
    await seed(root);
    env = await runtime.open(root, [FAKE_CLAUDE_DIR]);
    hub = new AgentHub({ vault: env.vault, host: env.host, providers: [createClaudeProvider(env.host)] });
  });

  afterEach(async () => {
    await hub.dispose();
    await env.close();
    delete process.env["FAKE_CLAUDE_LOGGED_OUT"];
    await rm(root, { recursive: true, force: true });
  });

  async function runTask(prompt: string, selection: string[] = ["Notes/Plan.md"]) {
    const events: AgentEvent[] = [];
    const before = new Set(await readdir(join(env.data, "agent-runs")).catch(() => [] as string[]));
    const started = await hub.start({ provider: "claude", prompt, selection }, (e) => events.push(e));
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
});
