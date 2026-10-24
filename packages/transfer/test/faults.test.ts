/**
 * Fault injection at every state boundary (ADR-0006, plan Phase 3 AC).
 *
 * A first dry run records every checkpoint the engine passes: after each
 * durable record write, before and after each server call, each local write
 * and each delete. Then, for each checkpoint, a fresh world runs the same
 * transfer and "crashes" there (the hook throws, nothing more is recorded). The
 * app restarts: `recover()` runs as on vault open, and if the operation was
 * rolled back the same plan is started again. The invariants:
 *
 * - the source is never lost: before the verified commit it is intact; after
 *   it, it exists at the destination with verified hashes;
 * - no content is duplicated: one copy of each page at the destination, no
 *   second server transfer applied, no stray local file;
 * - the outcome is a terminal state (`done` here, nothing was edited).
 *
 * Lost responses (the server did the work, the client never heard) are
 * covered separately with the fake server's `afterCall` hook.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@thoth/domain";
import { TransferInterrupted, type OperationRecord, type TransferEngineOptions } from "../src/index.ts";
import { livePages, thothIdOf, world, type World } from "./support.ts";

const FILES = {
  "Projects/Plan.md": "# Plan\n\nSee [[Notes]] and ![chart](chart.png).\n",
  "Projects/Notes.md": "# Notes\n\nBack to [[Plan]].\n",
  "Projects/chart.png": "PNG",
};
const PATHS = ["Projects/Plan.md", "Projects/Notes.md"];
const BODY = { "Projects/Plan.md": "See [[Notes]] and ![chart](chart.png).", "Projects/Notes.md": "Back to [[Plan]]." };

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

class Crash extends Error {}

/** Every checkpoint name a clean run passes, in order. */
async function checkpoints(run: (w: World) => Promise<OperationRecord>, setup: (w: World) => void = () => undefined): Promise<string[]> {
  const seen: string[] = [];
  const dry = await world(FILES);
  setup(dry);
  await dry.restart({ checkpoint: (p) => void seen.push(p) });
  await run(dry);
  await dry.close();
  return seen;
}

/** Runs until `crashAt`, then restarts and recovers. Returns the world and the final record. */
async function crashThenRecover(crashAt: string, run: (w: World) => Promise<OperationRecord>, setup: (w: World) => void = () => undefined, restart: (w: World) => Promise<OperationRecord> = run) {
  const x = await world(FILES);
  w = x;
  setup(x);
  let armed = true;
  const options: Partial<TransferEngineOptions> = {
    checkpoint: (p) => {
      if (armed && p === crashAt) {
        armed = false;
        throw new Crash(p);
      }
    },
  };
  await x.restart(options);
  await expect(run(x)).rejects.toBeInstanceOf(Crash);
  // Restart the app: a new engine on a new vault handle over the same folder.
  const engine = await x.restart();
  const report = await engine.recover();
  const [record] = await engine.list();
  if (!record) return { x, final: await restart(x), report };
  if (record.state === "aborted" || record.state === "failed") return { x, final: await restart(x), report, first: record };
  return { x, final: record, report };
}

const toWorkspace = (mode: "copy" | "move") => async (x: World) => {
  const preview = await x.engine.previewToWorkspace({ server: x.server, workspace: x.ws.id, parentId: null, mode, paths: PATHS, attachments: true });
  return x.engine.start(preview);
};

