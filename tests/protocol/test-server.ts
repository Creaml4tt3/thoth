/**
 * Minimal in-memory workspace server used to test the conformance suite.
 *
 * `startTestServer()` implements the protocol subset the suite exercises (all core
 * routes plus attachments, search, SSE hints and transfers). `startBrokenServer()` is
 * the same server with deliberate violations, so tests can prove the suite notices them.
 * It is a test fixture, not the reference server.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  API_BASE_PATH,
  ERROR_CODES,
  IdempotencyKeySchema,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PROBLEM_CONTENT_TYPE,
  PageIdSchema,
  PageWriteSchema,
  SSE_EVENT_NAME,
  SearchRequestSchema,
  TransferCommitRequestSchema,
  TransferCreateRequestSchema,
  formatEtag,
  parseEtag,
  problem,
  roleCan,
  type CapabilityId,
  type ChangeEntry,
  type ErrorCode,
  type Role,
  type TransferResource,
} from "@thoth/workspace-protocol";

export const EDITOR_TOKEN = "tok_conformance_editor_9f3a7c1e5b";
export const VIEWER_TOKEN = "tok_conformance_viewer_2d8e4a6c0f";
export const MAIN_WORKSPACE = "ws_main";
export const LOCKED_WORKSPACE = "ws_locked";

export interface Flaws {
  /** Applies stale If-Match writes (and deletes) instead of answering 412. */
  overwriteOnStale?: boolean;
  /** Returns plain `application/json` errors without a problem `code`. */
  plainJsonErrors?: boolean;
  /** Ignores Idempotency-Key: replays run again and key reuse is not detected. */
  badIdempotency?: boolean;
  /** Echoes the Authorization header into plain error bodies (to test token redaction). */
  leakAuthorization?: boolean;
}

export interface TestServerOptions {
  flaws?: Flaws;
  /** Capabilities to list and serve. Default: attachments, search, events.sse, transfers. */
  capabilities?: CapabilityId[];
}

export interface TestServer {
  url: string;
  token: string;
  viewerToken: string;
  close(): Promise<void>;
  /** Number of requests served, for assertions about injected fetch use. */
  requestCount(): number;
}

interface Revision {
  id: string;
  pageId: string;
  parentId: string | null;
  createdAt: string;
  authorId: string;
  title: string;
  markdown: string;
  pageParentId: string | null;
  size: number;
  contentHash: string;
}

interface PageRecord {
  id: string;
  workspaceId: string;
  revisions: Revision[];
  deleted: boolean;
  createdAt: string;
  createdBy: string;
}

interface Reply {
  status: number;
  headers: Record<string, string>;
  body?: string | Buffer;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Buffer;
  user: { id: string; displayName: string };
  headers: IncomingMessage["headers"];
  path: string;
}

class ApiError extends Error {
  readonly code: ErrorCode;
  readonly extra: Record<string, unknown>;
  constructor(code: ErrorCode, detail: string, extra: Record<string, unknown> = {}) {
    super(detail);
    this.code = code;
    this.extra = extra;
  }
}

interface Route {
  method: string;
  segments: string[];
  capability: CapabilityId | null;
  handler: (ctx: Ctx) => Reply | Promise<Reply> | "streaming";
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const uuid7 = () => {
  const bytes = randomBytes(16);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const encodeCursor = (prefix: string, value: string) => prefix + Buffer.from(value).toString("base64url");
function decodeCursor(prefix: string, cursor: string): string {
  if (!cursor.startsWith(prefix)) throw new ApiError("cursor_invalid", "cursor was not issued for this collection");
  const rest = cursor.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(rest)) throw new ApiError("cursor_invalid", "cursor is malformed");
  return Buffer.from(rest, "base64url").toString("utf8");
}
function decodeNumberCursor(prefix: string, cursor: string | null): number {
  if (cursor === null) return 0;
  const value = decodeCursor(prefix, cursor);
  if (!/^\d+$/.test(value)) throw new ApiError("cursor_invalid", "cursor does not decode");
  return Number(value);
}

function limitFrom(query: URLSearchParams): number {
  const raw = query.get("limit");
  if (raw === null) return PAGE_SIZE_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > PAGE_SIZE_MAX) throw new ApiError("validation_failed", "limit must be an integer between 1 and 200");
  return n;
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const flaws = options.flaws ?? {};
  const capabilities: CapabilityId[] = options.capabilities ?? ["attachments", "search", "events.sse", "transfers"];
  const caps = new Set<string>(capabilities);

