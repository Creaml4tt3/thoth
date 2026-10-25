/**
 * Node-only `Transport` that spawns the `thoth-host-stdio` harness and speaks
 * JSON lines (test infrastructure and the e2e dev bridge). Exported from
 * `@thoth/platform/stdio` so the main entry stays free of Node APIs.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { CommandName, Commands, Transport, VaultChangedEvent } from "./ipc.ts";
import { HostCallError, createRemotePlatform, decodeBase64, encodeBase64, isHostErrorShape } from "./remote.ts";
import type { Platform } from "./index.ts";

export interface StdioTransportOptions {
  /** Path to the built `thoth-host-stdio` binary. */
  binary: string;
  allowRoots?: string[];
  pickVault?: string;
  pickSource?: string;
  dataDir?: string;
  /** Test hook: look for agent CLIs only in these folders (`--agent-search-dir`). */
  agentSearchDirs?: string[];
  env?: Record<string, string>;
  /**
   * Harness-only host events other than `vault.changed` (for example `browser.open`, where the test harness
   * reports the sign-in URL instead of opening a browser). The app never depends on them.
   */
  onHostEvent?: (event: string, payload: unknown) => void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  wantsBytes: boolean;
}

/** Commands whose result is raw bytes (out of band). */
const BYTE_RESULTS = new Set<CommandName>(["fs.read", "source.file.read", "agent.fs.read", "agent.history.read"]);

export class StdioTransport implements Transport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(payload: VaultChangedEvent) => void>();
  private nextId = 1;
  private exited: Error | undefined;
  private stderr = "";
  private readonly onHostEvent: StdioTransportOptions["onHostEvent"];

  constructor(options: StdioTransportOptions) {
    this.onHostEvent = options.onHostEvent;
    const args: string[] = [];
    for (const root of options.allowRoots ?? []) args.push("--allow-root", root);
    if (options.pickVault !== undefined) args.push("--pick-vault", options.pickVault);
    if (options.pickSource !== undefined) args.push("--pick-source", options.pickSource);
    if (options.dataDir !== undefined) args.push("--data-dir", options.dataDir);
    for (const dir of options.agentSearchDirs ?? []) args.push("--agent-search-dir", dir);
    this.child = spawn(options.binary, args, { env: { ...process.env, ...options.env }, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4096);
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.onLine(line));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => this.fail(new Error(`thoth-host-stdio exited (${signal ?? code})${this.stderr ? `: ${this.stderr}` : ""}`)));
  }

  private fail(error: Error): void {
    this.exited ??= error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private onLine(line: string): void {
    let message: { id?: unknown; ok?: unknown; result?: unknown; bytes?: unknown; error?: unknown; event?: unknown; payload?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.event === "vault.changed") {
      for (const listener of this.listeners) listener(message.payload as VaultChangedEvent);
      return;
    }
    if (typeof message.event === "string") {
      this.onHostEvent?.(message.event, message.payload);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok === true) {
      pending.resolve(pending.wantsBytes ? decodeBase64(typeof message.bytes === "string" ? message.bytes : "") : (message.result ?? null));
    } else if (isHostErrorShape(message.error)) {
      pending.reject(new HostCallError(message.error.code, message.error.message));
    } else {
      pending.reject(new HostCallError("INTERNAL", "Malformed host response"));
    }
  }

  call<C extends CommandName>(command: C, args: Commands[C]["args"], bytes?: Uint8Array): Promise<Commands[C]["result"]> {
    return this.callAs("", command, args, bytes);
  }

  /**
   * This harness as the window `owner` (ADR-0019), as the desktop shell names the webview that calls: vaults it opens
   * and agent runs it starts are that window's, and a folder is `shared` only with another owner's handles.
   */
  as(owner: string): Transport {
    return {
      call: (command, args, bytes) => this.callAs(owner, command, args, bytes),
      listen: (event, handler) => this.listen(event, handler),
    };
  }

  private callAs<C extends CommandName>(owner: string, command: C, args: Commands[C]["args"], bytes?: Uint8Array): Promise<Commands[C]["result"]> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    const request: Record<string, unknown> = { id, command, args };
    if (owner !== "") request.owner = owner;
    if (bytes !== undefined) request.bytes = encodeBase64(bytes);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, wantsBytes: BYTE_RESULTS.has(command) });
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  async listen(_event: "vault.changed", handler: (payload: VaultChangedEvent) => void): Promise<() => void> {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** Ends the harness; it closes every vault and source (deleting temp files) on the way out. */
  async close(): Promise<void> {
    if (this.exited) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.stdin.end();
    await exited;
  }
}

export function createStdioPlatform(options: StdioTransportOptions): { platform: Platform; transport: StdioTransport } {
  const transport = new StdioTransport(options);
  return { platform: createRemotePlatform(transport, "bridge"), transport };
}
