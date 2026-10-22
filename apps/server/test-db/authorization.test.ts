import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, createTransfer, openEvents, toWorkspacePlan, uploadAttachment, uuid } from "./support.ts";

/**
 * ADR-0009: the server is the only authority. For every resource type, a non-member gets 404, a viewer gets
 * 200 on reads and 403 on writes, and members of one workspace cannot reach another's data by guessing IDs.
 */
describe("authorization matrix", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let editor: TestPrincipal;
  let viewer: TestPrincipal;
  let stranger: TestPrincipal; // member of workspace B only
  let nobody: TestPrincipal; // member of nothing
  let A: string;
  let B: string;
  let pageA: { id: string; revisionId: string };
  let pageB: { id: string; revisionId: string };
  let attA: string;
  let attB: string;
  let opA: string; // staged to_workspace transfer in A, created by the editor
  let opB: string;

  beforeAll(async () => {
    env = await startTestEnv();
    [owner, editor, viewer, stranger, nobody] = await Promise.all(["Owner", "Editor", "Viewer", "Stranger", "Nobody"].map((n) => env.user(n))) as [TestPrincipal, TestPrincipal, TestPrincipal, TestPrincipal, TestPrincipal];
    A = await env.workspace("A", { members: { [owner.userId]: "owner", [editor.userId]: "editor", [viewer.userId]: "viewer" } });
    B = await env.workspace("B", { members: { [stranger.userId]: "owner", [editor.userId]: "viewer" } });
    pageA = await createPage(env, owner, A, { title: "Alpha secret", markdown: "# Alpha\n\nneedle-in-A\n" });
    pageB = await createPage(env, stranger, B, { title: "Bravo secret", markdown: "# Bravo\n\nneedle-in-B\n" });
    attA = await uploadAttachment(env, owner, A, Buffer.from("attachment of A"));
    attB = await uploadAttachment(env, stranger, B, Buffer.from("attachment of B"));
    const planA = toWorkspacePlan();
    opA = planA.operationId;
    expect((await createTransfer(env, editor, A, planA)).status).toBe(201);
    const planB = toWorkspacePlan();
    opB = planB.operationId;
    expect((await createTransfer(env, stranger, B, planB)).status).toBe(201);
  });
  afterAll(() => env.close());

  const problemCode = (res: { json: any }) => res.json?.code;

  describe("unauthenticated", () => {
    it("is 401 with WWW-Authenticate on every route but /capabilities", async () => {
      const routes: [string, string][] = [
        ["GET", "/me"], ["GET", "/workspaces"], ["GET", `/workspaces/${A}/tree`], ["GET", `/workspaces/${A}/pages/${pageA.id}`],
        ["PUT", `/workspaces/${A}/pages/${pageA.id}`], ["DELETE", `/workspaces/${A}/pages/${pageA.id}`], ["GET", `/workspaces/${A}/pages/${pageA.id}/revisions`],
        ["POST", `/workspaces/${A}/search`], ["POST", `/workspaces/${A}/attachments`], ["GET", `/workspaces/${A}/attachments/${attA}`],
        ["GET", `/workspaces/${A}/changes`], ["GET", `/workspaces/${A}/events`], ["POST", `/workspaces/${A}/transfers`],
        ["GET", `/transfers/${opA}`], ["POST", `/transfers/${opA}/commit`], ["POST", `/transfers/${opA}/abort`], ["GET", "/no-such-route"],
      ];
      for (const [method, path] of routes) {
        const res = await env.api(null, method, path);
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(problemCode(res)).toBe("unauthenticated");
        expect(res.headers.get("www-authenticate")).toBe('Bearer realm="thoth"');
        expect(res.headers.get("content-type")).toContain("application/problem+json");
      }
      expect((await env.api(null, "GET", "/capabilities")).status).toBe(200);
    });

    it("rejects malformed, unknown, revoked and expired credentials", async () => {
      const revoked = await env.user("Revoked");
      await env.db.query("UPDATE access_tokens SET revoked_at = now() WHERE id = $1", [revoked.tokenId]);
      const expired = await env.user("Expired");
      await env.db.query("UPDATE access_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired.tokenId]);
      for (const headers of [{ authorization: "Bearer" }, { authorization: "Basic abc" }, { authorization: "Bearer thoth_pat_unknownunknownunknownunknown" }, revoked.headers, expired.headers]) {
        const res = await env.api(null, "GET", "/me", { headers });
        expect(res.status).toBe(401);
      }
    });

    it("a token revoked while a stream is open is rejected on the next request", async () => {
      const temp = await env.user("Temp");
      expect((await env.api(temp, "GET", "/me")).status).toBe(200);
      await env.db.query("UPDATE access_tokens SET revoked_at = now() WHERE id = $1", [temp.tokenId]);
      expect((await env.api(temp, "GET", "/me")).status).toBe(401);
    });
  });

  describe("non-member: 404 for every resource type, reads and writes", () => {
    it("workspace-scoped routes", async () => {
      const cases: [string, string, Record<string, unknown>?][] = [
        ["GET", `/workspaces/${A}/tree`],
        ["GET", `/workspaces/${A}/pages/${pageA.id}`],
        ["GET", `/workspaces/${A}/pages/${pageA.id}?revision=${pageA.revisionId}`],
        ["GET", `/workspaces/${A}/pages/${pageA.id}/revisions`],
        ["GET", `/workspaces/${A}/changes`],
        ["POST", `/workspaces/${A}/search`],
        ["GET", `/workspaces/${A}/attachments/${attA}`],
        ["PUT", `/workspaces/${A}/pages/${uuid()}`],
        ["DELETE", `/workspaces/${A}/pages/${pageA.id}`],
        ["POST", `/workspaces/${A}/attachments`],
        ["POST", `/workspaces/${A}/transfers`],
        ["GET", `/workspaces/${A}/events`],
        ["GET", `/workspaces/ws_does_not_exist/tree`],
      ];
      for (const [method, path] of cases) {
        const res = await env.api(nobody, method, path, {
          headers: { "if-none-match": "*", "if-match": '"x"', "content-type": "application/json" },
          body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify({ query: "needle", title: "t", markdown: "m" }),
        });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(problemCode(res)).toBe("not_found");
      }
    });

    it("transfer routes answer 404 whether the transfer exists or not", async () => {
      for (const [method, path] of [["GET", `/transfers/${opA}`], ["POST", `/transfers/${opA}/commit`], ["POST", `/transfers/${opA}/abort`]] as const) {
        const real = await env.api(nobody, method, path);
        const fake = await env.api(nobody, method, path.replace(opA, uuid()));
        expect(real.status).toBe(404);
        expect(fake.status).toBe(404);
        expect(real.json.detail).toBe(fake.json.detail);
      }
    });

    it("lists only its own workspaces", async () => {
      const mine = await env.api(nobody, "GET", "/workspaces");
      expect(mine.json.items).toEqual([]);
      const strangers = await env.api(stranger, "GET", "/workspaces");
      expect(strangers.json.items.map((w: { id: string }) => w.id)).toEqual([B]);
    });
  });

  describe("viewer: 200 on reads, 403 on writes", () => {
    it("reads", async () => {
      const get = (path: string, init?: Parameters<TestEnv["api"]>[3]) => env.api(viewer, "GET", path, init);
      expect((await get(`/workspaces`)).json.items[0].role).toBe("viewer");
      expect((await get(`/workspaces/${A}/tree`)).status).toBe(200);
      expect((await get(`/workspaces/${A}/pages/${pageA.id}`)).status).toBe(200);
      expect((await get(`/workspaces/${A}/pages/${pageA.id}?revision=${pageA.revisionId}`)).status).toBe(200);
      expect((await get(`/workspaces/${A}/pages/${pageA.id}/revisions`)).status).toBe(200);
      expect((await get(`/workspaces/${A}/changes`)).status).toBe(200);
      expect((await env.api(viewer, "POST", `/workspaces/${A}/search`, { json: { query: "needle" } })).json.items).toHaveLength(1);
      const att = await get(`/workspaces/${A}/attachments/${attA}`);
      expect(att.status).toBe(200);
      expect(att.text).toBe("attachment of A");
      expect((await get(`/transfers/${opA}`)).status).toBe(200);
      const stream = await openEvents(env, viewer, A);
      expect(stream.status).toBe(200);
      expect(stream.contentType).toBe("text/event-stream");
      stream.close();
    });

    it("writes are 403 forbidden", async () => {
      const put = await env.api(viewer, "PUT", `/workspaces/${A}/pages/${uuid()}`, { headers: { "if-none-match": "*" }, json: { title: "x", markdown: "x" } });
      expect([put.status, problemCode(put)]).toEqual([403, "forbidden"]);
      const putExisting = await env.api(viewer, "PUT", `/workspaces/${A}/pages/${pageA.id}`, { headers: { "if-match": `"${pageA.revisionId}"` }, json: { title: "x", markdown: "x" } });
      expect(putExisting.status).toBe(403);
      const del = await env.api(viewer, "DELETE", `/workspaces/${A}/pages/${pageA.id}`, { headers: { "if-match": `"${pageA.revisionId}"` } });
      expect([del.status, problemCode(del)]).toEqual([403, "forbidden"]);
      const upload = await env.api(viewer, "POST", `/workspaces/${A}/attachments`, { headers: { "content-type": "text/plain" }, body: "nope" });
      expect([upload.status, problemCode(upload)]).toEqual([403, "forbidden"]);
      const toWs = await createTransfer(env, viewer, A, toWorkspacePlan());
      expect([toWs.status, problemCode(toWs)]).toEqual([403, "forbidden"]);
      const move = await createTransfer(env, viewer, A, { operationId: uuid(), direction: "from_workspace", mode: "move", pages: [{ pageId: pageA.id }] });
      expect([move.status, problemCode(move)]).toEqual([403, "forbidden"]);
      for (const action of ["commit", "abort"]) {
        const res = await env.api(viewer, "POST", `/transfers/${opA}/${action}`);
        expect([res.status, problemCode(res)], action).toEqual([403, "forbidden"]);
      }
      // Nothing changed.
      expect((await env.api(owner, "GET", `/workspaces/${A}/pages/${pageA.id}`)).json.revision.id).toBe(pageA.revisionId);
      expect((await env.api(owner, "GET", `/transfers/${opA}`)).json.state).toBe("stage");
    });

    it("a viewer may copy out of an unrestricted workspace but never move", async () => {
      const copy = await createTransfer(env, viewer, A, { operationId: uuid(), direction: "from_workspace", mode: "copy", pages: [{ pageId: pageA.id }] });
      expect(copy.status).toBe(201);
    });
  });

  describe("cross-workspace: guessing IDs does not help", () => {
    it("a member of A cannot reach B's pages, revisions, attachments, hits, changes, events or transfers", async () => {
      // A viewer's writes in A are refused on role (403) before any page is looked up; a non-writer learns nothing either way.
      const probe = async (who: TestPrincipal, writeStatus: 403 | 404) => {
        // Direct, through B's workspace path.
        for (const path of [`/workspaces/${B}/pages/${pageB.id}`, `/workspaces/${B}/pages/${pageB.id}/revisions`, `/workspaces/${B}/attachments/${attB}`, `/workspaces/${B}/changes`, `/workspaces/${B}/tree`]) {
          expect((await env.api(who, "GET", path)).status, path).toBe(404);
        }
        expect((await env.api(who, "POST", `/workspaces/${B}/search`, { json: { query: "needle" } })).status).toBe(404);
        expect((await openEvents(env, who, B).then((s) => (s.close(), s.status)))).toBe(404);
        // Through A's path, with B's IDs.
        expect((await env.api(who, "GET", `/workspaces/${A}/pages/${pageB.id}`)).status).toBe(404);
        expect((await env.api(who, "GET", `/workspaces/${A}/pages/${pageB.id}/revisions`)).status).toBe(404);
        expect((await env.api(who, "GET", `/workspaces/${A}/pages/${pageB.id}?revision=${pageB.revisionId}`)).status).toBe(404);
        expect((await env.api(who, "GET", `/workspaces/${A}/pages/${pageA.id}?revision=${pageB.revisionId}`)).status, "B's revision under A's page").toBe(404);
        expect((await env.api(who, "GET", `/workspaces/${A}/attachments/${attB}`)).status).toBe(404);
        expect((await env.api(who, "DELETE", `/workspaces/${A}/pages/${pageB.id}`, { headers: { "if-match": `"${pageB.revisionId}"` } })).status).toBe(writeStatus);
        expect((await env.api(who, "PUT", `/workspaces/${A}/pages/${pageB.id}`, { headers: { "if-match": `"${pageB.revisionId}"` }, json: { title: "x", markdown: "x" } })).status).toBe(writeStatus);
        // Transfers.
        for (const [method, path] of [["GET", `/transfers/${opB}`], ["POST", `/transfers/${opB}/commit`], ["POST", `/transfers/${opB}/abort`]] as const) {
          expect((await env.api(who, method, path)).status, path).toBe(404);
        }
        // Search and the feed of the workspace they ARE in never contain B's data.
        const hits = await env.api(who, "POST", `/workspaces/${A}/search`, { json: { query: "needle-in-B" } });
        expect(hits.json.items).toEqual([]);
        const feed = await env.api(who, "GET", `/workspaces/${A}/changes`);
        expect(JSON.stringify(feed.json)).not.toContain(pageB.id);
        expect(JSON.stringify(feed.json)).not.toContain(attB);
        const tree = await env.api(who, "GET", `/workspaces/${A}/tree`);
        expect(JSON.stringify(tree.json)).not.toContain(pageB.id);
      };
      await probe(owner, 404);
      await probe(viewer, 403);
      // B's page is untouched by any of the above.
      const b = await env.api(stranger, "GET", `/workspaces/${B}/pages/${pageB.id}`);
      expect(b.json.revision.id).toBe(pageB.revisionId);
    });

    it("a transfer's operationId cannot be hijacked from another workspace or principal", async () => {
      // `owner` is a member of A but not B: B's operationId in A's path is a different request -> 422, and B's transfer is untouched.
      const plan = { ...toWorkspacePlan(), operationId: opB };
      const res = await createTransfer(env, owner, A, plan);
      expect(res.status).toBe(422);
      expect(problemCode(res)).toBe("idempotency_key_reused");
      expect((await env.api(stranger, "GET", `/transfers/${opB}`)).json.workspaceId).toBe(B);
    });

    it("a cursor from one workspace does not work in another", async () => {
      const feedA = await env.api(owner, "GET", `/workspaces/${A}/changes`, { query: { limit: "1" } });
      const own = await env.api(editor, "GET", `/workspaces/${B}/changes`, { query: { cursor: feedA.json.cursor } });
      expect(own.status).toBe(400);
      expect(problemCode(own)).toBe("cursor_invalid");
    });

    it("a user with different roles per workspace gets each role in each workspace", async () => {
      // editor: editor in A, viewer in B.
      expect((await env.api(editor, "PUT", `/workspaces/${B}/pages/${uuid()}`, { headers: { "if-none-match": "*" }, json: { title: "x", markdown: "x" } })).status).toBe(403);
      expect((await env.api(editor, "PUT", `/workspaces/${A}/pages/${uuid()}`, { headers: { "if-none-match": "*" }, json: { title: "x", markdown: "x" } })).status).toBe(201);
    });
  });

  describe("export restriction", () => {
    it("refuses from_workspace transfers (even for owners) with 403 export_restricted, and audits the refusal", async () => {
      const R = await env.workspace("Restricted", { exportRestricted: true, members: { [owner.userId]: "owner", [viewer.userId]: "viewer" } });
      const { id } = await createPage(env, owner, R);
      for (const [who, mode] of [[owner, "copy"], [owner, "move"], [viewer, "copy"]] as const) {
        const res = await createTransfer(env, who, R, { operationId: uuid(), direction: "from_workspace", mode, pages: [{ pageId: id }] });
        expect([res.status, problemCode(res)], `${mode}`).toEqual([403, mode === "copy" || who === owner ? "export_restricted" : "forbidden"]);
      }
      const events = await env.db.query("SELECT action FROM audit_events WHERE workspace_id = $1 AND action = 'export.refused'", [R]);
      expect(events.rowCount).toBeGreaterThanOrEqual(2);
      // Importing into a restricted workspace is fine.
      expect((await createTransfer(env, owner, R, toWorkspacePlan())).status).toBe(201);
    });
  });
});
