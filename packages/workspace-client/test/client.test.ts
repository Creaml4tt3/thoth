import { describe, expect, it } from "vitest";
import { isStableId, newStableId } from "@thoth/domain";
import { problem } from "@thoth/workspace-protocol";
import { ProblemError, ProtocolError, QuotaExceeded, RevisionConflict, WorkspaceClient, type SendRequest, type SendResponse } from "../src/index.ts";

const T = "2026-10-23T10:00:00Z";
const HASH = "0".repeat(64);
const PAGE = newStableId();

const revision = (id: string, title = "Plan") => ({ id, pageId: PAGE, parentId: null, createdAt: T, authorId: "u1", title, size: 7, contentHash: HASH });
const page = (rev = "r1", markdown = "# Plan\n") => ({
  id: PAGE,
  markdown,
  revision: revision(rev),
  metadata: { workspaceId: "ws1", parentId: null, title: "Plan", createdAt: T, createdBy: "u1", updatedAt: T, updatedBy: "u1" },
});
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}): SendResponse => ({ status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** A scripted `send`: records every request and answers from `respond`. */
function fake(respond: (req: SendRequest, n: number) => SendResponse) {
  const requests: SendRequest[] = [];
  const send = async (req: SendRequest) => {
    requests.push(req);
    return respond(req, requests.length - 1);
  };
  return { requests, client: new WorkspaceClient(send) };
}

const bodyOf = (req: SendRequest) => JSON.parse(new TextDecoder().decode(req.body));

describe("reads", () => {
  it("prefixes /api/v1 and validates capabilities", async () => {
    const { client, requests } = fake(() => ok({ protocolVersion: "1.0", capabilities: ["search"], limits: { maxPagesPerWorkspace: 200 } }));
    const caps = await client.getCapabilities();
    expect(caps.limits?.maxPagesPerWorkspace).toBe(200);
    expect(requests[0]).toMatchObject({ method: "GET", path: "/api/v1/capabilities" });
  });

  it("follows workspace pagination to the end", async () => {
    const ws = (id: string) => ({ id, kind: "workspace", name: id, role: "editor", exportRestricted: false, memberCount: 1, createdAt: T });
    const { client, requests } = fake((_, n) => ok(n === 0 ? { items: [ws("a")], nextCursor: "c1" } : { items: [ws("b")], nextCursor: null }));
    expect((await client.listWorkspaces()).map((w) => w.id)).toEqual(["a", "b"]);
    expect(requests[0]!.query).toEqual({});
    expect(requests[1]!.query).toEqual({ cursor: "c1" });
  });

  it("reads the whole tree and keeps the first traversal's change cursor", async () => {
    const node = (id: string) => ({ id, parentId: null, title: id, revisionId: "r1", updatedAt: T });
    const a = newStableId();
    const b = newStableId();
    const { client, requests } = fake((_, n) => ok(n === 0 ? { workspaceId: "ws1", items: [node(a)], nextCursor: "n1", changeCursor: "base" } : { workspaceId: "ws1", items: [node(b)], nextCursor: null, changeCursor: "base" }));
    const tree = await client.getTree("ws1");
    expect(tree.nodes.map((x) => x.id)).toEqual([a, b]);
    expect(tree.changeCursor).toBe("base");
    expect(requests[0]!.path).toBe("/api/v1/workspaces/ws1/tree");
  });

  it("reads a page and a specific revision", async () => {
    const { client, requests } = fake(() => ok(page()));
    expect((await client.getPage("ws1", PAGE)).markdown).toBe("# Plan\n");
    await client.getPage("ws1", PAGE, { revision: "r0" });
    expect(requests[1]!.query).toEqual({ revision: "r0" });
  });

  it("lists changes from a cursor", async () => {
    const { client, requests } = fake(() => ok({ entries: [{ id: "e1", kind: "page.updated", occurredAt: T, actorId: "u2", pageId: PAGE, revisionId: "r2" }], cursor: "c2", hasMore: false }));
    const changes = await client.listChanges("ws1", "c1", { limit: 50 });
    expect(changes.entries[0]!.revisionId).toBe("r2");
    expect(requests[0]!.query).toEqual({ cursor: "c1", limit: "50" });
  });

  it("searches with a JSON body", async () => {
    const { client, requests } = fake(() => ok({ items: [{ pageId: PAGE, title: "Plan", revisionId: "r1", snippet: "…plan…" }], nextCursor: null }));
    expect((await client.search("ws1", { query: "plan" })).items).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", path: "/api/v1/workspaces/ws1/search", headers: { "content-type": "application/json" } });
    expect(bodyOf(requests[0]!)).toEqual({ query: "plan" });
  });

  it("refuses a response that does not match the protocol", async () => {
    const { client } = fake(() => ok({ id: 42 }));
    await expect(client.getMe()).rejects.toBeInstanceOf(ProtocolError);
    const html = fake(() => ({ status: 200, headers: {}, body: "<html>" }));
    await expect(html.client.getMe()).rejects.toThrow(/not JSON/);
  });
});

describe("writes", () => {
  it("updates with If-Match carrying the revision's entity tag", async () => {
    const { client, requests } = fake(() => ok(page("r2"), 200, { etag: '"r2"' }));
    const written = await client.putPage("ws1", PAGE, { title: "Plan", markdown: "# Plan\nmore\n" }, "r1");
    expect(written.revision.id).toBe("r2");
    expect(requests[0]!.headers).toMatchObject({ "if-match": '"r1"', "content-type": "application/json" });
    expect(requests[0]!.headers).not.toHaveProperty("if-none-match");
    expect(bodyOf(requests[0]!)).toEqual({ title: "Plan", markdown: "# Plan\nmore\n" });
  });

  it("creates with If-None-Match: * and a fresh UUIDv7", async () => {
    const { client, requests } = fake(() => ok(page(), 201));
    await client.createPage("ws1", { title: "New", markdown: "# New\n" }, { idempotencyKey: "k1" });
    const id = requests[0]!.path.split("/").pop()!;
    expect(isStableId(id)).toBe(true);
    expect(requests[0]!.headers).toMatchObject({ "if-none-match": "*", "idempotency-key": "k1" });
    expect(requests[0]!.headers).not.toHaveProperty("if-match");
  });

  it("deletes with If-Match and accepts 204", async () => {
    const { client, requests } = fake(() => ({ status: 204, headers: {}, body: "" }));
    await client.deletePage("ws1", PAGE, "r3");
    expect(requests[0]).toMatchObject({ method: "DELETE", headers: { "if-match": '"r3"' } });
  });

  it("moves a page with If-Match and returns its tree node; a stale revision is a RevisionConflict", async () => {
    const parent = newStableId();
    const node = { id: PAGE, parentId: parent, title: "Plan", position: "a1", revisionId: "r3", updatedAt: T };
    const { client, requests } = fake((_, n) => (n === 0 ? ok(node, 200, { etag: '"r3"' }) : ok({ ...problem("revision_conflict"), currentRevision: revision("r4") }, 412)));
    expect(await client.movePage("ws1", PAGE, { parentId: parent, position: "a1" }, "r3", { idempotencyKey: "m1" })).toEqual(node);
    expect(requests[0]).toMatchObject({ method: "POST", path: `/api/v1/workspaces/ws1/pages/${PAGE}/move`, headers: { "if-match": '"r3"', "idempotency-key": "m1", "content-type": "application/json" } });
    expect(bodyOf(requests[0]!)).toEqual({ parentId: parent, position: "a1" });
    await expect(client.movePage("ws1", PAGE, { position: null }, "r3")).rejects.toBeInstanceOf(RevisionConflict);
  });
});

describe("errors", () => {
  it("turns 412 into RevisionConflict with the current revision", async () => {
    const body = { ...problem("revision_conflict", { detail: "stale" }), currentRevision: revision("r9", "Plan (theirs)") };
    const { client } = fake(() => ok(body, 412));
    const error = await client.putPage("ws1", PAGE, { title: "Plan", markdown: "x" }, "r1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RevisionConflict);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as RevisionConflict).currentRevision.id).toBe("r9");
    expect((error as RevisionConflict).status).toBe(412);
    expect((error as RevisionConflict).code).toBe("revision_conflict");
  });

  it("keeps quota_exceeded limit info and its message", async () => {
    const body = { ...problem("quota_exceeded", { detail: "this workspace is limited to 200 pages (200 in use); delete pages to make room" }), quota: "pagesPerWorkspace", limit: 200, current: 200 };
    const { client } = fake(() => ok(body, 409));
    const error = (await client.createPage("ws1", { title: "x", markdown: "" }).catch((e: unknown) => e)) as QuotaExceeded;
    expect(error).toBeInstanceOf(QuotaExceeded);
    expect([error.quota, error.limit, error.current]).toEqual(["pagesPerWorkspace", 200, 200]);
    expect(error.message).toBe("This workspace is limited to 200 pages (200 in use); delete pages to make room.");
  });

  it("describes a server-wide quota without numbers", async () => {
    const { client } = fake(() => ok({ ...problem("quota_exceeded"), quota: "accounts" }, 409));
    const error = (await client.getMe().catch((e: unknown) => e)) as QuotaExceeded;
    expect(error.limit).toBeUndefined();
    expect(error.message).toMatch(/reached one of its limits/);
  });

  it("carries code, status and body for other problems", async () => {
    const { client } = fake(() => ok(problem("forbidden", { detail: "viewers cannot write" }), 403));
    const error = (await client.putPage("ws1", PAGE, { title: "x", markdown: "" }, "r1").catch((e: unknown) => e)) as ProblemError;
    expect([error.code, error.status, error.problem.detail]).toEqual(["forbidden", 403, "viewers cannot write"]);
    expect(error.message).toMatch(/role/);
  });

  it("maps a bare error status with no problem body", async () => {
    const { client } = fake(() => ({ status: 401, headers: {}, body: "" }));
    const error = (await client.getMe().catch((e: unknown) => e)) as ProblemError;
    expect([error.code, error.status]).toEqual(["unauthenticated", 401]);
    expect(error.message).toMatch(/signed out/);
  });

  it("an unparseable 412 is still a problem, not a crash", async () => {
    const { client } = fake(() => ({ status: 412, headers: {}, body: "nope" }));
    const error = (await client.putPage("ws1", PAGE, { title: "x", markdown: "" }, "r1").catch((e: unknown) => e)) as ProblemError;
    expect(error).toBeInstanceOf(ProblemError);
    expect(error).not.toBeInstanceOf(RevisionConflict);
    expect(error.status).toBe(412);
  });
});

describe("transfers and attachments", () => {
  const OP = newStableId();
  const transfer = (state = "stage") => ({ operationId: OP, workspaceId: "ws1", direction: "to_workspace", mode: "copy", state, items: [{ pageId: PAGE, sourceId: "local:a", revisionId: null, state: "staged" }], createdAt: T, updatedAt: T, error: null });

  it("creates a transfer with Idempotency-Key equal to the operation id", async () => {
    const { client, requests } = fake(() => ok(transfer(), 201));
    const plan = { operationId: OP, direction: "to_workspace" as const, mode: "copy" as const, pages: [{ sourceId: "local:a", pageId: PAGE, parentId: null, title: "A", markdown: "# A\n" }] };
    expect((await client.createTransfer("ws1", plan)).state).toBe("stage");
    expect(requests[0]).toMatchObject({ method: "POST", path: "/api/v1/workspaces/ws1/transfers", headers: { "idempotency-key": OP, "content-type": "application/json" } });
    expect(bodyOf(requests[0]!)).toEqual(plan);
  });

  it("reads, commits (with verified entries) and aborts", async () => {
    const { client, requests } = fake((req) => ok(transfer(req.path.endsWith("/abort") ? "aborted" : req.path.endsWith("/commit") ? "done" : "stage")));
    expect((await client.getTransfer(OP)).state).toBe("stage");
    const verified = [{ pageId: PAGE, revisionId: "r1", contentHash: HASH }];
    expect((await client.commitTransfer(OP, { verified })).state).toBe("done");
    expect(bodyOf(requests[1]!)).toEqual({ verified });
    expect((await client.abortTransfer(OP)).state).toBe("aborted");
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([`GET /api/v1/transfers/${OP}`, `POST /api/v1/transfers/${OP}/commit`, `POST /api/v1/transfers/${OP}/abort`]);
  });

  it("uploads raw bytes with the MIME type, file name and an idempotency key", async () => {
    const id = newStableId();
    const { client, requests } = fake(() => ok({ id, workspaceId: "ws1", hash: HASH, size: 3, mimeType: "image/png", fileName: "a.png", createdAt: T, createdBy: "u1" }, 201));
    const bytes = new Uint8Array([1, 2, 3]);
    expect((await client.uploadAttachment("ws1", bytes, "image/png", { fileName: "a.png", idempotencyKey: "k1" })).id).toBe(id);
    expect(requests[0]).toMatchObject({ method: "POST", path: "/api/v1/workspaces/ws1/attachments", query: { fileName: "a.png" }, headers: { "content-type": "image/png", "idempotency-key": "k1" } });
    expect(requests[0]!.body).toEqual(bytes);
  });

  it("surfaces export_restricted as a problem", async () => {
    const { client } = fake(() => ok(problem("export_restricted"), 403));
    const error = (await client.createTransfer("ws1", { operationId: OP, direction: "from_workspace", mode: "copy", pages: [{ pageId: PAGE }] }).catch((e: unknown) => e)) as ProblemError;
    expect([error.code, error.status]).toEqual(["export_restricted", 403]);
  });
});
