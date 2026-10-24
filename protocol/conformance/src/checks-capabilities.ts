import { randomBytes } from "node:crypto";
import {
  AttachmentResourceSchema,
  ChangeHintEventSchema,
  ChangesResponseSchema,
  PageResourceSchema,
  RevisionListSchema,
  SSE_EVENT_NAME,
  SearchResponseSchema,
  TransferResourceSchema,
  TreeNodeSchema,
  TreePageSchema,
  parseEtag,
  type TreeNode,
} from "@thoth/workspace-protocol";
import { newStableId } from "@thoth/domain";
import { createPage } from "./checks-core.ts";
import { deepEqual, etagOf, expect, expectProblem, expectResponse, fail, parsed, requireWorkspace, sha256, skip, sleep, type Check, type Context } from "./support.ts";

const MIME = "application/x-thoth-conformance";

export const attachmentChecks: Check[] = [
  {
    id: "attachments.upload-download",
    title: "An uploaded attachment is stored with its hash, size and type, and downloads byte-identical",
    capability: "attachments",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const bytes = new Uint8Array([...randomBytes(200), 0, 255, 10, 13]);
      const upload = await ctx.client.call("uploadAttachment", {
        params: { workspaceId },
        query: { fileName: `conformance-${ctx.runId}.bin` },
        headers: { "content-type": MIME },
        body: bytes,
      });
      expectResponse(upload, 201, "upload");
      const meta = parsed(AttachmentResourceSchema, upload, "attachment resource");
      expect(meta.hash === sha256(bytes), "attachment hash is not the SHA-256 of the uploaded bytes");
      expect(meta.size === bytes.length, `attachment size ${meta.size} differs from the ${bytes.length} bytes uploaded`);
      expect(meta.mimeType === MIME, `attachment mimeType ${meta.mimeType} differs from the declared ${MIME}`);
      expect(meta.workspaceId === workspaceId, "attachment workspaceId differs");
      const location = upload.headers.get("location");
      expect(location?.endsWith(meta.id), `Location header ${String(location)} does not identify the attachment`);
      const download = await ctx.client.call("getAttachment", { params: { workspaceId, attachmentId: meta.id } });
      expectResponse(download, 200, "download");
      expect(download.contentType?.split(";")[0]?.trim().toLowerCase() === MIME, `download Content-Type is ${String(download.contentType)}, expected ${MIME}`);
      expect(sha256(download.bytes) === meta.hash, "downloaded bytes differ from the uploaded bytes");
      return `attachment ${meta.id}, ${meta.size} bytes`;
    },
  },
  {
    id: "attachments.idempotent-upload",
    title: "Replaying an upload with the same Idempotency-Key returns the same attachment",
    capability: "attachments",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const bytes = randomBytes(64);
      const init = { params: { workspaceId }, headers: { "content-type": MIME, "idempotency-key": `conformance-${ctx.runId}-upload` }, body: new Uint8Array(bytes) };
      const first = await ctx.client.call("uploadAttachment", init);
      expectResponse(first, 201, "first upload");
      const replay = await ctx.client.call("uploadAttachment", init);
      expectResponse(replay, 201, "replayed upload");
      expect(deepEqual(replay.body, first.body), "replayed upload returned a different attachment");
      return "replay returned the original attachment";
    },
  },
];

export const searchChecks: Check[] = [
  {
    id: "search.finds-page",
    title: "Search returns a hit for a page written by the principal (polling for index lag)",
    capability: "search",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const token = `thothconf${randomBytes(6).toString("hex")}`;
      const { id, res } = await createPage(ctx, { title: `Search ${ctx.runId}`, markdown: `# Search target\n\nunique word ${token} here\n` });
      expectResponse(res, 201, "create searchable page");
      const deadline = Date.now() + (ctx.options.searchTimeoutMs ?? 10_000);
      let attempts = 0;
      for (;;) {
        attempts++;
        const search = await ctx.client.call("searchWorkspace", { params: { workspaceId }, json: { query: token } });
        expectResponse(search, 200, "search");
        const result = parsed(SearchResponseSchema, search, "search response");
        if (result.items.some((hit) => hit.pageId === id)) return `hit after ${attempts} attempt(s)`;
        if (Date.now() >= deadline) fail(`page ${id} was not found by searching for "${token}" within ${ctx.options.searchTimeoutMs ?? 10_000} ms`);
        await sleep(250);
      }
    },
  },
  {
    id: "search.validation",
    title: "An empty search query returns 400 validation_failed",
    capability: "search",
    async run(ctx) {
      const res = await ctx.client.call("searchWorkspace", { params: { workspaceId: requireWorkspace(ctx) }, json: { query: "" } });
      expectProblem(res, 400, "validation_failed", "empty query");
      return "400 validation_failed";
    },
  },
];

