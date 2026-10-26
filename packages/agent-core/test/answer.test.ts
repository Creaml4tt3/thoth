/**
 * A run's answer (ADR-0007, amendment of 2026-10-26): what the agent said at the end, shown when the run ends. The
 * result's own text when it has one; else the last assistant text block(s), after the last tool call; never the text
 * of a failed result (that is the error, shown as the outcome).
 */
import { describe, expect, it } from "vitest";
import { runAnswer, type AgentEvent } from "../src/index.ts";

const session: AgentEvent = { type: "session", tools: [] };
const exit: AgentEvent = { type: "exit", reason: "exited", code: 0, signal: null };
const text = (t: string): AgentEvent => ({ type: "text", text: t });
const tool: AgentEvent = { type: "tool", id: "t1", tool: "Read", target: "Notes/Plan.md" };

describe("runAnswer", () => {
  it("is the result's text when the CLI gave one (Claude Code)", () => {
    expect(runAnswer([session, text("Looking."), tool, text("The page lists three tasks."), { type: "result", ok: true, text: "The page lists three tasks.\nNothing else.", costUsd: 0.01 }, exit])).toBe("The page lists three tasks.\nNothing else.");
  });

  it("falls back to the last text blocks after the last tool call when the result has no text", () => {
    expect(runAnswer([session, text("Looking."), tool, text("First part."), text("Second part."), { type: "result", ok: true, turns: 1 }, exit])).toBe("First part.\n\nSecond part.");
    expect(runAnswer([session, text("Looking."), tool, { type: "result", ok: true, text: "   " }, exit])).toBe("Looking.");
  });

  it("uses the last text when there is no result at all (a time-limit stop, a crash)", () => {
    expect(runAnswer([session, text("Half way there."), { type: "exit", reason: "timeout", code: null, signal: 15 }])).toBe("Half way there.");
  });

  it("is null when the agent said nothing, and for a failed result (its text is the error)", () => {
    expect(runAnswer([session, tool, { type: "result", ok: true }, exit])).toBeNull();
    expect(runAnswer([])).toBeNull();
    expect(runAnswer([session, text("Not logged in · Please run /login"), { type: "result", ok: false, text: "Not logged in · Please run /login" }, exit])).toBeNull();
  });
});
