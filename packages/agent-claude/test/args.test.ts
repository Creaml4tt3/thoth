import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildArgs, EMPTY_MCP_CONFIG, FILE_TOOLS, formatBudget, isModelName } from "../src/args.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/argv.json", import.meta.url), "utf8")) as { cases: { options: { model?: string; maxBudgetUsd?: number }; argv: string[] }[] };

describe("Claude Code arguments", () => {
  it("are exactly the verified argument lists the Rust host's policy accepts (fixtures/argv.json)", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(2);
    for (const { options, argv } of fixture.cases) expect(buildArgs(options)).toEqual(argv);
  });

  it("never carry the prompt, a shell or web tool, extra folders or permission bypasses", () => {
    const argv = buildArgs({ model: "opus", maxBudgetUsd: 2 });
    expect(argv.filter((a) => !a.startsWith("-"))).toEqual(["stream-json", "text", EMPTY_MCP_CONFIG, "Read,Edit,Write,Glob,Grep", "Read,Edit,Write,Glob,Grep", "mcp__*", "dontAsk", "none", "opus", "2"]);
    for (const banned of ["--add-dir", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--settings", "--plugin-dir", "--resume", "--continue", "--bare", "Bash", "WebFetch"]) {
      expect(argv.join(" ")).not.toContain(banned);
    }
    expect(FILE_TOOLS).toEqual(["Read", "Edit", "Write", "Glob", "Grep"]);
  });

  it("check the model name and spending limit before they reach the command line", () => {
    expect(buildArgs({ model: "" })).toEqual(fixture.cases[0]!.argv);
    for (const bad of ["-p", "--add-dir", "a b", "x;y", "m".repeat(101)]) expect(() => buildArgs({ model: bad })).toThrow(RangeError);
    expect(isModelName("claude-sonnet-5[1m]")).toBe(true);
    expect(formatBudget(5)).toBe("5");
    expect(formatBudget(0.5)).toBe("0.5");
    expect(formatBudget(1.239)).toBe("1.24");
    expect(formatBudget(100)).toBe("100");
    expect(formatBudget(0.25)).toBe("0.25");
    for (const bad of [0, 0.004, -1, 100.01, 101, 1001, Number.NaN, Infinity]) expect(() => formatBudget(bad)).toThrow(RangeError);
  });
});
