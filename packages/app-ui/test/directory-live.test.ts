// ADR-0041: live change hints where the server lists `events.sse` and the host can stream, the 5 s poll otherwise;
// presence heartbeats only for servers that list `presence`.
import { afterEach, describe, expect, it } from "vitest";
import type { ApiCallArgs, ApiCallResult, Servers } from "@thoth/platform";
import { problem } from "@thoth/workspace-protocol";
import { ServerDirectory, presenceKey, workspaceKey } from "../src/workspace/directory.ts";
import { FakeServers, type FakeServerConfig } from "../../../tests/helpers/fake-servers.ts";

const BASE: FakeServerConfig = { url: "http://127.0.0.1:8080", name: "Team", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" } };
const CAPS = ["search", "transfers", "attachments", "page-order", "page-kind"];
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** A host that can stream: the test drives each stream. */
class StreamingServers extends FakeServers {
  readonly streams: { workspace: string; on: { open(): void; hint(): void; end(): void }; closed: boolean }[] = [];
  events(_server: string, workspace: string, on: { open(): void; hint(): void; end(): void }): () => void {
    const stream = { workspace, on, closed: false };
    this.streams.push(stream);
    return () => void (stream.closed = true);
  }
  /** The next change-feed read answers 410 `cursor_expired`, as after a visibility change (ADR-0042). */
  expireFeed = false;
  override async call(args: ApiCallArgs, body?: Uint8Array): Promise<ApiCallResult> {
    if (this.expireFeed && args.path.endsWith("/changes")) {
      this.expireFeed = false;
      this.calls.push(structuredClone(args));
      const p = problem("cursor_expired");
      return { status: p.status, headers: { "content-type": "application/problem+json" }, body: JSON.stringify(p) };
    }
    return super.call(args, body);
  }
}

const directories: ServerDirectory[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) d.dispose();
});

async function setup(caps: string[], servers: FakeServers = new StreamingServers(), pollMs = 20) {
  const server = servers.connect({ ...BASE, capabilities: caps });
  const ws = servers.addWorkspace(server, { name: "Design" });
  const page = servers.writeAsOther(ws, { title: "Plan", markdown: "# Plan\n" });
  const directory = new ServerDirectory(servers as Servers, { pollMs, heartbeatMs: 30 });
  directories.push(directory);
  await directory.loadWorkspaces(server);
  directory.expand(server, ws.id);
  await directory.loadTree(server, ws.id);
  const ref = { server, workspace: ws.id, page: page.id };
  const feedReads = () => servers.calls.filter((c) => c.path.endsWith("/changes")).length;
  return { servers, server, ws, page, directory, ref, feedReads };
}

