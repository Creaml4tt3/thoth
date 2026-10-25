/**
 * Claude Code detection from the host's probes (`--version`, `--help`, `auth status --json`). Thoth never reads the
 * CLI's credential files or the keychain: whether someone is signed in comes from the CLI's own `auth status`, and at
 * run time from its own error output (`stream.ts`).
 */
import type { AgentInstallationStatus, AgentProbe } from "@thoth/agent-core";

/**
 * The first version with every flag `buildArgs` uses: `--restricted` (2.1.248) and `--permission-prompts`
 * (2.1.259), per https://code.claude.com/docs/en/cli-reference.
 */
export const MIN_VERSION = "2.1.259";

/** Flags `buildArgs` relies on; each must appear in `claude --help`. */
export const REQUIRED_FLAGS = [
  "--print",
  "--output-format",
  "--input-format",
  "--verbose",
  "--restricted",
  "--safe-mode",
  "--strict-mcp-config",
  "--mcp-config",
  "--tools",
  "--allowedTools",
  "--disallowedTools",
  "--permission-mode",
  "--permission-prompts",
  "--no-session-persistence",
  "--disable-slash-commands",
  "--model",
  "--max-budget-usd",
] as const;

/** `2.1.310 (Claude Code)` → `2.1.310`. */
export function parseVersion(text: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Required flags that `--help` does not list (plus `dontAsk`, a value of `--permission-mode`). */
export function missingFlags(help: string): string[] {
  const missing: string[] = REQUIRED_FLAGS.filter((flag) => !new RegExp(`(^|[\\s,])${escape(flag)}(?![\\w-])`, "m").test(help));
  if (!/\bdontAsk\b/.test(help)) missing.push("--permission-mode dontAsk");
  return missing;
}

/** `true`/`false` from `claude auth status --json`; null when it cannot tell. */
export function loggedIn(stdout: string): boolean | null {
  try {
    const value = JSON.parse(stdout) as { loggedIn?: unknown };
    return typeof value.loggedIn === "boolean" ? value.loggedIn : null;
  } catch {
    return null;
  }
}

export function interpretProbe(probe: AgentProbe): AgentInstallationStatus {
  if (!probe.found) return { state: "missing", searched: probe.searched };
  const { path } = probe;
  if (probe.version.timedOut || probe.version.code !== 0) {
    return { state: "error", path, message: (probe.version.stderr || probe.version.stdout || "claude --version did not answer").trim().slice(0, 500) };
  }
  const version = parseVersion(probe.version.stdout);
  if (!version) return { state: "error", path, message: `Unrecognised version output: ${probe.version.stdout.trim().slice(0, 200)}` };
  if (compareVersions(version, MIN_VERSION) < 0) return { state: "too_old", path, version, minimum: MIN_VERSION };
  const missing = missingFlags(probe.help.stdout);
  if (missing.length > 0) return { state: "unsupported", path, version, missingFlags: missing };
  // An unreadable answer does not block: a run reports "not logged in" itself.
  if (loggedIn(probe.auth.stdout) === false) return { state: "not_logged_in", path, version };
  return { state: "ready", path, version };
}
