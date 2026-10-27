/**
 * Copy and move between two workspaces (ADR-0006, amendment of 2026-10-27): on two servers and on one, the same
 * rules as every transfer. Records are kept in a Storage, as in the web client (the desktop keeps them in the vault;
 * the last test goes through `TransferEngine`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { newStableId, sha256Hex } from "@thoth/domain";
import { FakeServers, type FakeServerConfig, type FakeWorkspace } from "../../../tests/helpers/fake-servers.ts";
import { BetweenWorkspaces, storageRecords, TransferInterrupted, TransferRefused, type BetweenOptions, type BetweenRequest, type OperationRecord } from "../src/index.ts";
import { clientFor, livePages, thothIdOf, world, type World } from "./support.ts";

const TEAM: FakeServerConfig = { url: "https://team.example", name: "Team" };
const OTHER: FakeServerConfig = { url: "https://other.example", name: "Other" };

/** Only what the web client's storage offers (`WebEnv.localStorage`). */
function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

interface Two {
  servers: FakeServers;
  a: string;
  b: string;
  src: FakeWorkspace;
  dst: FakeWorkspace;
  ids: { plan: string; detail: string; other: string; chart: string };
  engine: BetweenWorkspaces;
  /** A new engine on the same records, as after a restart. */
  restart(extra?: Partial<BetweenOptions>): BetweenWorkspaces;
  request(mode: "copy" | "move", extra?: Partial<BetweenRequest>): BetweenRequest;
}

const CHART = new TextEncoder().encode("PNG bytes");

function two(options: { sameServer?: boolean; src?: Partial<Parameters<FakeServers["addWorkspace"]>[1]>; dst?: Partial<Parameters<FakeServers["addWorkspace"]>[1]> } = {}): Two {
  const servers = new FakeServers();
  const a = servers.connect(TEAM);
  const b = options.sameServer ? a : servers.connect(OTHER);
  const src = servers.addWorkspace(a, { name: "Studio", role: "owner", ...options.src });
  const dst = servers.addWorkspace(b, { name: "Archive", role: "owner", ...options.dst });
  const ids = { plan: newStableId(), detail: newStableId(), other: newStableId(), chart: newStableId() };
  src.attachments.set(ids.chart, { id: ids.chart, bytes: CHART, mimeType: "image/png", hash: sha256Hex(CHART) });
  servers.writeAsOther(src, { id: ids.plan, title: "Plan", markdown: `---\nthoth_id: ${ids.plan}\n---\n# Plan\n\nSee [[thoth:page/${ids.detail}|Detail]], [[thoth:page/${ids.other}|Other]] and ![chart](thoth:attachment/${ids.chart}).\n` });
  servers.writeAsOther(src, { id: ids.detail, title: "Detail", parentId: ids.plan, markdown: `# Detail\n\nUp to [[thoth:page/${ids.plan}|Plan]] and [Nowhere](Nowhere.md).\n` });
  servers.writeAsOther(src, { id: ids.other, title: "Other", markdown: "# Other\n" });
  const urls: Record<string, string> = { [a]: TEAM.url, [b]: options.sameServer ? TEAM.url : OTHER.url };
  const storage = memoryStorage();
  const make = (extra: Partial<BetweenOptions> = {}) =>
    new BetweenWorkspaces({ records: storageRecords(storage), server: (id) => (urls[id] ? { client: clientFor(servers, id), url: urls[id]! } : undefined), now: () => new Date("2026-10-27T10:00:00Z"), ...extra });
  const t: Two = {
    servers,
    a,
    b,
    src,
    dst,
    ids,
    engine: make(),
    restart(extra) {
      t.engine = make(extra);
      return t.engine;
    },
    request: (mode, extra = {}) => ({ from: { server: a, workspace: src.id }, to: { server: b, workspace: dst.id, parentId: null }, mode, pageIds: [ids.plan], attachments: true, ...extra }),
  };
  return t;
}

async function run(t: Two, mode: "copy" | "move", extra: Partial<BetweenRequest> = {}): Promise<OperationRecord> {
  const preview = await t.engine.previewBetweenWorkspaces(t.request(mode, extra));
  expect(preview.problems).toEqual([]);
  return t.engine.start(preview);
}