/** Reads SSE events from a stream until `match` accepts one, or the timeout elapses. */
async function waitForEvent(body: ReadableStream<Uint8Array>, timeoutMs: number, match: (event: { event: string; data: string }) => boolean): Promise<{ event: string; data: string } | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), remaining));
      const chunk = await Promise.race([reader.read(), timer]);
      if (chunk === "timeout") return null;
      if (chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        const parsedEvent = { event, data: data.join("\n") };
        if (match(parsedEvent)) return parsedEvent;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export const eventChecks: Check[] = [
  {
    id: "events.sse.stream-opens",
    title: "GET .../events opens a text/event-stream response",
    capability: "events.sse",
    async run(ctx) {
      const controller = new AbortController();
      try {
        const { response, issues } = await ctx.client.stream("streamWorkspaceEvents", { params: { workspaceId: requireWorkspace(ctx) } }, controller);
        if (issues.length) fail(`events stream: ${issues.join("; ")}`);
        return `HTTP 200 ${response.headers.get("content-type")}`;
      } finally {
        controller.abort();
      }
    },
  },
  {
    id: "events.sse.hint-after-write",
    title: "A write is followed by a valid change hint event; the hint carries no page content",
    capability: "events.sse",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const controller = new AbortController();
      try {
        const { response, issues } = await ctx.client.stream("streamWorkspaceEvents", { params: { workspaceId } }, controller);
        if (issues.length) fail(`events stream: ${issues.join("; ")}`);
        if (!response.body) fail("the event stream has no body");
        const waiting = waitForEvent(response.body, ctx.options.eventTimeoutMs ?? 10_000, (e) => e.event === SSE_EVENT_NAME);
        const { res } = await createPage(ctx, { title: `Event ${ctx.runId}`, markdown: `# Event trigger ${ctx.runId}\n` });
        expectResponse(res, 201, "write that should trigger a hint");
        const event = await waiting;
        if (!event) fail(`no "${SSE_EVENT_NAME}" event arrived within ${ctx.options.eventTimeoutMs ?? 10_000} ms of a write`);
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch {
          fail("the event data is not JSON");
        }
        const hint = ChangeHintEventSchema.safeParse(payload);
        if (!hint.success) fail(`event payload invalid: ${hint.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
        expect(hint.data.workspaceId === workspaceId, "event workspaceId differs from the stream's workspace");
        expect(!event.data.includes("# Event trigger"), "the hint payload contains page content; it must only be a hint");
        return "hint event received and valid";
      } finally {
        controller.abort();
      }
    },
  },
];

function stagedBody(ctx: Context, operationId: string, pageId: string, markdown: string) {
  return {
    operationId,
    direction: "to_workspace" as const,
    mode: "copy" as const,
    pages: [{ sourceId: `local:conformance-${ctx.runId}`, pageId, parentId: null, title: `Transfer ${ctx.runId}`, markdown }],
  };
}

async function createToWorkspace(ctx: Context, operationId = newStableId(), pageId = newStableId(), markdown = "# transferred\n") {
  const workspaceId = requireWorkspace(ctx);
  ctx.createdPageIds.add(pageId);
  const body = stagedBody(ctx, operationId, pageId, markdown);
  const res = await ctx.client.call("createTransfer", { params: { workspaceId }, json: body, headers: { "idempotency-key": operationId } });
  return { operationId, pageId, body, res, workspaceId };
}

export const transferChecks: Check[] = [
  {
    id: "transfers.create-idempotent",
    title: "Creating a transfer stages it without publishing; replay returns the original, a changed body returns 422",
    capability: "transfers",
    async run(ctx) {
      const { operationId, pageId, body, res, workspaceId } = await createToWorkspace(ctx);
      expectResponse(res, 201, "create transfer");
      const transfer = parsed(TransferResourceSchema, res, "transfer");
      expect(transfer.operationId === operationId && transfer.direction === "to_workspace" && transfer.mode === "copy", "transfer does not echo operationId, direction and mode");
      expect(transfer.state === "stage", `a newly created transfer must be in state stage, got ${transfer.state}`);
      expect(transfer.items.length === 1 && transfer.items[0]!.pageId === pageId && transfer.items[0]!.state === "staged", "the staged item is not reported as staged");
      const hidden = await ctx.client.call("getPage", { params: { workspaceId, pageId } });
      expectProblem(hidden, 404, "not_found", "GET of a staged, uncommitted page");
      const replay = await ctx.client.call("createTransfer", { params: { workspaceId }, json: body, headers: { "idempotency-key": operationId } });
      expectResponse(replay, 201, "replayed create");
      expect(deepEqual(replay.body, res.body), "replayed create returned a different transfer");
      const changed = await ctx.client.call("createTransfer", { params: { workspaceId }, json: stagedBody(ctx, operationId, pageId, "# a different payload\n"), headers: { "idempotency-key": operationId } });
      expectProblem(changed, 422, "idempotency_key_reused", "same operationId, different body");
      const abort = await ctx.client.call("abortTransfer", { params: { operationId } });
      expectResponse(abort, 200, "abort of the idempotency probe");
      return `transfer ${operationId} staged; replay identical; staged page not visible`;
    },
  },
  {
    id: "transfers.get",
    title: "GET /transfers/{operationId} returns the recorded state; an unknown ID is 404",
    capability: "transfers",
    async run(ctx) {
      const created = await createToWorkspace(ctx);
      expectResponse(created.res, 201, "create transfer");
      const res = await ctx.client.call("getTransfer", { params: { operationId: created.operationId } });
      expectResponse(res, 200, "GET transfer");
      const transfer = parsed(TransferResourceSchema, res, "transfer");
      expect(transfer.operationId === created.operationId && transfer.state === "stage", `GET returned operation ${transfer.operationId} in state ${transfer.state}`);
      const unknown = await ctx.client.call("getTransfer", { params: { operationId: newStableId() } });
      expectProblem(unknown, 404, "not_found", "GET unknown transfer");
      await ctx.client.call("abortTransfer", { params: { operationId: created.operationId } });
      return "state readable";
    },
  },
  {
    id: "transfers.commit",
    title: "Committing a to_workspace transfer publishes the page atomically and is idempotent",
    capability: "transfers",
    async run(ctx) {
      const markdown = `# Transferred ${ctx.runId}\n\nคัดลอกแล้ว\n`;
      const created = await createToWorkspace(ctx, newStableId(), newStableId(), markdown);
      expectResponse(created.res, 201, "create transfer");
      const commit = await ctx.client.call("commitTransfer", { params: { operationId: created.operationId } });
      expectResponse(commit, 200, "commit");
      const transfer = parsed(TransferResourceSchema, commit, "committed transfer");
      expect(transfer.state === "done", `state after commit is ${transfer.state}, expected done`);
      const item = transfer.items[0];
      expect(item?.state === "committed" && item.revisionId !== null, "the item is not reported committed with a revision ID");
      const page = await ctx.client.call("getPage", { params: { workspaceId: created.workspaceId, pageId: created.pageId } });
      expectResponse(page, 200, "GET committed page");
      const resource = parsed(PageResourceSchema, page, "committed page");
      expect(resource.markdown === markdown, "the committed page content differs from the staged content");
      expect(parseEtag(etagOf(page)) === item.revisionId, "the page revision differs from the revision the transfer reported");
      const again = await ctx.client.call("commitTransfer", { params: { operationId: created.operationId } });
      expectResponse(again, 200, "second commit");
      expect(parsed(TransferResourceSchema, again, "transfer").state === "done", "a repeated commit changed the state");
      ctx.committedTransferId = created.operationId;
      return `transfer ${created.operationId} done; page ${created.pageId} published`;
    },
  },
  {
    id: "transfers.abort",
    title: "Aborting discards staged items and is idempotent; aborting a committed transfer is 409",
    capability: "transfers",
    async run(ctx) {
      const created = await createToWorkspace(ctx);
      expectResponse(created.res, 201, "create transfer");
      const abort = await ctx.client.call("abortTransfer", { params: { operationId: created.operationId } });
      expectResponse(abort, 200, "abort");
      expect(parsed(TransferResourceSchema, abort, "aborted transfer").state === "aborted", "state after abort is not aborted");
      const page = await ctx.client.call("getPage", { params: { workspaceId: created.workspaceId, pageId: created.pageId } });
      expectProblem(page, 404, "not_found", "GET page of an aborted transfer");
      const again = await ctx.client.call("abortTransfer", { params: { operationId: created.operationId } });
      expectResponse(again, 200, "second abort");
      const commitAborted = await ctx.client.call("commitTransfer", { params: { operationId: created.operationId } });
      expectProblem(commitAborted, 409, "invalid_transfer_state", "commit of an aborted transfer");
      if (!ctx.committedTransferId) return "abort discards and repeats are safe; abort after commit was not exercised because transfers.commit did not pass";
      const late = await ctx.client.call("abortTransfer", { params: { operationId: ctx.committedTransferId } });
      expectProblem(late, 409, "invalid_transfer_state", "abort of a committed transfer");
      return "abort discards, repeats are safe, committed transfers cannot be aborted";
    },
  },
  {
    id: "transfers.from-workspace-copy",
    title: "A from_workspace copy pins the source revision and leaves the source page in place",
    capability: "transfers",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const source = await createPage(ctx, { title: `Source ${ctx.runId}`, markdown: `# Source ${ctx.runId}\n` });
      expectResponse(source.res, 201, "create source page");
      const page = parsed(PageResourceSchema, source.res, "source page");
      const operationId = newStableId();
      const res = await ctx.client.call("createTransfer", { params: { workspaceId }, json: { operationId, direction: "from_workspace", mode: "copy", pages: [{ pageId: source.id }] }, headers: { "idempotency-key": operationId } });
      if (res.status === 403 && (res.body as { code?: unknown } | undefined)?.code === "export_restricted") {
        expectProblem(res, 403, "export_restricted", "export from a restricted workspace");
        skip("the workspace is export restricted; the 403 export_restricted response is correct but the copy path cannot be exercised");
      }
      expectResponse(res, 201, "create from_workspace transfer");
      const transfer = parsed(TransferResourceSchema, res, "transfer");
      expect(transfer.items[0]?.pageId === source.id && transfer.items[0].revisionId === page.revision.id, "the item does not pin the source page's current revision");
      const commit = await ctx.client.call("commitTransfer", { params: { operationId }, json: { verified: [{ pageId: source.id, revisionId: page.revision.id, contentHash: page.revision.contentHash }] } });
      expectResponse(commit, 200, "commit");
      expect(parsed(TransferResourceSchema, commit, "committed transfer").state === "done", "a verified copy did not reach done");
      const still = await ctx.client.call("getPage", { params: { workspaceId, pageId: source.id } });
      expectResponse(still, 200, "GET source after copy");
      return "source revision pinned; copy committed; source intact";
    },
  },
  {
    id: "transfers.from-workspace-move",
    title: "A from_workspace move deletes the source only after verified commit",
    capability: "transfers",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const source = await createPage(ctx, { title: `Move source ${ctx.runId}`, markdown: `# Move source ${ctx.runId}\n` });
      expectResponse(source.res, 201, "create source page");
      const page = parsed(PageResourceSchema, source.res, "source page");
      const operationId = newStableId();
      const res = await ctx.client.call("createTransfer", { params: { workspaceId }, json: { operationId, direction: "from_workspace", mode: "move", pages: [{ pageId: source.id }] }, headers: { "idempotency-key": operationId } });
      if (res.status === 403 && (res.body as { code?: unknown } | undefined)?.code === "export_restricted") skip("the workspace is export restricted");
      expectResponse(res, 201, "create from_workspace move");
      const unverified = await ctx.client.call("commitTransfer", { params: { operationId } });
      expectProblem(unverified, 400, "validation_failed", "commit of a move without verification");
      const stillThere = await ctx.client.call("getPage", { params: { workspaceId, pageId: source.id } });
      expectResponse(stillThere, 200, "GET source before verified commit");
      const commit = await ctx.client.call("commitTransfer", { params: { operationId }, json: { verified: [{ pageId: source.id, revisionId: page.revision.id, contentHash: page.revision.contentHash }] } });
      expectResponse(commit, 200, "verified commit");
      expect(parsed(TransferResourceSchema, commit, "committed transfer").state === "done", "a verified move did not reach done");
      const gone = await ctx.client.call("getPage", { params: { workspaceId, pageId: source.id } });
      expectProblem(gone, 404, "not_found", "GET source after finalized move");
      return "400 without verification; source deleted after verified commit";
    },
  },
];

