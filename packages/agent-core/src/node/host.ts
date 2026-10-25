/**
 * `AgentHost` on Node, for tests and the desktop UI test platform. It follows the Rust host's rules (a private
 * working directory per run, the provider binary found in fixed folders, the environment without `THOTH_*` and
 * vault paths, a process group per run, pulled events, sweep, the same probes, Codex run by its real path) but does
 * not enforce the argument policy: that boundary is the Rust host's (`crates/thoth-host/src/agent/claude.rs`,
 * `codex.rs`), tested there and in `tests/ports`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { NodeVaultFs } from "@thoth/local-store/node";
import { checkTimeLimitMs } from "../limits.ts";
import type { AgentFiles, AgentHistoryStore, AgentHost, AgentProbe, HostAgentEvent, HostEventBatch, HostHistoryRun, ProbeOutput } from "../host.ts";

type ProbeKey = "version" | "help" | "auth" | "sandbox";
/** The Rust host's fixed probes (`crates/thoth-host/src/agent/mod.rs`, `codex.rs`); `bin` is the binary found. */
const PROBES: Record<string, { binary: string; canonical: boolean; probes: (bin: string) => [key: ProbeKey, args: string[]][] }> = {
  claude: { binary: "claude", canonical: false, probes: () => [["version", ["--version"]], ["help", ["--help"]], ["auth", ["auth", "status", "--json"]]] },
  codex: {
    binary: "codex",
    // Codex runs by its real path: its sandbox lets the binary re-run itself only under the path it was started as.
    canonical: true,
    probes: (bin) => [
      ["version", ["--version"]],
      ["help", ["exec", "--help"]],
      ["auth", ["login", "status"]],
      ["sandbox", ["sandbox", ...CODEX_SANDBOX_PROFILE, "-P", "thoth", "--", bin, "--version"]],
    ],
  },
};
/** The permission profile of `packages/agent-codex/src/args.ts`, for the sandbox probe. */
const CODEX_SANDBOX_PROFILE = [
  "-c",
  "default_permissions=thoth",
  "-c",
  "permissions.thoth.filesystem.:minimal=read",
  "-c",
  "permissions.thoth.filesystem.:workspace_roots=write",
  "-c",
  "permissions.thoth.filesystem.:slash_tmp=deny",
  "-c",
  "permissions.thoth.filesystem.:tmpdir=deny",
  "-c",
  "permissions.thoth.network.enabled=false",
];
const KILL_GRACE_MS = 3000;
const RUN_NAME = /^run_[0-9a-f]{32}$/;
const HISTORY_RUN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HISTORY_FILE = /^[a-z0-9_-][a-z0-9._-]{0,63}$/;
const HISTORY_MAX_FILE = 64 * 1024 * 1024;
const HISTORY_MAX_RUN = 512 * 1024 * 1024;

export interface NodeAgentHostOptions {
  /** The app data folder; runs go to `<dataDir>/agent-runs/<run>/work`. */
  dataDir: string;
  /** Folders searched for provider binaries, in order (the Rust host's `--agent-search-dir`). */
  searchDirs: string[];
  /** Vault roots no environment variable of the child may name. */
  excludeRoots?: () => string[];
  defaultTimeoutMs?: number;
}

interface Run {
  provider: string;
  dir: string;
  work: string;
  files: NodeVaultFs;
  started: boolean;
  child: ChildProcess | null;
  events: HostAgentEvent[];
  done: boolean;
  stop: "cancelled" | "timeout" | null;
  waiters: Set<() => void>;
}

export class NodeAgentHost implements AgentHost {
  private readonly options: NodeAgentHostOptions;
  private readonly runs = new Map<string, Run>();
  /** Local-only run details under `<dataDir>/agent-history`, with the Rust host's naming and size rules. */
  readonly history: AgentHistoryStore;

  constructor(options: NodeAgentHostOptions) {
    this.options = options;
    this.history = nodeHistory(join(options.dataDir, "agent-history"));
  }

  private resolve(provider: string): string | null {
    const spec = PROBES[provider];
    if (!spec) throw new Error(`Unknown agent provider ${provider}`);
    for (const dir of this.options.searchDirs) {
      const candidate = join(dir, spec.binary);
      try {
        const st = statSync(candidate);
        if (st.isFile() && (st.mode & 0o111) !== 0) return spec.canonical ? realpathSync(candidate) : candidate;
      } catch {
        // not here
      }
    }
    return null;
  }