  const users: Record<string, { id: string; displayName: string }> = {
    [EDITOR_TOKEN]: { id: "user_editor", displayName: "Conformance Editor" },
    [VIEWER_TOKEN]: { id: "user_viewer", displayName: "Conformance Viewer" },
  };
  const workspaces = [
    { id: MAIN_WORKSPACE, name: "Main", exportRestricted: false, members: { user_editor: "owner", user_viewer: "viewer" } as Record<string, Role> },
    { id: LOCKED_WORKSPACE, name: "Locked", exportRestricted: true, members: { user_editor: "owner", user_viewer: "viewer" } as Record<string, Role> },
  ];

  const pages = new Map<string, PageRecord>();
  const changes = new Map<string, ChangeEntry[]>();
  const attachments = new Map<string, { meta: Record<string, unknown>; bytes: Buffer; workspaceId: string }>();
  const transfers = new Map<string, TransferRecord>();
  const idempotency = new Map<string, { fingerprint: string; reply: Reply }>();
  const sseClients = new Map<string, Set<ServerResponse>>();
  let revisionCounter = 0;
  let served = 0;

  interface TransferRecord {
    resource: TransferResource;
    staged: { pageId: string; parentId: string | null; title: string; markdown: string }[];
    fingerprint: string;
    userId: string;
  }

  const pageKey = (workspaceId: string, pageId: string) => `${workspaceId}/${pageId}`;
  const feed = (workspaceId: string) => changes.get(workspaceId) ?? (changes.set(workspaceId, []), changes.get(workspaceId)!);

  function notify(workspaceId: string) {
    const head = encodeCursor("c", String(feed(workspaceId).length));
    const payload = JSON.stringify({ type: "changes.available", workspaceId, cursor: head });
    for (const client of sseClients.get(workspaceId) ?? []) client.write(`event: ${SSE_EVENT_NAME}\ndata: ${payload}\n\n`);
  }

  function record(workspaceId: string, entry: Omit<ChangeEntry, "id" | "occurredAt">) {
    const log = feed(workspaceId);
    log.push({ id: `chg_${log.length + 1}`, occurredAt: new Date().toISOString(), ...entry } as ChangeEntry);
    notify(workspaceId);
  }

  function currentRevision(page: PageRecord): Revision {
    return page.revisions[page.revisions.length - 1]!;
  }

  function summary(rev: Revision) {
    return { id: rev.id, pageId: rev.pageId, parentId: rev.parentId, createdAt: rev.createdAt, authorId: rev.authorId, title: rev.title, size: rev.size, contentHash: rev.contentHash };
  }

  function pageResource(page: PageRecord, rev: Revision) {
    return {
      id: page.id,
      markdown: rev.markdown,
      revision: summary(rev),
      metadata: { workspaceId: page.workspaceId, parentId: rev.pageParentId, title: rev.title, createdAt: page.createdAt, createdBy: page.createdBy, updatedAt: rev.createdAt, updatedBy: rev.authorId },
    };
  }

  function writeRevision(workspaceId: string, pageId: string, input: { title: string; markdown: string; parentId?: string | null | undefined }, userId: string): { page: PageRecord; rev: Revision; created: boolean } {
    const key = pageKey(workspaceId, pageId);
    let page = pages.get(key);
    const created = !page;
    const now = new Date().toISOString();
    if (!page) {
      page = { id: pageId, workspaceId, revisions: [], deleted: false, createdAt: now, createdBy: userId };
      pages.set(key, page);
    }
    const previous = page.revisions[page.revisions.length - 1];
    const rev: Revision = {
      id: `rev_${++revisionCounter}_${randomBytes(3).toString("hex")}`,
      pageId,
      parentId: previous?.id ?? null,
      createdAt: now,
      authorId: userId,
      title: input.title,
      markdown: input.markdown,
      pageParentId: input.parentId === undefined ? (previous?.pageParentId ?? null) : input.parentId,
      size: Buffer.byteLength(input.markdown),
      contentHash: sha256(input.markdown),
    };
    page.revisions.push(rev);
    record(workspaceId, { kind: created ? "page.created" : "page.updated", actorId: userId, pageId, revisionId: rev.id, parentId: rev.pageParentId, title: rev.title });
    return { page, rev, created };
  }

