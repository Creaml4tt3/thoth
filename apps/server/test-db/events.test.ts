import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendChange, changeCursorOf } from "../src/changes.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, openEvents, uuid } from "./support.ts";

describe("server-sent events are hints; the change feed is the truth", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let viewer: TestPrincipal;
  let ws: string;
  beforeAll(async () => {
    env = await startTestEnv();
    owner = await env.user("Owner");
    viewer = await env.user("Viewer");
    ws = await env.workspace("W", { members: { [owner.userId]: "owner", [viewer.userId]: "viewer" } });
  });
  afterAll(() => env.close());

  it("emits exactly the protocol payload after a write, carrying no content", async () => {
    const stream = await openEvents(env, viewer, ws);
    expect(stream.status).toBe(200);
    await createPage(env, owner, ws, { title: "Secret title", markdown: "# Secret body\n" });
    const got = await stream.until((e) => e.some((x) => x.event === "changes"));
    stream.close();
    const hint = got.find((x) => x.event === "changes")!;
    expect(Object.keys(hint.data).sort()).toEqual(["cursor", "type", "workspaceId"]);
    expect(hint.data).toMatchObject({ type: "changes.available", workspaceId: ws });
    expect(JSON.stringify(hint)).not.toContain("Secret");
  });

  it("recovers a missed event: disconnect, write, reconnect, read the feed from the old cursor", async () => {
    const before = (await env.api(owner, "GET", `/workspaces/${ws}/changes`)).json.cursor as string;
    const first = await openEvents(env, owner, ws);
    first.close(); // disconnect
    const { id, revisionId } = await createPage(env, owner, ws, { title: "While away" });
    const second = await openEvents(env, owner, ws); // reconnect
    // The reconnect hint is not needed for correctness: the feed from the old cursor has the entry.
    const feed = await env.api(owner, "GET", `/workspaces/${ws}/changes`, { query: { cursor: before } });
    second.close();
    expect(feed.json.entries.map((e: { pageId?: string; revisionId?: string; kind: string }) => [e.kind, e.pageId, e.revisionId])).toContainEqual(["page.created", id, revisionId]);
  });

  it("tells a reconnecting client about changes made while it was away", async () => {
    await createPage(env, owner, ws);
    const stream = await openEvents(env, owner, ws);
    const got = await stream.until((e) => e.length > 0);
    stream.close();
    expect(got[0]!.data.type).toBe("changes.available");
  });

  it("does not leak hints across workspaces", async () => {
    const other = await env.workspace("Other", { members: { [owner.userId]: "owner" } });
    const stream = await openEvents(env, owner, ws);
    await stream.until((e) => e.length > 0, 300);
    const seen = stream.received.length;
    await createPage(env, owner, other);
    await stream.until((e) => e.length > seen, 700);
    stream.close();
    expect(stream.received.length).toBe(seen);
  });

  it("fans hints out across server instances through LISTEN/NOTIFY", async () => {
    const second: RunningServer = await startServer(env.config, { migrate: false });
    try {
      const stream = await openEvents(env, viewer, ws, second.url); // connected to instance 2
      await createPage(env, owner, ws); // written through instance 1
      const got = await stream.until((e) => e.some((x) => x.event === "changes"));
      stream.close();
      expect(got.some((x) => x.data.workspaceId === ws)).toBe(true);
    } finally {
      await second.close();
    }
  });

  it("a rolled-back write sends no hint; a committed one does", async () => {
    const stream = await openEvents(env, owner, ws);
    await stream.until((e) => e.length > 0, 300);
    const seen = stream.received.length;
    // Append a change entry inside a transaction and roll it back: NOTIFY is queued with the transaction and dropped.
    await env.db
      .tx(async (tx) => {
        await tx.query("SELECT 1 FROM workspaces WHERE id = $1 FOR NO KEY UPDATE", [ws]);
        await appendChange(tx, ws, { kind: "page.deleted", actorId: owner.userId, pageId: uuid() }, new Date());
        throw new Error("roll back");
      })
      .catch(() => undefined);
    await stream.until((e) => e.length > seen, 600);
    expect(stream.received.length).toBe(seen);
    const head = (await env.db.query<{ change_seq: number }>("SELECT change_seq FROM workspaces WHERE id = $1", [ws])).rows[0]!.change_seq;
    expect((await env.api(owner, "GET", `/workspaces/${ws}/changes`)).json.cursor).toBe(changeCursorOf(ws, head));
    await createPage(env, owner, ws);
    await stream.until((e) => e.length > seen, 3000);
    stream.close();
    expect(stream.received.length).toBeGreaterThan(seen);
  });

  it("shutting the server down ends open streams promptly", async () => {
    const own = await startTestEnv();
    try {
      const u = await own.user("U");
      const w = await own.workspace("W", { members: { [u.userId]: "owner" } });
      const stream = await openEvents(own, u, w);
      const started = Date.now();
      await own.server.close();
      expect(Date.now() - started).toBeLessThan(5000);
      stream.close();
    } finally {
      await own.db.close();
      await own.close().catch(() => undefined);
    }
  });
});