  private env(bin: string, cwd: string): NodeJS.ProcessEnv {
    const exclude = (this.options.excludeRoots?.() ?? []).filter((r) => r.length > 1);
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || /^THOTH_/i.test(key) || key === "PWD" || key === "OLDPWD") continue;
      if (exclude.some((root) => value.includes(root))) continue;
      env[key] = value;
    }
    const binDir = bin.slice(0, bin.lastIndexOf("/"));
    const path = (env["PATH"] ?? "").split(delimiter).filter(Boolean);
    if (!path.includes(binDir)) path.unshift(binDir);
    env["PATH"] = path.join(delimiter);
    env["PWD"] = cwd;
    return env;
  }

  async detect(provider: string): Promise<AgentProbe> {
    const bin = this.resolve(provider);
    const searched = [...this.options.searchDirs];
    if (!bin) return { found: false, searched };
    const cwd = (await realpath(this.options.dataDir).catch(() => this.options.dataDir)) || process.cwd();
    const env = this.env(bin, cwd);
    const out: Partial<Record<ProbeKey, ProbeOutput>> = {};
    for (const [key, args] of PROBES[provider]!.probes(bin)) {
      const r = spawnSync(bin, args, { cwd, env, encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 });
      out[key] = { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: r.error !== undefined && (r.error as { code?: string }).code === "ETIMEDOUT" };
    }
    return { found: true, path: bin, searched, version: out.version!, help: out.help!, auth: out.auth!, ...(out.sandbox ? { sandbox: out.sandbox } : {}) };
  }

  async createRun(provider: string): Promise<{ run: string; dir: string }> {
    if (!PROBES[provider]) throw new Error(`Unknown agent provider ${provider}`);
    const runs = join(this.options.dataDir, "agent-runs");
    await mkdir(runs, { recursive: true, mode: 0o700 });
    await chmod(runs, 0o700);
    const id = `run_${randomBytes(16).toString("hex")}`;
    const dir = join(runs, id);
    await mkdir(join(dir, "work"), { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const work = await realpath(join(dir, "work"));
    this.runs.set(id, { provider, dir, work, files: new NodeVaultFs(work), started: false, child: null, events: [], done: false, stop: null, waiters: new Set() });
    return { run: id, dir: work };
  }

  private run(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw Object.assign(new Error("Unknown or closed agent run handle"), { code: "BAD_HANDLE" });
    return run;
  }

  files(id: string): AgentFiles {
    const writable = () => {
      if (this.run(id).started) throw Object.assign(new Error("The working directory can only be filled before the agent starts"), { code: "NOT_ALLOWED" });
      return this.run(id).files;
    };
    return {
      stat: (path) => this.run(id).files.stat(path),
      readFile: (path) => this.run(id).files.readFile(path),
      list: (dir) => this.run(id).files.list(dir),
      mkdirp: (dir) => writable().mkdirp(dir),
      writeFile: async (path, data, options) => {
        const fs = writable();
        await fs.writeFile(path, data, { exclusive: true });
        if (options?.readOnly) await chmod(join(this.run(id).work, path), 0o444);
      },
    };
  }

  private push(run: Run, event: HostAgentEvent extends infer E ? (E extends HostAgentEvent ? Omit<E, "seq"> : never) : never): void {
    run.events.push({ ...event, seq: run.events.length } as HostAgentEvent);
    for (const wake of run.waiters) wake();
    run.waiters.clear();
  }

  private signal(run: Run, signal: NodeJS.Signals): void {
    const pid = run.child?.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // the group is gone
    }
  }

  async start(id: string, argv: string[], stdin: Uint8Array, timeoutMs?: number): Promise<void> {
    const run = this.run(id);
    if (run.started) throw Object.assign(new Error("This agent run has already started"), { code: "NOT_ALLOWED" });
    const bin = this.resolve(run.provider);
    if (!bin) throw Object.assign(new Error(`The ${run.provider} CLI was not found`), { code: "AGENT_UNAVAILABLE" });
    // The Rust host refuses, rather than clamps, a time limit outside 1 second to 24 hours.
    if (timeoutMs !== undefined) {
      try {
        checkTimeLimitMs(timeoutMs);
      } catch (error) {
        throw Object.assign(error as Error, { code: "BAD_ARGUMENT" });
      }
    }
    run.started = true;
    const child = spawn(bin, argv, { cwd: run.work, env: this.env(bin, run.work), detached: true, stdio: ["pipe", "pipe", "pipe"] });
    run.child = child;
    child.stdin.end(Buffer.from(stdin));
    child.stdin.on("error", () => undefined);
    const closed = Promise.all(
      (["stdout", "stderr"] as const).map(
        (kind) =>
          new Promise<void>((resolve) => {
            const lines = createInterface({ input: child[kind], crlfDelay: Infinity });
            lines.on("line", (line) => this.push(run, { kind, line }));
            lines.on("close", () => resolve());
          }),
      ),
    );
    const timer = setTimeout(() => void this.stopRun(run, "timeout"), timeoutMs ?? this.options.defaultTimeoutMs ?? 30 * 60_000);
    child.on("error", () => undefined);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      // Whatever the CLI left in its group goes with it, as on the Rust host.
      this.signal(run, "SIGKILL");
      void closed.then(() => {
        run.done = true;
        this.push(run, { kind: "exit", code, signal: signal ? signalNumber(signal) : null, reason: run.stop ?? "exited" });
      });
    });
  }

  private stopRun(run: Run, reason: "cancelled" | "timeout"): void {
    if (run.done) return;
    if (!run.started) {
      run.done = true;
      this.push(run, { kind: "exit", code: null, signal: null, reason });
      return;
    }
    run.stop ??= reason;
    this.signal(run, "SIGTERM");
    setTimeout(() => !run.done && this.signal(run, "SIGKILL"), KILL_GRACE_MS).unref();
  }

  async events(id: string, after: number, waitMs: number): Promise<HostEventBatch> {
    const run = this.run(id);
    if (run.events.length <= after && !run.done) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          run.waiters.delete(wake);
          resolve();
        }, Math.min(waitMs, 10_000));
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        run.waiters.add(wake);
      });
    }
    const events = run.events.slice(after, after + 500);
    const next = after + events.length;
    return { events, next, done: run.done && next === run.events.length };
  }

  async cancel(id: string): Promise<void> {
    this.stopRun(this.run(id), "cancelled");
  }

  async dispose(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    this.runs.delete(id);
    this.stopRun(run, "cancelled");
    const deadline = Date.now() + KILL_GRACE_MS + 2000;
    while (!run.done && run.started && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await rm(run.dir, { recursive: true, force: true });
  }

  async sweep(): Promise<number> {
    const dir = join(this.options.dataDir, "agent-runs");
    if (!existsSync(dir)) return 0;
    let removed = 0;
    for (const name of await readdir(dir)) {
      if (!RUN_NAME.test(name) || this.runs.has(name)) continue;
      await rm(join(dir, name), { recursive: true, force: true });
      removed++;
    }
    return removed;
  }

  /** Stops every run and deletes its folder. */
  async close(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((id) => this.dispose(id)));
  }
}

