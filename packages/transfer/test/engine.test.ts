import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@thoth/domain";
import { OperationRecordSchema, syncPath, TransferRefused, type OperationRecord } from "../src/index.ts";
import { livePages, thothIdOf, world, type World } from "./support.ts";

const FILES = {
  "Projects/Plan.md": "# Plan\n\nSee [[Notes]], the [diagram](../Assets/diagram.png), [[Missing page]] and [docs](https://example.org).\nAlso [[Diary]].\n",
  "Projects/Notes.md": "---\naliases: [N]\n---\n# Notes\n\nBack to [[Plan]] and [[Plan#Goals|the goals]].\n",
  "Diary.md": "# Diary\n\nPrivate.\n",
  "Assets/diagram.png": "PNGDATA",
};

let w: World;
afterEach(() => w?.close());

const toWs = (paths: string[], mode: "copy" | "move", extra: { attachments?: boolean; parentId?: string | null } = {}) => ({ server: w.server, workspace: w.ws.id, parentId: extra.parentId ?? null, mode, paths, attachments: extra.attachments ?? true });

async function send(paths: string[], mode: "copy" | "move", extra: { attachments?: boolean } = {}): Promise<OperationRecord> {
  const preview = await w.engine.previewToWorkspace(toWs(paths, mode, extra));
  expect(preview.problems).toEqual([]);
  return w.engine.start(preview);
}

async function bringBack(pageIds: string[], mode: "copy" | "move", folder = ""): Promise<OperationRecord> {
  const preview = await w.engine.previewFromWorkspace({ server: w.server, workspace: w.ws.id, mode, pageIds, folder });
  expect(preview.problems).toEqual([]);
  return w.engine.start(preview);
}

describe("preview", () => {
  it("shows the destination, who can see it, and a link classification before anything leaves the computer", async () => {
    w = await world(FILES, { workspace: { name: "Studio", members: [{ userId: "u1", displayName: "Ada", role: "owner" }, { userId: "u2", displayName: "Grace", role: "viewer" }] } });
    const callsBefore = w.servers.calls.length;
    const preview = await w.engine.previewToWorkspace(toWs(["Projects/Plan.md", "Projects/Notes.md"], "copy"));
    expect(preview.workspace).toMatchObject({ name: "Studio", memberCount: 2, members: [{ displayName: "Ada", role: "owner" }, { displayName: "Grace", role: "viewer" }] });
    // Plan → Notes, Plan → diagram, Notes → Plan, Notes → Plan#Goals are included.
    expect(preview.links.counts).toEqual({ included: 4, already_at_destination: 0, left_at_source: 1, external: 1, unresolved: 1 });
    expect(preview.attachments.map((a) => a.path)).toEqual(["Assets/diagram.png"]);
    expect(preview.warnings.map((x) => x.code)).toEqual(["unresolved_links", "left_at_source"]);
    expect(preview.links.flagged.map((f) => [f.target, f.class])).toEqual([["Missing page", "unresolved"], ["Diary", "left_at_source"]]);
    expect(preview.canStart).toBe(true);
    // Only reads: no write request was sent and nothing was adopted.
    expect(w.servers.calls.slice(callsBefore).every((c) => c.method === "GET")).toBe(true);
    expect(await w.read("Projects/Plan.md")).toBe(FILES["Projects/Plan.md"]);
    expect(await readdir(join(w.root, ".thoth/operations"))).toEqual(["journal"]);
  });

  it("is off with a clear reason when the server does not list transfers", async () => {
    w = await world(FILES, { config: { url: "https://old.example", capabilities: ["search"] } });
    const availability = await w.engine.availability(w.server);
    expect(availability).toMatchObject({ ok: false, reason: "no_transfers" });
    const preview = await w.engine.previewToWorkspace(toWs(["Diary.md"], "copy"));
    expect(preview.canStart).toBe(false);
    expect(preview.problems.map((p) => p.code)).toEqual(["no_transfers"]);
    await expect(w.engine.start(preview)).rejects.toBeInstanceOf(TransferRefused);
  });

  it("refuses a viewer, a page over the size limit, and a selection over the page quota", async () => {
    w = await world({ "A.md": "x".repeat(2000), "B.md": "b" }, { config: { url: "https://q.example", limits: { maxMarkdownBytes: 1024, maxPagesPerWorkspace: 1 } }, workspace: { name: "Read only", role: "viewer" } });
    const preview = await w.engine.previewToWorkspace(toWs(["A.md", "B.md"], "copy"));
    expect(preview.problems.map((p) => p.code).sort()).toEqual(["forbidden", "page_too_large", "quota"]);
    expect(preview.canStart).toBe(false);
  });

  it("warns that attachments stay behind when the server has no attachments capability", async () => {
    w = await world(FILES, { config: { url: "https://noatt.example", capabilities: ["transfers"] } });
    const preview = await w.engine.previewToWorkspace(toWs(["Projects/Plan.md"], "copy"));
    expect(preview.attachments).toEqual([]);
    expect(preview.warnings.map((x) => x.code)).toContain("attachments_unsupported");
  });
});