  function deletePageRecord(page: PageRecord, userId: string) {
    page.deleted = true;
    record(page.workspaceId, { kind: "page.deleted", actorId: userId, pageId: page.id });
  }

  // ---------- replies ----------
  const jsonReply = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  function errorReply(error: ApiError, req: IncomingMessage): Reply {
    const status = ERROR_CODES[error.code].status;
    if (flaws.plainJsonErrors) {
      const body: Record<string, unknown> = { error: error.message };
      if (flaws.leakAuthorization) body.authorization = req.headers.authorization ?? null;
      return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    }
    const headers: Record<string, string> = { "content-type": PROBLEM_CONTENT_TYPE };
    if (error.code === "unauthenticated") headers["www-authenticate"] = 'Bearer realm="thoth"';
    if (error.code === "rate_limited") headers["retry-after"] = "1";
    const body = { ...problem(error.code, { detail: error.message }), ...error.extra };
    return { status, headers, body: JSON.stringify(body) };
  }

  function conflict(page: PageRecord, detail: string): ApiError {
    return new ApiError("revision_conflict", detail, { currentRevision: summary(currentRevision(page)) });
  }

  // ---------- access ----------
  function workspaceFor(ctx: Ctx, need: "read" | "write"): (typeof workspaces)[number] & { role: Role } {
    const ws = workspaces.find((w) => w.id === ctx.params.workspaceId);
    const role = ws?.members[ctx.user.id];
    if (!ws || !role) throw new ApiError("not_found", "workspace not found");
    if (!roleCan(role, need)) throw new ApiError("forbidden", `role ${role} may not ${need}`);
    return { ...ws, role };
  }

  function parsePageId(raw: string | undefined): string {
    const parsed = PageIdSchema.safeParse(raw);
    if (!parsed.success) throw new ApiError("validation_failed", "pageId must be a UUIDv7", { errors: [{ pointer: "path:pageId", detail: "expected UUIDv7" }] });
    return parsed.data;
  }

  function parseJson(ctx: Ctx): unknown {
    try {
      return JSON.parse(ctx.body.toString("utf8"));
    } catch {
      throw new ApiError("validation_failed", "request body is not valid JSON");
    }
  }

  function zodFail(error: { issues: { path: PropertyKey[]; message: string }[] }): ApiError {
    return new ApiError("validation_failed", "request body is invalid", { errors: error.issues.map((i) => ({ pointer: `/${i.path.join("/")}`, detail: i.message })) });
  }

  // ---------- idempotency ----------
  function withIdempotency(ctx: Ctx, run: () => Reply): Reply {
    const settle = (): Reply => {
      try {
        return run();
      } catch (error) {
        if (error instanceof ApiError) return errorReply(error, ctx.req);
        throw error;
      }
    };
    const raw = ctx.headers["idempotency-key"];
    const key = typeof raw === "string" ? raw : undefined;
    if (key !== undefined && !IdempotencyKeySchema.safeParse(key).success) return errorReply(new ApiError("validation_failed", "invalid Idempotency-Key"), ctx.req);
    if (!key || flaws.badIdempotency) return settle();
    const fingerprint = sha256([ctx.req.method, ctx.path, ctx.query.toString(), ctx.headers["if-match"] ?? "", ctx.headers["if-none-match"] ?? "", sha256(ctx.body)].join("\n"));
    const id = `${ctx.user.id}|${key}`;
    const stored = idempotency.get(id);
    if (stored) {
      if (stored.fingerprint !== fingerprint) return errorReply(new ApiError("idempotency_key_reused", "Idempotency-Key was used with a different request"), ctx.req);
      return { ...stored.reply, headers: { ...stored.reply.headers, "idempotent-replayed": "true" } };
    }
    const reply = settle();
    if (reply.status < 500 && reply.status !== 429) idempotency.set(id, { fingerprint, reply });
    return reply;
  }

