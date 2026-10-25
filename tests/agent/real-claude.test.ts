/**
 * Manual smoke test with the REAL Claude Code CLI on the Rust host. Skipped unless THOTH_REAL_CLAUDE=1, because it
 * spends the owner's credits (about a tenth of a cent with haiku; capped by --max-budget-usd 0.10). Never in CI.
 *
 *   THOTH_REAL_CLAUDE=1 pnpm vitest run tests/agent/real-claude.test.ts
 *
 * The CLI is looked up where the desktop app looks (PATH plus the usual install folders), through the same policy.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentHub, type AgentEvent } from "@thoth/agent-core";
import { createClaudeProvider } from "@thoth/agent-claude";
import { Vault } from "@thoth/local-store";
import { openRemoteVault, remoteAgents } from "@thoth/platform/remote";
import { rustTransport, tempDir } from "../ports/harness.ts";

const enabled = process.env["THOTH_REAL_CLAUDE"] === "1";

describe.skipIf(!enabled)("the real Claude Code CLI (manual, THOTH_REAL_CLAUDE=1)", () => {
  it("edits only the staged page, and the edit lands only after approval", async () => {
    const root = await tempDir("thoth-real-claude-vault-");
    const data = await tempDir("thoth-real-claude-data-");
    await mkdir(join(root, "Notes"), { recursive: true });
    await writeFile(join(root, "Notes/Pets.md"), "# Pets\n\nI have a cat.\n");
    await writeFile(join(root, "Secret.md"), "# Not for the agent\n");
    const search = [...(process.env["PATH"] ?? "").split(delimiter).filter((p) => p.startsWith("/")), "/opt/homebrew/bin", "/usr/local/bin"];
    const transport = await rustTransport({ allowRoots: [root], dataDir: data, agentSearchDirs: search });
    const connection = await openRemoteVault(transport, root);
    const { vault } = await Vault.open({ fs: connection.fs, sql: connection.sql });
    const host = remoteAgents(transport);
    const hub = new AgentHub({ vault, host, providers: [createClaudeProvider(host)] });
    try {
      const events: AgentEvent[] = [];
      const { finished } = await hub.start(
        { provider: "claude", prompt: "In Notes/Pets.md replace the word cat with dog. Change nothing else. Then try to read ../Secret.md and report whether you could.", selection: ["Notes/Pets.md"], model: "haiku", maxBudgetUsd: 0.1 },
        (e) => events.push(e),
      );
      const record = await finished;
      console.log(JSON.stringify(events.filter((e) => e.type !== "log"), null, 2));
      expect(events[0]).toMatchObject({ type: "session", permissionMode: "dontAsk", tools: ["Edit", "Glob", "Grep", "Read", "Write"] });
      expect(record.state).toBe("review");
      const [change] = hub.changes(record.id)!;
      expect(change).toMatchObject({ path: "Notes/Pets.md", change: "modified", after: "# Pets\n\nI have a dog.\n" });
      expect(await readFile(join(root, "Notes/Pets.md"), "utf8")).toBe("# Pets\n\nI have a cat.\n");
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
  }, 180_000);
});
