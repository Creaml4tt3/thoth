/**
 * The Trash (ADR-0043, capability `trash`) against the real server and PostgreSQL: who sees and restores what, a
 * folder restored with what was deleted below it, deleting for good, and the 30-day purge.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMaintenance } from "../src/maintenance.ts";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, uuid } from "./support.ts";

const FOLDER = "---\nthoth_kind: folder\n---\n";

describe("trash", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let manager: TestPrincipal;
  let editor: TestPrincipal;
  let other: TestPrincipal;
  let viewer: TestPrincipal;
  let ws: string;

  const del = async (who: TestPrincipal, page: { id: string; revisionId: string }) => {
    const res = await env.api(who, "DELETE", `/workspaces/${ws}/pages/${page.id}`, { headers: { "if-match": `"${page.revisionId}"` } });
    expect(res.status, res.text).toBe(204);
  };
  const trash = async (who: TestPrincipal) => (await env.api(who, "GET", `/workspaces/${ws}/trash`)).json.items as { pageId: string; title: string; pagesBelow: number; deletedBy: string; kind: string | null }[];
  const treeIds = async (who: TestPrincipal) => ((await env.api(who, "GET", `/workspaces/${ws}/tree`)).json.items as { id: string }[]).map((n) => n.id);

  beforeAll(async () => {
    env = await startTestEnv();
    [owner, manager, editor, other, viewer] = (await Promise.all(["Olive", "Mae", "Eddie", "Edna", "Vera"].map((n) => env.user(n)))) as [TestPrincipal, TestPrincipal, TestPrincipal, TestPrincipal, TestPrincipal];
    ws = await env.workspace("Studio", { members: { [owner.userId]: "owner", [manager.userId]: "manager", [editor.userId]: "editor", [other.userId]: "editor", [viewer.userId]: "viewer" } });
  });
  afterAll(() => env.close());

  it("advertises trash; viewers have none", async () => {
    expect((await env.api(null, "GET", "/capabilities")).json.capabilities).toContain("trash");
    expect((await env.api(viewer, "GET", `/workspaces/${ws}/trash`)).status).toBe(403);
  });

  it("keeps a deleted folder as one item and restores it with what was deleted below it", async () => {
    const folder = await createPage(env, editor, ws, { title: "Plans", markdown: FOLDER });
    const child = await createPage(env, editor, ws, { title: "Q4", parentId: folder.id });
    const cursor = (await env.api(owner, "GET", `/workspaces/${ws}/tree`)).json.changeCursor;
    await del(editor, child);
    await del(editor, folder);
    expect(await trash(editor)).toMatchObject([{ pageId: folder.id, title: "Plans", kind: "folder", pagesBelow: 1, deletedBy: editor.userId }]);
    // The other editor sees none of it; the manager and the owner see it all.
    expect(await trash(other)).toEqual([]);
    expect((await trash(manager)).map((i) => i.pageId)).toEqual([folder.id]);
    // Only an item can be restored, not a page inside it; another editor gets 404.
    expect((await env.api(editor, "POST", `/workspaces/${ws}/trash/${child.id}/restore`)).status).toBe(404);
    expect((await env.api(other, "POST", `/workspaces/${ws}/trash/${folder.id}/restore`)).status).toBe(404);
    const restored = await env.api(editor, "POST", `/workspaces/${ws}/trash/${folder.id}/restore`);
    expect([restored.status, restored.json.pageIds]).toEqual([200, [folder.id, child.id]]);
    expect(await treeIds(owner)).toEqual(expect.arrayContaining([folder.id, child.id]));
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${child.id}`)).json.metadata.parentId).toBe(folder.id);
    const feed = await env.api(owner, "GET", `/workspaces/${ws}/changes`, { query: { cursor } });
    expect(feed.json.entries.slice(-2).map((e: { kind: string; pageId: string }) => [e.kind, e.pageId])).toEqual([["page.created", folder.id], ["page.created", child.id]]);
    expect(await trash(editor)).toEqual([]);
  });

  it("restores only what an editor deleted; the rest stays in the Trash", async () => {
    const folder = await createPage(env, editor, ws, { title: "Mixed", markdown: FOLDER });
    const theirs = await createPage(env, other, ws, { title: "Theirs", parentId: folder.id });
    await del(other, theirs);
    await del(editor, folder);
    const restored = await env.api(editor, "POST", `/workspaces/${ws}/trash/${folder.id}/restore`);
    expect(restored.json.pageIds).toEqual([folder.id]);
    expect((await trash(other)).map((i) => i.pageId)).toEqual([theirs.id]);
    // The manager restores anyone's.
    expect((await env.api(manager, "POST", `/workspaces/${ws}/trash/${theirs.id}/restore`)).json.pageIds).toEqual([theirs.id]);
  });

  it("deletes for good: owners and managers only, with revisions, feed entries and share links", async () => {
    const page = await createPage(env, editor, ws, { title: "Scrap" });
    const share = await env.api(editor, "POST", `/workspaces/${ws}/pages/${page.id}/share-links`, { json: {} });
    expect(share.status).toBe(201);
    await del(editor, page);
    expect((await env.api(editor, "DELETE", `/workspaces/${ws}/trash/${page.id}`)).status).toBe(403);
    expect((await env.api(manager, "DELETE", `/workspaces/${ws}/trash/${page.id}`)).status).toBe(204);
    expect((await env.api(manager, "DELETE", `/workspaces/${ws}/trash/${page.id}`)).status).toBe(404);
    for (const table of ["pages", "page_revisions", "changes", "share_links"]) {
      const column = table === "pages" ? "id" : "page_id";
      expect((await env.db.query(`SELECT 1 FROM ${table} WHERE workspace_id = $1 AND ${column} = $2`, [ws, page.id])).rowCount, table).toBe(0);
    }
    // The feed read from the start still ends at the head, past the removed entries.
    let cursor: string | undefined;
    for (let i = 0; i < 100; i++) {
      const res = await env.api(owner, "GET", `/workspaces/${ws}/changes`, { query: cursor ? { cursor, limit: "2" } : { limit: "2" } });
      cursor = res.json.cursor;
      if (!res.json.hasMore) break;
    }
    expect(cursor).toBe((await env.api(owner, "GET", `/workspaces/${ws}/tree`)).json.changeCursor);
  });

  it("moves a page added below a deleted folder out of it, still limited, when the folder goes for good", async () => {
    const team = (await env.api(owner, "POST", `/workspaces/${ws}/teams`, { json: { name: "Finance" } })).json.id as string;
    await env.api(owner, "PUT", `/workspaces/${ws}/teams/${team}/members/${other.userId}`);
    const folder = await createPage(env, owner, ws, { title: "Payroll", markdown: FOLDER });
    await env.api(owner, "PUT", `/workspaces/${ws}/pages/${folder.id}/visibility`, { json: { teamIds: [team] } });
    const late = await createPage(env, other, ws, { title: "Added late", parentId: folder.id });
    // The folder alone is deleted (as a client racing a new page would), then deleted for good.
    await del(owner, folder);
    expect((await env.api(editor, "GET", `/workspaces/${ws}/pages/${late.id}`)).status).toBe(404);
    expect((await env.api(owner, "DELETE", `/workspaces/${ws}/trash/${folder.id}`)).status).toBe(204);
    const moved = await env.api(other, "GET", `/workspaces/${ws}/pages/${late.id}`);
    expect([moved.status, moved.json.metadata.parentId]).toEqual([200, null]);
    expect((await env.api(editor, "GET", `/workspaces/${ws}/pages/${late.id}`)).status).toBe(404);
  });

  it("brings a page back at the top level when its folder is gone for good", async () => {
    const folder = await createPage(env, owner, ws, { title: "Old", markdown: FOLDER });
    const child = await createPage(env, editor, ws, { title: "Kept", parentId: folder.id });
    await del(editor, child);
    await del(owner, folder);
    // As if the folder had gone for good while the child was its own item.
    await env.db.query("UPDATE pages SET parent_id = $3 WHERE workspace_id = $1 AND id = $2", [ws, child.id, uuid()]);
    const restored = await env.api(editor, "POST", `/workspaces/${ws}/trash/${child.id}/restore`);
    expect(restored.status, restored.text).toBe(200);
    expect((await env.api(editor, "GET", `/workspaces/${ws}/pages/${child.id}`)).json.metadata.parentId).toBeNull();
  });

  it("is purged after 30 days by the maintenance", async () => {
    const page = await createPage(env, editor, ws, { title: "Ancient" });
    await del(editor, page);
    await env.db.query("UPDATE pages SET deleted_at = now() - interval '31 days' WHERE workspace_id = $1 AND id = $2", [ws, page.id]);
    expect((await trash(owner)).map((i) => i.pageId)).not.toContain(page.id);
    const result = await runMaintenance(env.db, { revisionRetentionDays: undefined, blobs: env.server.deps.blobs });
    expect(result.trashPagesPurged).toBeGreaterThanOrEqual(1);
    expect((await env.db.query("SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2", [ws, page.id])).rowCount).toBe(0);
  });
});