  // ---------- handlers ----------
  const routes: Route[] = [];
  const add = (method: string, path: string, capability: CapabilityId | null, handler: Route["handler"]) => routes.push({ method, segments: path.split("/").filter(Boolean), capability, handler });

  add("GET", "/me", null, (ctx) => jsonReply(200, { id: ctx.user.id, displayName: ctx.user.displayName }));

  add("GET", "/workspaces", null, (ctx) => {
    const mine = workspaces.filter((w) => w.members[ctx.user.id]);
    const limit = limitFrom(ctx.query);
    const offset = decodeNumberCursor("w", ctx.query.get("cursor"));
    const slice = mine.slice(offset, offset + limit);
    const items = slice.map((w) => ({
      id: w.id,
      kind: "workspace",
      name: w.name,
      role: w.members[ctx.user.id]!,
      exportRestricted: w.exportRestricted,
      memberCount: Object.keys(w.members).length,
      members: Object.entries(w.members).map(([userId, role]) => ({ userId, displayName: userId, role })),
      createdAt: "2026-01-01T00:00:00Z",
    }));
    return jsonReply(200, { items, nextCursor: offset + limit < mine.length ? encodeCursor("w", String(offset + limit)) : null });
  });

  add("GET", "/workspaces/:workspaceId/tree", null, (ctx) => {
    const ws = workspaceFor(ctx, "read");
    const limit = limitFrom(ctx.query);
    const raw = ctx.query.get("cursor");
    let offset = 0;
    let head = feed(ws.id).length;
    if (raw !== null) {
      const parts = decodeCursor("t", raw).split(":");
      if (parts.length !== 2 || !/^\d+$/.test(parts[0]!) || !/^\d+$/.test(parts[1]!)) throw new ApiError("cursor_invalid", "cursor does not decode");
      offset = Number(parts[0]);
      head = Number(parts[1]);
    }
    const live = [...pages.values()].filter((p) => p.workspaceId === ws.id && !p.deleted);
    const slice = live.slice(offset, offset + limit).map((p) => {
      const rev = currentRevision(p);
      return { id: p.id, parentId: rev.pageParentId, title: rev.title, revisionId: rev.id, updatedAt: rev.createdAt };
    });
    return jsonReply(200, {
      workspaceId: ws.id,
      items: slice,
      nextCursor: offset + limit < live.length ? encodeCursor("t", `${offset + limit}:${head}`) : null,
      changeCursor: encodeCursor("c", String(head)),
    });
  });

  add("GET", "/workspaces/:workspaceId/pages/:pageId", null, (ctx) => {
    const ws = workspaceFor(ctx, "read");
    const pageId = parsePageId(ctx.params.pageId);
    const page = pages.get(pageKey(ws.id, pageId));
    if (!page || page.deleted) throw new ApiError("not_found", "page not found");
    const wanted = ctx.query.get("revision");
    let rev = currentRevision(page);
    if (wanted !== null) {
      const found = page.revisions.find((r) => r.id === wanted);
      if (!found) throw new ApiError("not_found", "revision not found");
      rev = found;
    }
    return jsonReply(200, pageResource(page, rev), { etag: formatEtag(rev.id) });
  });

