/**
 * The fake Claude Code CLI (`packages/agent-claude/test/fake-claude/claude`) and what it records, for Agent Hub
 * tests. CI never calls a real model.
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const FAKE_CLAUDE_DIR = resolve(import.meta.dirname, "../../packages/agent-claude/test/fake-claude");

export interface FakeRecord {
  pid: number;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  files: { path: string; kind: string }[];
  grandchild: number | null;
}

/** What the fake wrote next to (outside) the working directory `work`; waits until it exists. */
export async function fakeRecord(work: string, timeoutMs = 20_000): Promise<FakeRecord> {
  const file = join(dirname(work), "fake-claude-record.json");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(await readFile(file, "utf8")) as FakeRecord;
    } catch {
      if (Date.now() > deadline) throw new Error(`The fake CLI wrote no record in ${dirname(work)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

/** True while `ps` lists the process (and it is not a zombie). */
export async function alive(pid: number): Promise<boolean> {
  const { execFileSync } = await import("node:child_process");
  try {
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return stat !== "" && !stat.startsWith("Z");
  } catch {
    return false;
  }
}

export async function waitDead(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await alive(pid)) {
    if (Date.now() > deadline) throw new Error(`Process ${pid} is still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