async function expectToWorkspaceOutcome(x: World, final: OperationRecord, mode: "copy" | "move") {
  expect(final.state).toBe("done");
  // Exactly one copy of each page and of the attachment, each verified.
  const pages = livePages(x.ws);
  expect(pages.map((p) => p.title).sort()).toEqual(["Notes", "Plan"]);
  expect(x.ws.attachments.size).toBe(1);
  for (const item of final.items) expect(x.ws.pages.get(item.destId)!.revisions.at(-1)!.contentHash).toBe(item.destHash);
  // Only one server transfer was committed.
  expect([...x.servers.transfers.values()].filter((t) => t.resource.state === "done")).toHaveLength(1);
  for (const path of PATHS) {
    if (mode === "copy") expect(await x.read(path)).toContain(BODY[path as keyof typeof BODY]);
    else expect(await x.exists(path)).toBe(false);
  }
  expect(await x.exists("Projects/chart.png")).toBe(true);
  expect(await readdir(join(x.root, ".thoth/tmp"))).toEqual([]);
}

describe("Private → Workspace, crash at every boundary", async () => {
  for (const mode of ["copy", "move"] as const) {
    const points = await checkpoints(toWorkspace(mode));
    it(`${mode}: passes the expected boundaries`, () => {
      expect(points).toEqual(expect.arrayContaining(["saved:plan", "saved:validate", "before:upload:0", "after:upload:0", "saved:stage", "saved:payloads", "before:create", "after:create", "saved:transfer", "saved:verify", "before:commit", "after:commit", "saved:commit_destination"]));
      if (mode === "move") expect(points).toEqual(expect.arrayContaining(["before:delete:0", "after:delete:0", "before:delete:1", "saved:finalize_source"]));
    });
    for (const point of points) {
      it(`${mode}: crash at ${point} — source survives, retry never duplicates`, async () => {
        const { x, final } = await crashThenRecover(point, toWorkspace(mode));
        await expectToWorkspaceOutcome(x, final, mode);
      });
    }
  }
});

describe("Private → Workspace, lost responses", () => {
  for (const route of ["/attachments", "/transfers", "/commit"]) {
    it(`the server applied ${route} but the response was lost: the retry replays, nothing is duplicated`, async () => {
      const x = await world(FILES);
      w = x;
      let lost = false;
      x.servers.afterCall = (args) => {
        if (!lost && args.method === "POST" && args.path.endsWith(route)) {
          lost = true;
          throw new Error("connection reset");
        }
      };
      await expect(toWorkspace("move")(x)).rejects.toBeInstanceOf(TransferInterrupted);
      x.servers.afterCall = undefined;
      const [record] = await x.engine.list();
      expect(PATHS.every((p) => p)).toBe(true);
      const final = await x.engine.resume(record!.id);
      await expectToWorkspaceOutcome(x, final, "move");
    });
  }

  it("the network fails before the commit and stays down: the source is intact and the record waits", async () => {
    const x = await world(FILES);
    w = x;
    let offline = false;
    x.servers.beforeCall = (args) => {
      if (args.path.endsWith("/commit")) offline = true;
      if (offline) throw new Error("offline");
    };
    await expect(toWorkspace("move")(x)).rejects.toBeInstanceOf(TransferInterrupted);
    const engine = await x.restart();
    const report = await engine.recover();
    expect(report.waiting).toHaveLength(1);
    for (const path of PATHS) expect(await x.read(path)).toContain(BODY[path as keyof typeof BODY]);
    expect(livePages(x.ws)).toEqual([]);
    x.servers.beforeCall = undefined;
    const settled = await (await x.restart()).recover();
    expect(settled.rolledBack.map((r) => r.state)).toEqual(["aborted"]);
    expect(livePages(x.ws)).toEqual([]);
    for (const path of PATHS) expect(await x.exists(path)).toBe(true);
  });
});

// ---------------------------------------------------------------- inbound

/** Pages already in the workspace (as if moved out earlier by another device). */
function seedRemote(x: World): void {
  x.servers.writeAsOther(x.ws, { title: "Roadmap", markdown: "# Roadmap\n\nไทย\n" });
  x.servers.writeAsOther(x.ws, { title: "Ideas", markdown: "# Ideas\n" });
}

