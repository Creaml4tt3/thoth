import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRequestPath, getRoute } from "@thoth/workspace-protocol";
import { createClient, type Client } from "../../protocol/conformance/src/http.ts";
import { EDITOR_TOKEN, LOCKED_WORKSPACE, MAIN_WORKSPACE, VIEWER_TOKEN, startTestServer, type TestServer } from "./test-server.ts";

/**
 * The test server is a fixture, but the authorization and capability behavior it
 * implements is what ADR-0004 and ADR-0009 ask servers to do. These tests pin that
 * behavior and check that every response also satisfies the protocol contract.
 */
const PAGE_ID = "01a15cc9-7d0d-7982-a22a-e5ae3df6b019";

describe("test server: authorization and error behavior", () => {
  let server: TestServer;
  let editor: Client;
  let viewer: Client;
  beforeAll(async () => {
    server = await startTestServer({ capabilities: ["search"] });
    editor = createClient({ baseUrl: server.url, token: EDITOR_TOKEN });
    viewer = createClient({ baseUrl: server.url, token: VIEWER_TOKEN });
  });
  afterAll(() => server.close());

  const write = { json: { title: "t", markdown: "m" }, headers: { "if-none-match": "*" } };

  it("returns 403 forbidden when a viewer writes, and writes nothing", async () => {
    const res = await viewer.call("putPage", { params: { workspaceId: MAIN_WORKSPACE, pageId: PAGE_ID }, ...write });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "forbidden", status: 403 });
    expect(res.issues).toEqual([]);
    const read = await editor.call("getPage", { params: { workspaceId: MAIN_WORKSPACE, pageId: PAGE_ID } });
    expect(read.status).toBe(404);
  });

  it("lets a viewer read what an editor wrote", async () => {
    const put = await editor.call("putPage", { params: { workspaceId: MAIN_WORKSPACE, pageId: PAGE_ID }, ...write });
    expect(put.status).toBe(201);
    const get = await viewer.call("getPage", { params: { workspaceId: MAIN_WORKSPACE, pageId: PAGE_ID } });
    expect(get.status).toBe(200);
    expect(get.issues).toEqual([]);
  });

  it("answers 404 not_found, not 403, for a workspace the principal does not belong to", async () => {
    const res = await editor.call("getWorkspaceTree", { params: { workspaceId: "ws_unknown" } });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "not_found" });
    expect(res.issues).toEqual([]);
  });

  it("answers 501 capability_not_supported for routes of a capability it does not list", async () => {
    const calls = [
      editor.call("uploadAttachment", { params: { workspaceId: MAIN_WORKSPACE }, headers: { "content-type": "image/png" }, body: new Uint8Array([1]) }),
      editor.call("createTransfer", { params: { workspaceId: MAIN_WORKSPACE }, json: { operationId: PAGE_ID, direction: "from_workspace", mode: "copy", pages: [{ pageId: PAGE_ID }] }, headers: { "idempotency-key": PAGE_ID } }),
      editor.call("getTransfer", { params: { operationId: PAGE_ID } }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(501);
      expect(res.body).toMatchObject({ code: "capability_not_supported" });
      expect(res.issues).toEqual([]);
    }
    const events = await fetch(`${server.url}${buildRequestPath(getRoute("streamWorkspaceEvents"), { workspaceId: MAIN_WORKSPACE })}`, { headers: { authorization: `Bearer ${EDITOR_TOKEN}` } });
    expect(events.status).toBe(501);
    expect(events.headers.get("content-type")).toBe("application/problem+json");
    await events.arrayBuffer();
  });

  it("answers 405 method_not_allowed with an Allow header for a known path", async () => {
    const res = await fetch(`${server.url}/api/v1/me`, { method: "DELETE", headers: { authorization: `Bearer ${EDITOR_TOKEN}` } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ code: "method_not_allowed" });
  });

  it("answers 401 with WWW-Authenticate before anything else for protected routes", async () => {
    const res = await editor.call("getMe", { auth: "none" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    const unknown = await editor.unrouted("GET", "/api/v1/nothing", { auth: "none" });
    expect(unknown.status).toBe(401);
  });

  it("rejects an oversized attachment with 413 payload_too_large, using a server that lists attachments", async () => {
    const withAttachments = await startTestServer({ capabilities: ["attachments"] });
    try {
      const client = createClient({ baseUrl: withAttachments.url, token: EDITOR_TOKEN });
      const res = await client.call("uploadAttachment", { params: { workspaceId: MAIN_WORKSPACE }, headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(1_048_577) });
      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ code: "payload_too_large" });
      expect(res.issues).toEqual([]);
    } finally {
      await withAttachments.close();
    }
  });
});

describe("test server: export restriction (ADR-0009)", () => {
  it("refuses a from_workspace transfer in a restricted workspace with 403 export_restricted, even for the owner", async () => {
    const server = await startTestServer();
    try {
      const client = createClient({ baseUrl: server.url, token: EDITOR_TOKEN });
      const put = await client.call("putPage", { params: { workspaceId: LOCKED_WORKSPACE, pageId: PAGE_ID }, json: { title: "t", markdown: "m" }, headers: { "if-none-match": "*" } });
      expect(put.status).toBe(201);
      const operationId = "01a15cc9-7d0d-7982-a22a-e5ae3df6b01a";
      const res = await client.call("createTransfer", { params: { workspaceId: LOCKED_WORKSPACE }, json: { operationId, direction: "from_workspace", mode: "copy", pages: [{ pageId: PAGE_ID }] }, headers: { "idempotency-key": operationId } });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "export_restricted" });
      expect(res.issues).toEqual([]);
      const unknown = await client.call("getTransfer", { params: { operationId } });
      expect(unknown.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("does not let a viewer start a move or a to_workspace transfer", async () => {
    const server = await startTestServer();
    try {
      const client = createClient({ baseUrl: server.url, token: VIEWER_TOKEN });
      const operationId = "01a15cc9-7d0d-7982-a22a-e5ae3df6b01b";
      const res = await client.call("createTransfer", {
        params: { workspaceId: MAIN_WORKSPACE },
        json: { operationId, direction: "to_workspace", mode: "copy", pages: [{ sourceId: "local:a", pageId: PAGE_ID, parentId: null, title: "t", markdown: "m" }] },
        headers: { "idempotency-key": operationId },
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "forbidden" });
    } finally {
      await server.close();
    }
  });
});