const byTitle = (ws: FakeWorkspace, title: string) => livePages(ws).find((p) => p.title === title);
const writes = (servers: FakeServers) => servers.calls.filter((c) => c.method !== "GET");

describe("preview", () => {
  it("lists the page with its sub-page and attachment, and how each link travels; nothing is written", async () => {
    const t = two();
    const preview = await t.engine.previewBetweenWorkspaces(t.request("copy"));
    expect(preview.canStart).toBe(true);
    expect(preview.pages.map((p) => p.title)).toEqual(["Plan", "Detail"]);
    expect(preview.attachments).toEqual([{ id: t.ids.chart }]);
    expect(preview.workspace?.name).toBe("Archive");
    expect(preview.source.workspace?.name).toBe("Studio");
    // Plan → Detail, Detail → Plan and the chart travel; Plan → Other stays behind; [Nowhere](Nowhere.md) resolves nowhere.
    expect(preview.links.counts).toMatchObject({ included: 3, left_at_source: 1, unresolved: 1 });
    expect(preview.warnings.map((w) => w.code).sort()).toEqual(["left_at_source", "unresolved_links"]);
    expect(writes(t.servers)).toEqual([]);
  });

  it("refuses the same workspace as source and destination", async () => {
    const t = two({ sameServer: true });
    const preview = await t.engine.previewBetweenWorkspaces({ ...t.request("copy"), to: { server: t.a, workspace: t.src.id, parentId: null } });
    expect(preview.problems).toContainEqual({ code: "same_workspace" });
    expect(preview.canStart).toBe(false);
  });
});

describe("copy", () => {
  it("to another server: pages and attachments arrive with the destination's own IDs, links between them rewritten, the source unchanged", async () => {
    const t = two();
    const before = livePages(t.src).map((p) => [p.id, p.markdown]);
    const done = await run(t, "copy");
    expect(done.state).toBe("done");

    const plan = byTitle(t.dst, "Plan")!;
    const detail = byTitle(t.dst, "Detail")!;
    expect(livePages(t.dst)).toHaveLength(2);
    expect([plan.id, detail.id]).not.toContain(t.ids.plan);
    expect([plan.id, detail.id]).not.toContain(t.ids.detail);
    expect(detail.parentId).toBe(plan.id);
    const [chart] = [...t.dst.attachments.values()];
    expect(chart?.hash).toBe(sha256Hex(CHART));
    expect(chart?.id).not.toBe(t.ids.chart);
    expect(thothIdOf(plan.markdown)).toBe(plan.id);
    expect(plan.markdown).toContain(`[[thoth:page/${detail.id}|Detail]]`);
    expect(plan.markdown).toContain(`[[thoth:page/${t.ids.other}|Other]]`); // stays behind: kept as written
    expect(plan.markdown).toContain(`![chart](thoth:attachment/${chart!.id})`);
    expect(detail.markdown).toContain(`[[thoth:page/${plan.id}|Plan]]`);
    expect(detail.markdown).toContain("[Nowhere](Nowhere.md)");
    // Every page was read back at the destination.
    for (const item of done.items) expect(t.dst.pages.get(item.destId)!.revisions.at(-1)!.contentHash).toBe(item.destHash);

    expect(livePages(t.src).map((p) => [p.id, p.markdown])).toEqual(before);
    expect(t.servers.transfers.get(done.source!.operationId)?.resource.state).toBe("done");
    expect(t.servers.transfers.get(done.id)?.resource.state).toBe("done");
  });

  it("between two workspaces on one server, with two operation IDs", async () => {
    const t = two({ sameServer: true });
    const done = await run(t, "copy");
    expect(done.state).toBe("done");
    expect(done.source!.operationId).not.toBe(done.id);
    expect(livePages(t.dst).map((p) => p.title).sort()).toEqual(["Detail", "Plan"]);
    expect(livePages(t.src)).toHaveLength(3);
  });

  it("a title taken at the destination gets a new one; the page there is untouched", async () => {
    const t = two();
    const mine = t.servers.writeAsOther(t.dst, { title: "Plan", markdown: "# Mine\n" });
    const done = await run(t, "copy");
    expect(done.state).toBe("done");
    expect(livePages(t.dst).map((p) => p.title).sort()).toEqual(["Detail", "Plan", "Plan 2"]);
    expect(t.dst.pages.get(mine.id)!.markdown).toBe("# Mine\n");
  });
});

