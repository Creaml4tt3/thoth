/**
 * Claude Code `--output-format stream-json` → Agent Hub events. One JSON object per stdout line. Only the message
 * types and fields below are relied on; everything else (rate limit notices, thinking-token counters, UI hints,
 * future types) is ignored, and a line that is not JSON is passed on as a log line. Verified against a real run of
 * Claude Code 2.1.310 and the Agent SDK message reference (README.md lists the sources).
 *
 *   system/init               session: model, tools, claude_code_version, permissionMode, cwd
 *   system/permission_denied  denied: tool_name, message
 *   system/api_retry          retry: attempt, error
 *   assistant                 message.content[]: text → text, tool_use → tool (name, input); `error` (for example
 *                             "authentication_failed") → error
 *   user                      message.content[]: tool_result with is_error → tool_error
 *   result                    result: is_error, subtype, result, errors, total_cost_usd, num_turns, duration_ms.
 *                             A budget stop (--max-budget-usd used up) is subtype "error_max_budget_usd" with
 *                             is_error true, no `result` text and errors ["Reached maximum budget ($0.0001)"]
 *                             (recorded 2026-10-25: test/fixtures/stream-budget.jsonl); the CLI exits with 1.
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

/** The CLI's own error categories (assistant `error`, system/api_retry `error`) mapped to what the UI explains. */
const ERRORS: Record<string, AgentErrorCode> = {
  authentication_failed: "not_logged_in",
  oauth_org_not_allowed: "not_logged_in",
  billing_error: "billing",
  account_on_hold: "billing",
  rate_limit: "rate_limit",
  model_not_found: "model_not_found",
};

const NOT_LOGGED_IN = /not logged in|please run \/login|invalid api key/i;

export interface StreamParser {
  /** Events for one stdout line. */
  line(text: string): AgentEvent[];
  /** Events for the process exit (an error when the CLI failed without saying why). */
  exit(reason: ExitReason, code: number | null, signal: number | null, stderr: readonly string[]): AgentEvent[];
}

