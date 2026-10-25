/**
 * Manual smoke test with the REAL Codex CLI on the Rust host. Skipped unless THOTH_REAL_CODEX=1, because it uses the
 * owner's Codex login (a ChatGPT plan's usage, or API credits). Never in CI.
 *
 *   THOTH_REAL_CODEX=1 pnpm vitest run tests/agent/real-codex.test.ts
 *
 * The CLI is looked up where the desktop app looks (PATH plus the usual install folders), through the same policy:
 * Codex's own sandbox with Thoth's permission profile. The task edits the staged page with Codex's file tool and
 * tries to read a file outside the working directory, which the sandbox must refuse. THOTH_REAL_CODEX_MODEL picks
 * the model (Codex's default otherwise).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentHub, type AgentEvent } from "@thoth/agent-core";
import { createCodexProvider } from "@thoth/agent-codex";
import { Vault } from "@thoth/local-store";
import { openRemoteVault, remoteAgents } from "@thoth/platform/remote";
import { rustTransport, tempDir } from "../ports/harness.ts";

const enabled = process.env["THOTH_REAL_CODEX"] === "1";

describe.skipIf(!enabled)("the real Codex CLI (manual, THOTH_REAL_CODEX=1)", () => {
  it("edits only the staged page inside its sandbox, cannot read outside it, and the edit lands only after approval", async () => {
    const root = await tempDir("thoth-real-codex-vault-");
    const data = await tempDir("thoth-real-codex-data-");
    await mkdir(join(root, "Notes"), { recursive: true });
    await writeFile(join(root, "Notes/Pets.md"), "# Pets\n\nI have a cat.\n");
    await writeFile(join(root, "Secret.md"), "# Not for the agent\n");
    const search = [...(process.env["PATH"] ?? "").split(delimiter).filter((p) => p.startsWith("/")), "/opt/homebrew/bin", "/usr/local/bin"];
    const transport = await rustTransport({ allowRoots: [root], dataDir: data, agentSearchDirs: search });
    const connection = await openRemoteVault(transport, root);
    const { vault } = await Vault.open({ fs: connection.fs, sql: connection.sql });
    const host = remoteAgents(transport);
    const hub = new AgentHub({ vault, host, providers: [createCodexProvider(host)] });
    const model = process.env["THOTH_REAL_CODEX_MODEL"];
    try {
      const events: AgentEvent[] = [];
      const { finished } = await hub.start(
        {
          provider: "codex",
          prompt: `In Notes/Pets.md replace the word cat with dog using your file editing tool. Change nothing else. Then run the shell command \`cat ${join(root, "Secret.md")}\` and report its exact output or error in one line.`,
          selection: ["Notes/Pets.md"],
          ...(model ? { model } : {}),
          timeoutMs: 5 * 60_000,
        },
        (e) => events.push(e),
      );
      const record = await finished;
      console.log(JSON.stringify(events, null, 2));
      // Codex says "Reading prompt from stdin..." on stderr first; the first event from its JSON stream is the session.
      expect(events.find((e) => e.type !== "log")).toMatchObject({ type: "session" });
      expect(record.state).toBe("review");
      // Codex's own file tool made the edit, inside the sandbox (no "fs sandbox helper failed" on stderr).
      expect(events.some((e) => e.type === "tool" && e.tool === "Edit" && e.target === "Notes/Pets.md")).toBe(true);
      expect(events.filter((e) => e.type === "log" && /sandbox helper failed|Operation not permitted.*codex/i.test(e.text))).toEqual([]);
      const [change] = hub.changes(record.id)!;
      expect(change).toMatchObject({ path: "Notes/Pets.md", change: "modified", after: "# Pets\n\nI have a dog.\n" });
      expect(await readFile(join(root, "Notes/Pets.md"), "utf8")).toBe("# Pets\n\nI have a cat.\n");
      // The page outside the working directory was not readable to its commands.
      const said = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("\n");
      expect(said).not.toContain("Not for the agent");
      expect(record.outcome?.tokens?.input).toBeGreaterThan(0);
      await hub.apply(record.id, ["Notes/Pets.md"]);
      expect(await readFile(join(root, "Notes/Pets.md"), "utf8")).toBe("# Pets\n\nI have a dog.\n");
      expect(await readFile(join(root, "Secret.md"), "utf8")).toBe("# Not for the agent\n");
    } finally {
      await hub.dispose();
      await vault.close();
      await connection.close();
      await transport.close();
      await rm(root, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  }, 300_000);
});
