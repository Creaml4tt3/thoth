/**
 * The port an `AgentHub` reaches the native host through (ADR-0008). The desktop implements it with Rust commands
 * (`agent.*` in `packages/platform/src/ipc.ts`); tests use `NodeAgentHost` (`@thoth/agent-core/node`). A web client
 * has no such port: browsers cannot spawn processes (spec section 3.3, 14.11).
 */
import type { DirEntry, FileStat } from "@thoth/local-store";

/** One probe the host ran (`--version`, `--help`, the CLI's login status). */
export interface ProbeOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** What the host found when it looked for a provider's CLI. Interpreting it is the adapter's job. */
export type AgentProbe =
  | { found: false; searched: string[] }
  | { found: true; path: string; searched: string[]; version: ProbeOutput; help: ProbeOutput; auth: ProbeOutput };

/** Raw process output, numbered from 0. */
export type HostAgentEvent =
  | { seq: number; kind: "stdout" | "stderr"; line: string; truncated?: boolean }
  | { seq: number; kind: "exit"; code: number | null; signal: number | null; reason: "exited" | "cancelled" | "timeout" | "output_limit" };

export interface HostEventBatch {
  events: HostAgentEvent[];
  /** Pass as `after` next time. */
  next: number;
  /** True once the exit event has been returned. */
  done: boolean;
}

/** A run's working directory, with the `VaultFs` rules: relative paths, symlinks reported and never followed. */
export interface AgentFiles {
  stat(path: string): Promise<FileStat | undefined>;
  readFile(path: string): Promise<Uint8Array>;
  list(dir: string): Promise<DirEntry[]>;
  /** Only before the CLI starts. */
  mkdirp(dir: string): Promise<void>;
  /**
   * Exclusive create, only before the CLI starts. `readOnly` takes the write permission away afterwards (reference
   * copies the agent may read but whose changes are never applied).
   */
  writeFile(path: string, data: Uint8Array, options?: { readOnly?: boolean }): Promise<void>;
}

/** What the host keeps locally for one run: when its files last changed and what they are. */
export interface HostHistoryRun {
  id: string;
  modifiedMs: number;
  bytes: number;
  files: { name: string; size: number }[];
}

/**
 * Local-only run details (ADR-0007, "History"): the transcript and the proposed files of a run, in the app data
 * folder, never inside a vault. A run is named by its record's UUID and a file by a short flat name
 * (`a-z 0-9 . _ -`); the host accepts nothing else and bounds the sizes.
 */
export interface AgentHistoryStore {
  /** Creates or replaces a file (atomically). */
  write(id: string, name: string, data: Uint8Array): Promise<void>;
  /** Rejects with `ENOENT` when there is no such file. */
  read(id: string, name: string): Promise<Uint8Array>;
  /** Every run that has details, oldest first. */
  list(): Promise<HostHistoryRun[]>;
  /** Deletes a run's details. Harmless when there are none. */
  delete(id: string): Promise<void>;
}

export interface AgentHost {
  detect(provider: string): Promise<AgentProbe>;
  /** A new, empty, private working directory. `dir` is for display and tests; nothing is addressed by it. */
  createRun(provider: string): Promise<{ run: string; dir: string }>;
  files(run: string): AgentFiles;
  /** Runs the provider's CLI in the working directory with `argv` (the host checks it) and `stdin`. */
  start(run: string, argv: string[], stdin: Uint8Array, timeoutMs?: number): Promise<void>;
  /** Events after `after`, waiting up to `waitMs` for the first one. */
  events(run: string, after: number, waitMs: number): Promise<HostEventBatch>;
  /** SIGTERM to the run's process group, SIGKILL after a grace period. */
  cancel(run: string): Promise<void>;
  /** Stops the run if needed and deletes its working directory. */
  dispose(run: string): Promise<void>;
  /** Deletes working directories no open run owns (after a crash). Returns how many. */
  sweep(): Promise<number>;
  /** Local-only run details. */
  readonly history: AgentHistoryStore;
}