function signalNumber(signal: NodeJS.Signals): number | null {
  const table: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
  return table[signal] ?? null;
}

/** The history store on Node: a flat folder per run, atomic writes, the same names and bounds as `history.rs`. */
function nodeHistory(root: string): AgentHistoryStore {
  const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
  const dirOf = (id: string) => {
    if (!HISTORY_RUN.test(id)) throw fail("BAD_ARGUMENT", "A run ID is a lower-case UUID");
    return join(root, id);
  };
  const fileOf = (id: string, name: string) => {
    if (!HISTORY_FILE.test(name) || name.startsWith(".")) throw fail("BAD_ARGUMENT", "Not a history file name");
    return join(dirOf(id), name);
  };
  const files = async (dir: string): Promise<{ name: string; size: number; mtimeMs: number }[]> => {
    const out: { name: string; size: number; mtimeMs: number }[] = [];
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!HISTORY_FILE.test(name) || name.startsWith(".")) continue;
      const st = await lstat(join(dir, name)).catch(() => null);
      if (st?.isFile()) out.push({ name, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  };
  return {
    async write(id, name, data) {
      const dir = dirOf(id);
      const path = fileOf(id, name);
      if (data.length > HISTORY_MAX_FILE) throw fail("BAD_ARGUMENT", "That history file is too large");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const others = (await files(dir)).filter((f) => f.name !== name).reduce((n, f) => n + f.size, 0);
      if (others + data.length > HISTORY_MAX_RUN) throw fail("NOT_ALLOWED", "This run's history is full");
      const temp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
      try {
        await writeFile(temp, data, { flag: "wx", mode: 0o600 });
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
    async read(id, name) {
      const path = fileOf(id, name);
      const st = await lstat(path);
      if (!st.isFile()) throw fail("UNSAFE_PATH", "Not a regular file");
      return new Uint8Array(await readFile(path));
    },
    async list() {
      const runs: HostHistoryRun[] = [];
      for (const id of await readdir(root).catch(() => [] as string[])) {
        if (!HISTORY_RUN.test(id)) continue;
        const list = await files(join(root, id));
        runs.push({ id, modifiedMs: list.reduce((m, f) => Math.max(m, f.mtimeMs), 0), bytes: list.reduce((n, f) => n + f.size, 0), files: list.map((f) => ({ name: f.name, size: f.size })) });
      }
      return runs.sort((a, b) => a.modifiedMs - b.modifiedMs || (a.id < b.id ? -1 : 1));
    },
    async delete(id) {
      await rm(dirOf(id), { recursive: true, force: true });
    },
  };
}
