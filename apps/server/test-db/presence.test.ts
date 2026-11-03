// ADR-0041: who else has a page open. Members only, names and IDs only, gone after the TTL or on leave.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESENCE_TTL_SECONDS } from "@thoth/workspace-protocol";
import { runMaintenance } from "../src/maintenance.ts";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, uuid } from "./support.ts";

describe("presence (capability presence)", () => {
  let env: TestEnv;
  let ana: TestPrincipal;
  let ben: TestPrincipal;
  let vic: TestPrincipal;
  let outsider: TestPrincipal;
  let ws: string;
  let page: string;
  const path = () => `/workspaces/${ws}/pages/${page}/presence`;
  beforeAll(async () => {
    env = await startTestEnv();
    ana = await env.user("Ana");
    ben = await env.user("Ben");
    vic = await env.user("Vic");
    outsider = await env.user("Outsider");
    await env.db.query("UPDATE users SET email = 'ana@example.org' WHERE id = $1", [ana.userId]);
    ws = await env.workspace("W", { members: { [ana.userId]: "owner", [ben.userId]: "editor", [vic.userId]: "viewer" } });
    page = (await createPage(env, ana, ws, { title: "Plan" })).id;
  });
  afterAll(() => env.close());

  it("lists the other members who have the page open, by name and ID only, never the caller", async () => {
    const first = await env.api(ana, "PUT", path());
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ items: [] });
    const second = await env.api(vic, "PUT", path()); // a viewer may say it is reading
    expect(second.json).toEqual({ items: [{ userId: ana.userId, displayName: "Ana" }] });
    const third = await env.api(ana, "PUT", path());
    expect(third.json.items).toEqual([{ userId: vic.userId, displayName: "Vic" }]);
    expect(third.text).not.toContain("example.org");
  });

  it("forgets a member who left, and treats a second leave as done", async () => {
    expect((await env.api(vic, "DELETE", path())).status).toBe(204);
    expect((await env.api(vic, "DELETE", path())).status).toBe(204);
    expect((await env.api(ana, "PUT", path())).json.items).toEqual([]);
  });

  it("forgets a heartbeat older than the TTL, and maintenance deletes it", async () => {
    await env.api(ben, "PUT", path());
    expect((await env.api(ana, "PUT", path())).json.items).toEqual([{ userId: ben.userId, displayName: "Ben" }]);
    await env.db.query("UPDATE page_presence SET seen_at = now() - make_interval(secs => $1) WHERE user_id = $2", [PRESENCE_TTL_SECONDS + 1, ben.userId]);
    expect((await env.api(ana, "PUT", path())).json.items).toEqual([]);
    await env.api(ben, "PUT", path());
    await env.db.query("UPDATE page_presence SET seen_at = now() - make_interval(secs => $1)", [PRESENCE_TTL_SECONDS + 1]);
    const result = await runMaintenance(env.db, { revisionRetentionDays: undefined, blobs: env.server.deps.blobs });
    expect(result.presenceRowsDeleted).toBeGreaterThanOrEqual(1);
    expect(Number((await env.db.query<{ n: string }>("SELECT count(*) AS n FROM page_presence")).rows[0]!.n)).toBe(0);
  });

  it("is 404 for a non-member, an unknown page and a deleted page, and drops a removed member at once", async () => {
    expect((await env.api(outsider, "PUT", path())).status).toBe(404);
    expect((await env.api(outsider, "DELETE", path())).status).toBe(404);
    expect((await env.api(ana, "PUT", `/workspaces/${ws}/pages/${uuid()}/presence`)).status).toBe(404);
    expect((await env.api(ana, "PUT", `/workspaces/${ws}/pages/not-a-uuid/presence`)).status).toBe(400);
    await env.api(ben, "PUT", path());
    await env.db.query("DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2", [ws, ben.userId]);
    expect((await env.api(ana, "PUT", path())).json.items).toEqual([]);
    const gone = await createPage(env, ana, ws, { title: "Gone" });
    expect((await env.api(ana, "DELETE", `/workspaces/${ws}/pages/${gone.id}`, { headers: { "if-match": `"${gone.revisionId}"` } })).status).toBe(204);
    expect((await env.api(ana, "PUT", `/workspaces/${ws}/pages/${gone.id}/presence`)).status).toBe(404);
  });

  it("needs credentials, and answers 501 when the capability is off", async () => {
    expect((await env.api(null, "PUT", path())).status).toBe(401);
    const off = await startTestEnv({ configure: (c) => void (c.capabilities = c.capabilities.filter((x) => x !== "presence")) });
    try {
      const who = await off.user("Ana");
      const w = await off.workspace("W", { members: { [who.userId]: "owner" } });
      const p = (await createPage(off, who, w)).id;
      const res = await off.api(who, "PUT", `/workspaces/${w}/pages/${p}/presence`);
      expect(res.status).toBe(501);
      expect(res.json.code).toBe("capability_not_supported");
      expect((await off.api(who, "GET", "/capabilities")).json.capabilities).not.toContain("presence");
    } finally {
      await off.close();
    }
  });
});

// ADR-0042 rule 4: a hidden page is a 404 and absent everywhere, presence included.
describe("presence on a page limited to a team", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let insider: TestPrincipal;
  let outsider: TestPrincipal;
  let ws: string;
  let team: string;
  let secret: string;
  const path = () => `/workspaces/${ws}/pages/${secret}/presence`;
  const limit = async (teamIds: string[] | null) => expect((await env.api(owner, "PUT", `/workspaces/${ws}/pages/${secret}/visibility`, { json: { teamIds } })).status).toBe(200);
  beforeAll(async () => {
    env = await startTestEnv();
    owner = await env.user("Olive");
    insider = await env.user("Ian");
    outsider = await env.user("Otto");
    ws = await env.workspace("W", { members: { [owner.userId]: "owner", [insider.userId]: "editor", [outsider.userId]: "editor" } });
    team = (await env.api(owner, "POST", `/workspaces/${ws}/teams`, { json: { name: "Finance" } })).json.id as string;
    await env.api(owner, "PUT", `/workspaces/${ws}/teams/${team}/members/${insider.userId}`);
    secret = (await createPage(env, owner, ws, { title: "Salaries" })).id;
  });
  afterAll(() => env.close());

  it("is 404 for a member who cannot see the page, word for word an unknown page's 404, and records nothing", async () => {
    await limit([team]);
    const hidden = await env.api(outsider, "PUT", path());
    const unknown = await env.api(outsider, "PUT", `/workspaces/${ws}/pages/${uuid()}/presence`);
    expect(hidden.status).toBe(404);
    expect({ code: hidden.json.code, detail: hidden.json.detail }).toEqual({ code: unknown.json.code, detail: unknown.json.detail });
    expect((await env.db.query("SELECT 1 FROM page_presence WHERE user_id = $1", [outsider.userId])).rowCount).toBe(0);
    expect((await env.api(insider, "PUT", path())).json.items).toEqual([]);
    expect((await env.api(owner, "PUT", path())).json.items).toEqual([{ userId: insider.userId, displayName: "Ian" }]);
  });

  it("stops showing a member at once when the page is hidden from them", async () => {
    await limit(null);
    await env.api(owner, "PUT", path());
    await env.api(outsider, "PUT", path());
    expect((await env.api(insider, "PUT", path())).json.items.map((e: { userId: string }) => e.userId)).toContain(outsider.userId);
    await limit([team]); // Otto's row is still fresh, but he can no longer see the page
    expect((await env.api(insider, "PUT", path())).json.items).toEqual([{ userId: owner.userId, displayName: "Olive" }]);
  });
});
