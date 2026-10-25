import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@thoth/agent-core";
import { classifyError, commandSummary, createStreamParser } from "../src/stream.ts";

const lines = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n");
const parse = (name: string, options: Parameters<typeof createStreamParser>[0] = { cwd: "/RUN/work" }): AgentEvent[] => {
  const parser = createStreamParser(options);
  return lines(name).flatMap((l) => parser.line(l));
};

describe("codex exec --json", () => {
  it("turns a recorded edit run into the Agent Hub's events (apply_patch, relative paths, token usage)", () => {
    const events = parse("stream-edit.jsonl", { cwd: "/RUN/work", model: "gpt-5.6-luna" });
    expect(events).toEqual([
      { type: "session", tools: [], model: "gpt-5.6-luna" },
      { type: "text", text: "I’ll update `pets.md` with `apply_patch`, then run the requested command and report its result exactly in one line." },
      { type: "tool", id: "item_1", tool: "Shell", target: "pwd && rg -n -C 2 'cat' pets.md" },
      { type: "tool", id: "item_2", tool: "Edit", target: "pets.md" },
      { type: "text", text: "`cat: ../secret.txt: Operation not permitted` (exit code 1)" },
      { type: "result", ok: true, text: "`cat: ../secret.txt: Operation not permitted` (exit code 1)", turns: 1, tokens: { input: 52600, cachedInput: 45696, output: 344, reasoningOutput: 86 } },
    ]);
  });

  it("shows a command that failed in the sandbox with its exit code and output", () => {
    const events = parse("stream-shell-edit.jsonl");
    const curl = events.find((e) => e.type === "tool" && e.target?.startsWith("curl"));
    expect(curl).toMatchObject({ type: "tool", tool: "Shell", target: "curl -sS -m 5 https://example.com -o /dev/null" });
    expect(events).toContainEqual({ type: "tool_error", id: (curl as { id: string }).id, message: "exit code 6: curl: (6) Could not resolve host: example.com" });
    expect(events.at(-1)).toMatchObject({ type: "result", ok: true });
    // Each command is shown once, from item.started.
    expect(events.filter((e) => e.type === "tool").length).toBe(4);
  });

  it("maps an unknown model to model_not_found with the API's own message", () => {
    const events = parse("stream-model-not-found.jsonl");
    expect(events).toContainEqual({ type: "log", text: "Model metadata for `thoth-no-such-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues." });
    expect(events.slice(-2)).toEqual([
      { type: "result", ok: false, text: "The 'thoth-no-such-model' model is not supported when using Codex with a ChatGPT account." },
      { type: "error", code: "model_not_found", message: "The 'thoth-no-such-model' model is not supported when using Codex with a ChatGPT account." },
    ]);
  });

  it("maps a signed-out run (401) to not_logged_in, with its reconnects as retries", () => {
    const events = parse("stream-not-logged-in.jsonl");
    expect(events.filter((e) => e.type === "retry").map((e) => (e as { attempt: number }).attempt)).toEqual([2, 3, 4, 5, 1, 2, 3, 4, 5]);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "not_logged_in" });
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  it("reports a CLI that stopped without a turn result, from stderr but not its stdin notice", () => {
    const parser = createStreamParser();
    expect(parser.exit("exited", 1, null, ["Reading prompt from stdin...", "Error loading config.toml: unknown configuration field `x`"])).toEqual([
      { type: "error", code: "cli", message: "Error loading config.toml: unknown configuration field `x`" },
      { type: "exit", reason: "exited", code: 1, signal: null },
    ]);
    expect(createStreamParser().exit("cancelled", null, 15, [])).toEqual([{ type: "exit", reason: "cancelled", code: null, signal: 15 }]);
  });

  it("keeps agent output as bounded text and ignores what it does not know", () => {
    const parser = createStreamParser({ cwd: "/private/RUN/work" });
    expect(parser.line("not json")).toEqual([{ type: "log", text: "not json" }]);
    expect(parser.line(JSON.stringify({ type: "item.completed", item: { id: "r", type: "reasoning", text: "thinking" } }))).toEqual([]);
    expect(parser.line(JSON.stringify({ type: "something.new" }))).toEqual([]);
    const long = parser.line(JSON.stringify({ type: "item.completed", item: { id: "m", type: "agent_message", text: "x".repeat(30_000) } }));
    expect((long[0] as { text: string }).text.length).toBe(20_001);
    expect(parser.line(JSON.stringify({ type: "item.completed", item: { id: "f", type: "file_change", changes: [{ path: "/RUN/work/a.md", kind: "add" }, { path: "/RUN/work/b.md", kind: "delete" }], status: "failed" } }))).toEqual([
      { type: "tool", id: "f", tool: "Write", target: "a.md" },
      { type: "tool", id: "f", tool: "Delete", target: "b.md" },
      { type: "tool_error", id: "f", message: "The change could not be made" },
    ]);
    expect(parser.line(JSON.stringify({ type: "item.completed", item: { id: "d", type: "command_execution", command: "rm -rf /", aggregated_output: "", exit_code: null, status: "declined" } }))).toEqual([
      { type: "tool", id: "d", tool: "Shell", target: "rm -rf /" },
      { type: "denied", tool: "Shell", message: "rm -rf /" },
    ]);
  });

  it("summarises commands and classifies errors", () => {
    expect(commandSummary(`/bin/zsh -lc "sed -n '1,20p' pets.md"`)).toBe("sed -n '1,20p' pets.md");
    expect(commandSummary("/bin/bash -lc 'ls -la'")).toBe("ls -la");
    expect(commandSummary("ls")).toBe("ls");
    expect(classifyError("exceeded retry limit, last status: 429 Too Many Requests").code).toBe("rate_limit");
    expect(classifyError('{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}')).toEqual({ code: "billing", message: "You exceeded your current quota" });
    expect(classifyError("stream disconnected").code).toBe("cli");
  });
});
