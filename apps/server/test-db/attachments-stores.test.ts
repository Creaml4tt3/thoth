import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { uploadAttachment, uuid } from "./support.ts";

// The attachment routes end to end, once per blob store. (content.test.ts runs the same flows on the default store.)
describe.each(["fs", "postgres"] as const)("attachments over BLOB_STORE=%s", (store) => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let ws: string;
  beforeAll(async () => {
    env = await startTestEnv({ env: { BLOB_STORE: store }, configure: (c) => void (c.maxAttachmentBytes = 2048) });
    owner = await env.user("Owner");
    ws = await env.workspace("W", { members: { [owner.userId]: "owner" } });
  });
  afterAll(() => env.close());

  it("stores bytes content-addressed, serves them back safely, and deduplicates", async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13]);
    const up = await env.api(owner, "POST", `/workspaces/${ws}/attachments`, { headers: { "content-type": "image/png" }, body: bytes, query: { fileName: "pic ไทย.png" } });
    expect(up.status).toBe(201);
    expect(up.json).toMatchObject({ workspaceId: ws, size: 7, mimeType: "image/png", fileName: "pic ไทย.png" });
    const down = await env.api(owner, "GET", `/workspaces/${ws}/attachments/${up.json.id}`);
    expect(down.status).toBe(200);
    expect(down.bytes.equals(bytes)).toBe(true);
    expect(down.headers.get("content-type")).toBe("image/png");
    expect(down.headers.get("content-length")).toBe("7");
    expect(down.headers.get("content-disposition")).toBe("attachment");
    const again = await uploadAttachment(env, owner, ws, bytes);
    expect(again).not.toBe(up.json.id);
    expect((await env.db.query("SELECT DISTINCT hash FROM attachments WHERE workspace_id = $1", [ws])).rowCount).toBe(1);
    if (store === "postgres") expect(Number((await env.db.query<{ n: string }>("SELECT count(*) AS n FROM blobs")).rows[0]!.n)).toBe(1);
  });

  it("enforces the size limit and content types; an unknown attachment is 404", async () => {
    const big = await env.api(owner, "POST", `/workspaces/${ws}/attachments`, { headers: { "content-type": "text/plain" }, body: Buffer.alloc(2049, 1) });
    expect([big.status, big.json.code]).toEqual([413, "payload_too_large"]);
    const noType = await env.api(owner, "POST", `/workspaces/${ws}/attachments`, { headers: { "content-type": "not a media type" }, body: "x" });
    expect([noType.status, noType.json.code]).toEqual([415, "unsupported_media_type"]);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/attachments/${uuid()}`)).json.code).toBe("not_found");
  });

  it("a failed request leaves no blob (the Postgres store joins the request transaction)", async () => {
    const ws2 = await env.workspace("Other", { members: { [owner.userId]: "viewer" } });
    const before = store === "postgres" ? Number((await env.db.query<{ n: string }>("SELECT count(*) AS n FROM blobs")).rows[0]!.n) : 0;
    const denied = await env.api(owner, "POST", `/workspaces/${ws2}/attachments`, { headers: { "content-type": "text/plain" }, body: "viewers cannot upload" });
    expect(denied.status).toBe(403);
    if (store === "postgres") expect(Number((await env.db.query<{ n: string }>("SELECT count(*) AS n FROM blobs")).rows[0]!.n)).toBe(before);
  });
});
