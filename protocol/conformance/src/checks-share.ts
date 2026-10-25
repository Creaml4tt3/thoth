import { randomBytes } from "node:crypto";
import { newStableId } from "@thoth/domain";
import { ShareLinkCreatedSchema, ShareLinkListSchema, type ShareLinkCreated } from "@thoth/workspace-protocol";
import { expect, expectProblem, expectResponse, fail, parsed, requireWorkspace, skip, type Check, type Context } from "./support.ts";

/**
 * Capability `public-share` (ADR-0023): create, list and revoke share links through the protocol, and the public,
 * read-only page at `/s/<token>` on the server's origin, read without any credential.
 */
const HTML_ACCEPT = "text/html,application/xhtml+xml";
const DAY = 86_400_000;

interface ShareState {
  pageId: string;
  title: string;
  link: ShareLinkCreated;
}
const state = new WeakMap<Context, ShareState>();

function shared(ctx: Context): ShareState {
  return state.get(ctx) ?? skip("prerequisite public-share.create.returns-token-and-address did not pass");
}

async function createPage(ctx: Context, title: string, markdown: string): Promise<string> {
  const workspaceId = requireWorkspace(ctx);
  const id = newStableId();
  ctx.createdPageIds.add(id);
  const res = await ctx.client.call("putPage", { params: { workspaceId, pageId: id }, headers: { "if-none-match": "*" }, json: { title, markdown } });
  expectResponse(res, 201, `create ${title}`);
  return id;
}

/** The path of a share address, so the page is read from the origin under test even behind a different PUBLIC_URL. */
const pathOf = (url: string) => new URL(url).pathname;

const unknownToken = () => randomBytes(24).toString("base64url");

