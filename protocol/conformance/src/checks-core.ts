import {
  CapabilitiesSchema,
  MeSchema,
  PageResourceSchema,
  RevisionConflictProblemSchema,
  RevisionListSchema,
  RevisionSummarySchema,
  TreePageSchema,
  WorkspaceListSchema,
  isCompatibleProtocolVersion,
  parseEtag,
  type PageResource,
  type RevisionSummary,
} from "@thoth/workspace-protocol";
import { newStableId } from "@thoth/domain";
import {
  deepEqual,
  etagOf,
  expect,
  expectProblem,
  expectResponse,
  fail,
  parsed,
  readFeed,
  requirePrimary,
  requireWorkspace,
  sha256,
  skip,
  utf8Length,
  type Check,
  type Context,
} from "./support.ts";
import type { ApiResponse } from "./http.ts";

const INVALID_CURSOR_PREFIX = "zz-not-a-cursor-";

function pageParams(ctx: Context, pageId: string) {
  return { workspaceId: requireWorkspace(ctx), pageId };
}

function putPage(ctx: Context, pageId: string, body: unknown, headers: Record<string, string>) {
  return ctx.client.call("putPage", { params: pageParams(ctx, pageId), json: body, headers });
}

function getPage(ctx: Context, pageId: string, revision?: string) {
  return ctx.client.call("getPage", { params: pageParams(ctx, pageId), query: { revision } });
}

/** Creates a page with If-None-Match and records it for cleanup. */
export async function createPage(ctx: Context, input: { id?: string; title: string; markdown: string; headers?: Record<string, string> }): Promise<{ id: string; res: ApiResponse }> {
  const id = input.id ?? newStableId();
  ctx.createdPageIds.add(id);
  const res = await putPage(ctx, id, { title: input.title, markdown: input.markdown }, { "if-none-match": "*", ...input.headers });
  return { id, res };
}

function currentEtagOf(res: ApiResponse): string {
  const etag = etagOf(res);
  if (!etag) fail("response has no ETag header");
  return etag;
}

async function readPage(ctx: Context, pageId: string, what: string): Promise<{ page: PageResource; etag: string }> {
  const res = await getPage(ctx, pageId);
  expectResponse(res, 200, what);
  return { page: parsed(PageResourceSchema, res, what), etag: currentEtagOf(res) };
}