describe("move", () => {
  it("deletes the originals only after the destination has every page", async () => {
    const t = two();
    let liveAtCommit = -1;
    t.restart({ checkpoint: (p) => void (p === "after:commit" && (liveAtCommit = livePages(t.src).length)) });
    const done = await run(t, "move");
    expect(liveAtCommit).toBe(3);
    expect(done.state).toBe("done");
    expect(done.items.every((i) => i.state === "source_deleted")).toBe(true);
    expect(livePages(t.src).map((p) => p.title)).toEqual(["Other"]);
    expect(livePages(t.dst).map((p) => p.title).sort()).toEqual(["Detail", "Plan"]);
  });

  it("an original edited at the source after it was pinned is kept, and the record says so", async () => {
    const t = two();
    let commits = 0;
    t.servers.afterCall = (args) => {
      if (args.method === "POST" && args.path.endsWith("/commit") && ++commits === 1) t.servers.writeAsOther(t.src, { id: t.ids.plan, title: "Plan", markdown: "# Plan\n\nEdited meanwhile.\n" });
    };
    const done = await run(t, "move");
    expect(done.state).toBe("destination_committed_source_cleanup_pending");
    const plan = done.items.find((i) => i.sourceId === t.ids.plan)!;
    expect(plan).toMatchObject({ state: "cleanup_pending", error: "revision_conflict" });
    expect(t.src.pages.get(t.ids.plan)!.deleted).toBe(false);
    expect(t.src.pages.get(t.ids.plan)!.markdown).toContain("Edited meanwhile.");
    expect(livePages(t.dst).map((p) => p.title).sort()).toEqual(["Detail", "Plan"]);
  });

  it("a failure after the copy keeps the source; Try again finishes without a second copy", async () => {
    const t = two();
    let commits = 0;
    t.servers.beforeCall = (args) => {
      if (args.method === "POST" && args.path.endsWith("/commit") && ++commits === 2) throw new Error("The network went away.");
    };
    const failure = await run(t, "move").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransferInterrupted);
    const record = (failure as TransferInterrupted).record;
    // What is where: every page committed and verified at the destination, every original still at the source.
    expect(record.state).toBe("finalize_source");
    expect(record.items.every((i) => i.state === "committed" && i.destRevision !== null)).toBe(true);
    expect(record.error?.message).toContain("The network went away.");
    expect(livePages(t.src)).toHaveLength(3);
    expect(livePages(t.dst)).toHaveLength(2);

    t.servers.beforeCall = undefined;
    const done = await t.restart().resume(record.id);
    expect(done.state).toBe("done");
    expect(livePages(t.src).map((p) => p.title)).toEqual(["Other"]);
    expect(livePages(t.dst)).toHaveLength(2);
  });
});

describe("refusals", () => {
  for (const mode of ["copy", "move"] as const) {
    it(`an export-restricted source refuses ${mode}: in the preview, and again in the run when the preview is bypassed`, async () => {
      const t = two({ src: { exportRestricted: true } });
      const preview = await t.engine.previewBetweenWorkspaces(t.request(mode));
      expect(preview.problems).toContainEqual({ code: "export_restricted" });
      expect(preview.canStart).toBe(false);
      expect(preview.pages).toEqual([]); // nothing is read from it
      await expect(t.engine.start(preview)).rejects.toBeInstanceOf(TransferRefused);

      const forged = { ...preview, canStart: true, problems: [], pages: [{ pageId: t.ids.plan, title: "Plan", size: 1, folder: false, parentId: null }] };
      const record = await t.engine.start(forged);
      expect(record.state).toBe("failed");
      expect(record.error?.code).toBe("export_restricted");
      expect(livePages(t.dst)).toEqual([]);
      expect(livePages(t.src)).toHaveLength(3);
    });
  }

  it("a viewer at the destination is refused", async () => {
    const t = two({ dst: { role: "viewer" } });
    const preview = await t.engine.previewBetweenWorkspaces(t.request("copy"));
    expect(preview.problems).toContainEqual({ code: "forbidden", role: "viewer" });
    expect(preview.canStart).toBe(false);
  });

  it("a viewer at the source may copy but not move", async () => {
    const t = two({ src: { role: "viewer" } });
    expect((await t.engine.previewBetweenWorkspaces(t.request("copy"))).canStart).toBe(true);
    const move = await t.engine.previewBetweenWorkspaces(t.request("move"));
    expect(move.problems).toContainEqual({ code: "source_forbidden", role: "viewer" });
    const done = await run(t, "copy");
    expect(done.state).toBe("done");
    expect(livePages(t.src)).toHaveLength(3);
  });
});

