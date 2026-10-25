import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentProbe, ProbeOutput } from "@thoth/agent-core";
import { compareVersions, interpretProbe, loggedIn, MIN_VERSION, missingFlags, parseVersion, sandboxWorks } from "../src/detect.ts";

const HELP = readFileSync(new URL("./fixtures/help-exec-0.164.0.txt", import.meta.url), "utf8");
const out = (stdout: string, code = 0, stderr = ""): ProbeOutput => ({ code, stdout, stderr, timedOut: false });
const PATH = "/opt/homebrew/Caskroom/codex/0.164.0/bin/codex";
const found = (over: Partial<Extract<AgentProbe, { found: true }>> = {}): AgentProbe => ({
  found: true,
  path: PATH,
  searched: ["/opt/homebrew/bin"],
  version: out("codex-cli 0.164.0\n"),
  help: out(HELP),
  // What `codex login status` really prints, on stderr.
  auth: out("", 0, "Logged in using ChatGPT\n"),
  sandbox: out("codex-cli 0.164.0\n", 0, "WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)\n"),
  ...over,
});

describe("Codex detection", () => {
  it("is ready with the installed version's real `codex exec --help`", () => {
    expect(missingFlags(HELP)).toEqual([]);
    expect(interpretProbe(found())).toEqual({ state: "ready", path: PATH, version: "0.164.0" });
  });

  it("reports a missing CLI with the folders searched", () => {
    expect(interpretProbe({ found: false, searched: ["/usr/bin", "/opt/homebrew/bin"] })).toEqual({ state: "missing", searched: ["/usr/bin", "/opt/homebrew/bin"] });
  });

  it("reports a version older than the one every flag was verified with", () => {
    expect(interpretProbe(found({ version: out("codex-cli 0.163.2") }))).toEqual({ state: "too_old", path: PATH, version: "0.163.2", minimum: MIN_VERSION });
    expect(compareVersions("0.164.0", MIN_VERSION)).toBe(0);
    expect(compareVersions("0.200.0", "0.164.9")).toBe(1);
    expect(parseVersion("codex-cli 0.165.0-alpha.1")).toBe("0.165.0");
  });

  it("names the flags `codex exec --help` lacks", () => {
    const old = HELP.replaceAll("--strict-config", "--strict-x").replaceAll("--ephemeral", "--eph");
    expect(interpretProbe(found({ help: out(old) }))).toEqual({ state: "unsupported", path: PATH, version: "0.164.0", missingFlags: ["--ephemeral", "--strict-config"] });
    expect(missingFlags("--json-x -c")).toContain("--json");
  });

  it("refuses to run Codex where its sandbox does not start, with the CLI's own reason", () => {
    const failed = interpretProbe(found({ sandbox: out("", 1, "Error: bubblewrap is unavailable\n") }));
    expect(failed).toEqual({ state: "sandbox_unavailable", path: PATH, version: "0.164.0", message: "Error: bubblewrap is unavailable" });
    expect(interpretProbe(found({ sandbox: { code: null, stdout: "", stderr: "", timedOut: true } })).state).toBe("sandbox_unavailable");
    // A host that did not run the probe never gets a "ready".
    const { sandbox: _, ...unprobed } = found() as Extract<AgentProbe, { found: true }>;
    expect(interpretProbe(unprobed).state).toBe("sandbox_unavailable");
    expect(sandboxWorks(out("", 0))).toBe(false);
  });

  it("takes 'not logged in' from `codex login status`, and does not block when it cannot tell", () => {
    expect(interpretProbe(found({ auth: out("", 1, "Not logged in\n") }))).toEqual({ state: "not_logged_in", path: PATH, version: "0.164.0" });
    expect(loggedIn(out("", 0, "Logged in using an API key - sk-proj-***ABCDE\n"))).toBe(true);
    expect(loggedIn(out("", 2, "error: unrecognized subcommand 'status'"))).toBeNull();
    expect(interpretProbe(found({ auth: out("", 2, "error") })).state).toBe("ready");
  });

  it("reports a CLI that does not answer", () => {
    expect(interpretProbe(found({ version: { code: null, stdout: "", stderr: "", timedOut: true } }))).toMatchObject({ state: "error" });
    expect(interpretProbe(found({ version: out("hello") }))).toMatchObject({ state: "error" });
  });
});