  add("PUT", "/workspaces/:workspaceId/pages/:pageId", null, (ctx) =>
    withIdempotency(ctx, () => {
      const ws = workspaceFor(ctx, "write");
      const pageId = parsePageId(ctx.params.pageId);
      const ifMatch = ctx.headers["if-match"];
      const ifNoneMatch = ctx.headers["if-none-match"];
      if (ifMatch !== undefined && ifNoneMatch !== undefined) throw new ApiError("validation_failed", "send either If-Match or If-None-Match, not both");
      if (ifMatch === undefined && ifNoneMatch === undefined) throw new ApiError("precondition_required", "writes require If-Match or If-None-Match");
      if (ifNoneMatch !== undefined && ifNoneMatch !== "*") throw new ApiError("validation_failed", "If-None-Match must be *");
      const expected = ifMatch === undefined ? null : parseEtag(ifMatch);
      if (ifMatch !== undefined && expected === null) throw new ApiError("validation_failed", "If-Match must be one strong entity tag");
      if (ctx.body.length > 1_048_576) throw new ApiError("payload_too_large", "body exceeds 1 MiB");
      const parsed = PageWriteSchema.safeParse(parseJson(ctx));
      if (!parsed.success) throw zodFail(parsed.error);
      const existing = pages.get(pageKey(ws.id, pageId));
      if (ifNoneMatch !== undefined) {
        if (existing) throw conflict(existing, "the page already exists");
      } else {
        if (!existing || existing.deleted) throw new ApiError("not_found", "page not found");
        if (expected !== currentRevision(existing).id && !flaws.overwriteOnStale) throw conflict(existing, "If-Match does not match the current revision");
      }
      const { page, rev, created } = writeRevision(ws.id, pageId, parsed.data, ctx.user.id);
      return jsonReply(created ? 201 : 200, pageResource(page, rev), { etag: formatEtag(rev.id) });
    }),
  );

  add("DELETE", "/workspaces/:workspaceId/pages/:pageId", null, (ctx) =>
    withIdempotency(ctx, () => {
      const ws = workspaceFor(ctx, "write");
      const pageId = parsePageId(ctx.params.pageId);
      const ifMatch = ctx.headers["if-match"];
      if (ifMatch === undefined) throw new ApiError("precondition_required", "DELETE requires If-Match");
      const expected = parseEtag(ifMatch);
      if (expected === null) throw new ApiError("validation_failed", "If-Match must be one strong entity tag");
      const page = pages.get(pageKey(ws.id, pageId));
      if (!page || page.deleted) throw new ApiError("not_found", "page not found");
      if (expected !== currentRevision(page).id && !flaws.overwriteOnStale) throw conflict(page, "If-Match does not match the current revision");
      deletePageRecord(page, ctx.user.id);
      return { status: 204, headers: {} };
    }),
  );

  add("GET", "/workspaces/:workspaceId/pages/:pageId/revisions", null, (ctx) => {
    const ws = workspaceFor(ctx, "read");
    const pageId = parsePageId(ctx.params.pageId);
    const page = pages.get(pageKey(ws.id, pageId));
    if (!page || page.deleted) throw new ApiError("not_found", "page not found");
    const limit = limitFrom(ctx.query);
    const offset = decodeNumberCursor("r", ctx.query.get("cursor"));
    const newestFirst = [...page.revisions].reverse();
    return jsonReply(200, {
      items: newestFirst.slice(offset, offset + limit).map(summary),
      nextCursor: offset + limit < newestFirst.length ? encodeCursor("r", String(offset + limit)) : null,
    });
  });

  add("POST", "/workspaces/:workspaceId/search", "search", (ctx) => {
    const ws = workspaceFor(ctx, "read");
    const parsed = SearchRequestSchema.safeParse(parseJson(ctx));
    if (!parsed.success) throw zodFail(parsed.error);
    const limit = parsed.data.limit ?? PAGE_SIZE_DEFAULT;
    const offset = decodeNumberCursor("s", parsed.data.cursor ?? null);
    const needle = parsed.data.query.toLowerCase();
    const hits = [...pages.values()]
      .filter((p) => p.workspaceId === ws.id && !p.deleted)
      .map((p) => ({ p, rev: currentRevision(p) }))
      .filter(({ rev }) => rev.markdown.toLowerCase().includes(needle) || rev.title.toLowerCase().includes(needle));
    return jsonReply(200, {
      items: hits.slice(offset, offset + limit).map(({ p, rev }) => ({ pageId: p.id, title: rev.title, revisionId: rev.id })),
      nextCursor: offset + limit < hits.length ? encodeCursor("s", String(offset + limit)) : null,
    });
  });