describe("a crash at every boundary, then recovery", async () => {
  class Crash extends Error {}
  const points: string[] = [];
  {
    const dry = two();
    dry.restart({ checkpoint: (p) => void points.push(p) });
    await run(dry, "move");
  }
  it("passes both ends' boundaries", () => {
    expect(points).toEqual(expect.arrayContaining(["saved:plan", "saved:validate", "before:create:source", "after:create:source", "saved:stage", "before:upload:0", "after:upload:0", "saved:payloads", "before:create", "after:create", "saved:transfer", "saved:verify", "before:commit", "after:commit", "saved:commit_destination", "saved:finalize_source", "before:commit:source", "after:commit:source", "saved:done"]));
  });
  for (const point of points) {
    it(`move, crash at ${point}: never a lost page, never a second copy`, async () => {
      const t = two();
      let armed = true;
      t.restart({
        checkpoint: (p) => {
          if (armed && p === point) {
            armed = false;
            throw new Crash(p);
          }
        },
      });
      await expect(run(t, "move")).rejects.toBeInstanceOf(Crash);
      const engine = t.restart();
      await engine.recover();
      let [record] = await engine.list();
      if (!record || record.state === "aborted" || record.state === "failed") record = await run(t, "move");
      expect(record.state).toBe("done");
      expect(livePages(t.dst).map((p) => p.title).sort()).toEqual(["Detail", "Plan"]);
      expect(t.dst.attachments.size).toBe(1);
      expect(livePages(t.src).map((p) => p.title)).toEqual(["Other"]);
      expect([...t.servers.transfers.values()].filter((x) => x.workspace === t.dst && x.resource.state === "done")).toHaveLength(1);
      // A rolled-back attempt left nothing staged at either end.
      expect([...t.servers.transfers.values()].filter((x) => x.resource.state === "stage")).toEqual([]);
    });
  }
});

describe("in the desktop engine", () => {
  let w: World | undefined;
  afterEach(async () => {
    await w?.close();
    w = undefined;
  });

  it("keeps its record in the vault and finishes an interrupted one on recovery", async () => {
    w = await world({ "Diary.md": "# Diary\n" });
    const archive = w.servers.addWorkspace(w.server, { name: "Archive", role: "owner" });
    const page = w.servers.writeAsOther(w.ws, { title: "Roadmap", markdown: "# Roadmap\n" });
    const engine = await w.restart({
      checkpoint: (p) => {
        if (p === "after:commit") throw new Error("crash");
      },
    });
    const preview = await engine.previewBetweenWorkspaces({ from: { server: w.server, workspace: w.ws.id }, to: { server: w.server, workspace: archive.id, parentId: null }, mode: "move", pageIds: [page.id], attachments: true });
    expect(preview.canStart).toBe(true);
    await expect(engine.start(preview)).rejects.toThrow("crash");
    const [saved] = await engine.list();
    expect(saved?.direction).toBe("between_workspaces");

    const report = await (await w.restart()).recover();
    expect(report.completed.map((r) => r.state)).toEqual(["done"]);
    expect(livePages(archive).map((p) => p.title)).toEqual(["Roadmap"]);
    expect(livePages(w.ws)).toEqual([]);
    expect(await w.read("Diary.md")).toBe("# Diary\n");
  });
});