const fromWorkspace = (mode: "copy" | "move") => async (x: World) => {
  const pageIds = livePages(x.ws).map((p) => p.id);
  const preview = await x.engine.previewFromWorkspace({ server: x.server, workspace: x.ws.id, mode, pageIds, folder: "Inbox" });
  return x.engine.start(preview);
};

async function expectFromWorkspaceOutcome(x: World, final: OperationRecord, mode: "copy" | "move") {
  expect(final.state).toBe("done");
  const inbox = (await readdir(join(x.root, "Inbox"))).sort();
  expect(inbox).toEqual(["Ideas.md", "Roadmap.md"]); // never twice, never a "2"
  for (const item of final.items) expect(sha256Hex(await x.read(item.destPath!))).toBe(item.destHash);
  expect(await x.read("Inbox/Roadmap.md")).toContain("ไทย");
  const remaining = livePages(x.ws).map((p) => p.title).sort();
  expect(remaining).toEqual(mode === "copy" ? ["Ideas", "Roadmap"] : []);
  expect(await readdir(join(x.root, ".thoth/tmp"))).toEqual([]);
}

describe("Workspace → Private, crash at every boundary", async () => {
  for (const mode of ["copy", "move"] as const) {
    const points = await checkpoints(fromWorkspace(mode), seedRemote);
    it(`${mode}: passes the expected boundaries`, () => {
      expect(points).toEqual(expect.arrayContaining(["saved:plan", "saved:validate", "before:create", "after:create", "saved:stage", "saved:paths", "before:write:0", "after:write:0", "saved:transfer", "saved:verify", "saved:commit_destination", "before:commit", "after:commit"]));
    });
    for (const point of points) {
      it(`${mode}: crash at ${point} — the workspace page survives until verified, nothing lands twice`, async () => {
        const { x, final } = await crashThenRecover(point, fromWorkspace(mode), seedRemote);
        await expectFromWorkspaceOutcome(x, final, mode);
      });
    }
  }

  it("a rollback never deletes a file the user edited after it was written", async () => {
    const x = await world({});
    w = x;
    seedRemote(x);
    await x.restart({
      checkpoint: async (p) => {
        if (p === "saved:written:0") {
          const [first] = await x.engine.list();
          await x.write(first!.items[0]!.destPath!, "# Mine now\n");
          throw new Crash(p);
        }
      },
    });
    await expect(fromWorkspace("move")(x)).rejects.toBeInstanceOf(Crash);
    const report = await (await x.restart()).recover();
    expect(report.rolledBack).toHaveLength(1);
    expect(await x.read("Inbox/Roadmap.md")).toBe("# Mine now\n");
    expect(livePages(x.ws).map((p) => p.title).sort()).toEqual(["Ideas", "Roadmap"]); // nothing was moved
  });
});

describe("round trip", () => {
  it("Private → Workspace move, then Workspace → Private move back: same IDs, same paths, same content", async () => {
    const x = await world(FILES);
    w = x;
    const out = await toWorkspace("move")(x);
    expect(out.state).toBe("done");
    const ids = new Map(out.items.map((i) => [i.sourcePath, i.sourceId]));
    const back = await x.engine.start(await x.engine.previewFromWorkspace({ server: x.server, workspace: x.ws.id, mode: "move", pageIds: out.items.map((i) => i.destId), folder: "Elsewhere" }));
    expect(back.state).toBe("done");
    for (const path of PATHS) {
      const text = await x.read(path);
      expect(thothIdOf(text)).toBe(ids.get(path));
      expect(text).toContain(BODY[path as keyof typeof BODY]);
    }
    expect(livePages(x.ws)).toEqual([]);
    // And out again: the workspace has seen these IDs, so the move gets fresh ones there (no reuse of deleted IDs).
    const again = await toWorkspace("move")(x);
    expect(again.state).toBe("done");
    expect(again.items.every((i) => i.destId !== i.sourceId)).toBe(true);
    expect(livePages(x.ws)).toHaveLength(2);
  });
});