// ------------------------------------------------------------ page-order

/** Creates a page with `If-None-Match: *` and an optional parent and position; records it for cleanup. */
async function createPlaced(ctx: Context, label: string, placement: { parentId?: string | null; position?: string | null }): Promise<{ id: string; etag: string }> {
  const workspaceId = requireWorkspace(ctx);
  const id = newStableId();
  ctx.createdPageIds.add(id);
  const res = await ctx.client.call("putPage", { params: { workspaceId, pageId: id }, headers: { "if-none-match": "*" }, json: { title: `${label} ${ctx.runId}`, markdown: `# ${label}\n`, ...placement } });
  expectResponse(res, 201, `create ${label}`);
  const etag = parseEtag(etagOf(res));
  if (!etag) fail(`create ${label}: no ETag`);
  return { id, etag };
}

/** Every tree node of the workspace, and the change cursor of the traversal. */
async function wholeTree(ctx: Context): Promise<{ nodes: TreeNode[]; changeCursor: string }> {
  const workspaceId = requireWorkspace(ctx);
  const nodes: TreeNode[] = [];
  let cursor: string | undefined;
  let changeCursor: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const res = await ctx.client.call("getWorkspaceTree", { params: { workspaceId }, query: { cursor } });
    expectResponse(res, 200, "tree");
    const page = parsed(TreePageSchema, res, "tree page");
    nodes.push(...page.items);
    changeCursor ??= page.changeCursor;
    if (page.nextCursor === null) return { nodes, changeCursor };
    cursor = page.nextCursor;
  }
  return skip("the tree did not end within 1000 pages");
}

