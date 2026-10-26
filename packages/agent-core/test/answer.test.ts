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

describe("the answer names pages as you know them, not by the run's private work folder", () => {
  const work = "/Users/a/Library/Application Support/io.github.creaml4tt3.thoth/agent-runs/run_5b11accfe44550c4eeeb9c2bcfbce1c1/work";
  const url = `file://${work.replace(/ /g, "%20")}`;
  const answer = (t: string) => runAnswer([text(t), { type: "result", ok: true, text: t }, exit]);

  it("turns a Markdown link into the work folder into the page's path", () => {
    expect(answer(`I wrote it beneath the heading in [Test 2.md](${url}/Test%202.md).`)).toBe("I wrote it beneath the heading in Test 2.md.");
    // A label that is not the path keeps the path next to it.
    expect(answer(`See [the drawing](${url}/Notes/bird-uric-acid.svg).`)).toBe("See the drawing (Notes/bird-uric-acid.svg).");
  });

  it("turns bare file URLs and absolute paths into the work folder into vault paths, /private too", () => {
    expect(answer(`Saved ${url}/Notes/A%20b.md and ${work}/Plan.md and /private${work}/x.md.`)).toBe("Saved Notes/A b.md and Plan.md and x.md.");
    expect(answer(`<${url}/Test%202.md>`)).toBe("<Test 2.md>");
    expect(answer(`Look in C:\\Users\\a\\AppData\\Roaming\\io.github.creaml4tt3.thoth\\agent-runs\\run_5b11accfe44550c4eeeb9c2bcfbce1c1\\work\\Notes\\Plan.md now`)).toBe("Look in Notes/Plan.md now");
  });

  it("leaves every other path and link alone", () => {
    const other = "Read /etc/hosts, https://example.org/a%20b and [x](file:///Users/a/Notes/x.md); agent-runs/run_x/work/y stays.";
    expect(answer(other)).toBe(other);
  });
});