export const coreChecks: Check[] = [
  {
    id: "core.capabilities.shape",
    title: "GET /capabilities is public and has a valid protocolVersion and capability list",
    capability: "core",
    async run(ctx) {
      const res = await ctx.client.call("getCapabilities");
      expectResponse(res, 200, "GET /capabilities without credentials");
      const caps = parsed(CapabilitiesSchema, res, "capabilities");
      expect(isCompatibleProtocolVersion(caps.protocolVersion), `protocolVersion ${caps.protocolVersion} is not a 1.x version this suite understands`);
      ctx.capabilities = caps;
      return `protocolVersion ${caps.protocolVersion}; capabilities: ${caps.capabilities.length ? caps.capabilities.join(", ") : "(none listed)"}`;
    },
  },
  {
    id: "core.errors.unknown-route",
    title: "An unknown route returns application/problem+json with code not_found",
    capability: "core",
    async run(ctx) {
      const res = await ctx.client.unrouted("GET", `/api/v1/conformance-unknown-route-${ctx.runId}`);
      expectProblem(res, 404, "not_found", "unknown route");
      return "404 not_found as problem+json";
    },
  },
  {
    id: "core.errors.unauthenticated",
    title: "A request without or with an invalid credential returns 401 unauthenticated and WWW-Authenticate",
    capability: "core",
    async run(ctx) {
      for (const auth of ["none", "bad"] as const) {
        const res = await ctx.client.call("getMe", { auth });
        expectProblem(res, 401, "unauthenticated", `GET /me (${auth === "none" ? "no credential" : "invalid credential"})`);
        expect(res.headers.get("www-authenticate"), `GET /me (${auth}): 401 response lacks a WWW-Authenticate header (RFC 9110 section 11.6.1)`);
      }
      return "401 unauthenticated for a missing and an invalid credential";
    },
  },
  {
    id: "core.me.shape",
    title: "GET /me returns the principal",
    capability: "core",
    async run(ctx) {
      const res = await ctx.client.call("getMe");
      expectResponse(res, 200, "GET /me");
      const me = parsed(MeSchema, res, "me");
      return `principal ${me.id}`;
    },
  },
  {
    id: "core.workspaces.list",
    title: "GET /workspaces lists workspaces with roles; a writable workspace is selected for the write checks",
    capability: "core",
    async run(ctx) {
      let cursor: string | undefined;
      const seen: { id: string; role: string }[] = [];
      for (let pageNo = 0; pageNo < 50; pageNo++) {
        const res = await ctx.client.call("listWorkspaces", { query: { cursor, limit: 50 } });
        expectResponse(res, 200, "GET /workspaces");
        const list = parsed(WorkspaceListSchema, res, "workspace list");
        for (const w of list.items) seen.push({ id: w.id, role: w.role });
        if (!list.nextCursor) break;
        cursor = list.nextCursor;
      }
      const ids = seen.map((w) => w.id);
      expect(new Set(ids).size === ids.length, "workspace list contains duplicate workspace IDs across pages");
      const wanted = ctx.options.workspaceId;
      const writable = seen.find((w) => (wanted ? w.id === wanted : true) && (w.role === "owner" || w.role === "editor"));
      if (writable) ctx.workspaceId = writable.id;
      if (!writable) return `${seen.length} workspace(s); none ${wanted ? `matching ${wanted} ` : ""}with role owner or editor, so write checks will be skipped`;
      return `${seen.length} workspace(s); using ${writable.id} (role ${writable.role})`;
    },
  },
  {
    id: "core.tree.shape",
    title: "GET /workspaces/{id}/tree is paginated and returns a stable changeCursor",
    capability: "core",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const first = await ctx.client.call("getWorkspaceTree", { params: { workspaceId }, query: { limit: 1 } });
      expectResponse(first, 200, "GET tree");
      const page = parsed(TreePageSchema, first, "tree page");
      expect(page.workspaceId === workspaceId, `tree workspaceId ${page.workspaceId} differs from the requested ${workspaceId}`);
      expect(page.items.length <= 1, `limit=1 returned ${page.items.length} items`);
      ctx.baselineCursor = page.changeCursor;
      if (page.nextCursor) {
        const second = await ctx.client.call("getWorkspaceTree", { params: { workspaceId }, query: { limit: 1, cursor: page.nextCursor } });
        expectResponse(second, 200, "GET tree (second page)");
        const next = parsed(TreePageSchema, second, "tree page 2");
        expect(next.changeCursor === page.changeCursor, "changeCursor differs between pages of one tree traversal");
        expect(!next.items.some((n) => page.items.some((m) => m.id === n.id)), "tree pages overlap");
      }
      return "tree page and changeCursor valid";
    },
  },
  {
    id: "core.pages.create-returns-etag",
    title: "PUT with If-None-Match: * creates a page (201) and returns an ETag equal to the revision",
    capability: "core",
    async run(ctx) {
      const markdown = `# Conformance ${ctx.runId}\n\nสวัสดี Thoth 🌿 revision one\n`;
      const { id, res } = await createPage(ctx, { title: `Conformance ${ctx.runId}`, markdown });
      expectResponse(res, 201, "create page");
      const page = parsed(PageResourceSchema, res, "created page");
      const etag = parseEtag(etagOf(res));
      expect(etag, `ETag header is missing or not a single strong entity tag: ${String(etagOf(res))}`);
      expect(page.id === id, `body id ${page.id} differs from the path id ${id}`);
      expect(page.revision.id === etag, `ETag ${etag} differs from revision.id ${page.revision.id}`);
      expect(page.markdown === markdown, "body markdown differs from what was written");
      expect(page.revision.parentId === null, "first revision must have parentId null");
      expect(page.revision.contentHash === sha256(markdown), "revision.contentHash is not the SHA-256 of the UTF-8 markdown");
      expect(page.revision.size === utf8Length(markdown), `revision.size ${page.revision.size} is not the UTF-8 byte length ${utf8Length(markdown)}`);
      expect(page.metadata.workspaceId === requireWorkspace(ctx), "metadata.workspaceId differs from the workspace");
      expect(page.metadata.parentId === null, "a page created without parentId must be at the root");
      ctx.primary = {
        id,
        markdownByRevision: new Map([[page.revision.id, markdown]]),
        revisionSnapshots: new Map([[page.revision.id, page.revision]]),
        rev1: page.revision.id,
        rev2: null,
      };
      return `created ${id} at revision ${etag}`;
    },
  },
  {
    id: "core.pages.get-same-revision",
    title: "GET returns the same revision and body as the create response",
    capability: "core",
    async run(ctx) {
      const primary = requirePrimary(ctx);
      const res = await getPage(ctx, primary.id);
      expectResponse(res, 200, "GET page");
      const page = parsed(PageResourceSchema, res, "page");
      expect(parseEtag(etagOf(res)) === primary.rev1, `ETag ${String(etagOf(res))} differs from the created revision ${primary.rev1}`);
      expect(page.revision.id === primary.rev1, `revision.id ${page.revision.id} differs from ${primary.rev1}`);
      expect(page.markdown === primary.markdownByRevision.get(primary.rev1), "GET markdown differs from what was written");
      expect(deepEqual(page.revision, primary.revisionSnapshots.get(primary.rev1)), "revision object differs between the create response and GET");
      return `revision ${primary.rev1}`;
    },
  },
  {
    id: "core.pages.create-twice-conflict",
    title: "PUT with If-None-Match: * on an existing page returns 412 revision_conflict with the current revision",
    capability: "core",
    async run(ctx) {
      const primary = requirePrimary(ctx);
      const res = await putPage(ctx, primary.id, { title: "Should not replace", markdown: "# overwritten\n" }, { "if-none-match": "*" });
      expectProblem(res, 412, "revision_conflict", "create over existing page");
      const problem = parsed(RevisionConflictProblemSchema, res, "conflict problem");
      expect(problem.currentRevision.id === primary.rev1, `currentRevision ${problem.currentRevision.id} is not the current revision ${primary.rev1}`);
      const { page } = await readPage(ctx, primary.id, "GET after rejected create");
      expect(page.markdown === primary.markdownByRevision.get(primary.rev1), "page content changed after a rejected create");
      return "412 revision_conflict; content unchanged";
    },
  },
  {
    id: "core.pages.write-requires-precondition",
    title: "A PUT without If-Match or If-None-Match returns 428 precondition_required",
    capability: "core",
    async run(ctx) {
      const primary = requirePrimary(ctx);
      const res = await putPage(ctx, primary.id, { title: "No precondition", markdown: "# no precondition\n" }, {});
      expectProblem(res, 428, "precondition_required", "PUT without precondition");
      const { page } = await readPage(ctx, primary.id, "GET after rejected write");
      expect(page.markdown === primary.markdownByRevision.get(primary.rev1), "page content changed after a write without precondition");
      return "428 precondition_required; content unchanged";
    },
  },
  {
    id: "core.pages.validation-failed",
    title: "Invalid bodies and contradictory preconditions return 400 validation_failed and write nothing",
    capability: "core",
    async run(ctx) {
      requireWorkspace(ctx);
      const badId = newStableId();
      const invalid = await putPage(ctx, badId, { title: "", markdown: 5 }, { "if-none-match": "*" });
      expectProblem(invalid, 400, "validation_failed", "PUT with an invalid body");
      const gone = await getPage(ctx, badId);
      expectProblem(gone, 404, "not_found", "GET of a page whose create was rejected");
      const primary = requirePrimary(ctx);
      const both = await putPage(ctx, primary.id, { title: "Both", markdown: "# both\n" }, { "if-none-match": "*", "if-match": `"${primary.rev1}"` });
      expectProblem(both, 400, "validation_failed", "PUT with both If-Match and If-None-Match");
      return "400 validation_failed for an invalid body and for both preconditions";
    },
  },
  {
    id: "core.pages.not-found",
    title: "An unknown page returns 404 not_found for GET and for an If-Match update",
    capability: "core",
    async run(ctx) {
      requireWorkspace(ctx);
      const missing = newStableId();
      const get = await getPage(ctx, missing);
      expectProblem(get, 404, "not_found", "GET unknown page");
      const put = await putPage(ctx, missing, { title: "x", markdown: "x" }, { "if-match": `"does-not-exist"` });
      expectProblem(put, 404, "not_found", "If-Match update of an unknown page");
      return "404 not_found";
    },
  },
  {
    id: "core.pages.update-with-if-match",
    title: "PUT with a matching If-Match updates the page (200), returns a new ETag and links the parent revision",
    capability: "core",
    async run(ctx) {
      const primary = requirePrimary(ctx);
      const markdown = `# Conformance ${ctx.runId}\n\nrevision two\n`;
      const res = await putPage(ctx, primary.id, { title: `Conformance ${ctx.runId} v2`, markdown }, { "if-match": `"${primary.rev1}"` });
      expectResponse(res, 200, "update with If-Match");
      const page = parsed(PageResourceSchema, res, "updated page");
      const etag = parseEtag(etagOf(res));
      expect(etag && etag !== primary.rev1, "update must return a new ETag different from the previous one");
      expect(page.revision.id === etag, "ETag differs from revision.id");
      expect(page.revision.parentId === primary.rev1, `revision.parentId ${String(page.revision.parentId)} is not the replaced revision ${primary.rev1}`);
      expect(page.markdown === markdown, "body markdown differs from what was written");
      primary.rev2 = page.revision.id;
      primary.markdownByRevision.set(page.revision.id, markdown);
      primary.revisionSnapshots.set(page.revision.id, page.revision);
      const check = await readPage(ctx, primary.id, "GET after update");
      expect(check.page.revision.id === page.revision.id && check.page.markdown === markdown, "GET after update does not return the updated page");
      return `revision ${primary.rev1} -> ${page.revision.id}`;
    },
  },
  {
    id: "core.pages.stale-if-match-conflict",
    title: "A stale If-Match returns 412 revision_conflict with the current revision and does not overwrite",
    capability: "core",
    async run(ctx) {
      const primary = requirePrimary(ctx);
      if (!primary.rev2) skip("prerequisite core.pages.update-with-if-match did not pass");
      const res = await putPage(ctx, primary.id, { title: "Stale write", markdown: "# STALE WRITE MUST NOT LAND\n" }, { "if-match": `"${primary.rev1}"` });
      const after = await getPage(ctx, primary.id);
      const landed = after.status === 200 && (after.body as { markdown?: unknown } | undefined)?.markdown === "# STALE WRITE MUST NOT LAND\n";
      if (res.status !== 412) fail(`stale write was answered with HTTP ${res.status} instead of 412${landed ? " and it overwrote the page" : ""}`);
      expectProblem(res, 412, "revision_conflict", "stale write");
      const problem = parsed(RevisionConflictProblemSchema, res, "conflict problem");
      expect(problem.currentRevision.id === primary.rev2, `currentRevision ${problem.currentRevision.id} is not the current revision ${primary.rev2}`);
      expect(!landed, "the stale write overwrote the page");
      const check = await readPage(ctx, primary.id, "GET after stale write");
      expect(check.page.revision.id === primary.rev2, `current revision is ${check.page.revision.id} after a rejected write, expected ${primary.rev2}`);
      expect(check.page.markdown === primary.markdownByRevision.get(primary.rev2), "page content changed after a rejected stale write");
      return "412 revision_conflict; content not overwritten";
    },
  },
  {
    id: "core.revisions.list",
    title: "GET .../revisions lists revisions newest first, linked by parentId, with working pagination",
    capability: "core",
    async run(ctx) {
      const primary = requirePrimary(ctx);
      const workspaceId = requireWorkspace(ctx);
      const all: RevisionSummary[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 100; i++) {
        const res = await ctx.client.call("listPageRevisions", { params: { workspaceId, pageId: primary.id }, query: { limit: 1, cursor } });
        expectResponse(res, 200, "list revisions");
        const list = parsed(RevisionListSchema, res, "revision list");
        expect(list.items.length <= 1, `limit=1 returned ${list.items.length} revisions`);
        all.push(...list.items);
        if (!list.nextCursor) break;
        cursor = list.nextCursor;
      }
      const ids = all.map((r) => r.id);
      expect(new Set(ids).size === ids.length, "revision listing repeats a revision across pages");
      const at = (id: string) => ids.indexOf(id);
      expect(at(primary.rev1) >= 0, `revision ${primary.rev1} is not listed`);
      if (primary.rev2) {
        expect(at(primary.rev2) >= 0, `revision ${primary.rev2} is not listed`);
        expect(at(primary.rev2) < at(primary.rev1), "revisions are not ordered newest first");
        const second = all[at(primary.rev2)]!;
        expect(second.parentId === primary.rev1, "the second revision does not name the first as parentId");
      }
      const first = all[at(primary.rev1)]!;
      expect(first.parentId === null, "the first revision must have parentId null");
      expect(all.every((r) => r.pageId === primary.id), "a listed revision belongs to a different page");
      return `${all.length} revision(s) listed`;
    },
  },
  {
    id: "core.revisions.immutable",
    title: "Earlier revisions are immutable: listing and ?revision= still return the original data",
    capability: "core",
    async run(ctx) {
      const primary = requirePrimary(ctx);
      const workspaceId = requireWorkspace(ctx);
      const listed = new Map<string, unknown>();
      let cursor: string | undefined;
      for (let i = 0; i < 100; i++) {
        const res = await ctx.client.call("listPageRevisions", { params: { workspaceId, pageId: primary.id }, query: { cursor } });
        expectResponse(res, 200, "list revisions");
        const list = parsed(RevisionListSchema, res, "revision list");
        for (const item of list.items) listed.set(item.id, item);
        if (!list.nextCursor) break;
        cursor = list.nextCursor;
      }
      for (const [id, snapshot] of primary.revisionSnapshots) {
        const entry = listed.get(id);
        expect(entry !== undefined, `revision ${id} disappeared from the listing`);
        expect(deepEqual(RevisionSummarySchema.parse(entry), RevisionSummarySchema.parse(snapshot)), `revision ${id} changed after it was created`);
        const res = await getPage(ctx, primary.id, id);
        expectResponse(res, 200, `GET ?revision=${id}`);
        const page = parsed(PageResourceSchema, res, "historical page");
        expect(parseEtag(etagOf(res)) === id, `ETag of ?revision=${id} is ${String(etagOf(res))}`);
        expect(page.markdown === primary.markdownByRevision.get(id), `content of revision ${id} changed`);
        expect(page.revision.id === id, `?revision=${id} returned revision ${page.revision.id}`);
      }
      return `${primary.revisionSnapshots.size} revision(s) verified unchanged`;
    },
  },
  {
    id: "core.idempotency.replay",
    title: "An Idempotency-Key replay returns the same response and creates no second revision",
    capability: "core",
    async run(ctx) {
      requireWorkspace(ctx);
      const id = newStableId();
      ctx.createdPageIds.add(id);
      const key = `conformance-${ctx.runId}-replay`;
      const body = { title: `Idempotent ${ctx.runId}`, markdown: `# Idempotent ${ctx.runId}\n` };
      const headers = { "if-none-match": "*", "idempotency-key": key };
      const first = await putPage(ctx, id, body, headers);
      expectResponse(first, 201, "first request");
      const replay = await putPage(ctx, id, body, headers);
      expectResponse(replay, 201, "replayed request (must return the original 201, not 412)");
      expect(etagOf(replay) === etagOf(first), `replay ETag ${String(etagOf(replay))} differs from the original ${String(etagOf(first))}`);
      expect(deepEqual(replay.body, first.body), "replay body differs from the original response body");
      const revisions = await ctx.client.call("listPageRevisions", { params: { workspaceId: requireWorkspace(ctx), pageId: id } });
      expectResponse(revisions, 200, "list revisions after replay");
      const list = parsed(RevisionListSchema, revisions, "revision list");
      expect(list.items.length === 1, `the replay created ${list.items.length - 1} extra revision(s)`);
      return "replay returned the original 201 response; one revision";
    },
  },
  {
    id: "core.idempotency.key-reuse-different-body",
    title: "Reusing an Idempotency-Key with a different body returns 422 idempotency_key_reused",
    capability: "core",
    async run(ctx) {
      requireWorkspace(ctx);
      const id = newStableId();
      ctx.createdPageIds.add(id);
      const key = `conformance-${ctx.runId}-reuse`;
      const headers = { "if-none-match": "*", "idempotency-key": key };
      const first = await putPage(ctx, id, { title: "Original", markdown: "# original\n" }, headers);
      expectResponse(first, 201, "first request");
      const reuse = await putPage(ctx, id, { title: "Different", markdown: "# different body\n" }, headers);
      expectProblem(reuse, 422, "idempotency_key_reused", "same key, different body");
      const { page } = await readPage(ctx, id, "GET after key reuse");
      expect(page.markdown === "# original\n", "the request with a reused key changed the page");
      return "422 idempotency_key_reused; page unchanged";
    },
  },
  {
    id: "core.pages.delete",
    title: "DELETE requires If-Match (428), rejects a stale tag (412), then deletes (204) and the page is gone (404)",
    capability: "core",
    async run(ctx) {
      const primary = requirePrimary(ctx);
      const params = pageParams(ctx, primary.id);
      const current = await readPage(ctx, primary.id, "GET before delete");
      const none = await ctx.client.call("deletePage", { params });
      expectProblem(none, 428, "precondition_required", "DELETE without If-Match");
      const staleTag = current.page.revision.id !== primary.rev1 ? primary.rev1 : `stale-${ctx.runId}`;
      const stale = await ctx.client.call("deletePage", { params, headers: { "if-match": `"${staleTag}"` } });
      if (stale.status === 204) fail("DELETE with a stale If-Match succeeded; it must return 412");
      expectProblem(stale, 412, "revision_conflict", "DELETE with stale If-Match");
      const stillThere = await getPage(ctx, primary.id);
      expectResponse(stillThere, 200, "GET after rejected deletes");
      const done = await ctx.client.call("deletePage", { params, headers: { "if-match": current.etag } });
      expectResponse(done, 204, "DELETE with current If-Match");
      expect(done.bytes.length === 0, "a 204 response must have an empty body");
      const gone = await getPage(ctx, primary.id);
      expectProblem(gone, 404, "not_found", "GET after delete");
      return "428, 412, 204, then 404";
    },
  },
  {
    id: "core.changes.includes-write",
    title: "The change feed from the baseline cursor includes the create, update and delete in order",
    capability: "core",
    async run(ctx) {
      const primary = requirePrimary(ctx);
      const workspaceId = requireWorkspace(ctx);
      if (!ctx.baselineCursor) skip("prerequisite core.tree.shape did not pass (no baseline cursor)");
      const feed = await readFeed(ctx, workspaceId, ctx.baselineCursor, undefined, "change feed");
      const mine = feed.entries.filter((e) => e.pageId === primary.id);
      const kinds = mine.map((e) => e.kind);
      const created = mine.findIndex((e) => e.kind === "page.created");
      const updated = mine.findIndex((e) => e.kind === "page.updated");
      const deleted = mine.findIndex((e) => e.kind === "page.deleted");
      expect(created >= 0, `no page.created entry for the page (saw: ${kinds.join(", ") || "none"})`);
      expect(mine[created]!.revisionId === primary.rev1, "page.created does not carry the created revision ID");
      if (primary.rev2) {
        expect(updated >= 0, `no page.updated entry for the page (saw: ${kinds.join(", ")})`);
        expect(mine[updated]!.revisionId === primary.rev2, "page.updated does not carry the new revision ID");
        expect(created < updated, "page.created must precede page.updated in the feed");
      }
      expect(deleted >= 0, `no page.deleted entry for the page (saw: ${kinds.join(", ")})`);
      expect(updated < deleted && created < deleted, "page.deleted must come after the earlier entries");
      expect(feed.lastHasMore === false, "the traversal ended while hasMore was still true");
      return `${feed.entries.length} entries in ${feed.requests} request(s); the page's create, update and delete are present`;
    },
  },
  {
    id: "core.changes.pagination-complete",
    title: "Following cursors with limit=1 yields the same entries as an unpaged read: complete, no duplicates",
    capability: "core",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      requirePrimary(ctx);
      if (!ctx.baselineCursor) skip("prerequisite core.tree.shape did not pass (no baseline cursor)");
      const mine = (e: { pageId?: string | undefined }) => e.pageId !== undefined && ctx.createdPageIds.has(e.pageId);
      const full = await readFeed(ctx, workspaceId, ctx.baselineCursor, undefined, "unpaged feed read");
      const paged = await readFeed(ctx, workspaceId, ctx.baselineCursor, 1, "limit=1 feed read");
      const ids = paged.entries.map((e) => e.id);
      expect(new Set(ids).size === ids.length, "paging with limit=1 returned the same entry more than once");
      const fullMine = full.entries.filter(mine).map((e) => e.id);
      const pagedMine = paged.entries.filter(mine).map((e) => e.id);
      expect(fullMine.length > 0, "the feed contains none of this run's writes");
      expect(deepEqual(pagedMine, fullMine), `limit=1 traversal returned ${pagedMine.length} of this run's entries, an unpaged read returned ${fullMine.length}`);
      expect(paged.lastHasMore === false, "the limit=1 traversal ended while hasMore was still true");
      return `${pagedMine.length} of this run's entries matched across ${paged.requests} paged request(s)`;
    },
  },
  {
    id: "core.changes.cursor-invalid",
    title: "A malformed or foreign cursor returns 400 cursor_invalid",
    capability: "core",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const res = await ctx.client.call("listWorkspaceChanges", { params: { workspaceId }, query: { cursor: `${INVALID_CURSOR_PREFIX}${ctx.runId}` } });
      expectProblem(res, 400, "cursor_invalid", "change feed with a bogus cursor");
      return "400 cursor_invalid";
    },
  },
];