function move(ctx: Context, pageId: string, body: unknown, etag?: string, extra: Record<string, string> = {}) {
  return ctx.client.call("movePage", { params: { workspaceId: requireWorkspace(ctx), pageId }, json: body, headers: { ...(etag === undefined ? {} : { "if-match": `"${etag}"` }), ...extra } });
}

export const pageOrderChecks: Check[] = [
  {
    id: "page-order.position-round-trip",
    title: "putPage stores a position; GET and the tree return it; an update without position keeps it",
    capability: "page-order",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const parent = await createPlaced(ctx, "Order parent", {});
      const child = await createPlaced(ctx, "Order child", { parentId: parent.id, position: "a0" });
      const get = await ctx.client.call("getPage", { params: { workspaceId, pageId: child.id } });
      expectResponse(get, 200, "get child");
      const page = parsed(PageResourceSchema, get, "child");
      expect(page.metadata.position === "a0", `metadata.position is ${String(page.metadata.position)}, expected "a0"`);
      const update = await ctx.client.call("putPage", { params: { workspaceId, pageId: child.id }, headers: { "if-match": `"${child.etag}"` }, json: { title: page.metadata.title, markdown: `${page.markdown}more\n` } });
      expectResponse(update, 200, "update without position");
      expect(parsed(PageResourceSchema, update, "updated child").metadata.position === "a0", "an update without position cleared or changed it");
      const { nodes } = await wholeTree(ctx);
      const node = nodes.find((n) => n.id === child.id);
      expect(node?.position === "a0", `tree node position is ${String(node?.position)}, expected "a0"`);
      const top = nodes.find((n) => n.id === parent.id);
      expect(top && (top.position === null || top.position === undefined), "a page created without a position has one in the tree");
      return "position round-trips through putPage, getPage and the tree";
    },
  },
  {
    id: "page-order.move-metadata-only",
    title: "movePage changes parent and position without a new revision, and the change feed reports it",
    capability: "page-order",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const a = await createPlaced(ctx, "Move target", { position: "a0" });
      const b = await createPlaced(ctx, "Moved page", { position: "a1" });
      const { changeCursor } = await wholeTree(ctx);
      const res = await move(ctx, b.id, { parentId: a.id, position: "Zz" }, b.etag);
      expectResponse(res, 200, "move");
      const node = parsed(TreeNodeSchema, res, "moved node");
      expect(node.parentId === a.id && node.position === "Zz", `move answered parentId ${String(node.parentId)}, position ${String(node.position)}`);
      expect(node.revisionId === b.etag, "the move created a new revision (revisionId changed)");
      expect(parseEtag(etagOf(res)) === b.etag, "the move changed the ETag");
      const revisions = await ctx.client.call("listPageRevisions", { params: { workspaceId, pageId: b.id } });
      expectResponse(revisions, 200, "revisions");
      const list = parsed(RevisionListSchema, revisions, "revision list");
      expect(list.items.length === 1, `the page has ${list.items.length} revisions after a move, expected 1`);
      const get = await ctx.client.call("getPage", { params: { workspaceId, pageId: b.id } });
      expectResponse(get, 200, "get moved page");
      const meta = parsed(PageResourceSchema, get, "moved page").metadata;
      expect(meta.parentId === a.id && meta.position === "Zz", "GET does not show the new parent and position");
      expect(parseEtag(etagOf(get)) === b.etag, "GET after a move has a different ETag");
      const feed = await ctx.client.call("listWorkspaceChanges", { params: { workspaceId }, query: { cursor: changeCursor } });
      expectResponse(feed, 200, "change feed");
      const entry = parsed(ChangesResponseSchema, feed, "changes").entries.find((e) => e.pageId === b.id);
      expect(entry?.kind === "page.updated", "the change feed has no page.updated entry for the move");
      expect(entry.revisionId === b.etag && entry.parentId === a.id && entry.position === "Zz", "the move's change entry does not carry the current revision, the new parent and the position");
      const clear = await move(ctx, b.id, { position: null }, b.etag);
      expectResponse(clear, 200, "clear position");
      const cleared = parsed(TreeNodeSchema, clear, "cleared node");
      expect(cleared.parentId === a.id && (cleared.position === null || cleared.position === undefined), "position: null did not clear the position, or the parent changed");
      return "metadata-only move: same revision and ETag, a feed entry with the position";
    },
  },
  {
    id: "page-order.move-preconditions",
    title: "movePage requires If-Match (428), refuses a stale one (412), cycles and an empty body (400), unknown pages (404)",
    capability: "page-order",
    async run(ctx) {
      const parent = await createPlaced(ctx, "Cycle parent", {});
      const child = await createPlaced(ctx, "Cycle child", { parentId: parent.id });
      expectProblem(await move(ctx, child.id, { position: "a0" }), 428, "precondition_required", "move without If-Match");
      const stale = await move(ctx, child.id, { position: "a0" }, `${child.etag}x`);
      expectProblem(stale, 412, "revision_conflict", "move with a stale If-Match");
      expect((stale.body as { currentRevision?: { id?: string } }).currentRevision?.id === child.etag, "the 412 does not carry the current revision");
      expectProblem(await move(ctx, child.id, { parentId: child.id }, child.etag), 400, "validation_failed", "move under itself");
      expectProblem(await move(ctx, parent.id, { parentId: child.id }, parent.etag), 400, "validation_failed", "move under its own child");
      expectProblem(await move(ctx, child.id, {}, child.etag), 400, "validation_failed", "move with an empty body");
      expectProblem(await move(ctx, child.id, { position: "not valid!" }, child.etag), 400, "validation_failed", "move with a malformed position");
      expectProblem(await move(ctx, newStableId(), { position: "a0" }, child.etag), 404, "not_found", "move of an unknown page");
      return "428, 412, 400 (self, cycle, empty, malformed), 404";
    },
  },
  {
    id: "page-order.move-idempotent",
    title: "Replaying a move with the same Idempotency-Key returns the same response and records one change",
    capability: "page-order",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const page = await createPlaced(ctx, "Replayed move", {});
      const { changeCursor } = await wholeTree(ctx);
      const key = { "idempotency-key": `conformance-${ctx.runId}-move` };
      const first = await move(ctx, page.id, { position: "b0" }, page.etag, key);
      expectResponse(first, 200, "first move");
      const replay = await move(ctx, page.id, { position: "b0" }, page.etag, key);
      expectResponse(replay, 200, "replayed move");
      expect(deepEqual(replay.body, first.body), "the replay returned a different body");
      const feed = await ctx.client.call("listWorkspaceChanges", { params: { workspaceId }, query: { cursor: changeCursor } });
      expectResponse(feed, 200, "change feed");
      const entries = parsed(ChangesResponseSchema, feed, "changes").entries.filter((e) => e.pageId === page.id);
      expect(entries.length === 1, `the replayed move recorded ${entries.length} change entries, expected 1`);
      return "the replay returned the original response";
    },
  },
];

