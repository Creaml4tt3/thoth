/**
 * The Agent Hub with the fake Codex CLI (`packages/agent-codex/test/fake-codex`), on the real Rust host (stdio
 * harness, vault on Rust ports) and on the Node test host. Codex runs commands inside its own sandbox, so on top of
 * what `hub.test.ts` shows for Claude Code: it is not run where the sandbox probe fails, a spending limit (which
 * Codex does not have) is refused rather than dropped, its token counts are recorded, and its own errors (signed out,
 * unknown model) reach the record. The argument list is exactly the policy's.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@thoth/domain";
import { AgentHub, AgentUnavailableError, LimitError, type AgentEvent, type AgentHost, type StartTask } from "@thoth/agent-core";
import { NodeAgentHost } from "@thoth/agent-core/node";
import { createClaudeProvider } from "@thoth/agent-claude";
import { createCodexProvider } from "@thoth/agent-codex";
import { Vault } from "@thoth/local-store";
import { NodeSqlDriver, NodeVaultFs } from "@thoth/local-store/node";
import { openRemoteVault, remoteAgents } from "@thoth/platform/remote";
import type { StdioTransport } from "@thoth/platform/stdio";
import { buildHarness, rustTransport, tempDir } from "../ports/harness.ts";
import { FAKE_CLAUDE_DIR, FAKE_CODEX_DIR, fakeRecord, waitDead } from "../helpers/agent.ts";

const ARGV = (JSON.parse(await readFile(join(FAKE_CODEX_DIR, "../fixtures/argv.json"), "utf8")) as { cases: { argv: string[] }[] }).cases;
const PLAN = "# Plan\n\nWe have a cat.\n";
const leaky = (root: string) => ({ THOTH_AGENT_TEST_SECRET: "do-not-pass", NOTES_DIR_FOR_TEST: join(root, "Notes") });

interface Env {
  data: string;
  vault: Vault;
  host: AgentHost;
  close(): Promise<void>;
}

const runtimes: { name: string; open(root: string, search: string[]): Promise<Env> }[] = [
  {
    name: "Rust host",
    async open(root, search) {
      const data = await tempDir("thoth-codex-data-");
      const transport: StdioTransport = await rustTransport({ allowRoots: [root], dataDir: data, agentSearchDirs: search, env: leaky(root) });
      const connection = await openRemoteVault(transport, root);
      const { vault } = await Vault.open({ fs: connection.fs, sql: connection.sql });
      return {
        data,
        vault,
        host: remoteAgents(transport),
        async close() {
          await vault.close();
          await connection.close();
          await transport.close();
          await rm(data, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: "Node host",
    async open(root, search) {
      const data = await tempDir("thoth-codex-data-");
      Object.assign(process.env, leaky(root));
      const fs = new NodeVaultFs(root);
      await fs.mkdirp(".thoth");
      const { vault } = await Vault.open({ fs, sql: new NodeSqlDriver(join(root, ".thoth", "index.sqlite")) });
      const host = new NodeAgentHost({ dataDir: data, searchDirs: search, excludeRoots: () => [root] });
      return {
        data,
        vault,
        host,
        async close() {
          await host.close();
          await vault.close();
          for (const key of Object.keys(leaky(root))) delete process.env[key];
          await rm(data, { recursive: true, force: true });
        },
      };
    },
  },
];

beforeAll(() => buildHarness(), 600_000);

describe.each(runtimes)("Codex in the Agent Hub on the $name", (runtime) => {
  let root: string;
  let env: Env;
  let hub: AgentHub;

  const makeHub = (e: Env) => new AgentHub({ vault: e.vault, host: e.host, providers: [createClaudeProvider(e.host), createCodexProvider(e.host)], transcriptFlushMs: 50 });

  beforeEach(async () => {
    root = await tempDir("thoth-codex-vault-");
    await mkdir(join(root, "Notes"), { recursive: true });
    await writeFile(join(root, "Notes/Plan.md"), PLAN);
    await writeFile(join(root, "Diary.md"), "# Diary\n\nPrivate.\n");
    env = await runtime.open(root, [FAKE_CODEX_DIR, FAKE_CLAUDE_DIR]);
    hub = makeHub(env);
  });

  afterEach(async () => {
    await hub.dispose();
    await env.close();
    delete process.env["FAKE_CODEX_LOGGED_OUT"];
    delete process.env["FAKE_CODEX_NO_SANDBOX"];
    await rm(root, { recursive: true, force: true });
  });

  async function runTask(prompt: string, extra: Partial<StartTask> = {}) {
    const events: AgentEvent[] = [];
    const before = new Set(await readdir(join(env.data, "agent-runs")).catch(() => [] as string[]));
    const started = await hub.start({ provider: "codex", prompt, selection: ["Notes/Plan.md"], ...extra }, (e) => events.push(e));
    const runDir = (await readdir(join(env.data, "agent-runs"))).find((n) => !before.has(n))!;
    return { started, events, work: join(env.data, "agent-runs", runDir, "work"), runDir: join(env.data, "agent-runs", runDir) };
  }

  it("detects Codex next to Claude Code, and refuses to run it signed out or without its sandbox", async () => {
    expect(await hub.provider("codex").detect()).toEqual({ state: "ready", version: "0.164.0", path: join(FAKE_CODEX_DIR, "codex") });
    expect(await hub.provider("claude").detect()).toMatchObject({ state: "ready", version: "2.1.310" });
    for (const [variable, state] of [
      ["FAKE_CODEX_NO_SANDBOX", "sandbox_unavailable"],
      ["FAKE_CODEX_LOGGED_OUT", "not_logged_in"],
    ] as const) {
      process.env[variable] = "1";
      const other = await runtime.open(root, [FAKE_CODEX_DIR]);
      try {
        const status = await createCodexProvider(other.host).detect();
        expect(status.state).toBe(state);
        if (status.state === "sandbox_unavailable") expect(status.message).toBe("Error: the sandbox could not be started (fake)");
        const otherHub = makeHub(other);
        await expect(otherHub.start({ provider: "codex", prompt: "x", selection: ["Diary.md"] })).rejects.toBeInstanceOf(AgentUnavailableError);
        expect(await readdir(join(other.data, "agent-runs")).catch(() => [])).toEqual([]);
        await otherHub.dispose();
      } finally {
        await other.close();
        delete process.env[variable];
      }
    }
  });

  it("stages only the selection, runs with exactly the policy's arguments, streams, and applies exactly the approved bytes", async () => {
    const { started, events, work, runDir } = await runTask("Make it a dog.\n@run ls\n@replace Notes/Plan.md :: cat => dog\n@write Notes/Summary.md :: # Summary\\n", { model: "gpt-5.5" });
    const finished = await started.finished;
    const record = await fakeRecord(work, 20_000, "codex");
    expect(record.files).toEqual([
      { path: "Notes", kind: "directory" },
      { path: "Notes/Plan.md", kind: "file" },
    ]);
    expect(record.cwd).toBe(work);
    expect(record.argv).toEqual(ARGV[1]!.argv);
    expect(record.stdin).toContain("Make it a dog.");
    expect(Object.keys(record.env).filter((k) => /^THOTH_/i.test(k))).toEqual([]);
    expect(Object.entries(record.env).filter(([, v]) => v.includes(root))).toEqual([]);

    expect(events.filter((e) => e.type !== "log").map((e) => e.type)).toEqual(["session", "tool", "tool", "tool", "text", "result", "exit"]);
    expect(events.filter((e) => e.type === "tool").map((e) => [(e as { tool: string }).tool, (e as { target?: string }).target])).toEqual([
      ["Shell", "ls"],
      ["Edit", "Notes/Plan.md"],
      ["Write", "Notes/Summary.md"],
    ]);
    expect(finished.state).toBe("review");
    expect(finished.provider).toEqual({ id: "codex", name: "Codex", version: "0.164.0" });
    expect(finished.task).toMatchObject({ model: "gpt-5.5" });
    expect(finished.task.maxBudgetUsd).toBeUndefined();
    expect(finished.outcome).toMatchObject({ reason: "exited", code: 0, ok: true, tokens: { input: 1200, cachedInput: 1000, output: 34, reasoningOutput: 8 } });
    expect(finished.outcome?.costUsd).toBeUndefined();
    expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe(PLAN);

    expect(await hub.apply(finished.id, ["Notes/Plan.md"])).toEqual([{ path: "Notes/Plan.md", result: "applied", hash: sha256Hex("# Plan\n\nWe have a dog.\n") }]);
    expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe("# Plan\n\nWe have a dog.\n");
    await expect(stat(join(root, "Notes/Summary.md"))).rejects.toThrow();
    await expect(stat(runDir)).rejects.toThrow();
  });

  it("refuses a spending limit, which Codex cannot enforce, before anything is staged; the time limit applies", async () => {
    await expect(hub.start({ provider: "codex", prompt: "x", selection: ["Diary.md"], maxBudgetUsd: 1 })).rejects.toBeInstanceOf(LimitError);
    expect(await readdir(join(env.data, "agent-runs")).catch(() => [])).toEqual([]);
    const { started } = await runTask("@hang\n", { timeoutMs: 1000 });
    const finished = await started.finished;
    expect(finished.outcome).toMatchObject({ reason: "timeout", stoppedBy: "time" });
    expect(finished.task.timeoutMs).toBe(1000);
  });

  it("cancel stops Codex and everything it started, and changes nothing", async () => {
    const { started, work, runDir } = await runTask("@replace Notes/Plan.md :: cat => dog\n@hang\n");
    let record = await fakeRecord(work, 20_000, "codex");
    while (record.grandchild === null) record = await fakeRecord(work, 20_000, "codex");
    await hub.cancel(started.record.id);
    expect((await started.finished).state).toBe("cancelled");
    await waitDead(record.pid);
    await waitDead(record.grandchild!);
    await expect(stat(runDir)).rejects.toThrow();
    expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe(PLAN);
  });

  it("records Codex's own errors: signed out at run time, an unknown model", async () => {
    const signedOut = await (await runTask("@not-logged-in\n")).started.finished;
    expect(signedOut.state).toBe("failed");
    expect(signedOut.outcome).toMatchObject({ ok: false, code: 1, error: { code: "not_logged_in" } });
    const badModel = await (await runTask("@bad-model\n", { model: "no-such-model" })).started.finished;
    expect(badModel.outcome).toMatchObject({ ok: false, error: { code: "model_not_found", message: "The 'no-such-model' model is not supported when using Codex with a ChatGPT account." } });
  });
});
