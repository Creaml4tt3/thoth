/**
 * A run's answer (ADR-0007, amendment of 2026-10-26): what the agent said at the end, shown to the person when the
 * run ends (the mascot's bubble, the session tab). It is agent output, so it lives where the transcript does: in
 * memory for the run just finished and in the local-only transcript (`details.ts`), never in the vault's run record.
 *
 * - The result's own text, when the CLI gave one (Claude Code's `result`, Codex's last agent message).
 * - Otherwise the last assistant text block(s): every text after the last tool call, in order, or the last text
 *   before it when the agent said nothing after its last tool call.
 * - Never the text of a failed result: that is the error, which the outcome already says.
 *
 * Plain text, as the adapters clipped it. It is shown as text, never as HTML or Markdown.
 */
import type { AgentEvent } from "./types.ts";

/** Events after which earlier text no longer counts as the end of the answer. */
const ACTIONS: ReadonlySet<AgentEvent["type"]> = new Set(["tool", "tool_error", "denied", "error"]);

/** Keeps what `runAnswer` needs while a run streams, so the hub need not hold every event. */
export class AnswerTracker {
  private result: Extract<AgentEvent, { type: "result" }> | null = null;
  private tail: string[] = [];
  private last: string | null = null;

  push(event: AgentEvent): void {
    if (event.type === "result") this.result = event;
    else if (event.type === "text" && event.text.trim() !== "") {
      this.tail.push(event.text);
      this.last = event.text;
    } else if (ACTIONS.has(event.type)) this.tail = [];
  }

  answer(): string | null {
    if (this.result && !this.result.ok) return null;
    if (this.result?.text && this.result.text.trim() !== "") return this.result.text;
    return this.tail.length > 0 ? this.tail.join("\n\n") : this.last;
  }
}

/** The answer of a run from its events, or null when the agent said nothing. */
export function runAnswer(events: readonly AgentEvent[]): string | null {
  const tracker = new AnswerTracker();
  for (const event of events) tracker.push(event);
  return tracker.answer();
}
