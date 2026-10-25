/**
 * Context for an agent without a CLI (ADR-0007, "Context"): the whole Private Space, workspace pages as read-only
 * reference copies, the total shown before starting, and review that never offers a change to a reference copy. The
 * test plays the agent by changing the working directory directly.
 */
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@thoth/domain";
import { openNodeVault } from "@thoth/local-store/node";
import type { Vault } from "@thoth/local-store";
import {
  applyChanges,
  checkBudgetUsd,
  checkTimeLimitMs,
  collectChanges,
  LimitError,
  previewContext,
  readOnlyRoots,
  safeSegment,
  stageContext,
  workspaceContextAccess,
  workspaceFraming,
  workspaceLayout,
  type AgentFiles,
  type WorkspaceDocument,
} from "../src/index.ts";
import { NodeAgentHost } from "../src/node/index.ts";

let root: string;
let data: string;
let vault: Vault;
let host: NodeAgentHost;
let files: AgentFiles;
let work: string;

const doc = (title: string, markdown = `# ${title}\n`, workspaceName = "Team Docs", workspaceId = "ws_1"): WorkspaceDocument => ({
  workspaceId,
  workspaceName,
  pageId: `page-${title}`,
  title,
  markdown,
  revisionId: `rev-${title}`,
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "thoth-agent-context-")));
  data = await realpath(await mkdtemp(join(tmpdir(), "thoth-agent-context-data-")));
  await mkdir(join(root, "A"), { recursive: true });
  await mkdir(join(root, "Assets"), { recursive: true });
  await writeFile(join(root, "A/One.md"), "# One\n");
  await writeFile(join(root, "A/Two.md"), "# Two\n");
  await writeFile(join(root, "Assets/pic.png"), new Uint8Array([1, 2, 3, 4]));
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

describe("the whole Private Space", () => {
  it("stages every file, folders and attachments included, but never .thoth/", async () => {
    await writeFile(join(root, ".thoth/note.json"), "{}");
    const manifest = await stageContext(vault, files, [], undefined, { wholeSpace: true });
    expect(manifest.map((m) => [m.path, m.via, m.kind])).toEqual([
      ["A/One.md", "space", "page"],
      ["A/Two.md", "space", "page"],
      ["Assets/pic.png", "space", "file"],
      ["Top.md", "space", "page"],
    ]);
    expect((await files.list("")).map((e) => e.name).sort()).toEqual(["A", "Assets", "Top.md"]);
    await expect(stat(join(work, ".thoth"))).rejects.toThrow();
  });

  it("respects the count and size limits", async () => {
    await expect(stageContext(vault, files, [], { maxFiles: 3, maxFileBytes: 100, maxTotalBytes: 100 }, { wholeSpace: true })).rejects.toMatchObject({ problem: { code: "too_many", count: 4, limit: 3 } });
    await expect(stageContext(vault, files, [], { maxFiles: 10, maxFileBytes: 100, maxTotalBytes: 20 }, { wholeSpace: true })).rejects.toMatchObject({ problem: { code: "too_large", size: 22, limit: 20 } });
    expect(await files.list("")).toEqual([]);
  });

  it("is totalled before anything is copied, with the same limits", async () => {
    expect(await previewContext(vault, [], { wholeSpace: true })).toEqual({ files: 4, bytes: 6 + 6 + 4 + 6, problem: null });
    expect(await previewContext(vault, ["A"])).toEqual({ files: 2, bytes: 12, problem: null });
    expect(await previewContext(vault, [])).toEqual({ files: 0, bytes: 0, problem: null });
    expect(await previewContext(vault, [], { wholeSpace: true }, { maxFiles: 3, maxFileBytes: 100, maxTotalBytes: 100 })).toMatchObject({ files: 4, problem: { code: "too_many", count: 4, limit: 3 } });
    expect(await previewContext(vault, [], { wholeSpace: true }, { maxFiles: 10, maxFileBytes: 5, maxTotalBytes: 100 })).toMatchObject({ problem: { code: "file_too_large" } });
    expect(await previewContext(vault, ["A"], {}, { maxFiles: 10, maxFileBytes: 100, maxTotalBytes: 10 })).toMatchObject({ files: 2, bytes: 12, problem: { code: "too_large", size: 12, limit: 10 } });
    expect(await previewContext(vault, ["Nowhere.md"])).toMatchObject({ problem: { code: "not_found", path: "Nowhere.md" } });
  });
});

