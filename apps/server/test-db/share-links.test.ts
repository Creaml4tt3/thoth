/**
 * Public read-only share links (ADR-0023, capability `public-share`) against the real server and PostgreSQL.
 * Every security rule of the ADR has a test here: tokens and their storage, the one 404 for every failure, the
 * per-request re-checks (link active, page in the workspace and in the subtree, creator still owner or editor,
 * capability on), the HTML sanitising, the headers and the CSP, the attachments, the limits and the rate limits.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveShareLink } from "../src/share/resolve.ts";
import { hashShareToken } from "../src/share/tokens.ts";
import type { Queryable } from "../src/db.ts";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, uuid } from "./support.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const CSP = "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const HTML = { accept: "text/html,application/xhtml+xml" };

interface Shared {
  id: string;
  token: string;
  url: string;
  expiresAt: string | null;
}

async function upload(env: TestEnv, who: TestPrincipal, ws: string, bytes: Buffer, mime: string, fileName?: string): Promise<string> {
  const res = await env.api(who, "POST", `/workspaces/${ws}/attachments`, { headers: { "content-type": mime }, body: bytes, ...(fileName ? { query: { fileName } } : {}) });
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${res.text}`);
  return res.json.id;
}

async function share(env: TestEnv, who: TestPrincipal, ws: string, page: string, body: unknown = {}): Promise<Shared> {
  const res = await env.api(who, "POST", `/workspaces/${ws}/pages/${page}/share-links`, { json: body });
  if (res.status !== 201) throw new Error(`share failed: ${res.status} ${res.text}`);
  return res.json;
}

async function view(env: TestEnv, path: string, headers: Record<string, string> = HTML) {
  const res = await fetch(`${env.url}${path}`, { headers });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, text: bytes.toString("utf8"), bytes };
}

/** What a 404 looks like from outside: status, body and the headers that could tell two answers apart. */
const fingerprint = (r: Awaited<ReturnType<typeof view>>) => ({
  status: r.status,
  body: r.text,
  headers: ["content-type", "content-length", "content-security-policy", "x-robots-tag", "cache-control", "referrer-policy", "retry-after"].map((h) => `${h}: ${r.headers.get(h)}`),
});

/** A 429's Retry-After counts down by the second, so two refusals a moment apart may differ in it by one. */
const refusal = (r: Awaited<ReturnType<typeof view>>) => {
  const f = fingerprint(r);
  return { ...f, headers: f.headers.filter((h) => !h.startsWith("retry-after")) };
};

