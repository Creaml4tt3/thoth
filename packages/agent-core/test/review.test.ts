/**
 * Staging limits and review of untrusted output, without a CLI: the test plays the agent by changing the working
 * directory directly.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@thoth/domain";
import { openNodeVault } from "@thoth/local-store/node";
import type { Vault } from "@thoth/local-store";
import { applyChanges, collectChanges, StagingError, stageContext, type AgentFiles } from "../src/index.ts";
import { NodeAgentHost } from "../src/node/index.ts";

let root: string;
let data: string;
let vault: Vault;
let host: NodeAgentHost;
let files: AgentFiles;
let work: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "thoth-agent-core-")));
  data = await realpath(await mkdtemp(join(tmpdir(), "thoth-agent-core-data-")));
  await mkdir(join(root, "A"), { recursive: true });
  await writeFile(join(root, "A/One.md"), "# One\n");
  await writeFile(join(root, "A/Two.md"), "# Two\n");
  await writeFile(join(root, "Top.md"), "# Top\n");
  ({ vault } = await openNodeVault(root));
  host = new NodeAgentHost({ dataDir: data, searchDirs: [] });
  const created = await host.createRun("claude");
  files = host.files(created.run);
  work = created.dir;
});

afterEach(async () => {
  await host.close();
  await vault.close();
  await rm(root, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
});

describe("staging", () => {
  it("copies a folder's files with their hashes and nothing else", async () => {
    const manifest = await stageContext(vault, files, ["A"]);
    expect(manifest).toEqual([
      { path: "A/One.md", hash: sha256Hex("# One\n"), size: 6, kind: "page", via: "folder" },
      { path: "A/Two.md", hash: sha256Hex("# Two\n"), size: 6, kind: "page", via: "folder" },
    ]);
    expect((await files.list("")).map((e) => e.name)).toEqual(["A"]);
  });

  it("refuses more than the limits allow", async () => {
    await expect(stageContext(vault, files, ["A"], { maxFiles: 1, maxFileBytes: 100, maxTotalBytes: 100 })).rejects.toMatchObject({ problem: { code: "too_many", count: 2, limit: 1 } });
    await expect(stageContext(vault, files, ["A"], { maxFiles: 10, maxFileBytes: 5, maxTotalBytes: 100 })).rejects.toBeInstanceOf(StagingError);
    await expect(stageContext(vault, files, ["A", "Top.md"], { maxFiles: 10, maxFileBytes: 100, maxTotalBytes: 12 })).rejects.toMatchObject({ problem: { code: "too_large", size: 18 } });
  });
});

describe("review of untrusted output", () => {
  it("reports what cannot be applied and never applies it", async () => {
    const manifest = await stageContext(vault, files, ["A", "Top.md"]);
    await writeFile(join(work, "A/One.md"), new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a])); // not UTF-8
    await writeFile(join(work, "A/Two.md"), "x".repeat(64));
    await writeFile(join(work, "Big.bin"), "y".repeat(64));
    await writeFile(join(work, "Top.md"), "# Top\n"); // unchanged
    await writeFile(join(work, "notes.txt"), "plain text");
    execFileSync("mkfifo", [join(work, "pipe")]);
    await symlink("/etc", join(work, "etc"));
    await mkdir(join(work, ".THOTH"), { recursive: true });
    const changes = await collectChanges(vault, files, manifest, { maxFileBytes: 32, maxEntries: 100, maxDepth: 8 });
    expect(changes.map((c) => [c.path, c.change, c.problem ?? null])).toEqual([
      [".THOTH", "added", "reserved"],
      ["A/One.md", "modified", "not_utf8"],
      ["A/Two.md", "modified", "too_large"],
      ["Big.bin", "added", "too_large"],
      ["etc", "added", "symlink"],
      ["notes.txt", "added", null],
      ["pipe", "added", "special_file"],
    ]);
    const results = await applyChanges(vault, files, changes, new Set(changes.map((c) => c.path)));
    expect(results).toEqual([{ path: "notes.txt", result: "applied", hash: sha256Hex("plain text") }]);
    expect((await vault.readPage("A/One.md")).source).toBe("# One\n");
    expect((await vault.readPage("A/Two.md")).source).toBe("# Two\n");
  });

  it("stops walking at the entry limit and says so", async () => {
    const manifest = await stageContext(vault, files, ["Top.md"]);
    for (let i = 0; i < 5; i++) await writeFile(join(work, `n${i}.md`), `# ${i}\n`);
    const changes = await collectChanges(vault, files, manifest, { maxFileBytes: 1000, maxEntries: 3, maxDepth: 8 });
    expect(changes.some((c) => c.problem === "too_many")).toBe(true);
  });

  it("refuses bytes that changed after review", async () => {
    const manifest = await stageContext(vault, files, ["Top.md"]);
    await writeFile(join(work, "Top.md"), "# Top, agent\n");
    const changes = await collectChanges(vault, files, manifest);
    await writeFile(join(work, "Top.md"), "# Top, swapped after review\n");
    const [result] = await applyChanges(vault, files, changes, new Set(["Top.md"]));
    expect(result).toMatchObject({ path: "Top.md", result: "failed", message: expect.stringContaining("after it was reviewed") });
    expect((await vault.readPage("Top.md")).source).toBe("# Top\n");
  });
});