  add("POST", "/workspaces/:workspaceId/attachments", "attachments", (ctx) =>
    withIdempotency(ctx, () => {
      const ws = workspaceFor(ctx, "write");
      const mime = ctx.headers["content-type"];
      if (!mime) throw new ApiError("unsupported_media_type", "Content-Type is required");
      if (ctx.body.length === 0) throw new ApiError("validation_failed", "empty upload");
      if (ctx.body.length > 1_048_576) throw new ApiError("payload_too_large", "attachment exceeds 1 MiB");
      const id = uuid7();
      const fileName = ctx.query.get("fileName");
      const meta = {
        id,
        workspaceId: ws.id,
        hash: sha256(ctx.body),
        size: ctx.body.length,
        mimeType: mime.split(";")[0]!.trim(),
        ...(fileName ? { fileName } : {}),
        createdAt: new Date().toISOString(),
        createdBy: ctx.user.id,
      };
      attachments.set(id, { meta, bytes: Buffer.from(ctx.body), workspaceId: ws.id });
      record(ws.id, { kind: "attachment.created", actorId: ctx.user.id, attachmentId: id });
      return jsonReply(201, meta, { location: `${API_BASE_PATH}/workspaces/${ws.id}/attachments/${id}` });
    }),
  );

  add("GET", "/workspaces/:workspaceId/attachments/:attachmentId", "attachments", (ctx) => {
    const ws = workspaceFor(ctx, "read");
    const found = attachments.get(ctx.params.attachmentId ?? "");
    if (!found || found.workspaceId !== ws.id) throw new ApiError("not_found", "attachment not found");
    return { status: 200, headers: { "content-type": String(found.meta.mimeType) }, body: found.bytes };
  });

  add("GET", "/workspaces/:workspaceId/changes", null, (ctx) => {
    const ws = workspaceFor(ctx, "read");
    const limit = limitFrom(ctx.query);
    const log = feed(ws.id);
    const raw = ctx.query.get("cursor");
    const position = decodeNumberCursor("c", raw);
    if (position > log.length) throw new ApiError("cursor_invalid", "cursor is ahead of the feed");
    const entries = log.slice(position, position + limit);
    const next = position + entries.length;
    return jsonReply(200, { entries, cursor: encodeCursor("c", String(next)), hasMore: next < log.length });
  });

  add("GET", "/workspaces/:workspaceId/events", "events.sse", (ctx) => {
    const ws = workspaceFor(ctx, "read");
    ctx.res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    ctx.res.write(": connected\n\n");
    const set = sseClients.get(ws.id) ?? new Set<ServerResponse>();
    sseClients.set(ws.id, set);
    set.add(ctx.res);
    ctx.res.on("close", () => set.delete(ctx.res));
    return "streaming";
  });

  // ----- transfers -----
  const transferFor = (ctx: Ctx): TransferRecord => {
    const rec = transfers.get(ctx.params.operationId ?? "");
    const ws = rec && workspaces.find((w) => w.id === rec.resource.workspaceId);
    if (!rec || !ws?.members[ctx.user.id]) throw new ApiError("not_found", "transfer not found");
    return rec;
  };
  const touch = (rec: TransferRecord) => {
    rec.resource.updatedAt = new Date().toISOString();
  };

