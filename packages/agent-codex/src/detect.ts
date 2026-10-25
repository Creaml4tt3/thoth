/**
 * Codex detection from the host's probes: `codex --version`, `codex exec --help`, `codex login status` and a sandbox
 * probe (the host runs `codex --version` inside Codex's own sandbox with Thoth's permission profile). Thoth never
 * reads `~/.codex/auth.json` or the keychain: whether someone is signed in comes from `codex login status`, and at
 * run time from the CLI's own errors (`stream.ts`).
 */
import type { AgentInstallationStatus, AgentProbe, ProbeOutput } from "@thoth/agent-core";

/**
 * The version every flag and `-c` key in `args.ts` was verified against (2026-10-25). `--ignore-user-config` and
 * `--ignore-rules` exist since 0.130.0 and `--strict-config` since 0.138.0 (checked in the CLI's source at those
 * tags), but the permission profile, its quote-free `-c` form, the sandbox probe and the `--json` events were only
 * checked on 0.164.0, so nothing older is accepted.
 */
export const MIN_VERSION = "0.164.0";

/** Flags `buildArgs` relies on; each must appear in `codex exec --help`. */
export const REQUIRED_FLAGS = ["--json", "--color", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--strict-config", "-c", "--config", "-m", "--model"] as const;

/** `codex-cli 0.164.0` → `0.164.0`. */
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

/** Required flags that `codex exec --help` does not list. */
export function missingFlags(help: string): string[] {
  return REQUIRED_FLAGS.filter((flag) => !new RegExp(`(^|[\\s,])${escape(flag)}(?![\\w-])`, "m").test(help));
}

/**
 * `codex login status` prints "Logged in using ChatGPT" (or an API key) and exits 0, or "Not logged in" and exits 1,
 * on stderr. Null when it cannot tell.
 */
export function loggedIn(probe: ProbeOutput): boolean | null {
  const said = `${probe.stdout}\n${probe.stderr}`;
  if (/\bnot logged in\b/i.test(said)) return false;
  if (probe.code === 0 && /\blogged in\b/i.test(said)) return true;
  return null;
}

/** True when the sandbox probe ran `codex --version` inside Codex's sandbox and it answered. */
export function sandboxWorks(probe: ProbeOutput | undefined): boolean {
  return probe !== undefined && !probe.timedOut && probe.code === 0 && /codex-cli \d+\.\d+\.\d+/.test(probe.stdout);
}

const said = (p: ProbeOutput, fallback: string) => (p.stderr.trim() || p.stdout.trim() || fallback).slice(0, 500);

export function interpretProbe(probe: AgentProbe): AgentInstallationStatus {
  if (!probe.found) return { state: "missing", searched: probe.searched };
  const { path } = probe;
  if (probe.version.timedOut || probe.version.code !== 0) return { state: "error", path, message: said(probe.version, "codex --version did not answer") };
  const version = parseVersion(probe.version.stdout);
  if (!version) return { state: "error", path, message: `Unrecognised version output: ${probe.version.stdout.trim().slice(0, 200)}` };
  if (compareVersions(version, MIN_VERSION) < 0) return { state: "too_old", path, version, minimum: MIN_VERSION };
  const missing = missingFlags(probe.help.stdout);
  if (missing.length > 0) return { state: "unsupported", path, version, missingFlags: missing };
  // Codex runs commands, so it never runs without its sandbox: no working sandbox, no run.
  if (!sandboxWorks(probe.sandbox)) return { state: "sandbox_unavailable", path, version, message: probe.sandbox ? said(probe.sandbox, "The sandbox did not start") : "The sandbox was not checked" };
  // An unreadable answer does not block: a run reports "not logged in" itself.
  if (loggedIn(probe.auth) === false) return { state: "not_logged_in", path, version };
  return { state: "ready", path, version };
}
