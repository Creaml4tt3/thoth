/**
 * The Claude Code CLI as an `AgentProvider` (ADR-0007). It talks only to the `AgentHost` port: the host finds the
 * binary, checks the argument list and runs it in the staged working directory.
 */
import type { AgentCapability, AgentEvent, AgentHost, AgentInstallationStatus, AgentProvider, AgentRun, AgentTaskInput } from "@thoth/agent-core";
import { buildArgs } from "./args.ts";
import { interpretProbe } from "./detect.ts";
import { createStreamParser } from "./stream.ts";

export const CLAUDE_PROVIDER_ID = "claude";
const POLL_WAIT_MS = 5000;
const MAX_STDERR_LINES = 50;

export interface ClaudeProviderOptions {
  /** Default wall-clock limit for a run; the host clamps it. */
  timeoutMs?: number;
}

export function createClaudeProvider(host: AgentHost, options: ClaudeProviderOptions = {}): AgentProvider {
  return {
    id: CLAUDE_PROVIDER_ID,
    name: "Claude Code",

    async detect(): Promise<AgentInstallationStatus> {
      try {
        return interpretProbe(await host.detect(CLAUDE_PROVIDER_ID));
      } catch (error) {
        return { state: "error", message: error instanceof Error ? error.message : String(error) };
      }
    },

    async getCapabilities(): Promise<AgentCapability[]> {
      return ["streaming-output", "structured-events", "file-changes", "cancellation", "spending-limit"];
    },

    async startTask(input: AgentTaskInput): Promise<AgentRun> {
      const argv = buildArgs({ ...(input.model ? { model: input.model } : {}), ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}) });
      await host.start(input.workspace, argv, new TextEncoder().encode(input.prompt), input.timeoutMs ?? options.timeoutMs);
      return { id: input.workspace, providerId: CLAUDE_PROVIDER_ID, startedAt: Date.now() };
    },

    async *streamEvents(runId: string): AsyncIterable<AgentEvent> {
      // The working directory comes from the CLI's own init event; tool paths are shown relative to it.
      const parser = createStreamParser();
      const stderr: string[] = [];
      let after = 0;
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
    },

    async cancelRun(runId: string): Promise<void> {
      await host.cancel(runId);
    },
  };
}
