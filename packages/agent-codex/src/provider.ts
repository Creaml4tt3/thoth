/**
 * The Codex CLI as an `AgentProvider` (ADR-0007). It talks only to the `AgentHost` port: the host finds the binary,
 * checks the argument list and runs it in the staged working directory, inside Codex's own sandbox.
 *
 * Codex has no spending limit of its own (no flag or setting in 0.164.0; a ChatGPT login is billed to the plan's
 * usage, not in dollars per run), so this provider does not offer one and refuses a task that asks for one rather
 * than pretending to enforce it. The time limit is the host's and works as for any provider.
 */
import { LimitError, type AgentCapability, type AgentEvent, type AgentHost, type AgentInstallationStatus, type AgentProvider, type AgentRun, type AgentTaskInput } from "@thoth/agent-core";
import { buildArgs } from "./args.ts";
import { interpretProbe } from "./detect.ts";
import { createStreamParser } from "./stream.ts";

export const CODEX_PROVIDER_ID = "codex";
const POLL_WAIT_MS = 5000;
const MAX_STDERR_LINES = 50;

export interface CodexProviderOptions {
  /** Default wall-clock limit for a run; the host checks it. */
  timeoutMs?: number;
}

export function createCodexProvider(host: AgentHost, options: CodexProviderOptions = {}): AgentProvider {
  /** What each run was started with, for showing paths relative to its working directory. */
  const runs = new Map<string, { dir?: string; model?: string }>();
  return {
    id: CODEX_PROVIDER_ID,
    name: "Codex",

    async detect(): Promise<AgentInstallationStatus> {
      try {
        return interpretProbe(await host.detect(CODEX_PROVIDER_ID));
      } catch (error) {
        return { state: "error", message: error instanceof Error ? error.message : String(error) };
      }
    },

    async getCapabilities(): Promise<AgentCapability[]> {
      return ["streaming-output", "structured-events", "file-changes", "cancellation"];
    },

    async startTask(input: AgentTaskInput): Promise<AgentRun> {
      if (input.maxBudgetUsd !== undefined) throw new LimitError("budget", "Codex has no spending limit; start the task without one");
      const argv = buildArgs(input.model ? { model: input.model } : {});
      runs.set(input.workspace, { ...(input.dir ? { dir: input.dir } : {}), ...(input.model ? { model: input.model } : {}) });
      await host.start(input.workspace, argv, new TextEncoder().encode(input.prompt), input.timeoutMs ?? options.timeoutMs);
      return { id: input.workspace, providerId: CODEX_PROVIDER_ID, startedAt: Date.now() };
    },

    async *streamEvents(runId: string): AsyncIterable<AgentEvent> {
      const started = runs.get(runId);
      const parser = createStreamParser({ ...(started?.dir ? { cwd: started.dir } : {}), ...(started?.model ? { model: started.model } : {}) });
      const stderr: string[] = [];
      let after = 0;
      try {
        for (;;) {
          const batch = await host.events(runId, after, POLL_WAIT_MS);
          for (const event of batch.events) {
            if (event.kind === "stdout") yield* parser.line(event.line);
            else if (event.kind === "stderr") {
              stderr.push(event.line);
              if (stderr.length > MAX_STDERR_LINES) stderr.shift();
              yield { type: "log", text: event.line.slice(0, 500) };
            } else if (event.kind === "exit") yield* parser.exit(event.reason, event.code, event.signal, stderr);
          }
          after = batch.next;
          if (batch.done) return;
        }
      } finally {
        runs.delete(runId);
      }
    },

    async cancelRun(runId: string): Promise<void> {
      await host.cancel(runId);
    },
  };
}
