import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EDITOR_TOKEN, startBrokenServer, startTestServer, type TestServer } from "./test-server.ts";

const exec = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");
const CLI = "protocol/conformance/src/cli.ts";

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], env: Record<string, string | undefined>): Promise<Outcome> {
  // Start from a clean environment so an ambient THOTH_TOKEN cannot leak into the test.
  const clean: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { cwd: ROOT, env: clean });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("conformance CLI", () => {
  let good: TestServer;
  let broken: TestServer;
  beforeAll(async () => {
    good = await startTestServer();
    broken = await startBrokenServer();
  });
  afterAll(async () => {
    await good.close();
    await broken.close();
  });

  it("exits 0 and prints a grouped report against a correct server, reading the token from THOTH_TOKEN", async () => {
    const out = await cli(["--url", good.url], { THOTH_TOKEN: EDITOR_TOKEN });
    expect(out.code, out.stdout + out.stderr).toBe(0);
    expect(out.stdout).toMatch(/\[core\]/);
    expect(out.stdout).toMatch(/\[transfers\]/);
    expect(out.stdout).toMatch(/PASS {2}core\.pages\.stale-if-match-conflict/);
    expect(out.stdout).toMatch(/\d+ passed, 0 failed, 0 skipped/);
  });

  it("never prints the token, on success or failure", async () => {
    for (const server of [good, broken]) {
      const out = await cli(["--url", server.url], { THOTH_TOKEN: EDITOR_TOKEN });
      expect(out.stdout).not.toContain(EDITOR_TOKEN);
      expect(out.stderr).not.toContain(EDITOR_TOKEN);
    }
    const json = await cli(["--url", good.url, "--json"], { THOTH_TOKEN: EDITOR_TOKEN });
    expect(json.stdout).not.toContain(EDITOR_TOKEN);
  });

  it("exits 1 and names the failing checks against a broken server", async () => {
    const out = await cli(["--url", broken.url], { THOTH_TOKEN: EDITOR_TOKEN });
    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(/FAIL {2}core\.pages\.stale-if-match-conflict/);
    expect(out.stdout).toMatch(/FAIL {2}core\.errors\.unknown-route/);
    expect(out.stdout).toMatch(/[1-9]\d* failed/);
  });

  it("prints machine-readable JSON with --json", async () => {
    const out = await cli(["--url", good.url, "--json"], { THOTH_TOKEN: EDITOR_TOKEN });
    expect(out.code).toBe(0);
    const report = JSON.parse(out.stdout) as { summary: { fail: number }; groups: { capability: string; results: { id: string; status: string }[] }[] };
    expect(report.summary.fail).toBe(0);
    expect(report.groups.map((g) => g.capability)).toContain("core");
  });

  it("reads the token from the variable named by --token-env", async () => {
    const out = await cli(["--url", good.url, "--token-env", "MY_WORKSPACE_TOKEN"], { MY_WORKSPACE_TOKEN: EDITOR_TOKEN });
    expect(out.code, out.stdout + out.stderr).toBe(0);
  });

  it("exits 2 with a clear message when the token variable is missing, without echoing anything secret", async () => {
    const out = await cli(["--url", good.url], {});
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/THOTH_TOKEN is not set/);
  });

  it("refuses a token passed as an argument", async () => {
    const out = await cli(["--url", good.url, "--token", "tok_from_argv_should_not_be_accepted"], { THOTH_TOKEN: EDITOR_TOKEN });
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/not accepted as arguments/);
    expect(out.stderr).not.toContain("tok_from_argv_should_not_be_accepted");
    const inline = await cli(["--url", good.url, "--token=tok_inline_should_not_be_accepted"], { THOTH_TOKEN: EDITOR_TOKEN });
    expect(inline.code).toBe(2);
    expect(inline.stderr).not.toContain("tok_inline_should_not_be_accepted");
  });

  it("requires --url, rejects unknown arguments, and shows help", async () => {
    expect((await cli([], { THOTH_TOKEN: EDITOR_TOKEN })).code).toBe(2);
    expect((await cli(["--url", good.url, "--bogus"], { THOTH_TOKEN: EDITOR_TOKEN })).code).toBe(2);
    expect((await cli(["--url", good.url, "--token-env", "not a name"], { THOTH_TOKEN: EDITOR_TOKEN })).code).toBe(2);
    const help = await cli(["--help"], {});
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/--url/);
    expect(help.stdout).toMatch(/THOTH_TOKEN/);
  });

  it("exits 1 and reports network errors, without leaking the token, when the server cannot be reached", async () => {
    const server = await startTestServer();
    const url = server.url;
    await server.close();
    const out = await cli(["--url", url], { THOTH_TOKEN: EDITOR_TOKEN });
    expect(out.code).toBe(1);
    expect(out.stdout + out.stderr).not.toContain(EDITOR_TOKEN);
    expect(out.stdout).toMatch(/network error/);
  });
});
