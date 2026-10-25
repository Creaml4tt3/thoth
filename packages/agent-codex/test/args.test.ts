import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildArgs, CONFIG, isModelName, PROFILE } from "../src/args.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/argv.json", import.meta.url), "utf8")) as { cases: { options: { model?: string }; argv: string[] }[] };

describe("Codex arguments", () => {
  it("are exactly the verified argument lists the Rust host's policy accepts (fixtures/argv.json)", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(2);
    for (const { options, argv } of fixture.cases) expect(buildArgs(options)).toEqual(argv);
  });

  it("run non-interactively in Codex's sandbox: a write-only-here profile, no network, never asking", () => {
    const argv = buildArgs();
    expect(argv.slice(0, 9)).toEqual(["exec", "--json", "--color", "never", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--strict-config"]);
    const config = argv.filter((_, i) => argv[i - 1] === "-c");
    expect(config).toEqual(CONFIG);
    expect(config).toEqual(
      expect.arrayContaining([
        "approval_policy=never",
        `default_permissions=${PROFILE}`,
        "permissions.thoth.filesystem.:minimal=read",
        "permissions.thoth.filesystem.:workspace_roots=write",
        "permissions.thoth.filesystem.:slash_tmp=deny",
        "permissions.thoth.filesystem.:tmpdir=deny",
        "permissions.thoth.network.enabled=false",
        "sandbox_workspace_write.network_access=false",
        "web_search=disabled",
        "project_root_markers=[]",
        "project_doc_max_bytes=0",
      ]),
    );
    // Every value is quote- and brace-free, so nothing changes on its way through a Windows .cmd launcher.
    for (const a of argv) expect(a).not.toMatch(/["'%^&|<>{}\s]/);
  });

  it("never carry the prompt, a sandbox bypass, extra folders, web search or the user's profile", () => {
    const argv = buildArgs({ model: "gpt-5.5" });
    const text = argv.join(" ");
    for (const banned of ["danger-full-access", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--add-dir", "--search", "--profile", "-p ", "--sandbox", "-s ", "--full-auto", "--approve-for-me", "--oss", "--worktree", "--cd", "-C ", "--image", "--output-schema", "--output-last-message", "network_access=true", "on-request"]) {
      expect(text).not.toContain(banned);
    }
    // Every token is a flag, a -c value or the model: no positional prompt.
    const values = new Set([...CONFIG, "never", "gpt-5.5"]);
    expect(argv.filter((a) => !a.startsWith("-") && a !== "exec" && !values.has(a))).toEqual([]);
  });

  it("check the model name before it reaches the command line", () => {
    expect(buildArgs({ model: "" })).toEqual(fixture.cases[0]!.argv);
    expect(buildArgs({ model: "gpt-6.1-sol" }).slice(-2)).toEqual(["-m", "gpt-6.1-sol"]);
    for (const bad of ["-c", "--add-dir", "a b", "x;y", "m".repeat(101), 'x"y', "x=y"]) expect(() => buildArgs({ model: bad })).toThrow(RangeError);
    expect(isModelName("gpt-5.5")).toBe(true);
  });
});
