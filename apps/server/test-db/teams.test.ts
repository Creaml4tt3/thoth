/**
 * Teams and page visibility (ADR-0042, capability `teams`) against the real server and PostgreSQL: the Manager role,
 * team management, and for every route that returns or touches a page, a test that a page limited to a team the reader
 * is not in does not leak (404, never 403; absent from lists).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, createTransfer, uuid } from "./support.ts";

const SECRET = "Quarterly salaries";

describe("teams: the Manager role and team management", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let manager: TestPrincipal;
  let editor: TestPrincipal;
  let viewer: TestPrincipal;
  let ws: string;

  beforeAll(async () => {
    env = await startTestEnv();
    [owner, manager, editor, viewer] = (await Promise.all(["Olive", "Mae", "Eddie", "Vera"].map((n) => env.user(n)))) as [TestPrincipal, TestPrincipal, TestPrincipal, TestPrincipal];
    ws = await env.workspace("Studio", { members: { [owner.userId]: "owner", [manager.userId]: "manager", [editor.userId]: "editor", [viewer.userId]: "viewer" } });
  });
  afterAll(() => env.close());

  it("advertises teams and accepts manager in the database and as a role", async () => {
    expect((await env.api(null, "GET", "/capabilities")).json.capabilities).toContain("teams");
    const list = await env.api(viewer, "GET", `/workspaces/${ws}/members`);
    expect(list.json.items.find((m: { userId: string }) => m.userId === manager.userId).role).toBe("manager");
    const set = await env.api(owner, "PUT", `/workspaces/${ws}/members/${viewer.userId}`, { json: { role: "manager" } });
    expect([set.status, set.json.role]).toEqual([200, "manager"]);
    await env.api(owner, "PUT", `/workspaces/${ws}/members/${viewer.userId}`, { json: { role: "viewer" } });
  });

  it("lets a manager write pages like an editor, but not change roles or make invite links", async () => {
    await createPage(env, manager, ws, { title: "By the manager" });
    expect((await env.api(manager, "PUT", `/workspaces/${ws}/members/${viewer.userId}`, { json: { role: "editor" } })).status).toBe(403);
    expect((await env.api(manager, "POST", `/workspaces/${ws}/invite-links`, { json: { role: "viewer" } })).status).toBe(403);
  });

  it("lets an owner make a manager invite link, and joining with it makes a manager", async () => {
    const made = await env.api(owner, "POST", `/workspaces/${ws}/invite-links`, { json: { role: "manager" } });
    expect([made.status, made.json.role]).toEqual([201, "manager"]);
    const guest = await env.user("Gus");
    const joined = await env.api(guest, "POST", "/invites/accept", { json: { token: made.json.token } });
    expect([joined.status, joined.json.role]).toEqual([200, "manager"]);
  });

  it("lets owners and managers create, rename and delete teams and set their members; editors and viewers only read", async () => {
    for (const who of [editor, viewer]) expect((await env.api(who, "POST", `/workspaces/${ws}/teams`, { json: { name: "Nope" } })).status, who.userId).toBe(403);
    const made = await env.api(manager, "POST", `/workspaces/${ws}/teams`, { json: { name: " Design " } });
    expect([made.status, made.json.name, made.json.memberIds]).toEqual([201, "Design", []]);
    const team = made.json.id as string;
    const added = await env.api(manager, "PUT", `/workspaces/${ws}/teams/${team}/members/${editor.userId}`);
    expect(added.json.memberIds).toEqual([editor.userId]);
    expect((await env.api(owner, "PUT", `/workspaces/${ws}/teams/${team}/members/${editor.userId}`)).json.memberIds).toEqual([editor.userId]);
    const stranger = await env.user("Stan");
    expect((await env.api(owner, "PUT", `/workspaces/${ws}/teams/${team}/members/${stranger.userId}`)).status).toBe(404);
    expect((await env.api(owner, "PUT", `/workspaces/${ws}/teams/${team}`, { json: { name: "Product" } })).json.name).toBe("Product");
    const listed = await env.api(viewer, "GET", `/workspaces/${ws}/teams`);
    expect(listed.json.items).toEqual([{ id: team, name: "Product", memberIds: [editor.userId] }]);
    expect((await env.api(viewer, "PUT", `/workspaces/${ws}/teams/${team}`, { json: { name: "x" } })).status).toBe(403);
    expect((await env.api(stranger, "GET", `/workspaces/${ws}/teams`)).status).toBe(404);
    expect((await env.api(owner, "DELETE", `/workspaces/${ws}/teams/${team}`)).status).toBe(204);
    expect((await env.api(owner, "DELETE", `/workspaces/${ws}/teams/${team}`)).status).toBe(404);
  });

  it("removes a departing member from the workspace's teams", async () => {
    const team = (await env.api(owner, "POST", `/workspaces/${ws}/teams`, { json: { name: "Leavers" } })).json.id as string;
    const leaver = await env.user("Lee");
    await env.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')", [ws, leaver.userId]);
    await env.api(owner, "PUT", `/workspaces/${ws}/teams/${team}/members/${leaver.userId}`);
    expect((await env.api(leaver, "DELETE", `/workspaces/${ws}/members/${leaver.userId}`)).status).toBe(204);
    expect((await env.db.query("SELECT 1 FROM team_members WHERE team_id = $1", [team])).rowCount).toBe(0);
  });
});

describe("teams: a hidden page does not leak through any route", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let insider: TestPrincipal;
  let outsider: TestPrincipal;
  let manager: TestPrincipal;
  let ws: string;
  let team: string;
  let folder: string;
  let secret: { id: string; revisionId: string };
  let open: { id: string; revisionId: string };
  let cursorBefore: string;

  const tokenFor = async (pageId: string) => {
    const res = await env.api(owner, "POST", `/workspaces/${ws}/pages/${pageId}/share-links`, { json: {} });
    return res;
  };

  beforeAll(async () => {
    env = await startTestEnv();
    [owner, insider, outsider, manager] = (await Promise.all(["Olive", "Ines", "Otto", "Mae"].map((n) => env.user(n)))) as [TestPrincipal, TestPrincipal, TestPrincipal, TestPrincipal];
    ws = await env.workspace("Company", { members: { [owner.userId]: "owner", [insider.userId]: "editor", [outsider.userId]: "editor", [manager.userId]: "manager" } });
    team = (await env.api(manager, "POST", `/workspaces/${ws}/teams`, { json: { name: "Finance" } })).json.id;
    await env.api(manager, "PUT", `/workspaces/${ws}/teams/${team}/members/${insider.userId}`);
    folder = (await createPage(env, owner, ws, { title: "Finance", markdown: "---\nthoth_kind: folder\n---\n" })).id;
    secret = await createPage(env, owner, ws, { title: SECRET, markdown: `# ${SECRET}\n\nsalary table\n`, parentId: folder });
    open = await createPage(env, owner, ws, { title: "Lunch menu", markdown: "# Lunch menu\n\nsalary of soup\n" });
    cursorBefore = (await env.api(outsider, "GET", `/workspaces/${ws}/tree`)).json.changeCursor;
    const set = await env.api(manager, "PUT", `/workspaces/${ws}/pages/${folder}/visibility`, { json: { teamIds: [team] } });
    expect([set.status, set.json.teamIds, set.json.limitedAbove]).toEqual([200, [team], false]);
    // A child below the limited folder reports the limit above it.
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${secret.id}/visibility`)).json).toEqual({ pageId: secret.id, teamIds: null, limitedAbove: true });
  });
  afterAll(() => env.close());

  const notFound = (res: { status: number; json: any }) => expect([res.status, res.json?.code]).toEqual([404, "not_found"]);

  it("tree: absent for an outsider, present for the team and for owners", async () => {
    const ids = async (who: TestPrincipal) => (await env.api(who, "GET", `/workspaces/${ws}/tree`)).json.items.map((n: { id: string }) => n.id);
    expect(await ids(outsider)).toEqual([open.id]);
    expect((await ids(insider)).sort()).toEqual([folder, secret.id, open.id].sort());
    expect((await ids(owner)).sort()).toEqual([folder, secret.id, open.id].sort());
    expect((await env.api(outsider, "GET", `/workspaces/${ws}/tree`)).text).not.toContain(SECRET);
  });

  it("GET page and ?revision=: 404, never 403", async () => {
    notFound(await env.api(outsider, "GET", `/workspaces/${ws}/pages/${secret.id}`));
    notFound(await env.api(outsider, "GET", `/workspaces/${ws}/pages/${secret.id}`, { query: { revision: secret.revisionId } }));
    notFound(await env.api(outsider, "GET", `/workspaces/${ws}/pages/${folder}`));
    expect((await env.api(insider, "GET", `/workspaces/${ws}/pages/${secret.id}`)).status).toBe(200);
  });

  it("revisions: 404", async () => {
    notFound(await env.api(outsider, "GET", `/workspaces/${ws}/pages/${secret.id}/revisions`));
  });

  it("PUT, create over its ID, move and delete: 404, and nothing changes", async () => {
    notFound(await env.api(outsider, "PUT", `/workspaces/${ws}/pages/${secret.id}`, { headers: { "if-match": `"${secret.revisionId}"` }, json: { title: "x", markdown: "x" } }));
    notFound(await env.api(outsider, "PUT", `/workspaces/${ws}/pages/${secret.id}`, { headers: { "if-none-match": "*" }, json: { title: "x", markdown: "x" } }));
    notFound(await env.api(outsider, "POST", `/workspaces/${ws}/pages/${secret.id}/move`, { headers: { "if-match": `"${secret.revisionId}"` }, json: { parentId: null } }));
    notFound(await env.api(outsider, "DELETE", `/workspaces/${ws}/pages/${secret.id}`, { headers: { "if-match": `"${secret.revisionId}"` } }));
    // Nor can a page be put into the hidden folder.
    const intoIt = await env.api(outsider, "PUT", `/workspaces/${ws}/pages/${uuid()}`, { headers: { "if-none-match": "*" }, json: { title: "x", markdown: "x", parentId: folder } });
    notFound(intoIt);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${secret.id}`)).json.revision.id).toBe(secret.revisionId);
  });

  it("change feed: an old cursor expires, and a fresh read has no entry of the hidden pages", async () => {
    const old = await env.api(outsider, "GET", `/workspaces/${ws}/changes`, { query: { cursor: cursorBefore } });
    expect([old.status, old.json.code]).toEqual([410, "cursor_expired"]);
    const all = await env.api(outsider, "GET", `/workspaces/${ws}/changes`);
    expect(all.status).toBe(200);
    expect(all.text).not.toContain(SECRET);
    const pages = all.json.entries.map((e: { pageId?: string }) => e.pageId).filter(Boolean);
    expect(pages).not.toContain(secret.id);
    expect(pages).not.toContain(folder);
    expect(pages).toContain(open.id);
    // The team member reads the same entries with the pages in them.
    const theirs = await env.api(insider, "GET", `/workspaces/${ws}/changes`);
    expect(theirs.json.entries.map((e: { pageId?: string }) => e.pageId)).toContain(secret.id);
    // A later change to the hidden page moves the outsider's cursor on without showing it.
    const fresh = (await env.api(outsider, "GET", `/workspaces/${ws}/tree`)).json.changeCursor;
    await env.api(insider, "PUT", `/workspaces/${ws}/pages/${secret.id}`, { headers: { "if-match": `"${secret.revisionId}"` }, json: { title: SECRET, markdown: "# changed\n" } });
    secret.revisionId = (await env.api(owner, "GET", `/workspaces/${ws}/pages/${secret.id}`)).json.revision.id;
    const after = await env.api(outsider, "GET", `/workspaces/${ws}/changes`, { query: { cursor: fresh } });
    expect([after.status, after.json.entries]).toEqual([200, []]);
    expect(after.json.cursor).not.toBe(fresh);
  });

  it("search: no hit in a hidden page, also within it", async () => {
    // "salar" hits the hidden page's title ("Quarterly salaries") and the open page's text.
    const hits = await env.api(outsider, "POST", `/workspaces/${ws}/search`, { json: { query: "salar" } });
    expect(hits.json.items.map((h: { pageId: string }) => h.pageId)).toEqual([open.id]);
    const within = await env.api(outsider, "POST", `/workspaces/${ws}/search`, { json: { query: "salar", withinPageId: folder } });
    expect(within.json.items).toEqual([]);
    const theirs = await env.api(insider, "POST", `/workspaces/${ws}/search`, { json: { query: "salar" } });
    expect(theirs.json.items.map((h: { pageId: string }) => h.pageId)).toContain(secret.id);
  });

  it("transfers: copying a hidden page out is 404; staging into a hidden folder is 404; someone else's transfer of it is 404", async () => {
    const out = { operationId: uuid(), direction: "from_workspace", mode: "copy", pages: [{ pageId: secret.id }] };
    notFound(await createTransfer(env, outsider, ws, out));
    const into = { operationId: uuid(), direction: "to_workspace", mode: "copy", pages: [{ sourceId: "local:x", pageId: uuid(), parentId: folder, title: "x", markdown: "x" }] };
    notFound(await createTransfer(env, outsider, ws, into));
    const theirs = { operationId: uuid(), direction: "from_workspace", mode: "copy", pages: [{ pageId: secret.id }] };
    expect((await createTransfer(env, insider, ws, theirs)).status).toBe(201);
    notFound(await env.api(outsider, "GET", `/transfers/${theirs.operationId}`));
    notFound(await env.api(outsider, "POST", `/transfers/${theirs.operationId}/abort`));
    expect((await env.api(insider, "GET", `/transfers/${theirs.operationId}`)).status).toBe(200);
  });

  it("share links: an outsider cannot create or list them; nobody can share a limited page publicly", async () => {
    notFound(await env.api(outsider, "POST", `/workspaces/${ws}/pages/${secret.id}/share-links`, { json: {} }));
    notFound(await env.api(outsider, "GET", `/workspaces/${ws}/pages/${secret.id}/share-links`));
    const refused = await tokenFor(secret.id);
    expect([refused.status, refused.json.code]).toEqual([403, "forbidden"]);
  });

  it("public /s/ pages: a link made before the limit stops working, and the shared tree leaves out limited pages", async () => {
    // A link to an open page whose subtree later gains a limited child.
    const parent = await createPage(env, owner, ws, { title: "Handbook" });
    const inner = await createPage(env, owner, ws, { title: "Bonuses", markdown: "# Bonuses\n", parentId: parent.id });
    const made = await tokenFor(parent.id);
    expect(made.status).toBe(201);
    const page = (path: string) => fetch(`${env.url}${path}`, { headers: { accept: "text/html" } });
    expect((await page(`/s/${made.json.token}/p/${inner.id}`)).status).toBe(200);
    // A link straight to a page that then becomes limited.
    const direct = await tokenFor(inner.id);
    await env.api(owner, "PUT", `/workspaces/${ws}/pages/${inner.id}/visibility`, { json: { teamIds: [team] } });
    expect((await page(`/s/${direct.json.token}`)).status).toBe(404);
    expect((await page(`/s/${made.json.token}/p/${inner.id}`)).status).toBe(404);
    const home = await page(`/s/${made.json.token}`);
    expect(home.status).toBe(200);
    expect(await home.text()).not.toContain("Bonuses");
  });

  it("visibility routes: editors get the same 403 for hidden and open pages; a manager outside the team gets 404", async () => {
    // The role is checked first, so the answer says nothing about the page.
    for (const id of [secret.id, open.id, uuid()]) expect((await env.api(outsider, "GET", `/workspaces/${ws}/pages/${id}/visibility`)).status, id).toBe(403);
    // The manager is in no team: the limited folder is hidden from them too, so they cannot lift it.
    notFound(await env.api(manager, "PUT", `/workspaces/${ws}/pages/${folder}/visibility`, { json: { teamIds: null } }));
  });

  it("events: the SSE stream carries only hints, never a page ID or title", async () => {
    // The hint format has no page fields (protocol); this guards the frame builder against ever growing one.
    const { sseFrame } = await import("../src/changes.ts");
    expect(sseFrame(ws, "c")).not.toMatch(/pageId|title/);
  });

  it("moving a page into a limited folder limits it, and the move expires older cursors", async () => {
    const page = await createPage(env, outsider, ws, { title: "Moved in" });
    const before = (await env.api(outsider, "GET", `/workspaces/${ws}/tree`)).json.changeCursor;
    const moved = await env.api(insider, "POST", `/workspaces/${ws}/pages/${page.id}/move`, { headers: { "if-match": `"${page.revisionId}"` }, json: { parentId: folder } });
    expect(moved.status).toBe(200);
    notFound(await env.api(outsider, "GET", `/workspaces/${ws}/pages/${page.id}`));
    expect((await env.api(outsider, "GET", `/workspaces/${ws}/changes`, { query: { cursor: before } })).status).toBe(410);
  });

  it("deleting the only team keeps its pages hidden from everyone but owners", async () => {
    const solo = (await env.api(owner, "POST", `/workspaces/${ws}/teams`, { json: { name: "Solo" } })).json.id as string;
    await env.api(owner, "PUT", `/workspaces/${ws}/teams/${solo}/members/${outsider.userId}`);
    const page = await createPage(env, owner, ws, { title: "Solo page" });
    await env.api(owner, "PUT", `/workspaces/${ws}/pages/${page.id}/visibility`, { json: { teamIds: [solo] } });
    expect((await env.api(outsider, "GET", `/workspaces/${ws}/pages/${page.id}`)).status).toBe(200);
    await env.api(owner, "DELETE", `/workspaces/${ws}/teams/${solo}`);
    notFound(await env.api(outsider, "GET", `/workspaces/${ws}/pages/${page.id}`));
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${page.id}`)).status).toBe(200);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${page.id}/visibility`)).json.teamIds).toEqual([]);
  });

  it("refuses teams of another workspace", async () => {
    const other = await env.workspace("Other", { members: { [owner.userId]: "owner" } });
    const foreign = (await env.api(owner, "POST", `/workspaces/${other}/teams`, { json: { name: "Foreign" } })).json.id;
    const res = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${open.id}/visibility`, { json: { teamIds: [foreign] } });
    expect([res.status, res.json.code]).toEqual([400, "validation_failed"]);
  });
});