describe("workspace pages as read-only reference copies", () => {
  it("go to workspace/<workspace name>/<title>.md without write permission, next to the Private Space files", async () => {
    const manifest = await stageContext(vault, files, ["Top.md"], undefined, { workspace: [doc("Spec", "# Spec\n\nSecret roadmap.\n"), doc("Plan"), doc("Notes", "# Notes\n", "Other Team", "ws_2")] });
    expect(manifest.map((m) => [m.path, m.via, m.readOnly ?? false])).toEqual([
      ["Top.md", "selected", false],
      ["workspace/Team Docs/Spec.md", "workspace", true],
      ["workspace/Team Docs/Plan.md", "workspace", true],
      ["workspace/Other Team/Notes.md", "workspace", true],
    ]);
    expect(manifest[1]).toMatchObject({ hash: sha256Hex("# Spec\n\nSecret roadmap.\n"), kind: "page", workspace: { workspaceId: "ws_1", workspaceName: "Team Docs", pageId: "page-Spec", title: "Spec", revisionId: "rev-Spec" } });
    expect((await stat(join(work, "workspace/Team Docs/Spec.md"))).mode & 0o222).toBe(0);
    expect((await stat(join(work, "Top.md"))).mode & 0o200).not.toBe(0);
    expect(new TextDecoder().decode(await files.readFile("workspace/Team Docs/Spec.md"))).toBe("# Spec\n\nSecret roadmap.\n");
  });

  it("can be the only context", async () => {
    const manifest = await stageContext(vault, files, [], undefined, { workspace: [doc("Spec")] });
    expect(manifest.map((m) => m.path)).toEqual(["workspace/Team Docs/Spec.md"]);
    await expect(stageContext(vault, files, [], undefined, {})).rejects.toMatchObject({ problem: { code: "empty" } });
  });

  it("count against the same limits as everything else", async () => {
    await expect(stageContext(vault, files, ["Top.md"], { maxFiles: 1, maxFileBytes: 100, maxTotalBytes: 100 }, { workspace: [doc("Spec")] })).rejects.toMatchObject({ problem: { code: "too_many", count: 2 } });
    await expect(stageContext(vault, files, [], { maxFiles: 5, maxFileBytes: 100, maxTotalBytes: 5 }, { workspace: [doc("Spec", "# Spec, long\n")] })).rejects.toMatchObject({ problem: { code: "too_large" } });
  });

  it("get safe, unique names, and a different folder when the Private Space already has a 'workspace'", () => {
    expect(safeSegment("a/b\\c:d*e?", "x")).toBe("a-b-c-d-e");
    expect(safeSegment("../..", "Untitled")).toBe("Untitled");
    expect(safeSegment("  .hidden. ", "x")).toBe("hidden");
    expect(safeSegment(".thoth", "Untitled")).toBe("thoth"); // leading dots go, so it can never name the metadata folder
    expect(safeSegment("é".repeat(200), "x")).toHaveLength(80);
    const layout = workspaceLayout([doc("Spec"), doc("spec"), doc("a/b"), doc("Spec", "x", "team docs", "ws_2"), doc("../../etc")], ["Top.md"]);
    expect(layout.root).toBe("workspace");
    expect(layout.files.map((f) => f.path)).toEqual(["workspace/Team Docs/Spec.md", "workspace/Team Docs/spec (2).md", "workspace/Team Docs/a-b.md", "workspace/team docs (2)/Spec.md", "workspace/Team Docs/etc.md"]);
    expect(workspaceLayout([doc("Spec")], ["Workspace/mine.md"]).root).toBe("workspace (read-only)");
    expect(workspaceLayout([doc("Spec")], ["Workspace/mine.md", "workspace (read-only)/x.md"]).root).toBe("workspace (read-only 2)");
    expect(workspaceFraming("workspace")).toContain('"workspace/" holds read-only copies');
  });

  it("never mix with a Private Space folder of the same name", async () => {
    await mkdir(join(root, "workspace"));
    await writeFile(join(root, "workspace/mine.md"), "# Mine\n");
    ({ vault } = await openNodeVault(root));
    const manifest = await stageContext(vault, files, ["workspace"], undefined, { workspace: [doc("Spec")] });
    expect(manifest.map((m) => [m.path, m.readOnly ?? false])).toEqual([
      ["workspace/mine.md", false],
      ["workspace (read-only)/Team Docs/Spec.md", true],
    ]);
  });

  it("are never offered for approval when the agent changes, adds or deletes them, and nothing is written for them", async () => {
    const manifest = await stageContext(vault, files, ["A"], undefined, { workspace: [doc("Spec"), doc("Plan"), doc("Keep")] });
    // The agent works around the file mode.
    await writeFile(join(work, "A/One.md"), "# One, edited\n");
    await rm(join(work, "workspace/Team Docs/Spec.md"));
    await writeFile(join(work, "workspace/Team Docs/Spec.md"), "# Spec, rewritten\n");
    await rm(join(work, "workspace/Team Docs/Plan.md"));
    await writeFile(join(work, "workspace/Team Docs/Brand new.md"), "# Added\n");
    await mkdir(join(work, "workspace/Another"));
    await writeFile(join(work, "workspace/Another/x.md"), "x");
    const changes = await collectChanges(vault, files, manifest);
    expect(changes.map((c) => [c.path, c.change, c.problem])).toEqual([
      ["A/One.md", "modified", undefined],
      ["workspace/Another/x.md", "added", "read_only"],
      ["workspace/Team Docs/Brand new.md", "added", "read_only"],
      ["workspace/Team Docs/Plan.md", "deleted", "read_only"],
      ["workspace/Team Docs/Spec.md", "modified", "read_only"],
    ]);
    // Untouched reference copies are not changes.
    expect(changes.some((c) => c.path.endsWith("Keep.md"))).toBe(false);
    // Approving everything applies only the Private Space edit.
    const results = await applyChanges(vault, files, changes, new Set(changes.map((c) => c.path)));
    expect(results.map((r) => [r.path, r.result])).toEqual([["A/One.md", "applied"]]);
    await expect(stat(join(root, "workspace"))).rejects.toThrow();
  });

  it("are recognised by their top level folder whatever its letter case (default macOS and Windows volumes ignore case)", async () => {
    const manifest = await stageContext(vault, files, ["Top.md"], undefined, { workspace: [doc("Spec")] });
    expect([...readOnlyRoots(manifest)]).toEqual(["workspace"]);
    expect(readOnlyRoots(manifest.filter((m) => !m.readOnly)).size).toBe(0);
  });
});

