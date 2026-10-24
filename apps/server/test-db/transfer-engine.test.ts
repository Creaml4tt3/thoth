/**
 * Phase 3 acceptance against the real reference server on PostgreSQL: the
 * desktop's transfer engine (`packages/transfer`) with a real vault on disk,
 * talking to the server through the same `WorkspaceClient` the app uses.
 *
 * - Private → Workspace copy and move, then Workspace → Private move back,
 *   with verified hashes, attachments and link mapping.
 * - A crash at every state boundary of a move (both directions), recovered on
 *   the next open: the source survives and nothing is duplicated.
 * - `destination_committed_source_cleanup_pending` when a source changes.
 * - The server's export restriction.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@thoth/domain";
import type { Vault } from "@thoth/local-store";
import { openNodeVault } from "@thoth/local-store/node";
import { TransferEngine, type OperationRecord, type TransferEngineOptions } from "@thoth/transfer";
import { WorkspaceClient, type Send } from "@thoth/workspace-client";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage } from "./support.ts";

let env: TestEnv;
let ada: TestPrincipal;

beforeAll(async () => {
  env = await startTestEnv();
  ada = await env.user("Ada");
});
afterAll(() => env.close());

const FILES: Record<string, string> = {
  "Projects/Plan.md": "# Plan\n\nSee [[Notes]], ![chart](chart.png), [[Gone]] and [site](https://example.org).\n",
  "Projects/Notes.md": "# Notes\n\nBack to [[Plan#Goals|the goals]]. ไทย\n",
  "Projects/chart.png": "\u0089PNG fake bytes",
  "Diary.md": "# Diary\n",
};

/** A client over plain fetch with Ada's token, like the desktop host would send. */
function client(): WorkspaceClient {
  const send: Send = async (req) => {
    const qs = req.query && Object.keys(req.query).length > 0 ? `?${new URLSearchParams(req.query).toString()}` : "";
    const res = await fetch(`${env.url}${req.path}${qs}`, { method: req.method, headers: { ...ada.headers, ...(req.headers ?? {}) }, ...(req.body ? { body: req.body as never } : {}) });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, headers, body: await res.text() };
  };
  return new WorkspaceClient(send);
}

interface Local {
  root: string;
  vault: Vault;
  engine: TransferEngine;
  reopen(options?: Partial<TransferEngineOptions>): Promise<TransferEngine>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  close(): Promise<void>;
}

