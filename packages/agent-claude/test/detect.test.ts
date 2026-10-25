import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentProbe, ProbeOutput } from "@thoth/agent-core";
import { compareVersions, interpretProbe, loggedIn, MIN_VERSION, missingFlags, parseVersion } from "../src/detect.ts";

const HELP = readFileSync(new URL("./fixtures/help-2.1.310.txt", import.meta.url), "utf8");
const ok = (stdout: string, code = 0): ProbeOutput => ({ code, stdout, stderr: "", timedOut: false });
const found = (over: Partial<Extract<AgentProbe, { found: true }>> = {}): AgentProbe => ({
  found: true,
  path: "/opt/homebrew/bin/claude",
  searched: ["/opt/homebrew/bin"],
  version: ok("2.1.310 (Claude Code)\n"),
  help: ok(HELP),
  auth: ok('{"loggedIn": true, "authMethod": "oauth_token"}'),
  ...over,
});

describe("Claude Code detection", () => {
  it("is ready with the installed version's real --help", () => {
    expect(missingFlags(HELP)).toEqual([]);
    expect(interpretProbe(found())).toEqual({ state: "ready", path: "/opt/homebrew/bin/claude", version: "2.1.310" });
  });

  it("reports a missing CLI with the folders searched", () => {
    expect(interpretProbe({ found: false, searched: ["/usr/bin", "/opt/homebrew/bin"] })).toEqual({ state: "missing", searched: ["/usr/bin", "/opt/homebrew/bin"] });
  });

  it("reports a version older than the first with every flag used", () => {
    expect(interpretProbe(found({ version: ok("2.1.100 (Claude Code)") }))).toEqual({ state: "too_old", path: "/opt/homebrew/bin/claude", version: "2.1.100", minimum: MIN_VERSION });
    expect(compareVersions("2.1.259", MIN_VERSION)).toBe(0);
    expect(compareVersions("2.2.0", "2.1.999")).toBe(1);
    expect(compareVersions("1.9.9", "2.0.0")).toBe(-1);
  });

  it("names the flags a CLI's --help lacks", () => {
    const old = HELP.replaceAll("--restricted", "--restrict-x").replaceAll("dontAsk", "dont");
    expect(interpretProbe(found({ help: ok(old) }))).toEqual({ state: "unsupported", path: "/opt/homebrew/bin/claude", version: "2.1.310", missingFlags: ["--restricted", "--permission-mode dontAsk"] });
    // A flag must appear as a whole word: "--tools-x" is not "--tools".
    expect(missingFlags("--tools-x --print")).toContain("--tools");
  });

  it("takes 'not logged in' from the CLI's own auth status, and does not block when it cannot tell", () => {
    expect(interpretProbe(found({ auth: ok('{"loggedIn": false, "authMethod": "none"}', 1) }))).toEqual({ state: "not_logged_in", path: "/opt/homebrew/bin/claude", version: "2.1.310" });
    expect(interpretProbe(found({ auth: ok("error: unknown command 'auth'", 1) })).state).toBe("ready");
    expect(loggedIn("not json")).toBeNull();
  });

  it("reports a CLI that does not answer", () => {
    expect(interpretProbe(found({ version: { code: null, stdout: "", stderr: "", timedOut: true } }))).toMatchObject({ state: "error" });
    expect(interpretProbe(found({ version: ok("hello") }))).toMatchObject({ state: "error" });
    expect(parseVersion("claude 2.1.310-beta")).toBe("2.1.310");
  });
});
