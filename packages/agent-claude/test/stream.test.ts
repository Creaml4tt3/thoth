import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@thoth/agent-core";
import { createStreamParser } from "../src/stream.ts";

const lines = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n").filter(Boolean);

function parse(name: string, exit: [code: number | null, stderr?: string[]] = [0]): AgentEvent[] {
  const parser = createStreamParser();
  return [...lines(name).flatMap((l) => parser.line(l)), ...parser.exit("exited", exit[0], null, exit[1] ?? [])];
}

describe("stream-json parsing (recorded Claude Code 2.1.310 runs)", () => {
  it("turns a real edit run into session, tool, denial, text and result events, with paths relative to the working directory", () => {
    expect(parse("stream-edit.jsonl")).toEqual([
      { type: "session", tools: ["Edit", "Glob", "Grep", "Read", "Write"], model: "claude-haiku-5-5", cliVersion: "2.1.310", permissionMode: "dontAsk" },
      { type: "tool", id: "toolu_glob", tool: "Glob", target: "**/note.md" },
      { type: "tool", id: "toolu_outside", tool: "Read", target: "/tmp/thoth-probe-outside.txt" },
      {
        type: "denied",
        tool: "Read",
        message: "/tmp/thoth-probe-outside.txt is outside /private/tmp/thoth-agent-work, /tmp/thoth-agent-work; --restricted confines the file tools to the working directory.",
      },
      {
        type: "tool_error",
        id: "toolu_outside",
        message: "/tmp/thoth-probe-outside.txt is outside /private/tmp/thoth-agent-work, /tmp/thoth-agent-work; --restricted confines the file tools to the working directory.",
      },
      { type: "tool", id: "toolu_read", tool: "Read", target: "note.md" },
      { type: "tool", id: "toolu_edit", tool: "Edit", target: "note.md" },
      { type: "text", text: "Here's what happened:\n\n- Edit to `note.md`: worked.\n- Reading `/tmp/thoth-probe-outside.txt`: blocked.\n- Running `ls /`: not attempted. I don't have a shell tool in this session." },
      { type: "result", ok: true, text: "Here's what happened:\n\n- Edit to `note.md`: worked.", costUsd: 0.0014382500000000003, turns: 5, durationMs: 8442 },
      { type: "exit", reason: "exited", code: 0, signal: null },
    ]);
  });

  it("recognises the CLI's own not-logged-in answer", () => {
    const events = parse("stream-not-logged-in.jsonl", [1]);
    expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", code: "not_logged_in", message: "authentication_failed" }]);
    expect(events.find((e) => e.type === "result")).toEqual({ type: "result", ok: false, text: "Not logged in · Please run /login", costUsd: 0, turns: 1, durationMs: 40 });
  });

  it("recognises an unknown model", () => {
    const events = parse("stream-model-not-found.jsonl", [1]);
    expect(events.filter((e) => e.type === "error").map((e) => (e as { code: string }).code)).toEqual(["model_not_found"]);
  });

  it("passes non-JSON output on as a log line and ignores types it does not know", () => {
    const parser = createStreamParser();
    expect(parser.line("Warning: something")).toEqual([{ type: "log", text: "Warning: something" }]);
    expect(parser.line('{"type":"stream_event","event":{}}')).toEqual([]);
    expect(parser.line('{"type":"system","subtype":"thinking_tokens"}')).toEqual([]);
    expect(parser.line("[1,2]")).toEqual([]);
    expect(parser.line("")).toEqual([]);
  });

  it("explains a CLI that stopped without a result, from its stderr", () => {
    const parser = createStreamParser();
    expect(parser.exit("exited", 2, null, ["error: unknown option '--x'"])).toEqual([
      { type: "error", code: "cli", message: "error: unknown option '--x'" },
      { type: "exit", reason: "exited", code: 2, signal: null },
    ]);
    expect(createStreamParser().exit("exited", 1, null, ["Invalid API key · Please run /login"])[0]).toMatchObject({ code: "not_logged_in" });
    expect(createStreamParser().exit("cancelled", 143, null, [])).toEqual([{ type: "exit", reason: "cancelled", code: 143, signal: null }]);
  });

  it("keeps agent text as bounded plain text", () => {
    const parser = createStreamParser();
    const [event] = parser.line(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `<img src=x onerror=alert(1)>${"a".repeat(30_000)}` }] } }));
    expect(event).toMatchObject({ type: "text" });
    expect((event as { text: string }).text.startsWith("<img src=x onerror=alert(1)>")).toBe(true);
    expect((event as { text: string }).text.length).toBe(20_001);
  });

  it("recognises a budget stop from the CLI's own result (recorded with --max-budget-usd 0.0001)", () => {
    const events = parse("stream-budget.jsonl", [1]);
    expect(events).toEqual([
      { type: "session", tools: ["Edit", "Glob", "Grep", "Read", "Write"], model: "claude-haiku-5-5", cliVersion: "2.1.310", permissionMode: "dontAsk" },
      { type: "result", ok: false, text: "Reached maximum budget ($0.0001)", costUsd: 0.0001442, turns: 1, durationMs: 1398 },
      { type: "error", code: "budget", message: "Reached maximum budget ($0.0001)" },
      { type: "exit", reason: "exited", code: 1, signal: null },
    ]);
  });

  it("recognises a budget stop by its subtype or terminal reason alone, and still reports other failed results", () => {
    expect(createStreamParser().line(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.5 }))).toEqual([
      { type: "result", ok: false, costUsd: 0.5 },
      { type: "error", code: "budget", message: "error_max_budget_usd" },
    ]);
    expect(createStreamParser().line(JSON.stringify({ type: "result", subtype: "error_x", is_error: true, terminal_reason: "budget_exhausted" }))[1]).toMatchObject({ code: "budget" });
    expect(createStreamParser().line(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }))[1]).toMatchObject({ type: "error", code: "cli", message: "error_max_turns" });
  });
});