async function local(files: Record<string, string>, options: Partial<TransferEngineOptions> = {}): Promise<Local> {
  const root = await mkdtemp(join(tmpdir(), "thoth-p3-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const make = (vault: Vault, extra: Partial<TransferEngineOptions>) => new TransferEngine({ vault, server: (id) => (id === "srv" ? { client: client(), url: env.url } : undefined), ...extra });
  const opened = await openNodeVault(root);
  const l: Local = {
    root,
    vault: opened.vault,
    engine: make(opened.vault, options),
    async reopen(extra = {}) {
      await l.vault.close();
      l.vault = (await openNodeVault(root)).vault;
      l.engine = make(l.vault, extra);
      return l.engine;
    },
    read: (path) => readFile(join(root, path), "utf8"),
    exists: (path) =>
      readFile(join(root, path)).then(
        () => true,
        () => false,
      ),
    async close() {
      await l.vault.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
  return l;
}

async function toWorkspace(l: Local, workspace: string, mode: "copy" | "move", paths = ["Projects/Plan.md", "Projects/Notes.md"]): Promise<OperationRecord> {
  const preview = await l.engine.previewToWorkspace({ server: "srv", workspace, parentId: null, mode, paths, attachments: true });
  expect(preview.problems).toEqual([]);
  return l.engine.start(preview);
}

async function fromWorkspace(l: Local, workspace: string, mode: "copy" | "move", pageIds: string[], folder = "Inbox"): Promise<OperationRecord> {
  const preview = await l.engine.previewFromWorkspace({ server: "srv", workspace, mode, pageIds, folder });
  expect(preview.problems).toEqual([]);
  return l.engine.start(preview);
}

const livePages = async (ws: string) => (await env.api(ada, "GET", `/workspaces/${ws}/tree`)).json.items as { id: string; title: string; revisionId: string }[];
const pageOf = async (ws: string, id: string) => (await env.api(ada, "GET", `/workspaces/${ws}/pages/${id}`)).json;
const transferRows = async (ws: string) => (await env.db.query<{ operation_id: string; state: string }>("SELECT operation_id, state FROM transfers WHERE workspace_id = $1 ORDER BY created_at", [ws])).rows;

describe("transfer engine on the reference server", () => {
  it("copy, then move, then move back: verified hashes, attachments and links mapped by ID", async () => {
    const ws = await env.workspace("Studio", { members: { [ada.userId]: "owner" } });
    const l = await local(FILES);
    try {
      // Copy: new IDs, sources stay.
      const copy = await toWorkspace(l, ws, "copy");
      expect(copy.state).toBe("done");
      expect(await l.read("Projects/Plan.md")).toContain("See [[Notes]]");
      const copied = await pageOf(ws, copy.items.find((i) => i.sourcePath === "Projects/Plan.md")!.destId);
      const notesCopy = copy.items.find((i) => i.sourcePath === "Projects/Notes.md")!.destId;
      const chart = copy.attachments[0]!;
      expect(chart.state).toBe("committed");
      expect(copied.markdown).toContain(`[[thoth:page/${notesCopy}|Notes]]`);
      expect(copied.markdown).toContain(`![chart](thoth:attachment/${chart.destId})`);
      expect(copied.markdown).toContain("[[Gone]]");
      expect(copied.revision.contentHash).toBe(copy.items.find((i) => i.sourcePath === "Projects/Plan.md")!.destHash);
      const blob = await env.api(ada, "GET", `/workspaces/${ws}/attachments/${chart.destId}`);
      expect(sha256Hex(blob.bytes)).toBe(sha256Hex(FILES["Projects/chart.png"]!));

      // Move: IDs preserved, sources deleted after the verified commit. The attachment is already there: not uploaded again.
      const move = await toWorkspace(l, ws, "move");
      expect(move.state).toBe("done");
      expect(move.attachments).toEqual([]);
      expect(move.items.every((i) => i.destId === i.sourceId && i.state === "source_deleted")).toBe(true);
      expect(await l.exists("Projects/Plan.md")).toBe(false);
      expect(await l.exists("Projects/chart.png")).toBe(true);
      const moved = await pageOf(ws, move.items.find((i) => i.sourcePath === "Projects/Plan.md")!.destId);
      expect(moved.markdown).toContain(`![chart](thoth:attachment/${chart.destId})`);
      expect((await livePages(ws)).length).toBe(4);

      // Move back: exactly the pinned revisions, back to the paths they came from, links in vault form again.
      const back = await fromWorkspace(l, ws, "move", move.items.map((i) => i.destId));
      expect(back.state).toBe("done");
      expect(back.items.map((i) => i.destPath).sort()).toEqual(["Projects/Notes.md", "Projects/Plan.md"]);
      const plan = await l.read("Projects/Plan.md");
      expect(plan).toContain("See [[Notes]], ![chart](chart.png), [[Gone]] and [site](https://example.org).");
      expect(await l.read("Projects/Notes.md")).toContain("Back to [[Plan#Goals|the goals]]. ไทย");
      for (const item of back.items) expect(sha256Hex(await readFile(join(l.root, item.destPath!)))).toBe(item.destHash);
      // The server deleted the moved pages; the copies remain.
      expect((await livePages(ws)).map((p) => p.id).sort()).toEqual(copy.items.map((i) => i.destId).sort());
      expect((await transferRows(ws)).map((t) => t.state)).toEqual(["done", "done", "done"]);
    } finally {
      await l.close();
    }
  });

  it("an edited source is not deleted: destination_committed_source_cleanup_pending, both directions", async () => {
    const ws = await env.workspace("Pending", { members: { [ada.userId]: "owner" } });
    const l = await local(FILES);
    try {
      // The user appends to Notes (its adopted thoth_id stays) right after the server committed.
      const edit = async () => writeFile(join(l.root, "Projects/Notes.md"), `${await l.read("Projects/Notes.md")}Edited during the move.\n`);
      await l.reopen({ checkpoint: async (p) => (p === "after:commit" ? void (await edit()) : undefined) });
      const out = await toWorkspace(l, ws, "move");
      expect(out.state).toBe("destination_committed_source_cleanup_pending");
      expect(out.items.find((i) => i.sourcePath === "Projects/Notes.md")).toMatchObject({ state: "cleanup_pending", error: "source_changed" });
      expect(await l.read("Projects/Notes.md")).toContain("Edited during the move.");
      expect(await l.exists("Projects/Plan.md")).toBe(false);

      // Back: Grace edits the workspace page after it was pinned; the server keeps it.
      const plan = out.items.find((i) => i.sourcePath === "Projects/Plan.md")!.destId;
      await l.reopen({
        checkpoint: async (p) => {
          if (p !== "saved:transfer") return;
          const current = await pageOf(ws, plan);
          await env.api(ada, "PUT", `/workspaces/${ws}/pages/${plan}`, { headers: { "if-match": `"${current.revision.id}"` }, json: { title: "Plan", markdown: "# Plan\n\nChanged at the server.\n" } });
        },
      });
      const back = await fromWorkspace(l, ws, "move", [plan], "");
      expect(back.state).toBe("destination_committed_source_cleanup_pending");
      expect(back.items[0]).toMatchObject({ state: "cleanup_pending", error: "revision_conflict" });
      expect((await pageOf(ws, plan)).markdown).toBe("# Plan\n\nChanged at the server.\n");
      // Notes stayed here (cleanup pending) with its ID, so the link maps back to it.
      expect(await l.read(back.items[0]!.destPath!)).toContain("See [[Notes]]");
      expect((await transferRows(ws)).map((t) => t.state)).toEqual(["done", "destination_committed_source_cleanup_pending"]);
    } finally {
      await l.close();
    }
  });

  it("an export-restricted workspace refuses Workspace → Private; nothing is written", async () => {
    const ws = await env.workspace("Locked", { exportRestricted: true, members: { [ada.userId]: "owner" } });
    const page = await createPage(env, ada, ws, { title: "Secret", markdown: "# Secret\n" });
    const l = await local({});
    try {
      const preview = await l.engine.previewFromWorkspace({ server: "srv", workspace: ws, mode: "copy", pageIds: [page.id], folder: "" });
      expect(preview.problems.map((p) => p.code)).toEqual(["export_restricted"]);
      // The engine refuses too, before asking the server.
      const forced = await l.engine.start({ ...preview, problems: [], canStart: true, pages: [{ pageId: page.id, title: "Secret", size: 9 }] });
      expect([forced.state, forced.error?.code]).toEqual(["failed", "export_restricted"]);
      expect(await readdir(l.root)).toEqual([".thoth"]);

      // And the server is the authority: the restriction is switched on after the client checked, and the server refuses.
      await env.db.query("UPDATE workspaces SET export_restricted = false WHERE id = $1", [ws]);
      const open = await l.engine.previewFromWorkspace({ server: "srv", workspace: ws, mode: "move", pageIds: [page.id], folder: "" });
      expect(open.problems).toEqual([]);
      await l.reopen({ checkpoint: async (p) => (p === "saved:validate" ? void (await env.db.query("UPDATE workspaces SET export_restricted = true WHERE id = $1", [ws])) : undefined) });
      const refused = await l.engine.start(open);
      expect([refused.state, refused.error?.code]).toEqual(["failed", "export_restricted"]);
      expect(await readdir(l.root)).toEqual([".thoth"]);
      expect((await pageOf(ws, page.id)).markdown).toBe("# Secret\n");
      const audit = await env.db.query("SELECT 1 FROM audit_events WHERE workspace_id = $1 AND action = 'export.refused'", [ws]);
      expect(audit.rowCount).toBe(1);
    } finally {
      await l.close();
    }
  });
});

describe("fault injection on the reference server", async () => {
  class Crash extends Error {}

  /** Boundaries a clean run passes. */
  async function boundaries(run: (l: Local, ws: string) => Promise<OperationRecord>, seed: (ws: string) => Promise<void>): Promise<string[]> {
    const seen: string[] = [];
    const ws = await env.workspace("Dry", { members: { [ada.userId]: "owner" } });
    await seed(ws);
    const l = await local(FILES, { checkpoint: (p) => void seen.push(p) });
    try {
      await run(l, ws);
    } finally {
      await l.close();
    }
    return seen;
  }

  const out = (l: Local, ws: string) => toWorkspace(l, ws, "move");
  const seedRemote = async (ws: string) => {
    for (const title of ["Roadmap", "Ideas"]) await createPage(env, ada, ws, { title, markdown: `# ${title}\n\nไทย\n` });
  };
  const back = async (l: Local, ws: string) => fromWorkspace(l, ws, "move", (await livePages(ws)).map((p) => p.id));

  // env is created in beforeAll, so the dry runs happen inside a test-time hook.
  let outPoints: string[] = [];
  let backPoints: string[] = [];
  beforeAll(async () => {
    outPoints = await boundaries(out, async () => undefined);
    backPoints = await boundaries(back, seedRemote);
  });

  it("Private → Workspace move: crash at every boundary, recover on open, source survives, no duplicates", async () => {
    expect(outPoints.length).toBeGreaterThan(15);
    for (const point of outPoints) {
      const ws = await env.workspace(`Out ${point}`, { members: { [ada.userId]: "owner" } });
      let armed = true;
      const l = await local(FILES, {
        checkpoint: (p) => {
          if (armed && p === point) {
            armed = false;
            throw new Crash(p);
          }
        },
      });
      try {
        await expect(out(l, ws), point).rejects.toBeInstanceOf(Crash);
        const engine = await l.reopen();
        await engine.recover();
        let [record] = await engine.list();
        if (!record || record.state === "aborted" || record.state === "failed") record = await out(l, ws);
        expect([point, record.state]).toEqual([point, "done"]);
        const pages = await livePages(ws);
        expect([point, pages.map((p) => p.title).sort()]).toEqual([point, ["Notes", "Plan"]]);
        for (const item of record.items) expect([point, (await pageOf(ws, item.destId)).revision.contentHash]).toEqual([point, item.destHash]);
        expect([point, await l.exists("Projects/Plan.md"), await l.exists("Projects/Notes.md")]).toEqual([point, false, false]);
        const attachments = await env.db.query("SELECT 1 FROM attachments WHERE workspace_id = $1", [ws]);
        expect([point, attachments.rowCount]).toEqual([point, 1]);
        expect([point, (await transferRows(ws)).filter((t) => t.state === "done").length]).toEqual([point, 1]);
      } finally {
        await l.close();
      }
    }
  });

  it("Workspace → Private move: crash at every boundary, the workspace page survives until verified, nothing lands twice", async () => {
    expect(backPoints.length).toBeGreaterThan(12);
    for (const point of backPoints) {
      const ws = await env.workspace(`Back ${point}`, { members: { [ada.userId]: "owner" } });
      await seedRemote(ws);
      let armed = true;
      const l = await local({}, {
        checkpoint: (p) => {
          if (armed && p === point) {
            armed = false;
            throw new Crash(p);
          }
        },
      });
      try {
        await expect(back(l, ws), point).rejects.toBeInstanceOf(Crash);
        // Before the server commit the workspace pages are all still there.
        if (!["after:commit"].includes(point) && !point.startsWith("saved:finalize") && point !== "saved:done") expect([point, (await livePages(ws)).length]).toEqual([point, 2]);
        const engine = await l.reopen();
        await engine.recover();
        let [record] = await engine.list();
        if (!record || record.state === "aborted" || record.state === "failed") record = await back(l, ws);
        expect([point, record.state]).toEqual([point, "done"]);
        expect([point, (await readdir(join(l.root, "Inbox"))).sort()]).toEqual([point, ["Ideas.md", "Roadmap.md"]]);
        for (const item of record.items) expect([point, sha256Hex(await readFile(join(l.root, item.destPath!)))]).toEqual([point, item.destHash]);
        expect([point, (await livePages(ws)).length]).toEqual([point, 0]);
      } finally {
        await l.close();
      }
    }
  });
});