// ------------------------------------------------------------ page-kind (ADR-0017)

const FOLDER_MARKDOWN = "---\nthoth_kind: folder\n---\n";
const PLAIN_MARKDOWN = "# Plain page\n\nthoth_kind: folder\n";
/** Frontmatter that does not parse (an unclosed flow sequence). A write with it must still succeed. */
const MALFORMED_MARKDOWN = "---\nthoth_kind: [folder\n---\n# Broken frontmatter\n";

/** Creates a page with the given Markdown; records it for cleanup. */
async function createWithMarkdown(ctx: Context, label: string, markdown: string): Promise<{ id: string; etag: string; kind: unknown }> {
  const workspaceId = requireWorkspace(ctx);
  const id = newStableId();
  ctx.createdPageIds.add(id);
  const res = await ctx.client.call("putPage", { params: { workspaceId, pageId: id }, headers: { "if-none-match": "*" }, json: { title: `${label} ${ctx.runId}`, markdown } });
  expectResponse(res, 201, `create ${label}`);
  const etag = parseEtag(etagOf(res));
  if (!etag) fail(`create ${label}: no ETag`);
  return { id, etag, kind: parsed(PageResourceSchema, res, label).metadata.kind };
}

/** The `kind` member as the protocol defines it: `null` and absent both mean unknown. */
const unknownKind = (kind: unknown): boolean => kind === null || kind === undefined;