describe("Private → Workspace", () => {
  it("copy: new IDs, links mapped by ID, attachments uploaded, hashes verified, sources untouched but adopted", async () => {
    w = await world(FILES);
    const done = await send(["Projects/Plan.md", "Projects/Notes.md"], "copy");
    expect(done.state).toBe("done");
    expect(done.items.every((i) => i.state === "committed" && i.destRevision)).toBe(true);
    const plan = done.items.find((i) => i.sourcePath === "Projects/Plan.md")!;
    const notes = done.items.find((i) => i.sourcePath === "Projects/Notes.md")!;
    expect(plan.destId).not.toBe(plan.sourceId); // copy: new logical IDs
    const remotePlan = w.ws.pages.get(plan.destId)!;
    const remoteNotes = w.ws.pages.get(notes.destId)!;
    const attachment = done.attachments[0]!;
    expect(attachment).toMatchObject({ state: "committed", destHash: sha256Hex("PNGDATA") });
    expect(w.ws.attachments.get(attachment.destId!)!.hash).toBe(sha256Hex("PNGDATA"));
    // Included links are rewritten by ID; the rest keep their target as written.
    expect(remotePlan.markdown).toContain(`[[thoth:page/${notes.destId}|Notes]]`);
    expect(remotePlan.markdown).toContain(`[diagram](thoth:attachment/${attachment.destId})`);
    expect(remotePlan.markdown).toContain("[[Missing page]]");
    expect(remotePlan.markdown).toContain("[[Diary]]");
    expect(remotePlan.markdown).toContain("[docs](https://example.org)");
    expect(remoteNotes.markdown).toContain(`[[thoth:page/${plan.destId}#Goals|the goals]]`);
    expect(thothIdOf(remotePlan.markdown)).toBe(plan.destId);
    expect(remotePlan.revisions.at(-1)!.contentHash).toBe(plan.destHash);
    // Sources stay; their only change is the adopted thoth_id (ADR-0003).
    expect(thothIdOf(await w.read("Projects/Plan.md"))).toBe(plan.sourceId);
    expect((await w.read("Projects/Plan.md")).endsWith(FILES["Projects/Plan.md"])).toBe(true);
    // The record: no content, the mapping and verification results.
    const raw = await readFile(join(w.root, `.thoth/operations/${done.id}.json`), "utf8");
    expect(OperationRecordSchema.parse(JSON.parse(raw)).state).toBe("done");
    expect(raw).not.toContain("Private.");
    expect(raw).not.toContain("Back to");
    // The mapping is durable in .thoth/sync/ and projected into the index.
    const sync = JSON.parse(await readFile(join(w.root, syncPath(w.servers.info(w.server)!.url, w.ws.id)), "utf8"));
    expect(sync.entries.map((e: { kind: string; remoteId: string }) => [e.kind, e.remoteId]).sort()).toEqual([["attachment", attachment.destId], ["page", notes.destId], ["page", plan.destId]].sort());
    expect((await w.vault.listOperationJournal()).find((o) => o.id === done.id)?.state).toBe("done");
    expect((await w.vault.listExternalLocations()).map((l) => l.remoteId).sort()).toEqual([notes.destId, plan.destId].sort());
  });

  it("a later transfer links to pages already at the destination", async () => {
    w = await world(FILES);
    const first = await send(["Projects/Notes.md"], "copy");
    const preview = await w.engine.previewToWorkspace(toWs(["Projects/Plan.md"], "copy", { attachments: false }));
    expect(preview.links.counts.already_at_destination).toBe(1);
    const second = await w.engine.start(preview);
    const remote = w.ws.pages.get(second.items[0]!.destId)!;
    expect(remote.markdown).toContain(`[[thoth:page/${first.items[0]!.destId}|Notes]]`);
  });

  it("move: preserves IDs, deletes the sources only after the verified commit", async () => {
    w = await world(FILES);
    const done = await send(["Projects/Plan.md", "Projects/Notes.md"], "move");
    expect(done.state).toBe("done");
    expect(done.items.every((i) => i.state === "source_deleted" && i.destId === i.sourceId)).toBe(true);
    expect(await w.exists("Projects/Plan.md")).toBe(false);
    expect(await w.exists("Projects/Notes.md")).toBe(false);
    expect(await w.exists("Diary.md")).toBe(true);
    expect(await w.exists("Assets/diagram.png")).toBe(true); // attachments are copied, never deleted
    expect(livePages(w.ws).map((p) => p.id).sort()).toEqual(done.items.map((i) => i.sourceId).sort());
  });

  it("move: a page edited after it was sent is not deleted and is reported as cleanup pending", async () => {
    w = await world(FILES);
    // The user saves a change to one page right after the server committed, before the sources are finalized.
    const restarted = await w.restart({ checkpoint: async (p) => (p === "after:commit" ? w.write("Projects/Notes.md", "# Notes\n\nEdited meanwhile.\n") : undefined) });
    const preview = await restarted.previewToWorkspace(toWs(["Projects/Plan.md", "Projects/Notes.md"], "move"));
    const done = await restarted.start(preview);
    expect(done.state).toBe("destination_committed_source_cleanup_pending");
    const notes = done.items.find((i) => i.sourcePath === "Projects/Notes.md")!;
    expect(notes).toMatchObject({ state: "cleanup_pending", error: "source_changed" });
    expect(await w.read("Projects/Notes.md")).toBe("# Notes\n\nEdited meanwhile.\n");
    expect(done.items.find((i) => i.sourcePath === "Projects/Plan.md")!.state).toBe("source_deleted");
    expect(w.ws.pages.has(notes.destId)).toBe(true);
  });

  it("a server refusal before commit rolls back: staged pages discarded, sources untouched", async () => {
    w = await world({ "A.md": "# A\n" }, { config: { url: "https://full.example", limits: { maxPagesPerWorkspace: 1 } } });
    const preview = await w.engine.previewToWorkspace(toWs(["A.md"], "move"));
    w.servers.writeAsOther(w.ws, { title: "Filler", markdown: "x" }); // the workspace fills up after the preview
    const result = await w.engine.start(preview);
    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe("quota_exceeded");
    expect(await w.exists("A.md")).toBe(true);
    expect(livePages(w.ws).map((p) => p.title)).toEqual(["Filler"]);
  });
});

