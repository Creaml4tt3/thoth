/**
 * `codex exec --json` → Agent Hub events. One JSON object per stdout line (the `ThreadEvent` type of Codex's
 * `codex-rs/exec/src/exec_events.rs` at rust-v0.164.0, and the event list in the non-interactive docs). Only the
 * types and fields below are relied on; anything else is ignored, and a line that is not JSON is passed on as a log
 * line. Verified against real runs of Codex CLI 0.164.0 (test/fixtures, README.md).
 *
 *   thread.started                           session
 *   item.started / item.completed, by item.type:
 *     agent_message (text)                   text
 *     command_execution (command, status,    tool "Shell" with the command; a failed one adds tool_error (exit code,
 *       exit_code, aggregated_output)          end of its output), a declined one denied
 *     file_change (changes[] path, kind)     tool "Edit" (update), "Write" (add), "Delete" (delete); failed → tool_error
 *     mcp_tool_call, web_search              tool (Thoth turns both off; shown if they ever appear)
 *     error (message)                        log (a non-fatal notice, such as unknown model metadata)
 *     reasoning, todo_list, collab_tool_call ignored
 *   error (message)                          "Reconnecting... N/M (…)" → retry; any other is kept for turn.failed
 *   turn.completed (usage)                   result ok, with the token counts (Codex reports tokens, not a cost)
 *   turn.failed (error.message)              result not ok + error: not_logged_in (401), model_not_found, rate_limit,
 *                                            billing, or cli
 *
 * Agent output is untrusted: text is kept as text (never HTML), messages are cut to a bounded length, and paths are
 * shown relative to the working directory.
 */
import type { AgentErrorCode, AgentEvent, ExitReason } from "@thoth/agent-core";

const MAX_TEXT = 20_000;
const MAX_MESSAGE = 500;
const MAX_TARGET = 200;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The file change kinds Codex reports, as the Agent Hub's tool names. */
const CHANGE_TOOL: Record<string, string> = { update: "Edit", add: "Write", delete: "Delete" };

/** What a failure message says, as the error the UI explains, with the API's own message when it is JSON. */
export function classifyError(raw: string): { code: AgentErrorCode; message: string } {
  let message = raw;
  let apiCode: string | undefined;
  let status: number | undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (isObject(value)) {
      status = num(value["status"]);
      const inner = value["error"];
      if (isObject(inner)) {
        apiCode = str(inner["code"]) ?? str(inner["type"]);
        message = str(inner["message"]) ?? raw;
      }
    }
  } catch {
    // plain text
  }
  const all = `${raw} ${apiCode ?? ""}`;
  if (apiCode === "model_not_found" || /model_not_found|model .* (is not supported|does not exist)/i.test(all)) return { code: "model_not_found", message };
  if (status === 401 || /\b401\b|unauthorized|not logged in|missing bearer|codex login/i.test(all)) return { code: "not_logged_in", message };
  if (status === 429 || /\b429\b|rate.?limit|usage limit|too many requests/i.test(all)) return { code: "rate_limit", message };
  if (/insufficient_quota|billing|payment required|out of credits/i.test(all)) return { code: "billing", message };
  return { code: "cli", message };
}

/** `/bin/zsh -lc "rg -n cat pets.md"` → `rg -n cat pets.md`. */
export function commandSummary(command: string): string {
  const match = /^\S*\b(?:ba|z|da)?sh\s+-l?c\s+([\s\S]*)$/.exec(command.trim());
  let shown = match ? match[1]!.trim() : command.trim();
  if (shown.length >= 2 && (shown[0] === '"' || shown[0] === "'") && shown.at(-1) === shown[0]) shown = shown.slice(1, -1);
  return clip(shown.replace(/\s+/g, " "), MAX_TARGET);
}

export interface StreamParser {
  /** Events for one stdout line. */
  line(text: string): AgentEvent[];
  /** Events for the process exit (an error when the CLI failed without saying why). */
  exit(reason: ExitReason, code: number | null, signal: number | null, stderr: readonly string[]): AgentEvent[];
}