export function createStreamParser(options: { cwd?: string } = {}): StreamParser {
  /** Prefixes stripped from tool paths: the folder we gave and the one the CLI reports (macOS adds /private). */
  const roots = new Set<string>();
  const addRoot = (dir: string | undefined) => {
    if (!dir) return;
    const clean = dir.replace(/\/+$/, "");
    roots.add(clean);
    if (clean.startsWith("/private/")) roots.add(clean.slice("/private".length));
    else roots.add(`/private${clean}`);
  };
  addRoot(options.cwd);
  let sawResult = false;
  let sawError = false;

  const relative = (path: string): string => {
    for (const root of roots) {
      if (path === root) return ".";
      if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
    }
    return path;
  };

  const target = (tool: string, input: unknown): string | undefined => {
    if (!isObject(input)) return undefined;
    const path = str(input["file_path"]) ?? str(input["path"]) ?? str(input["notebook_path"]);
    const pattern = str(input["pattern"]);
    const shown = tool === "Glob" || tool === "Grep" ? (pattern ?? (path ? relative(path) : undefined)) : path ? relative(path) : pattern;
    return shown === undefined ? undefined : clip(shown, MAX_TARGET);
  };

  const error = (code: AgentErrorCode, message: string): AgentEvent => {
    sawError = true;
    return { type: "error", code, message: clip(message, MAX_MESSAGE) };
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
      const subtype = str(value["subtype"]);
      if (type === "system" && subtype === "init") {
        addRoot(str(value["cwd"]));
        const tools = Array.isArray(value["tools"]) ? value["tools"].filter((t): t is string => typeof t === "string") : [];
        const model = str(value["model"]);
        const cliVersion = str(value["claude_code_version"]);
        const permissionMode = str(value["permissionMode"]);
        return [{ type: "session", tools, ...(model ? { model } : {}), ...(cliVersion ? { cliVersion } : {}), ...(permissionMode ? { permissionMode } : {}) }];
      }
      if (type === "system" && subtype === "permission_denied") {
        return [{ type: "denied", tool: str(value["tool_name"]) ?? "?", message: clip(str(value["message"]) ?? str(value["decision_reason"]) ?? "", MAX_MESSAGE) }];
      }
      if (type === "system" && subtype === "api_retry") {
        return [{ type: "retry", attempt: num(value["attempt"]) ?? 0, error: str(value["error"]) ?? "unknown" }];
      }
      if (type === "assistant") {
        const out: AgentEvent[] = [];
        const message = value["message"];
        const content = isObject(message) && Array.isArray(message["content"]) ? message["content"] : [];
        for (const block of content) {
          if (!isObject(block)) continue;
          if (block["type"] === "text") {
            const t = str(block["text"]);
            if (t && t.trim() !== "") out.push({ type: "text", text: clip(t, MAX_TEXT) });
          } else if (block["type"] === "tool_use") {
            const tool = str(block["name"]) ?? "?";
            const shown = target(tool, block["input"]);
            out.push({ type: "tool", id: str(block["id"]) ?? "", tool, ...(shown !== undefined ? { target: shown } : {}) });
          }
        }
        const failure = str(value["error"]);
        if (failure) out.push(error(ERRORS[failure] ?? "cli", failure));
        return out;
      }
      if (type === "user") {
        const out: AgentEvent[] = [];
        const message = value["message"];
        const content = isObject(message) && Array.isArray(message["content"]) ? message["content"] : [];
        for (const block of content) {
          if (!isObject(block) || block["type"] !== "tool_result" || block["is_error"] !== true) continue;
          const body = block["content"];
          const text = typeof body === "string" ? body : Array.isArray(body) ? body.map((b) => (isObject(b) ? (str(b["text"]) ?? "") : "")).join(" ") : "";
          out.push({ type: "tool_error", id: str(block["tool_use_id"]) ?? "", message: clip(text, MAX_MESSAGE) });
        }
        return out;
      }
      if (type === "result") {
        sawResult = true;
        const ok = value["is_error"] !== true && subtype === "success";
        // A failed result may carry its reasons in `errors` instead of `result` (budget stop).
        const errors = Array.isArray(value["errors"]) ? value["errors"].filter((e): e is string => typeof e === "string") : [];
        const resultText = str(value["result"]) ?? (errors.length > 0 ? errors.join("; ") : undefined);
        const costUsd = num(value["total_cost_usd"]);
        const turns = num(value["num_turns"]);
        const durationMs = num(value["duration_ms"]);
        const out: AgentEvent[] = [
          { type: "result", ok, ...(resultText ? { text: clip(resultText, MAX_TEXT) } : {}), ...(costUsd !== undefined ? { costUsd } : {}), ...(turns !== undefined ? { turns } : {}), ...(durationMs !== undefined ? { durationMs } : {}) },
        ];
        if (!ok && !sawError) {
          if (resultText && NOT_LOGGED_IN.test(resultText)) out.push(error("not_logged_in", resultText));
          else if (subtype === "error_max_budget_usd" || str(value["terminal_reason"]) === "budget_exhausted") out.push(error("budget", resultText ?? subtype ?? "budget_exhausted"));
          else out.push(error("cli", resultText ?? subtype ?? "The agent reported an error"));
        }
        return out;
      }
      return [];
    },

    exit(reason, code, signal, stderr) {
      const out: AgentEvent[] = [];
      if (reason === "exited" && code !== 0 && !sawResult && !sawError) {
        const said = stderr.slice(-5).join("\n").trim();
        out.push(error(NOT_LOGGED_IN.test(said) ? "not_logged_in" : "cli", said || `Claude Code stopped with exit code ${code ?? signal ?? "?"}`));
      }
      out.push({ type: "exit", reason, code, signal });
      return out;
    },
  };
}
