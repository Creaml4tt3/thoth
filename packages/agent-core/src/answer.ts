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
    const raw = this.result?.text && this.result.text.trim() !== "" ? this.result.text : this.tail.length > 0 ? this.tail.join("\n\n") : this.last;
    return raw === null ? null : withVaultPaths(raw);
  }
}

// ---- Paths into the run's private work folder

/**
 * The run's work folder as an absolute path or `file://` URL, up to and including `…/agent-runs/run_<32 hex>/work/`
 * (both hosts name it so, ADR-0007). It starts at a boundary, and never runs across another absolute path (`␣/` or
 * `␣C:\`), so ordinary text before it is never taken. Spaces inside it are allowed ("Application Support").
 */
const WORK = String.raw`(?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])(?:(?!\s\/|\s[A-Za-z]:[\\/])[^\n<>()\[\]"'\x60])*?[\\/]agent-runs[\\/]run_[0-9a-f]{32}[\\/]work[\\/]`;
const TAIL = String.raw`[^\s<>()\[\]"'\x60]+`;
const MD_LINK = new RegExp(String.raw`\[([^\]\n]*)\]\(<?(${WORK})(${TAIL})>?\)`, "g");
const BARE = new RegExp(String.raw`(?<=^|[\s(<\["'\x60])(${WORK})(${TAIL})`, "gm");

/** A path inside the work folder, as the vault path it was staged from (decoded when it came from a URL). */
function vaultPath(prefix: string, tail: string): string {
  let path = tail.replace(/\\/g, "/");
  if (prefix.startsWith("file:")) {
    try {
      path = decodeURIComponent(path);
    } catch {
      // not valid percent-encoding: shown as it is
    }
  }
  return path;
}

/**
 * The CLI ran in a private copy of the pages (`<app data>/agent-runs/run_…/work/`), so it names them by that copy's
 * absolute path or `file://` URL. Shown to the person (and quoted in a follow-up), they read as the vault paths the
 * pages have: `[Test 2.md](file:///…/work/Test%202.md)` becomes `Test 2.md`. Nothing else changes.
 */
export function withVaultPaths(text: string): string {
  const linked = text.replace(MD_LINK, (_all, label: string, prefix: string, tail: string) => {
    const path = vaultPath(prefix, tail);
    const base = path.split("/").pop();
    return label.trim() === "" || label === path || label === base ? path : `${label} (${path})`;
  });
  return linked.replace(BARE, (_all, prefix: string, tail: string) => {
    const end = /[.,;:!?]+$/.exec(tail)?.[0] ?? "";
    return vaultPath(prefix, tail.slice(0, tail.length - end.length)) + end;
  });
}

/** The answer of a run from its events, or null when the agent said nothing. */
export function runAnswer(events: readonly AgentEvent[]): string | null {
  const tracker = new AnswerTracker();
  for (const event of events) tracker.push(event);
  return tracker.answer();
}
