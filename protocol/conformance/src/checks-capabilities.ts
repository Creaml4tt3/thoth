import { randomBytes } from "node:crypto";
import {
  AttachmentResourceSchema,
  ChangeHintEventSchema,
  PageResourceSchema,
  SSE_EVENT_NAME,
  SearchResponseSchema,
  TransferResourceSchema,
  parseEtag,
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
