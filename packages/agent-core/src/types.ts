/**
 * The Agent Hub contract (spec section 10, ADR-0007 rule 1). A provider wraps one AI CLI the user already has and is
 * signed in to. It never sees the vault: it runs in a working directory the host prepared (`AgentTaskInput.workspace`)
 * and reports what it does as `AgentEvent`s. What it changed is read back and reviewed by `AgentHub`, never by the
 * provider.
 */

/** `spending-limit`: the CLI enforces `AgentTaskInput.maxBudgetUsd` itself (Claude Code does, Codex has no such limit). */
export type AgentCapability = "streaming-output" | "resume-session" | "structured-events" | "file-changes" | "approval-controls" | "cancellation" | "spending-limit";

/** Whether the CLI can be used, and if not, what the user can do about it. */
export type AgentInstallationStatus =
  /** Not found in any folder that was searched. */
  | { state: "missing"; searched: string[] }
  /** Found, but older than the first version with every flag the adapter relies on. */
  | { state: "too_old"; path: string; version: string; minimum: string }
  /** Found, recent enough by number, but its `--help` lacks flags the adapter needs. */
  | { state: "unsupported"; path: string; version: string; missingFlags: string[] }
  /** The CLI itself says nobody is signed in. Thoth never looks at credentials. */
  | { state: "not_logged_in"; path: string; version: string }
  /** The CLI runs commands only inside its own OS sandbox, and that sandbox does not start here: it is not run. */
  | { state: "sandbox_unavailable"; path: string; version: string; message: string }
  | { state: "ready"; path: string; version: string }
  /** Found but could not be asked (it crashed or timed out). */
  | { state: "error"; path?: string; message: string };

export interface AgentTaskInput {
  /** The host's run handle: a working directory already holding the selected context. */
  workspace: string;
  /** Where that directory is (for showing the paths a CLI reports relative to it; nothing is addressed by it). */
  dir?: string;
  prompt: string;
  /** A model alias or name the CLI accepts; the CLI's default when absent. */
  model?: string;
  /** A spending limit the CLI enforces itself (an estimate, see the adapter README). */
  maxBudgetUsd?: number;
  timeoutMs?: number;
}

export interface AgentRun {
  /** Same as the workspace handle: one CLI process per working directory. */
  id: string;
  providerId: string;
  startedAt: number;
}

/** Tokens a run used, as the CLI reported them. */
export interface TokenUsage {
  input: number;
  cachedInput: number;
  output: number;
  reasoningOutput: number;
}

/** Why the CLI process ended. */
export type ExitReason = "exited" | "cancelled" | "timeout" | "output_limit";

/** Errors a provider recognises in the CLI's own output. */
export type AgentErrorCode = "not_logged_in" | "billing" | "rate_limit" | "model_not_found" | "budget" | "cli";

/**
 * What a run reports, in order. Agent output is untrusted text: it is shown, never executed or rendered as HTML.
 * Paths in `tool.target` are relative to the working directory when the provider can tell.
 */
export type AgentEvent =
  | { type: "session"; model?: string; tools: string[]; cliVersion?: string; permissionMode?: string }
  | { type: "text"; text: string }
  | { type: "tool"; id: string; tool: string; target?: string }
  | { type: "tool_error"; id: string; message: string }
  | { type: "denied"; tool: string; message: string }
  | { type: "retry"; attempt: number; error: string }
  /** `costUsd` when the CLI estimates a cost (Claude Code), `tokens` when it reports token counts instead (Codex). */
  | { type: "result"; ok: boolean; text?: string; costUsd?: number; turns?: number; durationMs?: number; tokens?: TokenUsage }
  | { type: "error"; code: AgentErrorCode; message: string }
  /** A line on the CLI's stderr. */
  | { type: "log"; text: string }
  | { type: "exit"; reason: ExitReason; code: number | null; signal: number | null };

export interface AgentProvider {
  readonly id: string;
  /** Shown in the UI ("Claude Code"). */
  readonly name: string;
  detect(): Promise<AgentInstallationStatus>;
  getCapabilities(): Promise<AgentCapability[]>;
  startTask(input: AgentTaskInput): Promise<AgentRun>;
  /** Every event of the run, ending with `exit`. Safe to call once per run. */
  streamEvents(runId: string): AsyncIterable<AgentEvent>;
  cancelRun(runId: string): Promise<void>;
}
