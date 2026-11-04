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

describe("the web client's change-hint reader against this server (ADR-0041)", () => {
  it("opens, delivers a hint after a write, and ends with 501 when events.sse is off", async () => {
    const { WebServers } = await import("../../web/src/servers.ts");
    const env = await startTestEnv();
    const off = await startTestEnv({ env: { EVENTS: "off" } });
    try {
      const run = async (target: TestEnv, write: boolean) => {
        const who = await target.user("Ana");
        const ws = await target.workspace("W", { members: { [who.userId]: "owner" } });
        const auth = { status: "signed-in", token: async () => who.token, renew: async () => null } as never;
        const web = new WebServers({ server: target.url, capabilities: { protocolVersion: "1.0", capabilities: [] }, auth, fetch, account: () => undefined });
        const seen = { opened: false, hints: 0, ended: false };
        let opened!: () => void;
        const up = new Promise<void>((r) => (opened = r));
        const close = web.events("trial", ws, { open: () => ((seen.opened = true), opened()), hint: () => void seen.hints++, end: () => ((seen.ended = true), opened()) });
        await up;
        if (write) {
          const before = seen.hints;
          await createPage(target, who, ws);
          const deadline = Date.now() + 5000;
          while (seen.hints === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
          expect(seen.hints).toBeGreaterThan(before);
        }
        close();
        return seen;
      };
      expect(await run(env, true)).toMatchObject({ opened: true, ended: false });
      expect(await run(off, false)).toEqual({ opened: false, hints: 0, ended: true });
    } finally {
      await env.close();
      await off.close();
    }
  });
});

// ADR-0042 rule 4 and ADR-0041: a hint's timing must not tell a member that a page hidden from them changed.
describe("hints, presence and the feed on a page limited to a team", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let insider: TestPrincipal;
  let outsider: TestPrincipal;
  let ws: string;
  let team: string;
  let folder: string;
  let secret: string;
  let rev: string;
  beforeAll(async () => {
    env = await startTestEnv();
    owner = await env.user("Olive");
    insider = await env.user("Ian");
    outsider = await env.user("Otto");
    ws = await env.workspace("W", { members: { [owner.userId]: "owner", [insider.userId]: "editor", [outsider.userId]: "editor" } });
    team = (await env.api(owner, "POST", `/workspaces/${ws}/teams`, { json: { name: "Finance" } })).json.id as string;
    await env.api(owner, "PUT", `/workspaces/${ws}/teams/${team}/members/${insider.userId}`);
    folder = (await createPage(env, owner, ws, { title: "Finance", markdown: "---\nthoth_kind: folder\n---\n" })).id;
    const page = await createPage(env, owner, ws, { title: "Salaries", parentId: folder });
    secret = page.id;
    rev = page.revisionId;
  });
  afterAll(() => env.close());

  const limit = async (teamIds: string[] | null) => expect((await env.api(owner, "PUT", `/workspaces/${ws}/pages/${folder}/visibility`, { json: { teamIds } })).status).toBe(200);
  const edit = async () => {
    const res = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${secret}`, { headers: { "if-match": `"${rev}"` }, json: { title: "Salaries", markdown: `# ${uuid()}\n` } });
    expect(res.status).toBe(200);
    rev = res.json.revision.id as string;
  };
  /** Opens a stream and waits for its connect hint, so later hints are the ones under test. */
  const connected = async (who: TestPrincipal) => {
    const stream = await openEvents(env, who, ws);
    await stream.until((e) => e.length > 0, 1000);
    return stream;
  };
  const hintsAfter = async (stream: Awaited<ReturnType<typeof connected>>, seen: number, wait: number) => (await stream.until((e) => e.length > seen, wait)).length - seen;

  it("an edit reaches a member in the team, and neither hint, feed entry, title nor presence reaches one outside it", async () => {
    await limit([team]);
    const inside = await connected(insider);
    const outside = await connected(outsider);
    const [i0, o0] = [inside.received.length, outside.received.length];
    const before = (await env.api(outsider, "GET", `/workspaces/${ws}/changes`)).json.cursor as string;
    await env.api(owner, "PUT", `/workspaces/${ws}/pages/${secret}/presence`);
    await edit();
    expect(await hintsAfter(inside, i0, 3000)).toBeGreaterThan(0);
    expect(await hintsAfter(outside, o0, 1000)).toBe(0);
    inside.close();
    outside.close();

    const feed = await env.api(outsider, "GET", `/workspaces/${ws}/changes`, { query: { cursor: before } });
    expect(feed.status).toBe(200);
    expect(JSON.stringify(feed.json)).not.toContain(secret);
    expect(JSON.stringify(feed.json)).not.toContain("Salaries");
    expect((await env.api(insider, "GET", `/workspaces/${ws}/changes`, { query: { cursor: before } })).json.entries.map((e: { pageId?: string }) => e.pageId)).toContain(secret);

    expect((await env.api(outsider, "PUT", `/workspaces/${ws}/pages/${secret}/presence`)).status).toBe(404);
    expect((await env.api(insider, "PUT", `/workspaces/${ws}/pages/${secret}/presence`)).json.items).toEqual([{ userId: owner.userId, displayName: "Olive" }]);
  });

  it("follows a limit set while the member is connected", async () => {
    await limit(null);
    const outside = await connected(outsider);
    let seen = outside.received.length;
    await edit();
    expect(await hintsAfter(outside, seen, 3000)).toBeGreaterThan(0); // visible: hinted
    seen = outside.received.length;
    await limit([team]); // a visibility entry, which every member is told about so it reads the tree again
    await outside.until((e) => e.length > seen, 3000);
    seen = outside.received.length;
    await edit();
    expect(await hintsAfter(outside, seen, 1000)).toBe(0); // hidden now: nothing
    outside.close();
  });

  it("hides a page whose teams were all deleted from every member but owners and managers", async () => {
    await limit([team]);
    expect((await env.api(owner, "DELETE", `/workspaces/${ws}/teams/${team}`)).status).toBe(204);
    const inside = await connected(insider);
    const own = await connected(owner);
    const [i0, w0] = [inside.received.length, own.received.length];
    await edit();
    expect(await hintsAfter(own, w0, 3000)).toBeGreaterThan(0);
    expect(await hintsAfter(inside, i0, 1000)).toBe(0);
    inside.close();
    own.close();
    expect((await env.api(insider, "PUT", `/workspaces/${ws}/pages/${secret}/presence`)).status).toBe(404);
  });
});