export const pageKindChecks: Check[] = [
  {
    id: "page-kind.derived-from-frontmatter",
    title: "putPage derives kind from frontmatter thoth_kind; getPage and the tree report it; malformed frontmatter does not fail the write",
    capability: "page-kind",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const folder = await createWithMarkdown(ctx, "Kind folder", FOLDER_MARKDOWN);
      const plain = await createWithMarkdown(ctx, "Kind plain", PLAIN_MARKDOWN);
      const broken = await createWithMarkdown(ctx, "Kind malformed", MALFORMED_MARKDOWN);
      expect(folder.kind === "folder", `putPage answered metadata.kind ${String(folder.kind)} for a folder page, expected "folder"`);
      expect(plain.kind === "page", `putPage answered metadata.kind ${String(plain.kind)} for a page without the folder marker, expected "page"`);
      expect(unknownKind(broken.kind), `a page with malformed frontmatter has kind ${String(broken.kind)}, expected null or absent`);
      for (const [label, page, want] of [["folder", folder, "folder"], ["plain page", plain, "page"]] as const) {
        const get = await ctx.client.call("getPage", { params: { workspaceId, pageId: page.id } });
        expectResponse(get, 200, `get ${label}`);
        const kind = parsed(PageResourceSchema, get, label).metadata.kind;
        expect(kind === want, `getPage metadata.kind is ${String(kind)} for the ${label}, expected "${want}"`);
      }
      const { nodes } = await wholeTree(ctx);
      const kindOf = (id: string) => nodes.find((n) => n.id === id)?.kind;
      expect(kindOf(folder.id) === "folder", `tree node kind is ${String(kindOf(folder.id))} for the folder page, expected "folder"`);
      expect(kindOf(plain.id) === "page", `tree node kind is ${String(kindOf(plain.id))} for the plain page, expected "page"`);
      expect(unknownKind(kindOf(broken.id)), `tree node kind is ${String(kindOf(broken.id))} for malformed frontmatter, expected null or absent`);
      return "folder, page and unknown kinds round-trip through putPage, getPage and the tree";
    },
  },
  {
    id: "page-kind.follows-the-latest-write",
    title: "An update that adds or removes thoth_kind: folder changes kind; an older revision reports the kind it was written with",
    capability: "page-kind",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const page = await createWithMarkdown(ctx, "Kind changes", PLAIN_MARKDOWN);
      const put = (etag: string, markdown: string) => ctx.client.call("putPage", { params: { workspaceId, pageId: page.id }, headers: { "if-match": `"${etag}"` }, json: { title: `Kind changes ${ctx.runId}`, markdown } });
      const toFolder = await put(page.etag, FOLDER_MARKDOWN);
      expectResponse(toFolder, 200, "update to a folder");
      expect(parsed(PageResourceSchema, toFolder, "folder revision").metadata.kind === "folder", "an update adding thoth_kind: folder did not make the page a folder");
      const folderEtag = parseEtag(etagOf(toFolder));
      if (!folderEtag) fail("update to a folder: no ETag");
      const tree = await wholeTree(ctx);
      expect(tree.nodes.find((n) => n.id === page.id)?.kind === "folder", "the tree does not show the page as a folder after the update");
      const toPage = await put(folderEtag, "# Plain again\n");
      expectResponse(toPage, 200, "update back to a page");
      expect(parsed(PageResourceSchema, toPage, "page revision").metadata.kind === "page", "an update removing thoth_kind: folder left the page a folder");
      const old = await ctx.client.call("getPage", { params: { workspaceId, pageId: page.id }, query: { revision: folderEtag } });
      expectResponse(old, 200, "get the folder revision");
      expect(parsed(PageResourceSchema, old, "old revision").metadata.kind === "folder", "?revision= of the folder revision does not report kind folder");
      return "kind follows the Markdown of each write";
    },
  },
  {
    id: "page-kind.change-feed",
    title: "page.created and page.updated entries carry pageKind; a metadata-only move keeps it",
    capability: "page-kind",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const { changeCursor } = await wholeTree(ctx);
      const folder = await createWithMarkdown(ctx, "Kind feed", FOLDER_MARKDOWN);
      const moved = ctx.capabilities?.capabilities.includes("page-order") === true;
      if (moved) expectResponse(await move(ctx, folder.id, { position: "a0" }, folder.etag), 200, "move the folder page");
      const feed = await ctx.client.call("listWorkspaceChanges", { params: { workspaceId }, query: { cursor: changeCursor } });
      expectResponse(feed, 200, "change feed");
      const entries = parsed(ChangesResponseSchema, feed, "changes").entries.filter((e) => e.pageId === folder.id);
      const created = entries.find((e) => e.kind === "page.created");
      expect(created?.pageKind === "folder", `the page.created entry has pageKind ${String(created?.pageKind)}, expected "folder"`);
      if (moved) {
        const updated = entries.find((e) => e.kind === "page.updated");
        expect(updated?.pageKind === "folder", `the page.updated entry for a move has pageKind ${String(updated?.pageKind)}, expected "folder"`);
        const { nodes } = await wholeTree(ctx);
        expect(nodes.find((n) => n.id === folder.id)?.kind === "folder", "a move changed the page kind in the tree");
      }
      return moved ? "pageKind on page.created and on the entry for a move" : "pageKind on page.created (page-order is not listed, so no move was tried)";
    },
  },
];