describe("workspace access", () => {
  it("needs a role that can read and a workspace that allows copying out", () => {
    for (const role of ["owner", "editor", "viewer"] as const) expect(workspaceContextAccess({ role, exportRestricted: false })).toBe("allowed");
    for (const role of ["owner", "editor", "viewer"] as const) expect(workspaceContextAccess({ role, exportRestricted: true })).toBe("export_restricted");
    for (const role of ["guest", "", "none", "OWNER"]) expect(workspaceContextAccess({ role: role as never, exportRestricted: false })).toBe("forbidden");
  });
});

describe("limits", () => {
  it("accept the Agent Hub's choices and refuse anything the host would", () => {
    for (const minutes of [5, 15, 30, 60]) expect(() => checkTimeLimitMs(minutes * 60_000)).not.toThrow();
    expect(() => checkTimeLimitMs(24 * 60 * 60 * 1000)).not.toThrow();
    for (const ms of [0, -1, 999, 24 * 60 * 60 * 1000 + 1, 1.5, Number.NaN, Infinity]) expect(() => checkTimeLimitMs(ms), String(ms)).toThrow(LimitError);
    for (const usd of [0.25, 0.5, 1, 2, 5, 100]) expect(() => checkBudgetUsd(usd)).not.toThrow();
    for (const usd of [0, -1, 100.01, 1000, Number.NaN, Infinity]) expect(() => checkBudgetUsd(usd), String(usd)).toThrow(LimitError);
  });
});
