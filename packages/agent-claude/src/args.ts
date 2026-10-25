/**
 * The Claude Code command line for one Agent Hub run. Every flag here was checked against `claude --help` of Claude
 * Code 2.1.310 and https://code.claude.com/docs/en/cli-reference on 2026-10-25, and one real run confirmed the
 * combination (see README.md). The prompt is not an argument: it goes to stdin (`--input-format text`), so it never
 * shows in a process list and can never be read as a flag.
 *
 * The Rust host accepts only this shape (`crates/thoth-host/src/agent/claude.rs`); `test/fixtures/argv.json` is
 * checked by both sides.
 */

/** The built-in tools the agent gets: reading and editing files in its working directory, nothing else. */
export const FILE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"] as const;
/** No MCP servers at all (with `--strict-mcp-config`, the user's configured servers are ignored too). */
export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

export interface ClaudeRunOptions {
  model?: string;
  maxBudgetUsd?: number;
}

/** `5` → "5", `0.5` → "0.5", `1.239` → "1.24". */
export function formatBudget(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0 || usd > 1000) throw new RangeError("The spending limit must be more than 0 and at most 1000 USD");
  return String(Math.round(usd * 100) / 100);
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

export function isModelName(name: string): boolean {
  return MODEL.test(name);
}

export function buildArgs(options: ClaudeRunOptions = {}): string[] {
  const tools = FILE_TOOLS.join(",");
  const args = [
    // Non-interactive, newline-delimited JSON events (stream-json needs --verbose in print mode).
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "text",
    // No command or code tools, no WebFetch, file tools confined to the working directory, user/project/local
    // settings ignored, bypassPermissions refused.
    "--restricted",
    // No CLAUDE.md, skills, plugins, hooks, custom agents or auto memory from the user's setup.
    "--safe-mode",
    "--strict-mcp-config",
    "--mcp-config",
    EMPTY_MCP_CONFIG,
    "--tools",
    tools,
    // Pre-approved, so nothing prompts; everything else is denied without asking (dontAsk + no prompt host).
    "--allowedTools",
    tools,
    "--disallowedTools",
    "mcp__*",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    // Nothing is added to the user's Claude Code session history.
    "--no-session-persistence",
    "--disable-slash-commands",
  ];
  if (options.model !== undefined && options.model !== "") {
    if (!isModelName(options.model)) throw new RangeError("That is not a model name Claude Code accepts");
    args.push("--model", options.model);
  }
  if (options.maxBudgetUsd !== undefined) args.push("--max-budget-usd", formatBudget(options.maxBudgetUsd));
  return args;
}