export const shareChecks: Check[] = [
  {
    id: "public-share.create.returns-token-and-address",
    title: "createShareLink returns 201 with a URL-safe token of at least 128 bits, its /s/<token> address and a 30-day default expiry",
    capability: "public-share",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const title = `Shared ${ctx.runId}`;
      const pageId = await createPage(ctx, title, `# ${title}\n\nRead-only words ${ctx.runId}.\n`);
      const before = Date.now();
      const res = await ctx.client.call("createShareLink", { params: { workspaceId, pageId }, json: {} });
      expectResponse(res, 201, "createShareLink");
      const link = parsed(ShareLinkCreatedSchema, res, "createShareLink");
      expect(link.pageId === pageId && link.workspaceId === workspaceId, "the link names the page and workspace it shares");
      expect(/^[A-Za-z0-9_-]+$/.test(link.token) && Buffer.from(link.token, "base64url").length >= 16, "the token is URL-safe base64 of at least 16 bytes");
      expect(pathOf(link.url) === `/s/${link.token}`, `url ends in /s/<token>, got path ${pathOf(link.url)}`);
      expect(link.expiresAt !== null, "the default expiry is not never");
      const days = (Date.parse(link.expiresAt) - before) / DAY;
      expect(days > 29.9 && days < 30.1, `the default expiry is 30 days, got ${days.toFixed(2)}`);
      state.set(ctx, { pageId, title, link });
      return `link ${link.id}, expires ${link.expiresAt}`;
    },
  },
  {
    id: "public-share.create.expiry-choices",
    title: "createShareLink accepts expiresInDays 7, 90 and null (never), and refuses anything else with 400",
    capability: "public-share",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const { pageId } = shared(ctx);
      for (const [choice, days] of [[7, 7], [90, 90], [null, null]] as const) {
        const res = await ctx.client.call("createShareLink", { params: { workspaceId, pageId }, json: { expiresInDays: choice } });
        expectResponse(res, 201, `createShareLink ${String(choice)}`);
        const link = parsed(ShareLinkCreatedSchema, res, "createShareLink");
        if (days === null) expect(link.expiresAt === null, "null means never");
        else expect(link.expiresAt !== null && Math.round((Date.parse(link.expiresAt) - Date.now()) / DAY) === days, `${days} days`);
        const revoke = await ctx.client.call("revokeShareLink", { params: { workspaceId, linkId: link.id } });
        expectResponse(revoke, 204, "revokeShareLink");
      }
      const bad = await ctx.client.call("createShareLink", { params: { workspaceId, pageId }, json: { expiresInDays: 31 } });
      expectProblem(bad, 400, "validation_failed", "createShareLink with 31 days");
      return "7, 90 and never accepted; 31 refused";
    },
  },
  {
    id: "public-share.auth.required",
    title: "the share-link calls need a credential (401 without one)",
    capability: "public-share",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const { pageId } = shared(ctx);
      expectProblem(await ctx.client.call("createShareLink", { params: { workspaceId, pageId }, json: {}, auth: "none" }), 401, "unauthenticated", "createShareLink without credentials");
      expectProblem(await ctx.client.call("listShareLinks", { params: { workspaceId, pageId }, auth: "none" }), 401, "unauthenticated", "listShareLinks without credentials");
    },
  },
  {
    id: "public-share.list.active-without-token",
    title: "listShareLinks lists the page's active links and never returns a token",
    capability: "public-share",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const { pageId, link } = shared(ctx);
      const res = await ctx.client.call("listShareLinks", { params: { workspaceId, pageId } });
      expectResponse(res, 200, "listShareLinks");
      const list = parsed(ShareLinkListSchema, res, "listShareLinks");
      expect(list.items.some((l) => l.id === link.id), "the new link is listed");
      expect(!new TextDecoder().decode(res.bytes).includes(link.token), "the list does not carry the token");
      return `${list.items.length} active link(s)`;
    },
  },
  {
    id: "public-share.view.read-only-html",
    title: "GET /s/<token> without credentials is the page as HTML: no script, a strict CSP, noindex, no referrer, nosniff",
    capability: "public-share",
    async run(ctx) {
      const { link, title } = shared(ctx);
      const res = await ctx.client.publicGet(pathOf(link.url), HTML_ACCEPT);
      expect(res.status === 200, `expected HTTP 200, got ${res.status}`);
      expect((res.headers.get("content-type") ?? "").startsWith("text/html"), `content-type is HTML, got ${res.headers.get("content-type")}`);
      const csp = (res.headers.get("content-security-policy") ?? "").toLowerCase();
      for (const part of ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) expect(csp.includes(part), `CSP has ${part}: ${csp}`);
      expect(!csp.includes("script-src") && !csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"), `CSP allows no script: ${csp}`);
      expect(/noindex/i.test(res.headers.get("x-robots-tag") ?? ""), "X-Robots-Tag: noindex");
      expect(res.headers.get("referrer-policy") === "no-referrer", "Referrer-Policy: no-referrer");
      expect(res.headers.get("x-content-type-options") === "nosniff", "X-Content-Type-Options: nosniff");
      expect(/<meta name="robots" content="noindex/i.test(res.text), "a robots meta tag");
      expect(!/<script/i.test(res.text), "no script element");
      expect(res.text.includes(title) && res.text.includes(`Read-only words ${ctx.runId}.`), "the page's title and text are shown");
      const workspaceId = requireWorkspace(ctx);
      expect(!res.text.includes(workspaceId), "the workspace ID is not shown");
    },
  },
  {
    id: "public-share.view.unknown-token-404",
    title: "an unknown token is 404, with no credential needed and nothing about why",
    capability: "public-share",
    async run(ctx) {
      const res = await ctx.client.publicGet(`/s/${unknownToken()}`, HTML_ACCEPT);
      expect(res.status === 404, `expected HTTP 404, got ${res.status}`);
      expect(!/<script/i.test(res.text), "no script element");
    },
  },
  {
    id: "public-share.revoke.stops-link",
    title: "revokeShareLink is 204; afterwards the address answers exactly like an unknown token and the list no longer has it",
    capability: "public-share",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const { link, pageId } = shared(ctx);
      expectResponse(await ctx.client.call("revokeShareLink", { params: { workspaceId, linkId: link.id } }), 204, "revokeShareLink");
      expectResponse(await ctx.client.call("revokeShareLink", { params: { workspaceId, linkId: link.id } }), 204, "revokeShareLink again");
      const revoked = await ctx.client.publicGet(pathOf(link.url), HTML_ACCEPT);
      const unknown = await ctx.client.publicGet(`/s/${unknownToken()}`, HTML_ACCEPT);
      if (revoked.status !== 404) fail(`a revoked link answers HTTP ${revoked.status}, expected 404`);
      expect(revoked.text === unknown.text && revoked.headers.get("content-type") === unknown.headers.get("content-type"), "a revoked link and an unknown token get the same answer");
      const list = parsed(ShareLinkListSchema, await ctx.client.call("listShareLinks", { params: { workspaceId, pageId } }), "listShareLinks");
      expect(!list.items.some((l) => l.id === link.id), "the revoked link is not listed");
    },
  },
];
