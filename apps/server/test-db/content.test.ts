import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, uploadAttachment, uuid } from "./support.ts";

describe("search", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let ws: string;
  const search = (query: string, extra: Record<string, unknown> = {}) => env.api(owner, "POST", `/workspaces/${ws}/search`, { json: { query, ...extra } });
  beforeAll(async () => {
    env = await startTestEnv();
    owner = await env.user("Owner");
    ws = await env.workspace("W", { members: { [owner.userId]: "owner" } });
  });
  afterAll(() => env.close());

  it("finds Thai text by substring, case-insensitively for Latin, in title and body", async () => {
    const thai = await createPage(env, owner, ws, { title: "สมุดบันทึกของฉัน", markdown: "# บันทึกประจำวัน\n\nวันนี้ไปตลาดซื้อมะม่วงและทุเรียน\n" });
    const latin = await createPage(env, owner, ws, { title: "Weekly Notes", markdown: "Remember the MILK and the Bread\n" });
    expect((await search("มะม่วง")).json.items.map((h: { pageId: string }) => h.pageId)).toEqual([thai.id]);
    expect((await search("ตลาดซื้อ")).json.items).toHaveLength(1); // mid-sentence, no word boundary
    expect((await search("สมุดบันทึก")).json.items.map((h: { pageId: string }) => h.pageId)).toEqual([thai.id]); // title
    expect((await search("milk and the bread")).json.items.map((h: { pageId: string }) => h.pageId)).toEqual([latin.id]);
    expect((await search("WEEKLY")).json.items[0].title).toBe("Weekly Notes");
    expect((await search("no such text anywhere")).json.items).toEqual([]);
    const hit = (await search("ทุเรียน")).json.items[0];
    expect(hit).toMatchObject({ pageId: thai.id, revisionId: thai.revisionId });
    expect(hit.snippet).toContain("ทุเรียน");
  });

  it("treats LIKE wildcards literally", async () => {
    await createPage(env, owner, ws, { title: "pct", markdown: "discount 100% off, snake_case here" });
    await createPage(env, owner, ws, { title: "other", markdown: "plain text without those characters" });
    expect((await search("100%")).json.items).toHaveLength(1);
    expect((await search("snake_case")).json.items).toHaveLength(1);
    expect((await search("%")).json.items).toHaveLength(1);
    expect((await search("_")).json.items).toHaveLength(1); // only snake_case contains "_"
    expect((await search("a\\b")).json.items).toEqual([]);
  });

  it("searches only current revisions and never deleted pages", async () => {
    const p = await createPage(env, owner, ws, { markdown: "old-version-marker" });
    const upd = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${p.id}`, { headers: { "if-match": `"${p.revisionId}"` }, json: { title: "T", markdown: "new-version-marker" } });
    expect((await search("old-version-marker")).json.items).toEqual([]);
    expect((await search("new-version-marker")).json.items[0].revisionId).toBe(upd.json.revision.id);
    await env.api(owner, "DELETE", `/workspaces/${ws}/pages/${p.id}`, { headers: { "if-match": `"${upd.json.revision.id}"` } });
    expect((await search("new-version-marker")).json.items).toEqual([]);
  });

  it("pages through results without repeats and limits to a subtree", async () => {
    const root = await createPage(env, owner, ws, { title: "tree-root", markdown: "paging-marker" });
    const kid = await createPage(env, owner, ws, { title: "kid", markdown: "paging-marker", parentId: root.id });
    const grandkid = await createPage(env, owner, ws, { title: "grandkid", markdown: "paging-marker", parentId: kid.id });
    await createPage(env, owner, ws, { title: "outsider", markdown: "paging-marker" });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const res = await search("paging-marker", { limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...res.json.items.map((h: { pageId: string }) => h.pageId));
      cursor = res.json.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    const within = await search("paging-marker", { withinPageId: root.id });
    expect(within.json.items.map((h: { pageId: string }) => h.pageId).sort()).toEqual([root.id, kid.id, grandkid.id].sort());
    // A cursor from another query is refused.
    const first = await search("paging-marker", { limit: 1 });
    const foreign = await search("something-else", { cursor: first.json.nextCursor });
    expect([foreign.status, foreign.json.code]).toEqual([400, "cursor_invalid"]);
  });

  it("is backed by trigram indexes", async () => {
    const idx = await env.db.query("SELECT indexname FROM pg_indexes WHERE tablename = 'page_revisions' AND indexdef LIKE '%gin_trgm_ops%'");
    expect(idx.rows.map((r) => r.indexname).sort()).toEqual(["page_revisions_markdown_trgm", "page_revisions_title_trgm"]);
  });
});

describe("attachments", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let ws: string;
  beforeAll(async () => {
    env = await startTestEnv({ configure: (c) => void (c.maxAttachmentBytes = 2048) });
    owner = await env.user("Owner");
    ws = await env.workspace("W", { members: { [owner.userId]: "owner" } });
  });
  afterAll(() => env.close());

  it("stores bytes content-addressed, serves them back safely, and records a feed entry", async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13]);
    const up = await env.api(owner, "POST", `/workspaces/${ws}/attachments`, { headers: { "content-type": "image/png" }, body: bytes, query: { fileName: "pic ไทย.png" } });
    expect(up.status).toBe(201);
    expect(up.json).toMatchObject({ workspaceId: ws, size: 7, mimeType: "image/png", fileName: "pic ไทย.png" });
    const down = await env.api(owner, "GET", `/workspaces/${ws}/attachments/${up.json.id}`);
    expect(down.bytes.equals(bytes)).toBe(true);
    expect(down.headers.get("content-type")).toBe("image/png");
    expect(down.headers.get("x-content-type-options")).toBe("nosniff");
    expect(down.headers.get("content-disposition")).toBe("attachment");
    expect(down.headers.get("content-security-policy")).toContain("sandbox");
    const again = await uploadAttachment(env, owner, ws, bytes);
    expect((await env.db.query("SELECT DISTINCT hash FROM attachments WHERE workspace_id = $1", [ws])).rowCount).toBe(1); // stored once
    expect(again).not.toBe(up.json.id);
    const feed = (await env.api(owner, "GET", `/workspaces/${ws}/changes`)).json.entries;
    expect(feed.filter((e: { kind: string }) => e.kind === "attachment.created")).toHaveLength(2);
  });

  it("enforces limits and content types", async () => {
    const big = await env.api(owner, "POST", `/workspaces/${ws}/attachments`, { headers: { "content-type": "text/plain" }, body: Buffer.alloc(2049, 1) });
    expect([big.status, big.json.code]).toEqual([413, "payload_too_large"]);
    const noType = await env.api(owner, "POST", `/workspaces/${ws}/attachments`, { headers: { "content-type": "not a media type" }, body: "x" });
    expect([noType.status, noType.json.code]).toEqual([415, "unsupported_media_type"]);
    const empty = await env.api(owner, "POST", `/workspaces/${ws}/attachments`, { headers: { "content-type": "text/plain" }, body: "" });
    expect([empty.status, empty.json.code]).toEqual([400, "validation_failed"]);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/attachments/not-a-uuid`)).json.code).toBe("validation_failed");
    expect((await env.api(owner, "GET", `/workspaces/${ws}/attachments/${uuid()}`)).json.code).toBe("not_found");
  });

  it("a transfer may reference attachments uploaded to the workspace", async () => {
    const attachmentId = await uploadAttachment(env, owner, ws);
    const operationId = uuid();
    const res = await env.api(owner, "POST", `/workspaces/${ws}/transfers`, { headers: { "idempotency-key": operationId }, json: { operationId, direction: "to_workspace", mode: "copy", pages: [{ sourceId: "s", pageId: uuid(), parentId: null, title: "t", markdown: "m" }], attachmentIds: [attachmentId] } });
    expect(res.status).toBe(201);
  });
});