  add("POST", "/workspaces/:workspaceId/transfers", "transfers", (ctx) =>
    withIdempotency(ctx, () => {
      const parsed = TransferCreateRequestSchema.safeParse(parseJson(ctx));
      if (!parsed.success) throw zodFail(parsed.error);
      const req = parsed.data;
      const key = ctx.headers["idempotency-key"];
      if (key !== req.operationId) throw new ApiError("validation_failed", "Idempotency-Key must equal operationId and is required");
      const fingerprint = sha256(ctx.body);
      const existing = transfers.get(req.operationId);
      const needed = req.direction === "to_workspace" || req.mode === "move" ? "write" : "read";
      const ws = workspaceFor(ctx, needed);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ApiError("idempotency_key_reused", "operationId already used with a different plan");
        return jsonReply(201, existing.resource, { location: `${API_BASE_PATH}/transfers/${req.operationId}` });
      }
      const now = new Date().toISOString();
      let rec: TransferRecord;
      if (req.direction === "to_workspace") {
        const ids = req.pages.map((p) => p.pageId);
        if (new Set(ids).size !== ids.length || ids.some((id) => pages.has(pageKey(ws.id, id)))) throw new ApiError("validation_failed", "pageId values must be new and unique in the workspace");
        rec = {
          fingerprint,
          userId: ctx.user.id,
          staged: req.pages.map((p) => ({ pageId: p.pageId, parentId: p.parentId, title: p.title, markdown: p.markdown })),
          resource: {
            operationId: req.operationId,
            workspaceId: ws.id,
            direction: "to_workspace",
            mode: req.mode,
            state: "stage",
            items: req.pages.map((p) => ({ pageId: p.pageId, sourceId: p.sourceId, revisionId: null, state: "staged" })),
            createdAt: now,
            updatedAt: now,
            error: null,
          },
        };
      } else {
        if (ws.exportRestricted) throw new ApiError("export_restricted", "this workspace forbids export");
        const items = req.pages.map((p) => {
          const page = pages.get(pageKey(ws.id, p.pageId));
          if (!page || page.deleted) throw new ApiError("not_found", `page ${p.pageId} not found`);
          return { pageId: p.pageId, revisionId: currentRevision(page).id, state: "staged" as const };
        });
        rec = { fingerprint, userId: ctx.user.id, staged: [], resource: { operationId: req.operationId, workspaceId: ws.id, direction: "from_workspace", mode: req.mode, state: "stage", items, createdAt: now, updatedAt: now, error: null } };
      }
      transfers.set(req.operationId, rec);
      return jsonReply(201, rec.resource, { location: `${API_BASE_PATH}/transfers/${req.operationId}` });
    }),
  );

  add("GET", "/transfers/:operationId", "transfers", (ctx) => jsonReply(200, transferFor(ctx).resource));

  add("POST", "/transfers/:operationId/commit", "transfers", (ctx) =>
    withIdempotency(ctx, () => {
      const rec = transferFor(ctx);
      const r = rec.resource;
      const ws = workspaces.find((w) => w.id === r.workspaceId)!;
      if (!roleCan(ws.members[ctx.user.id]!, r.direction === "to_workspace" || r.mode === "move" ? "write" : "read")) throw new ApiError("forbidden", "role may not commit this transfer");
      if (r.state === "aborted" || r.state === "failed") throw new ApiError("invalid_transfer_state", `transfer is ${r.state}`);
      if (r.state === "done" || r.state === "destination_committed_source_cleanup_pending") return jsonReply(200, r);
      const body = ctx.body.length ? TransferCommitRequestSchema.safeParse(parseJson(ctx)) : TransferCommitRequestSchema.safeParse({});
      if (!body.success) throw zodFail(body.error);
      if (r.direction === "to_workspace") {
        for (const staged of rec.staged) {
          const { rev } = writeRevision(ws.id, staged.pageId, { title: staged.title, markdown: staged.markdown, parentId: staged.parentId }, rec.userId);
          const item = r.items.find((i) => i.pageId === staged.pageId)!;
          item.state = "committed";
          item.revisionId = rev.id;
        }
        r.state = "done";
      } else {
        const verified = body.data.verified ?? [];
        for (const v of verified) {
          const item = r.items.find((i) => i.pageId === v.pageId);
          if (!item || item.revisionId !== v.revisionId) throw new ApiError("validation_failed", `verified entry for ${v.pageId} does not match the pinned revision`);
        }
        if (r.mode === "move") {
          if (r.items.some((i) => !verified.some((v) => v.pageId === i.pageId))) throw new ApiError("validation_failed", "a move commit must verify every item");
          let cleanupFailed = false;
          for (const item of r.items) {
            const page = pages.get(pageKey(ws.id, item.pageId))!;
            const v = verified.find((x) => x.pageId === item.pageId)!;
            if (!page.deleted && currentRevision(page).id === v.revisionId && currentRevision(page).contentHash === v.contentHash) {
              deletePageRecord(page, ctx.user.id);
              item.state = "committed";
            } else {
              item.state = "failed";
              item.error = "revision_conflict";
              cleanupFailed = true;
            }
          }
          r.state = cleanupFailed ? "destination_committed_source_cleanup_pending" : "done";
        } else {
          for (const item of r.items) item.state = "committed";
          r.state = "done";
        }
      }
      touch(rec);
      return jsonReply(200, r);
    }),
  );

  add("POST", "/transfers/:operationId/abort", "transfers", (ctx) =>
    withIdempotency(ctx, () => {
      const rec = transferFor(ctx);
      const r = rec.resource;
      if (r.state === "aborted") return jsonReply(200, r);
      if (r.state === "done" || r.state === "destination_committed_source_cleanup_pending") throw new ApiError("invalid_transfer_state", "a committed transfer cannot be aborted");
      rec.staged = [];
      for (const item of r.items) item.state = "skipped";
      r.state = "aborted";
      touch(rec);
      return jsonReply(200, r);
    }),
  );

  // ---------- dispatch ----------
  function matchRoute(segments: string[]): { route: Route; params: Record<string, string> }[] {
    const found: { route: Route; params: Record<string, string> }[] = [];
    for (const route of routes) {
      if (route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      const ok = route.segments.every((seg, i) => {
        const actual = segments[i]!;
        if (seg.startsWith(":")) {
          params[seg.slice(1)] = decodeURIComponent(actual);
          return true;
        }
        return seg === actual;
      });
      if (ok) found.push({ route, params });
    }
    return found;
  }

  function send(res: ServerResponse, reply: Reply) {
    res.writeHead(reply.status, reply.headers);
    res.end(reply.body);
  }

  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  const server: Server = createServer(async (req, res) => {
    served++;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const body = await readBody(req);
      if (!url.pathname.startsWith(`${API_BASE_PATH}/`)) return send(res, errorReply(new ApiError("not_found", "no such route"), req));
      const segments = url.pathname.slice(API_BASE_PATH.length).split("/").filter(Boolean);

      if (method === "GET" && segments.length === 1 && segments[0] === "capabilities") {
        return send(res, jsonReply(200, { protocolVersion: "1.0", capabilities, limits: { maxMarkdownBytes: 1_048_576, maxAttachmentBytes: 1_048_576, maxPageSize: PAGE_SIZE_MAX, idempotencyWindowSeconds: 86_400 }, server: { name: "thoth-test-server", version: "0.0.0" } }));
      }

      const auth = req.headers.authorization;
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
      const user = token ? users[token] : undefined;
      if (!user) return send(res, errorReply(new ApiError("unauthenticated", "a valid bearer credential is required"), req));

      const candidates = matchRoute(segments);
      if (candidates.length === 0) return send(res, errorReply(new ApiError("not_found", "no such route"), req));
      const hit = candidates.find((c) => c.route.method === method);
      if (!hit) {
        const reply = errorReply(new ApiError("method_not_allowed", "method not allowed"), req);
        return send(res, { ...reply, headers: { ...reply.headers, allow: candidates.map((c) => c.route.method).join(", ") } });
      }
      const ctx: Ctx = { req, res, params: hit.params, query: url.searchParams, body, user, headers: req.headers, path: url.pathname };
      let reply: Reply | "streaming";
      try {
        if (hit.route.capability && !caps.has(hit.route.capability)) throw new ApiError("capability_not_supported", `capability ${hit.route.capability} is not supported`);
        reply = await hit.route.handler(ctx);
      } catch (error) {
        if (error instanceof ApiError) reply = errorReply(error, req);
        else throw error;
      }
      if (reply !== "streaming") send(res, reply);
    } catch (error) {
      if (!res.headersSent) send(res, errorReply(new ApiError("internal_error", error instanceof Error ? error.message : "error"), req));
      else res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    token: EDITOR_TOKEN,
    viewerToken: VIEWER_TOKEN,
    requestCount: () => served,
    close: () =>
      new Promise<void>((resolve) => {
        for (const set of sseClients.values()) for (const client of set) client.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** The same server with all deliberate violations enabled. */
export function startBrokenServer(options: Omit<TestServerOptions, "flaws"> & { flaws?: Flaws } = {}): Promise<TestServer> {
  return startTestServer({ ...options, flaws: { overwriteOnStale: true, plainJsonErrors: true, badIdempotency: true, ...options.flaws } });
}