describe("live change hints (events.sse)", () => {
  it("streams the workspace of an open page, reads the feed at once on a hint, and stops polling while live", async () => {
    const { servers, ws, directory, ref, feedReads } = await setup([...CAPS, "events.sse"]);
    const streaming = servers as StreamingServers;
    const release = directory.openPage(ref);
    expect(streaming.streams.map((s) => s.workspace)).toEqual([ws.id]);
    streaming.streams[0]!.on.open();
    expect(directory.getState().live).toEqual([workspaceKey(ref.server, ws.id)]);
    await tick(60);
    const before = feedReads();
    await tick(60);
    expect(feedReads()).toBe(before); // no polling while the stream is up

    servers.writeAsOther(ws, { title: "Retro", markdown: "# Retro\n" });
    streaming.streams[0]!.on.hint();
    await tick();
    expect(directory.getState().trees[workspaceKey(ref.server, ws.id)]!.nodes.map((n) => n.title)).toContain("Retro");

    release();
    expect(streaming.streams[0]!.closed).toBe(true);
    expect(directory.getState().live).toEqual([]);
  });

  it("falls back to the poll when the stream ends, and does not reopen it at once", async () => {
    const { servers, ws, directory, ref, feedReads } = await setup([...CAPS, "events.sse"]);
    const streaming = servers as StreamingServers;
    directory.openPage(ref);
    streaming.streams[0]!.on.open();
    streaming.streams[0]!.on.end();
    expect(directory.getState().live).toEqual([]);
    servers.writeAsOther(ws, { title: "While down", markdown: "# While down\n" });
    const before = feedReads();
    await tick(80);
    expect(feedReads()).toBeGreaterThan(before);
    expect(directory.getState().trees[workspaceKey(ref.server, ws.id)]!.nodes.map((n) => n.title)).toContain("While down");
    expect(streaming.streams).toHaveLength(1); // retried later, not in a tight loop
  });

  it("on a hint after a visibility change (410 cursor_expired) reads the tree again and makes the open page re-read itself", async () => {
    const { servers, ws, directory, ref } = await setup([...CAPS, "events.sse"]);
    const streaming = servers as StreamingServers;
    const other = servers.writeAsOther(ws, { title: "Hidden soon", markdown: "# Hidden soon\n" });
    await directory.pollNow();
    directory.openPage(ref);
    streaming.streams[0]!.on.open();
    const key = workspaceKey(ref.server, ws.id);
    const before = directory.getState().trees[key]!.ticks[ref.page] ?? 0;
    // The page is now hidden from this account: the server drops it from the tree and expires older cursors.
    ws.pages.delete(other.id);
    streaming.expireFeed = true;
    const treeReads = () => servers.calls.filter((c) => c.method === "GET" && c.path.endsWith("/tree")).length;
    const reads = treeReads();
    streaming.streams[0]!.on.hint();
    await tick();
    expect(treeReads()).toBe(reads + 1);
    expect(directory.getState().trees[key]!.nodes.map((n) => n.id)).not.toContain(other.id);
    expect(directory.getState().trees[key]!.ticks[ref.page]).toBe(before + 1);
  });

  it("a page restored from the Trash comes back with the next hint (page.created)", async () => {
    const { servers, ws, directory, ref } = await setup([...CAPS, "events.sse"]);
    const streaming = servers as StreamingServers;
    const gone = servers.writeAsOther(ws, { title: "Restored", markdown: "# Restored\n" });
    directory.openPage(ref);
    streaming.streams[0]!.on.open();
    servers.deleteAsOther(ws, gone.id);
    streaming.streams[0]!.on.hint();
    await tick();
    const titles = () => directory.getState().trees[workspaceKey(ref.server, ws.id)]!.nodes.map((n) => n.title);
    expect(titles()).not.toContain("Restored");
    ws.pages.delete(gone.id);
    servers.writeAsOther(ws, { id: gone.id, title: "Restored", markdown: "# Restored\n" }); // page.created, as a restore records
    streaming.streams[0]!.on.hint();
    await tick();
    expect(titles()).toContain("Restored");
  });

  it("polls a server without events.sse, and a host that cannot stream", async () => {
    const plain = await setup(CAPS);
    plain.directory.openPage(plain.ref);
    expect((plain.servers as StreamingServers).streams).toHaveLength(0);
    const host = await setup([...CAPS, "events.sse"], new FakeServers());
    host.directory.openPage(host.ref);
    const before = host.feedReads();
    await tick(80);
    expect(host.feedReads()).toBeGreaterThan(before);
    expect(host.directory.getState().live).toEqual([]);
  });
});

describe("presence", () => {
  it("sends a heartbeat for an open page, repeats it, keeps who else is there, and leaves on the last release", async () => {
    const { servers, ws, directory, ref } = await setup([...CAPS, "presence"]);
    servers.presence = () => [{ userId: "usr_ana", displayName: "Ana" }];
    const one = directory.openPage(ref);
    const two = directory.openPage(ref); // the same page in the other pane
    await tick();
    expect(directory.getState().presence[presenceKey(ref)]).toEqual([{ userId: "usr_ana", displayName: "Ana" }]);
    const beats = () => servers.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/presence")).length;
    const first = beats();
    expect(first).toBe(1);
    await tick(80);
    expect(beats()).toBeGreaterThan(first);
    one();
    expect(servers.calls.some((c) => c.method === "DELETE" && c.path.endsWith("/presence"))).toBe(false);
    two();
    await tick();
    expect(servers.calls.filter((c) => c.method === "DELETE" && c.path.endsWith(`/workspaces/${ws.id}/pages/${ref.page}/presence`))).toHaveLength(1);
    expect(directory.getState().presence[presenceKey(ref)]).toBeUndefined();
    const after = beats();
    await tick(80);
    expect(beats()).toBe(after);
  });

  it("sends nothing to a server without presence", async () => {
    const { servers, directory, ref } = await setup(CAPS);
    directory.openPage(ref)();
    await tick(60);
    expect(servers.calls.some((c) => c.path.endsWith("/presence"))).toBe(false);
  });
});