export function createStreamParser(options: { cwd?: string; model?: string } = {}): StreamParser {
  /** Prefixes stripped from reported paths: the working directory, with and without macOS's /private. */
  const roots = new Set<string>();
  if (options.cwd) {
    const clean = options.cwd.replace(/[/\\]+$/, "");
    roots.add(clean);
    if (clean.startsWith("/private/")) roots.add(clean.slice("/private".length));
    else if (clean.startsWith("/")) roots.add(`/private${clean}`);
  }
  const relative = (path: string): string => {
    for (const root of roots) {
      if (path === root) return ".";
      if (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)) return path.slice(root.length + 1);
    }
    return path;
  };
  /** Items whose tool event was already sent (on item.started). */
  const shown = new Set<string>();
  let lastText: string | undefined;
  let pendingError: string | undefined;
  let sawResult = false;
  let sawError = false;

  const error = (code: AgentErrorCode, message: string): AgentEvent => {
    sawError = true;
    return { type: "error", code, message: clip(message, MAX_MESSAGE) };
  };

  const toolEvents = (item: Json, id: string): AgentEvent[] => {
    const type = str(item["type"]);
    if (type === "command_execution") return [{ type: "tool", id, tool: "Shell", target: commandSummary(str(item["command"]) ?? "") }];
    if (type === "file_change") {
      const changes = Array.isArray(item["changes"]) ? item["changes"].filter(isObject) : [];
      return changes.map((c) => ({ type: "tool", id, tool: CHANGE_TOOL[str(c["kind"]) ?? ""] ?? "Edit", target: clip(relative(str(c["path"]) ?? "?"), MAX_TARGET) }));
    }
    if (type === "mcp_tool_call") return [{ type: "tool", id, tool: "MCP", target: clip(`${str(item["server"]) ?? "?"}.${str(item["tool"]) ?? "?"}`, MAX_TARGET) }];
    if (type === "web_search") return [{ type: "tool", id, tool: "WebSearch", target: clip(str(item["query"]) ?? "", MAX_TARGET) }];
    return [];
  };

  const onItem = (item: Json, completed: boolean): AgentEvent[] => {
    const id = str(item["id"]) ?? "";
    const type = str(item["type"]);
    const status = str(item["status"]);
    if (type === "agent_message") {
      if (!completed) return [];
      const text = str(item["text"]);
      if (!text || text.trim() === "") return [];
      lastText = text;
      return [{ type: "text", text: clip(text, MAX_TEXT) }];
    }
    if (type === "error") return completed ? [{ type: "log", text: clip(str(item["message"]) ?? "", MAX_MESSAGE) }] : [];
    const out: AgentEvent[] = [];
    if (!shown.has(id)) {
      const tools = toolEvents(item, id);
      if (tools.length > 0) shown.add(id);
      out.push(...tools);
    }
    if (!completed) return out;
    if (type === "command_execution" && status === "declined") {
      out.push({ type: "denied", tool: "Shell", message: commandSummary(str(item["command"]) ?? "") });
    } else if (type === "command_execution" && status === "failed") {
      const exitCode = num(item["exit_code"]);
      const output = (str(item["aggregated_output"]) ?? "").trim();
      const tail = output.length > MAX_MESSAGE ? output.slice(-MAX_MESSAGE) : output;
      out.push({ type: "tool_error", id, message: clip(`${exitCode === undefined ? "failed" : `exit code ${exitCode}`}${tail ? `: ${tail}` : ""}`, MAX_MESSAGE) });
    } else if ((type === "file_change" || type === "mcp_tool_call") && status === "failed") {
      const failure = isObject(item["error"]) ? str(item["error"]["message"]) : undefined;
      out.push({ type: "tool_error", id, message: clip(failure ?? "The change could not be made", MAX_MESSAGE) });
    }
    return out;
  };

  return {
    line(text) {
      if (text.trim() === "") return [];
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return [{ type: "log", text: clip(text, MAX_MESSAGE) }];
      }
      if (!isObject(value)) return [];
      const type = str(value["type"]);
      if (type === "thread.started") return [{ type: "session", tools: [], ...(options.model ? { model: options.model } : {}) }];
      if (type === "item.started" || type === "item.updated" || type === "item.completed") {
        const item = value["item"];
        return isObject(item) && type !== "item.updated" ? onItem(item, type === "item.completed") : [];
      }
      if (type === "error") {
        const message = str(value["message"]) ?? "";
        const retry = /^Reconnecting\.\.\.\s*(\d+)\/\d+\s*\(([\s\S]*)\)\s*$/.exec(message);
        if (retry) return [{ type: "retry", attempt: Number(retry[1]), error: clip(retry[2]!, MAX_MESSAGE) }];
        pendingError = message;
        return [];
      }
      if (type === "turn.completed") {
        sawResult = true;
        const usage = isObject(value["usage"]) ? value["usage"] : {};
        const tokens = { input: num(usage["input_tokens"]) ?? 0, cachedInput: num(usage["cached_input_tokens"]) ?? 0, output: num(usage["output_tokens"]) ?? 0, reasoningOutput: num(usage["reasoning_output_tokens"]) ?? 0 };
        return [{ type: "result", ok: true, ...(lastText ? { text: clip(lastText, MAX_TEXT) } : {}), turns: 1, tokens }];
      }
      if (type === "turn.failed") {
        sawResult = true;
        const failure = isObject(value["error"]) ? str(value["error"]["message"]) : undefined;
        const { code, message } = classifyError(failure ?? pendingError ?? "The agent reported an error");
        const out: AgentEvent[] = [{ type: "result", ok: false, text: clip(message, MAX_TEXT) }];
        if (!sawError) out.push(error(code, message));
        return out;
      }
      return [];
    },

    exit(reason, code, signal, stderr) {
      const out: AgentEvent[] = [];
      if (reason === "exited" && code !== 0 && !sawResult && !sawError) {
        // Codex says "Reading prompt from stdin..." on stderr every time; the rest is the reason, if any.
        const said = stderr.filter((l) => !/^Reading prompt from stdin/.test(l)).slice(-5).join("\n").trim();
        const { code: kind, message } = classifyError(pendingError ?? (said || `Codex stopped with exit code ${code ?? signal ?? "?"}`));
        out.push(error(kind, message));
      }
      out.push({ type: "exit", reason, code, signal });
      return out;
    },
  };
}