describe("share links: creating, listing and revoking (protocol calls)", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let editor: TestPrincipal;
  let viewer: TestPrincipal;
  let stranger: TestPrincipal;
  let ws: string;
  let page: string;

  beforeAll(async () => {
    env = await startTestEnv();
    [owner, editor, viewer, stranger] = (await Promise.all(["Owner", "Editor", "Viewer", "Stranger"].map((n) => env.user(n)))) as [TestPrincipal, TestPrincipal, TestPrincipal, TestPrincipal];
    ws = await env.workspace("Team", { members: { [owner.userId]: "owner", [editor.userId]: "editor", [viewer.userId]: "viewer" } });
    page = (await createPage(env, owner, ws, { title: "Plan", markdown: "# Plan\n" })).id;
  });
  afterAll(() => env.close());

  it("advertises the capability public-share by default", async () => {
    const caps = await env.api(null, "GET", "/capabilities");
    expect(caps.json.capabilities).toContain("public-share");
  });

  it("lets owners and editors create a link; the default expiry is 30 days and the address is /s/<token>", async () => {
    for (const who of [owner, editor]) {
      const before = Date.now();
      const res = await env.api(who, "POST", `/workspaces/${ws}/pages/${page}/share-links`, { json: {} });
      expect(res.status, res.text).toBe(201);
      expect(res.json.pageId).toBe(page);
      expect(res.json.workspaceId).toBe(ws);
      expect(res.json.createdBy).toBe(who.userId);
      expect(res.json.url).toBe(`${env.url}/s/${res.json.token}`);
      const days = (Date.parse(res.json.expiresAt) - before) / 86_400_000;
      expect(days).toBeGreaterThan(29.99);
      expect(days).toBeLessThan(30.01);
    }
  });

  it("accepts 7, 90 and never (null), and nothing else", async () => {
    for (const [choice, days] of [[7, 7], [90, 90]] as const) {
      const link = await share(env, owner, ws, page, { expiresInDays: choice });
      expect(Math.round((Date.parse(link.expiresAt!) - Date.now()) / 86_400_000)).toBe(days);
    }
    expect((await share(env, owner, ws, page, { expiresInDays: null })).expiresAt).toBeNull();
    for (const bad of [1, 31, "30", -7, 365]) {
      const res = await env.api(owner, "POST", `/workspaces/${ws}/pages/${page}/share-links`, { json: { expiresInDays: bad } });
      expect([res.status, res.json.code], JSON.stringify(bad)).toEqual([400, "validation_failed"]);
    }
  });

  it("refuses viewers (403) and non-members (404, existence not leaked), and unknown or deleted pages (404)", async () => {
    const asViewer = await env.api(viewer, "POST", `/workspaces/${ws}/pages/${page}/share-links`, { json: {} });
    expect([asViewer.status, asViewer.json.code]).toEqual([403, "forbidden"]);
    const asStranger = await env.api(stranger, "POST", `/workspaces/${ws}/pages/${page}/share-links`, { json: {} });
    expect([asStranger.status, asStranger.json.code]).toEqual([404, "not_found"]);
    const unknown = await env.api(owner, "POST", `/workspaces/${ws}/pages/${uuid()}/share-links`, { json: {} });
    expect([unknown.status, unknown.json.code]).toEqual([404, "not_found"]);
    const gone = await createPage(env, owner, ws, { title: "Gone" });
    await env.api(owner, "DELETE", `/workspaces/${ws}/pages/${gone.id}`, { headers: { "if-match": `"${gone.revisionId}"` } });
    const deleted = await env.api(owner, "POST", `/workspaces/${ws}/pages/${gone.id}/share-links`, { json: {} });
    expect([deleted.status, deleted.json.code]).toEqual([404, "not_found"]);
    expect((await env.api(null, "POST", `/workspaces/${ws}/pages/${page}/share-links`, { json: {} })).status).toBe(401);
  });

  it("refuses a link in a workspace that forbids exporting (403 export_restricted)", async () => {
    const closed = await env.workspace("Closed", { exportRestricted: true, members: { [owner.userId]: "owner" } });
    const p = await createPage(env, owner, closed);
    const res = await env.api(owner, "POST", `/workspaces/${closed}/pages/${p.id}/share-links`, { json: {} });
    expect([res.status, res.json.code]).toEqual([403, "export_restricted"]);
  });

  it("stores only a hash of the token: not in the link row, the idempotency records or the audit log", async () => {
    const res = await env.api(owner, "POST", `/workspaces/${ws}/pages/${page}/share-links`, { headers: { "idempotency-key": uuid() }, json: { expiresInDays: 7 } });
    expect(res.status).toBe(201);
    const { token, id } = res.json;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    // At least 128 bits: 32 base64url characters carry 192.
    expect(Buffer.from(token, "base64url").length).toBeGreaterThanOrEqual(16);
    const row = (await env.db.query<{ token_hash: string }>("SELECT token_hash FROM share_links WHERE id = $1", [id])).rows[0]!;
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    for (const table of ["share_links", "idempotency_records", "audit_events"]) {
      const dump = await env.db.query(`SELECT t::text AS row FROM ${table} t`);
      expect(dump.rows.map((r: any) => r.row).join("\n"), table).not.toContain(token);
    }
    const audit = await env.db.query<{ action: string }>("SELECT action FROM audit_events WHERE workspace_id = $1 AND action LIKE 'share_link.%'", [ws]);
    expect(audit.rows.map((r) => r.action)).toContain("share_link.created");
  });

  it("gives every link its own random token", async () => {
    const tokens = await Promise.all(Array.from({ length: 8 }, () => share(env, owner, ws, page).then((l) => l.token)));
    expect(new Set(tokens).size).toBe(8);
  });

  it("lists the page's active links newest first, without tokens; viewers are refused", async () => {
    const p = (await createPage(env, owner, ws, { title: "Listed" })).id;
    const a = await share(env, owner, ws, p, { expiresInDays: 7 });
    const b = await share(env, editor, ws, p, { expiresInDays: null });
    const c = await share(env, owner, ws, p);
    await env.db.query("UPDATE share_links SET expires_at = now() - interval '1 second' WHERE id = $1", [c.id]);
    const list = await env.api(editor, "GET", `/workspaces/${ws}/pages/${p}/share-links`);
    expect(list.status).toBe(200);
    expect(list.json.items.map((l: { id: string }) => l.id)).toEqual([b.id, a.id]);
    expect(list.json.nextCursor).toBeNull();
    expect(list.text).not.toContain(a.token);
    expect(list.text).not.toContain(b.token);
    expect(list.json.items[0]).toEqual({ id: b.id, workspaceId: ws, pageId: p, createdAt: expect.any(String), createdBy: editor.userId, expiresAt: null });
    const asViewer = await env.api(viewer, "GET", `/workspaces/${ws}/pages/${p}/share-links`);
    expect([asViewer.status, asViewer.json.code]).toEqual([403, "forbidden"]);
    const paged = await env.api(owner, "GET", `/workspaces/${ws}/pages/${p}/share-links`, { query: { limit: "1" } });
    expect(paged.json.items.map((l: { id: string }) => l.id)).toEqual([b.id]);
    const rest = await env.api(owner, "GET", `/workspaces/${ws}/pages/${p}/share-links`, { query: { limit: "1", cursor: paged.json.nextCursor } });
    expect(rest.json.items.map((l: { id: string }) => l.id)).toEqual([a.id]);
    expect(rest.json.nextCursor).toBeNull();
  });

  it("revokes: 204, gone from the list, repeatable; viewers 403; another workspace's link 404", async () => {
    const p = (await createPage(env, owner, ws, { title: "Revoked" })).id;
    const link = await share(env, owner, ws, p);
    const asViewer = await env.api(viewer, "DELETE", `/workspaces/${ws}/share-links/${link.id}`);
    expect([asViewer.status, asViewer.json.code]).toEqual([403, "forbidden"]);
    const other = await env.workspace("Other", { members: { [stranger.userId]: "owner" } });
    const elsewhere = await env.api(stranger, "DELETE", `/workspaces/${other}/share-links/${link.id}`);
    expect([elsewhere.status, elsewhere.json.code]).toEqual([404, "not_found"]);
    expect((await env.api(editor, "DELETE", `/workspaces/${ws}/share-links/${link.id}`)).status).toBe(204);
    expect((await env.api(owner, "DELETE", `/workspaces/${ws}/share-links/${link.id}`)).status).toBe(204);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${p}/share-links`)).json.items).toEqual([]);
    expect((await env.api(owner, "DELETE", `/workspaces/${ws}/share-links/shl_unknown`)).status).toBe(404);
    const audit = await env.db.query<{ n: string }>("SELECT count(*) AS n FROM audit_events WHERE action = 'share_link.revoked' AND detail->>'linkId' = $1", [link.id]);
    expect(Number(audit.rows[0]!.n)).toBe(1);
  });
});

describe("the shared page (GET /s/<token>)", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let editor: TestPrincipal;
  let ws: string;
  let parent: string;
  let root: string;
  let child: string;
  let grandchild: string;
  let sibling: string;
  let picture: string;
  let vector: string;
  let unused: string;
  let outsidePicture: string;
  let link: Shared;
  const logLines: string[] = [];

  const MARKDOWN = (ids: Record<string, string>) => `---
thoth_secret: frontmatter is never shown
---
# Field notes

Hello **world** and _friends_.

![the diagram](thoth:attachment/${ids.picture})

See [[thoth:page/${ids.child}|the child page]] and [[thoth:page/${ids.sibling}|a page that is not shared]] and [[thoth:page/${ids.sibling}]].

A [[Plain wikilink]] and an [external link](https://example.org/x) and [a trap](javascript:alert(1)) and [data](data:text/html,hi).

Vector: ![[thoth:attachment/${ids.vector}|drawing.svg]]

<script>alert("x")</script>

<img src=x onerror=alert(1)>

<div onclick="alert(2)"><iframe src="https://evil.example"></iframe></div>

Inline <b onmouseover="alert(3)">bold</b> and <u>underlined</u> and <span data-color="red">red</span> and ==marked==.

- [x] done
- [ ] open

| a | b |
| - | -: |
| 1 | 2 |

\`\`\`js
const x = "<script>";
\`\`\`
`;

  beforeAll(async () => {
    env = await startTestEnv({ startOptions: { logStream: { write: (line: string) => void logLines.push(line) } }, configure: (c) => void (c.logLevel = "info") });
    owner = await env.user("Olivia Owner");
    editor = await env.user("Eddie Editor");
    ws = await env.workspace("Secret Workspace Name", { members: { [owner.userId]: "owner", [editor.userId]: "editor" } });
    await env.db.query("UPDATE users SET email = 'olivia@example.org' WHERE id = $1", [owner.userId]);
    picture = await upload(env, owner, ws, PNG, "image/png", 'evil"name\r\n.png');
    vector = await upload(env, owner, ws, SVG, "image/svg+xml", "drawing.svg");
    unused = await upload(env, owner, ws, PNG, "image/png", "unused.png");
    outsidePicture = await upload(env, owner, ws, PNG, "image/png", "outside.png");
    parent = (await createPage(env, owner, ws, { title: "Parent Above" })).id;
    sibling = (await createPage(env, owner, ws, { title: "Sibling Secret Title", markdown: `# Sibling\n\n![x](thoth:attachment/${outsidePicture})\n` })).id;
    root = uuid();
    child = uuid();
    await createPage(env, owner, ws, { id: root, title: "Field notes", parentId: parent, markdown: MARKDOWN({ picture, child, sibling, vector }) });
    await createPage(env, owner, ws, { id: child, title: "Child Page", parentId: root, markdown: `# Child\n\nBack to [[thoth:page/${root}|the top]].\n` });
    grandchild = (await createPage(env, owner, ws, { title: "Grandchild Page", parentId: child, markdown: "# Grandchild\n\nDeep.\n" })).id;
    link = await share(env, editor, ws, root);
  });
  afterAll(() => env.close());

  it("serves the page without sign-in, as HTML with the strict headers", async () => {
    const res = await view(env, `/s/${link.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.text).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(res.text).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(res.text).toContain('<link rel="stylesheet" href="/assets/share/share.css">');
    expect(res.text).toContain("<title>Field notes</title>");
    expect(res.text).toContain("Hello <strong>world</strong> and <em>friends</em>.");
  });

  it("has no scripts at all and passes no raw HTML through", async () => {
    const { text } = await view(env, `/s/${link.token}`);
    expect(text).not.toMatch(/<script/i);
    expect(text).not.toMatch(/<iframe/i);
    expect(text).not.toMatch(/<img[^>]+src="?x/i);
    expect(text).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(text).not.toMatch(/<div[^>]*onclick/i);
    expect(text).not.toMatch(/<b\b/i);
    expect(text).not.toMatch(/href="\s*(javascript|data|vbscript):/i);
    // Shown as text, escaped.
    expect(text).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(text).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(text).toContain('<code class="language-js">const x = &quot;&lt;script&gt;&quot;;\n</code>');
    // Thoth's own styles are kept, as fixed tags the server writes.
    expect(text).toContain("<u>underlined</u>");
    expect(text).toContain('<span class="tc tc-red">red</span>');
    expect(text).toContain("<mark>marked</mark>");
    expect(text).toContain('<input type="checkbox" disabled checked aria-label="Done">');
    expect(text).toContain('<td class="right">2</td>');
    expect(text).not.toContain("thoth_secret");
  });

  it("links pages of the subtree to their share address and leaves everything else as plain text", async () => {
    const { text } = await view(env, `/s/${link.token}`);
    expect(text).toContain(`<a href="/s/${link.token}/p/${child}">the child page</a>`);
    expect(text).not.toContain(`thoth:page/${sibling}`);
    expect(text).toContain("a page that is not shared");
    expect(text).not.toMatch(new RegExp(`<a[^>]*>a page that is not shared`));
    expect(text).toContain("Plain wikilink");
    expect(text).not.toMatch(/<a[^>]*>Plain wikilink/);
    expect(text).toContain('<a href="https://example.org/x" rel="noopener noreferrer nofollow">external link</a>');
    expect(text).toContain("a trap");
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("data:text/html");
  });

  it("never shows workspace IDs or names, member names or emails, or titles of pages outside the subtree", async () => {
    const pages = await Promise.all([`/s/${link.token}`, `/s/${link.token}/p/${child}`, `/s/${link.token}/p/${grandchild}`].map((p) => view(env, p)));
    for (const { text } of pages) {
      for (const secret of [ws, "Secret Workspace Name", "Olivia", "Eddie", "olivia@example.org", owner.userId, editor.userId, "Sibling Secret Title", "Parent Above", parent]) expect(text, secret).not.toContain(secret);
    }
  });

  it("shows the sub-pages: listed on the page, and each reachable under the token", async () => {
    const top = await view(env, `/s/${link.token}`);
    expect(top.text).toContain(`<a href="/s/${link.token}/p/${child}">Child Page</a>`);
    const middle = await view(env, `/s/${link.token}/p/${child}`);
    expect(middle.status).toBe(200);
    expect(middle.text).toContain("<title>Child Page</title>");
    expect(middle.text).toContain(`<a href="/s/${link.token}">the top</a>`);
    expect(middle.text).toContain(`<a href="/s/${link.token}/p/${grandchild}">Grandchild Page</a>`);
    const deep = await view(env, `/s/${link.token}/p/${grandchild}`);
    expect(deep.status).toBe(200);
    expect(deep.text).toContain("Deep.");
    expect((await view(env, `/s/${link.token}/p/${root}`)).status).toBe(200);
  });

  it("answers an unknown or malformed token, page or attachment with its 404 and logs no error", async () => {
    const before = logLines.length;
    for (const path of [`/s/${"A".repeat(32)}`, "/s/notarealtoken", `/s/${"B".repeat(32)}/p/${uuid()}`, `/s/${"C".repeat(32)}/a/att_x`]) {
      for (const headers of [HTML, { accept: "application/json" }]) expect((await view(env, path, headers)).status, path).toBe(404);
    }
    const errors = logLines.slice(before).filter((line) => (JSON.parse(line) as { level: number }).level >= 50);
    expect(errors).toEqual([]);
  });

  it("does not reach pages outside the subtree: the parent and a sibling are the same 404 as an unknown token", async () => {
    const unknown = fingerprint(await view(env, `/s/${"A".repeat(32)}`));
    expect(unknown.status).toBe(404);
    for (const id of [parent, sibling, uuid(), "not-a-uuid"]) expect(fingerprint(await view(env, `/s/${link.token}/p/${id}`)), id).toEqual(unknown);
  });

  it("serves the picture the page uses, inline, with its stored type and a safe file name", async () => {
    const { text } = await view(env, `/s/${link.token}`);
    expect(text).toContain(`<img src="/s/${link.token}/a/${picture}" alt="the diagram">`);
    const res = await view(env, `/s/${link.token}/a/${picture}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.bytes.equals(PNG)).toBe(true);
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="evil_name__.png"; filename*=UTF-8''evil%22name%0D%0A.png`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("never serves SVG inline: it is a download link, sent as an attachment", async () => {
    const { text } = await view(env, `/s/${link.token}`);
    expect(text).not.toContain(`<img src="/s/${link.token}/a/${vector}"`);
    expect(text).toContain(`<a href="/s/${link.token}/a/${vector}" download>drawing.svg</a>`);
    const res = await view(env, `/s/${link.token}/a/${vector}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="drawing.svg"; filename*=UTF-8''drawing.svg`);
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  });

  it("serves only attachments the shared pages use: an unused one, or one only a page outside uses, is the same 404", async () => {
    const unknown = fingerprint(await view(env, `/s/${"A".repeat(32)}/a/${picture}`));
    expect(unknown.status).toBe(404);
    for (const id of [unused, outsidePicture, uuid(), "nope"]) expect(fingerprint(await view(env, `/s/${link.token}/a/${id}`)), id).toEqual(unknown);
  });

  it("shows the current revision, not a snapshot", async () => {
    const p = await createPage(env, owner, ws, { title: "Living", parentId: root, markdown: "# Living\n\nfirst words\n" });
    expect((await view(env, `/s/${link.token}/p/${p.id}`)).text).toContain("first words");
    const put = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${p.id}`, { headers: { "if-match": `"${p.revisionId}"` }, json: { title: "Living", markdown: "# Living\n\nsecond words\n", parentId: root } });
    expect(put.status).toBe(200);
    const after = await view(env, `/s/${link.token}/p/${p.id}`);
    expect(after.text).toContain("second words");
    expect(after.text).not.toContain("first words");
  });

  it("serves its stylesheet and the brand fonts from the server, with light and dark from prefers-color-scheme", async () => {
    const css = await view(env, "/assets/share/share.css", {});
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(css.text).toContain("@media (prefers-color-scheme: dark)");
    expect(css.text).toContain("--thoth-accent");
    const fonts = [...css.text.matchAll(/url\("([^"]+\.woff2)"\)/g)].map((m) => m[1]!);
    expect(fonts.length).toBe(3);
    for (const font of fonts) {
      const res = await view(env, font, {});
      expect(res.status, font).toBe(200);
      expect(res.headers.get("content-type")).toBe("font/woff2");
      expect(res.bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
    }
    expect((await view(env, "/assets/share/../package.json", {})).status).toBe(404);
    expect((await view(env, "/assets/share/nothing.css", {})).status).toBe(404);
  });

  it("never writes a token into the log", async () => {
    await view(env, `/s/${link.token}/p/${child}`);
    await view(env, `/s/${"B".repeat(32)}`);
    const all = logLines.join("\n");
    expect(all).toContain("/s/[token]");
    expect(all).not.toContain(link.token);
    expect(all).not.toContain("B".repeat(32));
  });
});

describe("a link stops working, always with the same 404", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let editor: TestPrincipal;
  let ws: string;

  beforeAll(async () => {
    env = await startTestEnv();
    owner = await env.user("Owner");
    editor = await env.user("Editor");
    ws = await env.workspace("W", { members: { [owner.userId]: "owner", [editor.userId]: "editor" } });
  });
  afterAll(() => env.close());

  const unknown404 = async (accept: Record<string, string> = HTML) => fingerprint(await view(env, `/s/${"Z".repeat(32)}`, accept));

  it("answers an unknown, malformed, expired, revoked or out-of-scope token identically, in HTML and in JSON", async () => {
    const p = await createPage(env, owner, ws, { title: "P" });
    const expired = await share(env, owner, ws, p.id);
    await env.db.query("UPDATE share_links SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
    const revoked = await share(env, owner, ws, p.id);
    await env.api(owner, "DELETE", `/workspaces/${ws}/share-links/${revoked.id}`);
    const live = await share(env, owner, ws, p.id);
    for (const accept of [HTML, { accept: "application/json" }, {}]) {
      const expected = await unknown404(accept);
      expect(expected.status).toBe(404);
      for (const path of [`/s/${expired.token}`, `/s/${revoked.token}`, "/s/short", `/s/${"%3Cscript%3E".repeat(3)}`, `/s/${live.token}/p/${uuid()}`, `/s/${live.token}/a/${uuid()}`, `/s/${live.token}/nothing`]) {
        expect(fingerprint(await view(env, path, accept)), `${path} ${JSON.stringify(accept)}`).toEqual(expected);
      }
    }
    const json = await view(env, `/s/${expired.token}`, { accept: "application/json" });
    expect(json.headers.get("content-type")).toContain("application/problem+json");
    expect(JSON.parse(json.text)).toMatchObject({ status: 404, code: "not_found" });
    expect((await view(env, `/s/${live.token}`)).status).toBe(200);
  });

  it("uses one query of the same shape for every unknown or dead token, so timing does not tell them apart", async () => {
    const p = await createPage(env, owner, ws, { title: "Shape" });
    const expired = await share(env, owner, ws, p.id);
    await env.db.query("UPDATE share_links SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
    const revoked = await share(env, owner, ws, p.id);
    await env.db.query("UPDATE share_links SET revoked_at = now() WHERE id = $1", [revoked.id]);
    const demotedBy = await env.user("Soon viewer");
    await env.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'editor')", [ws, demotedBy.userId]);
    const demoted = await share(env, demotedBy, ws, p.id);
    await env.db.query("UPDATE memberships SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2", [ws, demotedBy.userId]);
    const live = await share(env, owner, ws, p.id);
    const shapes: string[][] = [];
    for (const token of ["Q".repeat(32), expired.token, revoked.token, demoted.token, live.token]) {
      const seen: string[] = [];
      const recording: Queryable = { query: (text: string, values?: unknown[]) => (seen.push(text), env.db.query(text, values)) } as Queryable;
      const found = await resolveShareLink(recording, hashShareToken(token));
      expect(found === null, token).toBe(token !== live.token);
      shapes.push(seen);
    }
    expect(shapes[0]!.length).toBe(1);
    for (const s of shapes) expect(s).toEqual(shapes[0]);
  });

  it("stops when the page is deleted, and when it moves out of the workspace (a transfer move deletes it there)", async () => {
    const p = await createPage(env, owner, ws, { title: "Doomed" });
    const link = await share(env, owner, ws, p.id);
    expect((await view(env, `/s/${link.token}`)).status).toBe(200);
    await env.api(owner, "DELETE", `/workspaces/${ws}/pages/${p.id}`, { headers: { "if-match": `"${p.revisionId}"` } });
    expect(fingerprint(await view(env, `/s/${link.token}`))).toEqual(await unknown404());
  });

  it("keeps working when the page moves inside the workspace; a sub-page moved out of the subtree drops out", async () => {
    const top = await createPage(env, owner, ws, { title: "Top" });
    const elsewhere = await createPage(env, owner, ws, { title: "Elsewhere" });
    const sub = await createPage(env, owner, ws, { title: "Sub", parentId: top.id });
    const link = await share(env, owner, ws, top.id);
    expect((await view(env, `/s/${link.token}/p/${sub.id}`)).status).toBe(200);
    const moved = await env.api(owner, "POST", `/workspaces/${ws}/pages/${sub.id}/move`, { headers: { "if-match": `"${sub.revisionId}"` }, json: { parentId: elsewhere.id } });
    expect(moved.status, moved.text).toBe(200);
    expect(fingerprint(await view(env, `/s/${link.token}/p/${sub.id}`))).toEqual(await unknown404());
    expect((await view(env, `/s/${link.token}`)).text).not.toContain("Sub");
    const movedTop = await env.api(owner, "POST", `/workspaces/${ws}/pages/${top.id}/move`, { headers: { "if-match": `"${top.revisionId}"` }, json: { parentId: elsewhere.id } });
    expect(movedTop.status).toBe(200);
    expect((await view(env, `/s/${link.token}`)).status).toBe(200);
  });

  it("re-checks the creator on every request: demoted to viewer or removed, it stops; promoted back, it works", async () => {
    const p = await createPage(env, owner, ws, { title: "Creator check" });
    const link = await share(env, editor, ws, p.id);
    expect((await view(env, `/s/${link.token}`)).status).toBe(200);
    await env.db.query("UPDATE memberships SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2", [ws, editor.userId]);
    expect(fingerprint(await view(env, `/s/${link.token}`))).toEqual(await unknown404());
    await env.db.query("UPDATE memberships SET role = 'editor' WHERE workspace_id = $1 AND user_id = $2", [ws, editor.userId]);
    expect((await view(env, `/s/${link.token}`)).status).toBe(200);
    await env.db.query("DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2", [ws, editor.userId]);
    expect(fingerprint(await view(env, `/s/${link.token}`))).toEqual(await unknown404());
    await env.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'editor')", [ws, editor.userId]);
  });

  it("stops when the workspace later forbids exporting", async () => {
    const other = await env.workspace("Later closed", { members: { [owner.userId]: "owner" } });
    const p = await createPage(env, owner, other, { title: "P" });
    const link = await share(env, owner, other, p.id);
    expect((await view(env, `/s/${link.token}`)).status).toBe(200);
    await env.db.query("UPDATE workspaces SET export_restricted = true WHERE id = $1", [other]);
    expect(fingerprint(await view(env, `/s/${link.token}`))).toEqual(await unknown404());
  });

  it("stops when the operator switches the capability off (PUBLIC_SHARE=off), with the same 404; the calls are 501", async () => {
    const p = await createPage(env, owner, ws, { title: "Switch" });
    const link = await share(env, owner, ws, p.id);
    expect((await view(env, `/s/${link.token}`)).status).toBe(200);
    const before = await unknown404();
    const saved = env.config.capabilities;
    env.config.capabilities = saved.filter((c) => c !== "public-share");
    await env.restart();
    try {
      expect(fingerprint(await view(env, `/s/${link.token}`))).toEqual(before);
      const res = await env.api(owner, "POST", `/workspaces/${ws}/pages/${p.id}/share-links`, { json: {} });
      expect([res.status, res.json.code]).toEqual([501, "capability_not_supported"]);
      expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${p.id}/share-links`)).status).toBe(501);
      expect((await env.api(null, "GET", "/capabilities")).json.capabilities).not.toContain("public-share");
    } finally {
      env.config.capabilities = saved;
      await env.restart();
    }
  });
});

describe("configuration: off, the trial's limits, and rate limits that do not tell whether a token exists", () => {
  it("PUBLIC_SHARE=off does not advertise the capability", async () => {
    const env = await startTestEnv({ env: { PUBLIC_SHARE: "off" } });
    try {
      const caps = await env.api(null, "GET", "/capabilities");
      expect(caps.json.capabilities).not.toContain("public-share");
      expect(caps.json.capabilities).toContain("attachments");
    } finally {
      await env.close();
    }
  });

  it("the trial allows 20 active links per workspace; the 21st is a clear 409, and revoking makes room", async () => {
    const env = await startTestEnv({ env: { THOTH_PROFILE: "trial", RATE_LIMIT_PER_ACCOUNT: "unlimited", RATE_LIMIT_PER_IP: "unlimited" } });
    try {
      const owner = await env.user("Owner");
      const ws = await env.workspace("W", { members: { [owner.userId]: "owner" } });
      const p = await createPage(env, owner, ws);
      const q = await createPage(env, owner, ws);
      const links: Shared[] = [];
      for (let i = 0; i < 20; i++) links.push(await share(env, owner, ws, i % 2 ? p.id : q.id));
      const over = await env.api(owner, "POST", `/workspaces/${ws}/pages/${p.id}/share-links`, { json: {} });
      expect(over.status).toBe(409);
      expect(over.headers.get("content-type")).toContain("application/problem+json");
      expect(over.json).toMatchObject({ code: "quota_exceeded", quota: "shareLinksPerWorkspace", limit: 20, current: 20 });
      expect(over.json.detail).toContain("20");
      await env.api(owner, "DELETE", `/workspaces/${ws}/share-links/${links[0]!.id}`);
      expect((await env.api(owner, "POST", `/workspaces/${ws}/pages/${p.id}/share-links`, { json: {} })).status).toBe(201);
      // Expired links do not count either.
      await env.db.query("UPDATE share_links SET expires_at = now() - interval '1 second' WHERE id = $1", [links[1]!.id]);
      expect((await env.api(owner, "POST", `/workspaces/${ws}/pages/${p.id}/share-links`, { json: {} })).status).toBe(201);
    } finally {
      await env.close();
    }
  });

  it("limits views per link: a known and an unknown token hit the limit at the same count with the same answer", async () => {
    const env = await startTestEnv({ env: { SHARE_VIEWS_PER_LINK: "3", RATE_LIMIT_WINDOW_SECONDS: "3600" } });
    try {
      const owner = await env.user("Owner");
      const ws = await env.workspace("W", { members: { [owner.userId]: "owner" } });
      const p = await createPage(env, owner, ws);
      const link = await share(env, owner, ws, p.id);
      const unknown = "U".repeat(32);
      for (let i = 0; i < 3; i++) {
        expect((await view(env, `/s/${link.token}`)).status).toBe(200);
        expect((await view(env, `/s/${unknown}`)).status).toBe(404);
      }
      const known = await view(env, `/s/${link.token}`);
      const stranger = await view(env, `/s/${unknown}`);
      expect(known.status).toBe(429);
      expect(refusal(known)).toEqual(refusal(stranger));
      expect(Number(known.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(known.headers.get("content-security-policy")).toBe(CSP);
      const asJson = await view(env, `/s/${link.token}`, { accept: "application/json" });
      expect(JSON.parse(asJson.text)).toMatchObject({ status: 429, code: "rate_limited" });
      // Another link is not affected.
      const other = await share(env, owner, ws, p.id);
      expect((await view(env, `/s/${other.token}`)).status).toBe(200);
    } finally {
      await env.close();
    }
  });

  it("limits views per IP across tokens, known or not", async () => {
    const env = await startTestEnv({ env: { SHARE_VIEWS_PER_IP: "4", RATE_LIMIT_WINDOW_SECONDS: "3600" } });
    try {
      const owner = await env.user("Owner");
      const ws = await env.workspace("W", { members: { [owner.userId]: "owner" } });
      const p = await createPage(env, owner, ws);
      const link = await share(env, owner, ws, p.id);
      for (const token of ["a", "b", "c"].map((c) => c.repeat(32))) expect((await view(env, `/s/${token}`)).status).toBe(404);
      expect((await view(env, `/s/${link.token}`)).status).toBe(200);
      const refused = await view(env, `/s/${link.token}`);
      expect(refused.status).toBe(429);
      expect(refusal(refused)).toEqual(refusal(await view(env, `/s/${"d".repeat(32)}`)));
    } finally {
      await env.close();
    }
  });

  it("the trial profile limits views per link and per IP by default", async () => {
    const env = await startTestEnv({ env: { THOTH_PROFILE: "trial" } });
    try {
      expect(env.config.share).toEqual({ maxLinksPerWorkspace: 20, viewsPerLink: 300, viewsPerIp: 120 });
    } finally {
      await env.close();
    }
  });
});