describe("Workspace → Private", () => {
  it("move back: exactly the pinned revisions, links mapped back to paths, hashes verified, server deletes the source", async () => {
    w = await world(FILES);
    const out = await send(["Projects/Plan.md", "Projects/Notes.md"], "move");
    const ids = out.items.map((i) => i.destId);
    const back = await bringBack(ids, "move", "Inbox");
    expect(back.state).toBe("done");
    expect(back.items.every((i) => i.state === "source_deleted")).toBe(true);
    // Moved pages go back where they came from, with their IDs and their links in vault form.
    expect(back.items.map((i) => i.destPath).sort()).toEqual(["Projects/Notes.md", "Projects/Plan.md"]);
    const plan = await w.read("Projects/Plan.md");
    expect(plan).toContain("See [[Notes]], the");
    expect(plan).toContain("[diagram](../Assets/diagram.png)");
    expect(plan).toContain("[[Missing page]]");
    expect(thothIdOf(plan)).toBe(out.items.find((i) => i.sourcePath === "Projects/Plan.md")!.sourceId);
    expect(await w.read("Projects/Notes.md")).toContain("[[Plan#Goals|the goals]]");
    expect(livePages(w.ws)).toEqual([]);
    for (const item of back.items) expect(await w.hash(item.destPath!)).toBe(item.destHash);
  });

  it("copy: the workspace keeps its pages; local copies get new IDs and land in the chosen folder", async () => {
    w = await world({});
    const page = w.servers.writeAsOther(w.ws, { title: "Roadmap: Q4/Q1", markdown: "# Roadmap\n\nไทย ✓\n" });
    const back = await bringBack([page.id], "copy", "From team");
    expect(back.state).toBe("done");
    expect(back.items[0]!.destPath).toBe("From team/Roadmap- Q4-Q1.md");
    const text = await w.read("From team/Roadmap- Q4-Q1.md");
    expect(text).toContain("ไทย ✓");
    expect(thothIdOf(text)).not.toBe(page.id);
    expect(w.ws.pages.get(page.id)!.deleted).toBe(false);
  });

  it("a page edited at the server after pinning is copied as pinned and left there (cleanup pending)", async () => {
    w = await world({});
    const page = w.servers.writeAsOther(w.ws, { title: "Doc", markdown: "v1\n" });
    const engine = await w.restart({ checkpoint: (p) => void (p === "saved:transfer" ? w.servers.writeAsOther(w.ws, { id: page.id, title: "Doc", markdown: "v2 by Grace\n" }) : undefined) });
    const preview = await engine.previewFromWorkspace({ server: w.server, workspace: w.ws.id, mode: "move", pageIds: [page.id], folder: "" });
    const done = await engine.start(preview);
    expect(done.state).toBe("destination_committed_source_cleanup_pending");
    expect(await w.read("Doc.md")).toContain("v1");
    expect(w.ws.pages.get(page.id)!.deleted).toBe(false);
    expect(w.ws.pages.get(page.id)!.markdown).toBe("v2 by Grace\n");
  });

  it("never overwrites a local file: a name taken gets a new name; the same page edited locally becomes a conflict copy", async () => {
    w = await world({ "Doc.md": "# Mine, unrelated\n" });
    const page = w.servers.writeAsOther(w.ws, { title: "Doc", markdown: "# Theirs\n" });
    const copy = await bringBack([page.id], "copy");
    expect(copy.items[0]!.destPath).toBe("Doc 2.md");
    expect(await w.read("Doc.md")).toBe("# Mine, unrelated\n");
    // Bring the same page again: its copy exists locally under the new ID, so this is just another free name.
    const again = await bringBack([page.id], "copy");
    expect(again.items[0]!.destPath).toBe("Doc 3.md");
  });

  it("an export-restricted workspace refuses, in the preview and at the server", async () => {
    w = await world({}, { workspace: { name: "Locked", exportRestricted: true } });
    const page = w.servers.writeAsOther(w.ws, { title: "Secret", markdown: "s" });
    const preview = await w.engine.previewFromWorkspace({ server: w.server, workspace: w.ws.id, mode: "copy", pageIds: [page.id], folder: "" });
    expect(preview.problems.map((p) => p.code)).toEqual(["export_restricted"]);
    expect(preview.pages).toEqual([]); // nothing was even downloaded for the preview
    // A client that ignores the preview is still refused by the server, and nothing is written.
    const forced = await w.engine.start({ ...preview, problems: [], canStart: true, pages: [{ pageId: page.id, title: "Secret", size: 1, folder: false, parentId: null }] });
    expect(forced.state).toBe("failed");
    expect(forced.error?.code).toBe("export_restricted");
    expect(await w.exists("Secret.md")).toBe(false);
  });
});

describe("records", () => {
  it("abort before commit discards the staged transfer; a committed one cannot be aborted", async () => {
    w = await world({ "A.md": "# A\n" });
    const engine = await w.restart({ checkpoint: (p) => { if (p === "saved:transfer") throw new Error("crash"); } });
    const preview = await engine.previewToWorkspace(toWs(["A.md"], "move"));
    await expect(engine.start(preview)).rejects.toThrow("crash");
    const [record] = await engine.list();
    const fresh = await w.restart();
    const aborted = await fresh.abort(record!.id);
    expect(aborted.state).toBe("aborted");
    expect(w.servers.transfers.get(record!.id)!.resource.state).toBe("aborted");
    expect(await w.exists("A.md")).toBe(true);
    const done = await send(["A.md"], "copy");
    await expect(fresh.abort(done.id)).resolves.toMatchObject({ state: "done" });
  });

  it("removes completed records after the retention period, keeps cleanup-pending ones", async () => {
    w = await world({ "A.md": "# A\n" });
    const done = await send(["A.md"], "copy");
    const later = await w.restart({ now: () => new Date("2027-01-01T00:00:00Z") });
    await later.recover();
    expect(await later.get(done.id)).toBeUndefined();
  });
});
