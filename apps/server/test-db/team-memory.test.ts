/**
 * Team memory (ADR-0052 rule 8, capability `team-memory`) against the real server and PostgreSQL: agents' memories as
 * proposals the server keeps, who sees and settles them, the folder made on the first one, review off, changes with
 * compare-and-swap, hidden folders, the activity record and expiry.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage } from "./support.ts";

const MEMORY = "---\nkind: preference\ntitle: Blockers first\nsource: Claude Code\n---\nPut blockers first in the weekly update.\n";

describe("team memory", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let manager: TestPrincipal;
  let editor: TestPrincipal;
  let other: TestPrincipal;
  let viewer: TestPrincipal;
  let ws: string;

  const path = (rest = "") => `/workspaces/${ws}/team-memory${rest}`;
  const propose = (who: TestPrincipal, json: Record<string, unknown>) => env.api(who, "POST", path("/proposals"), { json: { agent: "Claude Code", title: "Blockers first", markdown: MEMORY, ...json } });
  const list = async (who: TestPrincipal, query: Record<string, string> = {}) => {
    const res = await env.api(who, "GET", path("/proposals"), { query });
    expect(res.status, res.text).toBe(200);
    return res.json.items as { id: string; status: string; authorId: string; agent: string; pageId: string | null; settledBy: string | null; settledByName: string | null; authorName: string | null }[];
  };
  const tree = async (who: TestPrincipal) => (await env.api(who, "GET", `/workspaces/${ws}/tree`)).json.items as { id: string; parentId: string | null; title: string }[];

  beforeAll(async () => {
    env = await startTestEnv();
    [owner, manager, editor, other, viewer] = (await Promise.all(["Olive", "Mae", "Eddie", "Edna", "Vera"].map((n) => env.user(n)))) as [TestPrincipal, TestPrincipal, TestPrincipal, TestPrincipal, TestPrincipal];
    ws = await env.workspace("Studio", { members: { [owner.userId]: "owner", [manager.userId]: "manager", [editor.userId]: "editor", [other.userId]: "editor", [viewer.userId]: "viewer" } });
  });
  afterAll(() => env.close());

  it("advertises team-memory; review is on and there is no folder yet", async () => {
    expect((await env.api(null, "GET", "/capabilities")).json.capabilities).toContain("team-memory");
    expect((await env.api(viewer, "GET", path())).json).toEqual({ review: true, folderId: null });
    expect((await propose(viewer, {})).status).toBe(403);
    expect((await env.api(viewer, "GET", path("/proposals"))).status).toBe(403);
  });

  it("keeps an agent's memory waiting, shows it to its author and to owners and managers, and nothing is written", async () => {
    const made = await propose(editor, {});
    expect(made.status, made.text).toBe(201);
    expect(made.json).toMatchObject({ status: "pending", agent: "Claude Code", authorId: editor.userId, pageId: null, settledBy: null });
    expect(made.json.expiresAt).toBeTruthy();
    expect(await tree(editor)).toEqual([]);

    expect((await list(editor)).map((p) => p.id)).toEqual([made.json.id]);
    expect(await list(other)).toEqual([]);
    for (const who of [owner, manager]) expect((await list(who)).map((p) => p.id)).toEqual([made.json.id]);
    expect((await env.api(other, "GET", path(`/proposals/${made.json.id}`))).status).toBe(404);
    const one = await env.api(manager, "GET", path(`/proposals/${made.json.id}`));
    expect(one.json.markdown).toBe(MEMORY);
    // Another editor cannot settle it.
    expect((await env.api(other, "POST", path(`/proposals/${made.json.id}/apply`))).status).toBe(404);
  });

  it("applies the first one into a new Team memory folder, as a write by whoever applies it, and records who did", async () => {
    const [waiting] = await list(manager, { status: "pending" });
    const applied = await env.api(manager, "POST", path(`/proposals/${waiting!.id}/apply`));
    expect(applied.status, applied.text).toBe(200);
    expect(applied.json).toMatchObject({ status: "applied", authorId: editor.userId, settledBy: manager.userId, settledByName: "Mae" });
    const nodes = await tree(editor);
    const folder = nodes.find((n) => n.title === "Team memory")!;
    expect(folder.parentId).toBeNull();
    const memory = nodes.find((n) => n.id === applied.json.pageId)!;
    expect(memory).toMatchObject({ parentId: folder.id, title: "Blockers first" });
    const page = await env.api(editor, "GET", `/workspaces/${ws}/pages/${memory.id}`);
    expect(page.json.markdown).toBe(MEMORY);
    expect(page.json.metadata.updatedBy).toBe(manager.userId);
    expect((await env.api(editor, "GET", path())).json).toEqual({ review: true, folderId: folder.id });
    // Settled: its text is gone from the proposal, and it cannot be settled again.
    expect((await env.api(editor, "GET", path(`/proposals/${waiting!.id}`))).json.markdown).toBeNull();
    expect((await env.api(editor, "POST", path(`/proposals/${waiting!.id}/decline`))).status).toBe(404);
    // The activity: applied ones, with the agent, the author and who applied them.
    expect(await list(owner, { status: "applied" })).toEqual([expect.objectContaining({ agent: "Claude Code", authorName: "Eddie", settledByName: "Mae" })]);
  });

  it("changes a memory in the folder only from its current version, and never a page outside it", async () => {
    const memory = (await tree(editor)).find((n) => n.title === "Blockers first")!;
    const current = (await env.api(editor, "GET", `/workspaces/${ws}/pages/${memory.id}`)).json.revision.id as string;
    const change = await propose(editor, { pageId: memory.id, baseRevision: current, markdown: MEMORY.replace("weekly", "Friday") });
    expect(change.status, change.text).toBe(201);
    // The page changes meanwhile: applying is a conflict, and the proposal keeps waiting.
    const edited = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${memory.id}`, { headers: { "if-match": `"${current}"` }, json: { title: "Blockers first", markdown: `${MEMORY}\nEdited.\n` } });
    expect(edited.status).toBe(200);
    expect((await env.api(editor, "POST", path(`/proposals/${change.json.id}/apply`))).status).toBe(412);
    expect((await env.api(editor, "GET", path(`/proposals/${change.json.id}`))).json.status).toBe("pending");
    // Declined by its own author: nothing written.
    expect((await env.api(editor, "POST", path(`/proposals/${change.json.id}/decline`))).json).toMatchObject({ status: "declined", settledBy: editor.userId });
    expect((await env.api(editor, "GET", `/workspaces/${ws}/pages/${memory.id}`)).json.markdown).toContain("Edited.");

    const plan = await createPage(env, owner, ws, { title: "Plan" });
    expect((await propose(editor, { pageId: plan.id, baseRevision: plan.revisionId })).status).toBe(404);
    expect((await propose(editor, { pageId: memory.id, baseRevision: current })).status).toBe(412);
    expect((await propose(editor, { pageId: memory.id })).status).toBe(400);
    expect((await propose(editor, { markdown: "x".repeat(17 * 1024) })).status).toBe(413);
  });

  it("with review off (owners and managers choose), applies a memory at once as the author's write", async () => {
    expect((await env.api(editor, "PUT", path("/review"), { json: { review: false } })).status).toBe(403);
    expect((await env.api(manager, "PUT", path("/review"), { json: { review: false } })).json.review).toBe(false);
    const made = await propose(other, { title: "Standup at ten", markdown: "---\nkind: work\n---\nStandup moved to 10:00.\n" });
    expect(made.status, made.text).toBe(200);
    expect(made.json).toMatchObject({ status: "applied", authorId: other.userId, settledBy: other.userId });
    expect((await tree(other)).find((n) => n.id === made.json.pageId)?.title).toBe("Standup at ten");
    expect((await env.api(owner, "PUT", path("/review"), { json: { review: true } })).json.review).toBe(true);
  });

  it("keeps Team memory to those who can see it (ADR-0042)", async () => {
    const folder = (await env.api(owner, "GET", path())).json.folderId as string;
    const team = await env.api(owner, "POST", `/workspaces/${ws}/teams`, { json: { name: "Leads" } });
    expect(team.status, team.text).toBe(201);
    await env.api(owner, "PUT", `/workspaces/${ws}/teams/${team.json.id}/members/${owner.userId}`);
    const waiting = await propose(owner, { title: "Leads only" });
    const limited = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${folder}/visibility`, { json: { teamIds: [team.json.id] } });
    expect(limited.status, limited.text).toBe(200);
    expect((await env.api(editor, "GET", path())).json.folderId).toBeNull();
    expect((await propose(editor, {})).status).toBe(201);
    const [mine] = await list(editor, { status: "pending" });
    expect((await env.api(editor, "POST", path(`/proposals/${mine!.id}/apply`))).status).toBe(404);
    // Its author still sees it; owners and managers see every page (ADR-0042) and can apply it.
    expect(mine!.authorId).toBe(editor.userId);
    expect((await list(manager, { status: "pending" })).map((p) => p.id)).toEqual(expect.arrayContaining([waiting.json.id, mine!.id]));
    expect((await env.api(manager, "POST", path(`/proposals/${waiting.json.id}/apply`))).status).toBe(200);
    await env.api(owner, "PUT", `/workspaces/${ws}/pages/${folder}/visibility`, { json: { teamIds: null } });
  });

  it("lets a pending memory expire after 30 days", async () => {
    const made = await propose(other, { title: "Old" });
    await env.db.query("UPDATE memory_proposals SET created_at = now() - interval '31 days' WHERE id = $1", [made.json.id]);
    expect((await env.api(other, "GET", path(`/proposals/${made.json.id}`))).json).toMatchObject({ status: "expired", markdown: null, expiresAt: null });
    expect((await list(other, { status: "expired" })).map((p) => p.id)).toEqual([made.json.id]);
    expect((await env.api(other, "POST", path(`/proposals/${made.json.id}/apply`))).status).toBe(404);
  });
});
