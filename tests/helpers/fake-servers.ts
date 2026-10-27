/**
 * An in-memory `Servers` for UI tests: a configurable fake host in front of
 * fake workspace servers. `call` answers protocol requests from in-memory
 * workspaces with the reference server's rules (If-Match / If-None-Match, 412
 * with `currentRevision`, roles, page quota, change feed). Sign-in can be
 * finished, failed or cancelled by the test. Like the real host it never
 * returns a token, and it refuses headers outside the `api.call` allow-list.
 */
import { newStableId, sha256Hex } from "@thoth/domain";
import type { ApiCallArgs, ApiCallResult, ServerInfo, Servers } from "@thoth/platform";
import { HostCallError } from "@thoth/platform/remote";
import { DELETED_WORKSPACE_RESTORE_DAYS, FeedbackRequestSchema, InviteAcceptRequestSchema, InviteLinkCreateRequestSchema, WorkspaceCreateRequestSchema, WorkspaceRenameSchema, MemberRoleChangeSchema, PageMoveSchema, pageKindOf, parseEtag, problem, ShareLinkCreateRequestSchema, TransferCommitRequestSchema, TransferCreateRequestSchema, type ChangeEntry, type ErrorCode, type RevisionSummary, type Role, type TransferResource } from "@thoth/workspace-protocol";

export interface FakePage {
  id: string;
  parentId: string | null;
  title: string;
  markdown: string;
  /** Sibling sort key (capability `page-order`); absent means none. */
  position?: string | null;
  revisions: RevisionSummary[];
  deleted: boolean;
  /** Markdown of each revision, in step with `revisions` (for `?revision=`). */
  history?: string[];
}

export interface FakeWorkspace {
  id: string;
  name: string;
  role: Role;
  pages: Map<string, FakePage>;
  changes: ChangeEntry[];
  /** The server refuses Workspace → Private transfers (ADR-0009). */
  exportRestricted: boolean;
  members: { userId: string; displayName: string; role: Role }[];
  attachments: Map<string, { id: string; bytes: Uint8Array; mimeType: string; hash: string; fileName?: string }>;
  /** Public share links (capability `public-share`); the token is kept only so tests can read it. */
  shares: { id: string; workspaceId: string; pageId: string; createdAt: string; createdBy: string; expiresAt: string | null; token: string; revoked: boolean }[];
  /** Invite links (capability `invite-links`, ADR-0024); the token is kept only so tests can read it. */
  invites: { id: string; role: "editor" | "viewer"; maxUses: number; uses: number; createdAt: string; createdBy: string; expiresAt: string; token: string; revoked: boolean }[];
  /** False for a workspace "me" is not in yet (it can be joined with one of its invite links). */
  joined: boolean;
  /** ADR-0025: when it was deleted (restorable for 30 days), or null. */
  deletedAt: string | null;
}

export interface FakeTransfer {
  resource: TransferResource;
  staged: { pageId: string; parentId: string | null; title: string; markdown: string }[];
  body: string;
  workspace: FakeWorkspace;
}

export interface FakeServerConfig {
  url: string;
  name?: string;
  providers?: { id: string; name: string }[];
  limits?: Record<string, number>;
  /** Personal access tokens this server accepts. */
  tokens?: string[];
  account?: { id: string; displayName: string; email?: string };
  /** Answers, but not as a Thoth server. */
  notThoth?: boolean;
  /** Capabilities listed (default: `search`, `transfers`, `attachments`, `page-order`, `page-kind`). */
  capabilities?: string[];
}

interface Known {
  info: ServerInfo;
  config: FakeServerConfig;
  /** The next api.call answers 401 (the host's refresh failed). */
  expired: boolean;
}

interface PendingSignIn {
  resolve(info: ServerInfo): void;
  reject(error: Error): void;
}

const ALLOWED_HEADERS = new Set(["if-match", "if-none-match", "idempotency-key", "content-type"]);
const T0 = Date.parse("2026-10-23T09:00:00Z");
const decoder = new TextDecoder();

export class FakeServers implements Servers {
  /** Servers that exist at an address (reachable by `add`). */
  private readonly registry = new Map<string, FakeServerConfig>();
  private readonly known = new Map<string, Known>();
  readonly workspaces = new Map<string, FakeWorkspace[]>();
  /** Which server holds a workspace, so responses can follow that server's capabilities. */
  private readonly serverOf = new WeakMap<FakeWorkspace, string>();
  /** Every api.call, in order. */
  readonly calls: ApiCallArgs[] = [];
  /** Feedback received (capability `feedback`, ADR-0033), by server, as sent. */
  readonly feedback: { server: string; body: unknown }[] = [];
  readonly transfers = new Map<string, FakeTransfer>();
  /** Stored replies by (server, Idempotency-Key): a retry with the same key and body replays, another body is 422. */
  private readonly idempotent = new Map<string, { body: string; reply: ApiCallResult }>();
  /** Test hook: runs before each protocol request is answered; throwing simulates a network failure. */
  beforeCall: ((args: ApiCallArgs) => void) | undefined;
  /** Test hook: runs after a request was answered (its effect is done); throwing simulates a lost response. */
  afterCall: ((args: ApiCallArgs, result: ApiCallResult) => void) | undefined;
  /** Tokens `useToken` received (to prove the UI sent it once). */
  readonly tokensReceived: string[] = [];
  /** "auto" finishes browser sign-in at once; "manual" waits for `finishSignIn` / `failSignIn`. */
  signInMode: "auto" | "manual" = "auto";
  private readonly pending = new Map<string, PendingSignIn>();
  private nextServer = 1;
  private made = 0;
  private seq = 0;
  private clock = 0;

  // -------------------------------------------------------------- test setup

  define(config: FakeServerConfig): FakeServerConfig {
    this.registry.set(config.url, config);
    return config;
  }

  /** A server the host already knows (signed in unless `signedIn` is false). */
  connect(config: FakeServerConfig, options: { signedIn?: boolean } = {}): string {
    this.define(config);
    const info = this.infoFor(config);
    const known: Known = { info, config, expired: false };
    this.known.set(info.id, known);
    if (options.signedIn !== false) this.signInAs(known, "token");
    return info.id;
  }

  addWorkspace(server: string, init: { id?: string; name: string; role?: Role; exportRestricted?: boolean; members?: FakeWorkspace["members"]; joined?: boolean }): FakeWorkspace {
    const ws: FakeWorkspace = {
      id: init.id ?? `ws_${this.workspaces.size + 1}${server}`,
      name: init.name,
      role: init.role ?? "editor",
      pages: new Map(),
      changes: [],
      exportRestricted: init.exportRestricted ?? false,
      members: init.members ?? [{ userId: "usr_me", displayName: "Me", role: init.role ?? "editor" }],
      attachments: new Map(),
      shares: [],
      invites: [],
      joined: init.joined ?? true,
      deletedAt: null,
    };
    this.serverOf.set(ws, server);
    const list = this.workspaces.get(server) ?? [];
    list.push(ws);
    this.workspaces.set(server, list);
    return ws;
  }

  /** An invite link to `ws` made by someone else (an owner), as the test's "received" link. Returns its token. */
  inviteAsOther(ws: FakeWorkspace, init: { role?: "editor" | "viewer"; maxUses?: number } = {}): string {
    const token = `inv${String(ws.invites.length + 1).padStart(29, "0")}`;
    ws.invites.push({ id: `inv_${ws.invites.length + 1}`, role: init.role ?? "editor", maxUses: init.maxUses ?? 1, uses: 0, createdAt: iso(T0), createdBy: "usr_other", expiresAt: iso(T0 + 7 * 86_400_000), token, revoked: false });
    return token;
  }

  /** Creates or changes a page as another user would (a new revision and a change-feed entry). */
  writeAsOther(ws: FakeWorkspace, init: { id?: string; title: string; markdown: string; parentId?: string | null; position?: string | null }): FakePage {
    const id = init.id ?? newStableId();
    const existing = ws.pages.get(id);
    const page: FakePage = existing ?? { id, parentId: init.parentId ?? null, title: init.title, markdown: "", revisions: [], deleted: false };
    if (init.parentId !== undefined) page.parentId = init.parentId;
    if (init.position !== undefined) page.position = init.position;
    page.title = init.title;
    page.markdown = init.markdown;
    page.revisions.push(this.revision(page, "usr_other"));
    ws.pages.set(id, page);
    this.record(ws, existing ? "page.updated" : "page.created", page, "usr_other");
    return page;
  }

  deleteAsOther(ws: FakeWorkspace, id: string): void {
    const page = ws.pages.get(id);
    if (!page) return;
    page.deleted = true;
    this.record(ws, "page.deleted", page, "usr_other");
  }

  /** The host's refresh fails: the next protocol call answers 401 and the server is signed out. */
  expire(server: string): void {
    this.known.get(server)!.expired = true;
  }

  finishSignIn(server: string): void {
    const pending = this.pending.get(server);
    if (!pending) throw new Error("No sign-in is waiting");
    this.pending.delete(server);
    pending.resolve(this.signInAs(this.known.get(server)!, "browser"));
  }

  failSignIn(server: string, message: string): void {
    const pending = this.pending.get(server);
    if (!pending) throw new Error("No sign-in is waiting");
    this.pending.delete(server);
    pending.reject(new HostCallError("SIGN_IN_FAILED", message));
  }

  waiting(server: string): boolean {
    return this.pending.has(server);
  }

  info(server: string): ServerInfo | undefined {
    return this.known.get(server)?.info;
  }

  page(ws: FakeWorkspace, title: string): FakePage {
    const found = [...ws.pages.values()].find((p) => p.title === title && !p.deleted);
    if (!found) throw new Error(`No page "${title}"`);
    return found;
  }

  // ---------------------------------------------------------------- Servers

  async list(): Promise<ServerInfo[]> {
    return [...this.known.values()].map((k) => structuredClone(k.info));
  }

  async add(url: string): Promise<ServerInfo> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HostCallError("BAD_ARGUMENT", "That is not a web address.");
    }
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new HostCallError("NOT_ALLOWED", "Only https addresses are allowed (or http on this computer).");
    const config = this.registry.get(parsed.origin);
    if (!config) throw new HostCallError("SERVER_UNREACHABLE", `Nothing answered at ${parsed.origin}.`);
    if (config.notThoth) throw new HostCallError("SERVER_UNREACHABLE", `${parsed.origin} answered, but it is not a Thoth server.`);
    const existing = [...this.known.values()].find((k) => k.config === config);
    if (existing) return structuredClone(existing.info);
    const info = this.infoFor(config);
    this.known.set(info.id, { info, config, expired: false });
    return structuredClone(info);
  }

  async remove(server: string): Promise<void> {
    this.pending.get(server)?.reject(new HostCallError("SIGN_IN_FAILED", "Sign-in was cancelled."));
    this.pending.delete(server);
    this.known.delete(server);
  }

  signIn(server: string, provider?: string): Promise<ServerInfo> {
    const known = this.mustKnow(server);
    if (provider !== undefined && !known.info.providers.some((p) => p.id === provider)) return Promise.reject(new HostCallError("BAD_ARGUMENT", "Unknown provider"));
    if (this.signInMode === "auto") return Promise.resolve(this.signInAs(known, "browser"));
    return new Promise((resolve, reject) => this.pending.set(server, { resolve, reject }));
  }

  async cancelSignIn(server: string): Promise<void> {
    const pending = this.pending.get(server);
    this.pending.delete(server);
    pending?.reject(new HostCallError("SIGN_IN_FAILED", "Sign-in was cancelled."));
  }

  async useToken(server: string, token: string): Promise<ServerInfo> {
    const known = this.mustKnow(server);
    this.tokensReceived.push(token);
    if (!(known.config.tokens ?? []).includes(token)) throw new HostCallError("SIGN_IN_FAILED", "The server did not accept that token.");
    return this.signInAs(known, "token");
  }

  async signOut(server: string): Promise<ServerInfo> {
    const known = this.mustKnow(server);
    const { account: _account, ...info } = known.info;
    known.info = { ...info, auth: "signed-out" };
    return structuredClone(known.info);
  }

  async call(args: ApiCallArgs, body?: Uint8Array): Promise<ApiCallResult> {
    this.calls.push(structuredClone(args));
    const known = this.mustKnow(args.server);
    if (!args.path.startsWith("/api/v1/") || /\.\.|\/\/|[?#]/.test(args.path)) throw new HostCallError("NOT_ALLOWED", "Path refused");
    for (const name of Object.keys(args.headers ?? {})) if (!ALLOWED_HEADERS.has(name.toLowerCase())) throw new HostCallError("NOT_ALLOWED", `Header ${name} refused`);
    const path = args.path.slice("/api/v1".length);
    if (path === "/capabilities") return json(200, this.capabilities(known.config));
    // ADR-0033: feedback needs no sign-in.
    if (path === "/feedback" && args.method === "POST") {
      if (!this.capable(args.server, "feedback")) return fail("capability_not_supported");
      const parsed = FeedbackRequestSchema.safeParse(JSON.parse(body ? decoder.decode(body) : "null"));
      if (!parsed.success) return fail("validation_failed");
      this.feedback.push({ server: args.server, body: parsed.data });
      return { status: 204, headers: {}, body: "" };
    }
    if (known.expired) {
      const { account: _account, ...info } = known.info;
      known.info = { ...info, auth: "signed-out" };
      known.expired = false;
    }
    if (known.info.auth === "signed-out") return fail("unauthenticated");
    this.beforeCall?.(args);
    const headers = Object.fromEntries(Object.entries(args.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const key = headers["idempotency-key"];
    const text = body ? (path.endsWith("/attachments") ? Buffer.from(body).toString("base64") : decoder.decode(body)) : "";
    let result: ApiCallResult;
    const stored = key === undefined ? undefined : this.idempotent.get(`${args.server}\n${key}`);
    if (stored) result = stored.body === `${args.method} ${path}\n${text}` ? stored.reply : fail("idempotency_key_reused");
    else {
      result = this.route(args.server, args.method, path, args.query ?? {}, headers, text, body);
      if (key !== undefined && result.status < 500) this.idempotent.set(`${args.server}\n${key}`, { body: `${args.method} ${path}\n${text}`, reply: result });
    }
    this.afterCall?.(args, result);
    return result;
  }

  // ----------------------------------------------------------------- server

  private route(server: string, method: string, path: string, query: Record<string, string>, headers: Record<string, string>, text: string, bytes?: Uint8Array): ApiCallResult {
    if (path === "/me" && method === "GET") return json(200, this.mustKnow(server).config.account ?? { id: "usr_me", displayName: "Me" });
    if (path === "/workspaces" && method === "GET") {
      return json(200, {
        items: (this.workspaces.get(server) ?? []).filter((w) => w.joined && w.deletedAt === null).map((w) => this.workspaceResource(w)),
        nextCursor: null,
      });
    }
    if (path === "/workspaces" && method === "POST") return this.createWorkspace(server, text);
    if (path === "/deleted-workspaces" || path.startsWith("/deleted-workspaces/")) return this.deletedWorkspaces(server, method, path, text);
    const whole = /^\/workspaces\/([^/]+)$/.exec(path);
    if (whole && method === "DELETE") return this.deleteWorkspace(server, decodeURIComponent(whole[1]!));
    const tm = /^\/transfers\/([^/]+)(\/commit|\/abort)?$/.exec(path);
    if (tm) return this.transferRoute(server, method, decodeURIComponent(tm[1]!), tm[2] ?? "", text);
    const m = /^\/workspaces\/([^/]+)(\/.*)$/.exec(path);
    if (path === "/invites/accept" && method === "POST") return this.acceptInvite(server, text);
    const ws = m ? (this.workspaces.get(server) ?? []).find((w) => w.joined && w.deletedAt === null && w.id === decodeURIComponent(m[1]!)) : undefined;
    if (!m || !ws) return fail("not_found");
    const rest = m[2]!;
    if (rest === "/name" && method === "PUT") return this.renameWorkspace(server, ws, text);
    if (rest === "/members" || rest.startsWith("/members/")) return this.members(server, ws, method, rest, text);
    if (rest === "/invite-links" || rest.startsWith("/invite-links/")) return this.inviteLinks(server, ws, method, rest, text);
    if (rest === "/tree" && method === "GET") {
      const items = [...ws.pages.values()].filter((p) => !p.deleted).map((p) => this.node(server, p));
      return json(200, { workspaceId: ws.id, items, nextCursor: null, changeCursor: this.cursor(ws.changes.length) });
    }
    if (rest === "/changes" && method === "GET") {
      const from = query["cursor"] === undefined ? 0 : Number(query["cursor"].slice(1));
      const entries = ws.changes.slice(from);
      return json(200, { entries, cursor: this.cursor(from + entries.length), hasMore: false });
    }
    if (rest === "/search" && method === "POST") {
      const q = (JSON.parse(text) as { query: string }).query.toLowerCase();
      const items = [...ws.pages.values()].filter((p) => !p.deleted && p.markdown.toLowerCase().includes(q)).map((p) => ({ pageId: p.id, title: p.title, revisionId: p.revisions.at(-1)!.id }));
      return json(200, { items, nextCursor: null });
    }
    if (rest === "/transfers" && method === "POST") return this.createTransfer(server, ws, headers, text);
    if (rest === "/attachments" && method === "POST") {
      if (!this.capable(server, "attachments")) return fail("capability_not_supported");
      if (ws.role === "viewer") return fail("forbidden");
      const data = bytes ?? new Uint8Array();
      if (data.length === 0) return fail("validation_failed", "an attachment cannot be empty");
      const id = newStableId();
      const hash = sha256Hex(data);
      const mimeType = headers["content-type"] ?? "application/octet-stream";
      ws.attachments.set(id, { id, bytes: data, mimeType, hash, ...(query["fileName"] ? { fileName: query["fileName"] } : {}) });
      return json(201, { id, workspaceId: ws.id, hash, size: data.length, mimeType, ...(query["fileName"] ? { fileName: query["fileName"] } : {}), createdAt: iso(T0), createdBy: "usr_me" });
    }
    const at = /^\/attachments\/([^/]+)$/.exec(rest);
    if (at && method === "GET") {
      if (!this.capable(server, "attachments")) return fail("capability_not_supported");
      const found = ws.attachments.get(decodeURIComponent(at[1]!));
      if (!found) return fail("not_found");
      // `responseBytes` (ADR-0028): the bytes as base64, as the host sends them.
      return { status: 200, headers: { "content-type": found.mimeType }, body: "", bodyBase64: Buffer.from(found.bytes).toString("base64") };
    }
    const mv = /^\/pages\/([^/]+)\/move$/.exec(rest);
    if (mv && method === "POST") return this.move(server, ws, decodeURIComponent(mv[1]!), headers, text);
    const sl = /^\/pages\/([^/]+)\/share-links$/.exec(rest);
    if (sl) return this.shareLinks(server, ws, method, decodeURIComponent(sl[1]!), text);
    const sr = /^\/share-links\/([^/]+)$/.exec(rest);
    if (sr && method === "DELETE") {
      if (!this.capable(server, "public-share")) return fail("capability_not_supported");
      if (ws.role === "viewer") return fail("forbidden");
      const link = ws.shares.find((l) => l.id === decodeURIComponent(sr[1]!));
      if (!link) return fail("not_found", "share link not found");
      link.revoked = true;
      return { status: 204, headers: {}, body: "" };
    }
    const pm = /^\/pages\/([^/]+)$/.exec(rest);
    if (!pm) return fail("not_found");
    const id = decodeURIComponent(pm[1]!);
    const page = ws.pages.get(id);
    const live = page && !page.deleted ? page : undefined;
    if (method === "GET") {
      if (!live) return fail("not_found");
      const wanted = query["revision"];
      if (wanted !== undefined) {
        const at = live.revisions.findIndex((r) => r.id === wanted);
        if (at < 0) return fail("not_found");
        const markdown = live.history?.[at] ?? live.markdown;
        const current = this.resource(ws, live);
        // ADR-0017: the kind of the revision returned, from that revision's own Markdown.
        const metadata = this.kinded(ws) ? { ...current.metadata, kind: pageKindOf(markdown) } : current.metadata;
        return json(200, { ...current, markdown, revision: live.revisions[at]!, metadata });
      }
      return json(200, this.resource(ws, live), { etag: `"${live.revisions.at(-1)!.id}"` });
    }
    if (method === "DELETE") {
      if (!live) return fail("not_found");
      if (parseEtag(headers["if-match"]) !== live.revisions.at(-1)!.id) return this.conflict(live);
      live.deleted = true;
      this.record(ws, "page.deleted", live, "usr_me");
      return { status: 204, headers: {}, body: "" };
    }
    if (method === "PUT") {
      if (ws.role === "viewer") return fail("forbidden", "viewers cannot change pages");
      const ifMatch = headers["if-match"];
      const ifNone = headers["if-none-match"];
      if (ifMatch === undefined && ifNone === undefined) return fail("precondition_required");
      const write = JSON.parse(text) as { title: string; markdown: string; parentId?: string | null; position?: string | null };
      const ordered = this.capable(server, "page-order");
      if (ifNone === "*") {
        if (page) return this.conflict(page);
        const limit = this.mustKnow(server).config.limits?.["maxPagesPerWorkspace"];
        const count = [...ws.pages.values()].filter((p) => !p.deleted).length;
        if (limit !== undefined && count + 1 > limit) {
          return json(409, { ...problem("quota_exceeded", { detail: `this workspace is limited to ${limit} pages (${count} in use); delete pages to make room` }), quota: "pagesPerWorkspace", limit, current: count });
        }
        const created: FakePage = { id, parentId: write.parentId ?? null, title: write.title, markdown: write.markdown, ...(ordered && write.position ? { position: write.position } : {}), revisions: [], deleted: false };
        created.revisions.push(this.revision(created, "usr_me"));
        ws.pages.set(id, created);
        this.record(ws, "page.created", created, "usr_me");
        return json(201, this.resource(ws, created), { etag: `"${created.revisions.at(-1)!.id}"` });
      }
      if (!live) return fail("not_found");
      if (parseEtag(ifMatch) !== live.revisions.at(-1)!.id) return this.conflict(live);
      live.title = write.title;
      live.markdown = write.markdown;
      if (write.parentId !== undefined) live.parentId = write.parentId;
      if (ordered && write.position !== undefined) live.position = write.position;
      live.revisions.push(this.revision(live, "usr_me"));
      this.record(ws, "page.updated", live, "usr_me");
      return json(200, this.resource(ws, live), { etag: `"${live.revisions.at(-1)!.id}"` });
    }
    return fail("method_not_allowed");
  }

  private node(server: string, p: FakePage) {
    return { id: p.id, parentId: p.parentId, title: p.title, ...(this.capable(server, "page-order") ? { position: p.position ?? null } : {}), ...(this.capable(server, "page-kind") ? { kind: pageKindOf(p.markdown) } : {}), revisionId: p.revisions.at(-1)!.id, updatedAt: p.revisions.at(-1)!.createdAt };
  }

  /** `movePage` (capability `page-order`): parent and position change, no new revision. */
  private move(server: string, ws: FakeWorkspace, id: string, headers: Record<string, string>, text: string): ApiCallResult {
    if (!this.capable(server, "page-order")) return fail("capability_not_supported");
    if (ws.role === "viewer") return fail("forbidden", "viewers cannot move pages");
    if (headers["if-match"] === undefined) return fail("precondition_required");
    const parsed = PageMoveSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return fail("validation_failed", parsed.error.message);
    const page = ws.pages.get(id);
    if (!page || page.deleted) return fail("not_found");
    if (parseEtag(headers["if-match"]) !== page.revisions.at(-1)!.id) return this.conflict(page);
    const { parentId, position } = parsed.data;
    for (let at = parentId ?? null; at !== null; at = ws.pages.get(at)?.parentId ?? null) if (at === id) return fail("validation_failed", "parentId would make the page its own ancestor");
    if (parentId !== undefined) page.parentId = parentId;
    if (position !== undefined) page.position = position;
    this.record(ws, "page.updated", page, "usr_me");
    return json(200, this.node(server, page), { etag: `"${page.revisions.at(-1)!.id}"` });
  }

  private me(server: string): { id: string; displayName: string } {
    const account = this.mustKnow(server).config.account;
    return { id: account?.id ?? "usr_me", displayName: account?.displayName ?? "Me" };
  }

  private workspaceResource(w: FakeWorkspace) {
    return { id: w.id, kind: "workspace", name: w.name, role: w.role, exportRestricted: w.exportRestricted, memberCount: w.members.length, members: w.members, createdAt: iso(T0) };
  }

  /** Deleted workspaces "me" owns that can still be restored (ADR-0025). */
  private restorable(server: string): FakeWorkspace[] {
    return (this.workspaces.get(server) ?? []).filter((w) => w.joined && w.deletedAt !== null && Date.parse(w.deletedAt) + DELETED_WORKSPACE_RESTORE_DAYS * 86_400_000 > this.now());
  }

  /** `createWorkspace` (capability `workspace-management`): the owned-workspace limit counts deleted ones too. */
  private createWorkspace(server: string, text: string): ApiCallResult {
    if (!this.capable(server, "workspace-management")) return fail("capability_not_supported");
    const parsed = WorkspaceCreateRequestSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return fail("validation_failed", parsed.error.message);
    const name = parsed.data.name.trim();
    if (name === "") return fail("validation_failed", "the name must be 1 to 200 characters");
    const limit = this.mustKnow(server).config.limits?.["maxWorkspacesPerAccount"];
    const owned = (this.workspaces.get(server) ?? []).filter((w) => w.joined && w.role === "owner" && (w.deletedAt === null || this.restorable(server).includes(w))).length;
    if (limit !== undefined && owned >= limit) return json(409, { ...problem("quota_exceeded", { detail: `an account may own at most ${limit} workspaces (${owned} owned)` }), quota: "workspacesPerAccount", limit, current: owned });
    const me = this.me(server);
    const ws = this.addWorkspace(server, { id: `ws_made_${++this.made}`, name, role: "owner", exportRestricted: parsed.data.exportRestricted ?? false, members: [{ userId: me.id, displayName: me.displayName, role: "owner" }] });
    return json(201, this.workspaceResource(ws));
  }

  private renameWorkspace(server: string, ws: FakeWorkspace, text: string): ApiCallResult {
    if (!this.capable(server, "workspace-management")) return fail("capability_not_supported");
    if (ws.role !== "owner") return fail("forbidden", "only owners of this workspace may do this");
    const parsed = WorkspaceRenameSchema.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.name.trim() === "") return fail("validation_failed", "the name must be 1 to 200 characters");
    ws.name = parsed.data.name.trim();
    return json(200, this.workspaceResource(ws));
  }

  private deleteWorkspace(server: string, id: string): ApiCallResult {
    if (!this.capable(server, "workspace-management")) return fail("capability_not_supported");
    const ws = (this.workspaces.get(server) ?? []).find((w) => w.joined && w.deletedAt === null && w.id === id);
    if (!ws) return fail("not_found");
    if (ws.role !== "owner") return fail("forbidden", "only owners of this workspace may do this");
    ws.deletedAt = iso(this.now());
    for (const link of ws.shares) link.revoked = true;
    for (const link of ws.invites) link.revoked = true;
    return { status: 204, headers: {}, body: "" };
  }

  /** `listDeletedWorkspaces`, `restoreWorkspace`, `purgeWorkspace`. */
  private deletedWorkspaces(server: string, method: string, path: string, _text: string): ApiCallResult {
    if (!this.capable(server, "workspace-management")) return fail("capability_not_supported");
    const restorable = this.restorable(server);
    if (path === "/deleted-workspaces" && method === "GET") {
      const items = restorable
        .filter((w) => w.role === "owner")
        .sort((a, b) => Date.parse(b.deletedAt!) - Date.parse(a.deletedAt!))
        .map((w) => ({ id: w.id, name: w.name, exportRestricted: w.exportRestricted, memberCount: w.members.length, deletedAt: w.deletedAt!, deletedBy: this.me(server).id, restorableUntil: iso(Date.parse(w.deletedAt!) + DELETED_WORKSPACE_RESTORE_DAYS * 86_400_000) }));
      return json(200, { items, nextCursor: null });
    }
    const m = /^\/deleted-workspaces\/([^/]+)(\/restore)?$/.exec(path);
    const ws = m ? restorable.find((w) => w.id === decodeURIComponent(m[1]!)) : undefined;
    if (!m || !ws) return fail("not_found", "no such deleted workspace");
    if (ws.role !== "owner") return fail("forbidden", "only owners of this workspace may do this");
    if (m[2] && method === "POST") {
      ws.deletedAt = null;
      return json(200, this.workspaceResource(ws));
    }
    if (!m[2] && method === "DELETE") {
      const list = this.workspaces.get(server)!;
      list.splice(list.indexOf(ws), 1);
      return { status: 204, headers: {}, body: "" };
    }
    return fail("method_not_allowed");
  }

  /** `listMembers`, `setMemberRole`, `removeMember` (capability `members`, ADR-0024), with the one-owner rule. */
  private members(server: string, ws: FakeWorkspace, method: string, rest: string, text: string): ApiCallResult {
    if (!this.capable(server, "members")) return fail("capability_not_supported");
    if (rest === "/members") return method === "GET" ? json(200, { items: ws.members, nextCursor: null }) : fail("method_not_allowed");
    const userId = decodeURIComponent(rest.slice("/members/".length));
    const me = this.me(server).id;
    const owners = ws.members.filter((m) => m.role === "owner").length;
    if (method === "PUT") {
      if (ws.role !== "owner") return fail("forbidden", "only owners of this workspace may do this");
      const parsed = MemberRoleChangeSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return fail("validation_failed", parsed.error.message);
      const member = ws.members.find((m) => m.userId === userId);
      if (!member) return fail("not_found", "no such member");
      if (member.role === "owner" && parsed.data.role !== "owner" && owners <= 1) return fail("last_owner", "a workspace keeps at least one owner: make another member an owner first");
      member.role = parsed.data.role;
      if (userId === me) ws.role = parsed.data.role;
      return json(200, member);
    }
    if (method === "DELETE") {
      if (userId !== me && ws.role !== "owner") return fail("forbidden", "only owners of this workspace may do this");
      const member = ws.members.find((m) => m.userId === userId);
      if (!member) return fail("not_found", "no such member");
      if (member.role === "owner" && owners <= 1) return fail("last_owner", "a workspace keeps at least one owner: make another member an owner first");
      ws.members = ws.members.filter((m) => m.userId !== userId);
      if (userId === me) ws.joined = false;
      return { status: 204, headers: {}, body: "" };
    }
    return fail("method_not_allowed");
  }

  private activeInvites(ws: FakeWorkspace) {
    return ws.invites.filter((l) => !l.revoked && l.uses < l.maxUses && Date.parse(l.expiresAt) > this.now());
  }

  private inviteResource(ws: FakeWorkspace, l: FakeWorkspace["invites"][number]) {
    return { id: l.id, workspaceId: ws.id, role: l.role, maxUses: l.maxUses, usesLeft: l.maxUses - l.uses, createdAt: l.createdAt, createdBy: l.createdBy, createdByName: l.createdBy === "usr_other" ? "Someone else" : this.me(this.serverOf.get(ws)!).displayName, expiresAt: l.expiresAt };
  }

  /** `createInviteLink`, `listInviteLinks`, `revokeInviteLink` (capability `invite-links`): owners only. */
  private inviteLinks(server: string, ws: FakeWorkspace, method: string, rest: string, text: string): ApiCallResult {
    if (!this.capable(server, "invite-links")) return fail("capability_not_supported");
    if (ws.role !== "owner") return fail("forbidden", "only owners of this workspace may do this");
    if (rest === "/invite-links" && method === "GET") return json(200, { items: this.activeInvites(ws).reverse().map((l) => this.inviteResource(ws, l)), nextCursor: null });
    if (rest === "/invite-links" && method === "POST") {
      const parsed = InviteLinkCreateRequestSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return fail("validation_failed", parsed.error.message);
      const limits = this.mustKnow(server).config.limits ?? {};
      const linkLimit = limits["maxInviteLinksPerWorkspace"];
      const active = this.activeInvites(ws).length;
      if (linkLimit !== undefined && active >= linkLimit) return json(409, { ...problem("quota_exceeded", { detail: `this workspace may have ${linkLimit} active invite links (${active} in use); revoke one to make room` }), quota: "inviteLinksPerWorkspace", limit: linkLimit, current: active });
      const memberLimit = limits["maxMembersPerWorkspace"];
      const maxUses = parsed.data.maxUses ?? 1;
      if (memberLimit !== undefined && maxUses > memberLimit - ws.members.length) return json(409, { ...problem("quota_exceeded", { detail: `this workspace is limited to ${memberLimit} members (${ws.members.length} in use), so a link can let in at most ${Math.max(0, memberLimit - ws.members.length)} more` }), quota: "membersPerWorkspace", limit: memberLimit, current: ws.members.length });
      const created = this.now() + ws.invites.length * 1000;
      const token = `inv${String(ws.invites.length + 1).padStart(29, "0")}`;
      const link = { id: `inv_${ws.invites.length + 1}`, role: parsed.data.role, maxUses, uses: 0, createdAt: iso(created), createdBy: this.me(server).id, expiresAt: iso(created + (parsed.data.expiresInDays ?? 7) * 86_400_000), token, revoked: false };
      ws.invites.push(link);
      return json(201, { ...this.inviteResource(ws, link), token, url: `${this.mustKnow(server).config.url}/i/${token}` });
    }
    const im = /^\/invite-links\/([^/]+)$/.exec(rest);
    if (im && method === "DELETE") {
      const link = ws.invites.find((l) => l.id === decodeURIComponent(im[1]!));
      if (!link) return fail("not_found", "invite link not found");
      link.revoked = true;
      return { status: 204, headers: {}, body: "" };
    }
    return fail("method_not_allowed");
  }

  /** `acceptInvite`: the same 404 for every dead token; someone already a member keeps their role. */
  private acceptInvite(server: string, text: string): ApiCallResult {
    if (!this.capable(server, "invite-links")) return fail("capability_not_supported");
    const parsed = InviteAcceptRequestSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return fail("validation_failed", parsed.error.message);
    for (const ws of this.workspaces.get(server) ?? []) {
      const link = this.activeInvites(ws).find((l) => l.token === parsed.data.token);
      if (!link) continue;
      if (ws.joined) return json(200, { workspaceId: ws.id, name: ws.name, role: ws.role, joined: false });
      const me = this.me(server);
      ws.joined = true;
      ws.role = link.role;
      ws.members = [...ws.members.filter((m) => m.userId !== me.id), { userId: me.id, displayName: me.displayName, role: link.role }];
      link.uses++;
      return json(200, { workspaceId: ws.id, name: ws.name, role: link.role, joined: true });
    }
    return fail("not_found", "no such invite");
  }

  /** `createShareLink` and `listShareLinks` (capability `public-share`, ADR-0023): owners and editors only. */
  private shareLinks(server: string, ws: FakeWorkspace, method: string, pageId: string, text: string): ApiCallResult {
    if (!this.capable(server, "public-share")) return fail("capability_not_supported");
    if (ws.role === "viewer") return fail("forbidden", "viewers cannot share pages");
    const page = ws.pages.get(pageId);
    if (!page || page.deleted) return fail("not_found");
    const active = () => ws.shares.filter((l) => l.pageId === pageId && !l.revoked && (l.expiresAt === null || Date.parse(l.expiresAt) > this.now()));
    if (method === "GET") return json(200, { items: active().reverse().map(({ token: _t, revoked: _r, ...link }) => link), nextCursor: null });
    if (method !== "POST") return fail("method_not_allowed");
    const parsed = ShareLinkCreateRequestSchema.safeParse(text === "" ? {} : JSON.parse(text));
    if (!parsed.success) return fail("validation_failed", parsed.error.message);
    const limit = this.mustKnow(server).config.limits?.["maxShareLinksPerWorkspace"];
    const current = ws.shares.filter((l) => !l.revoked && (l.expiresAt === null || Date.parse(l.expiresAt) > this.now())).length;
    if (limit !== undefined && current >= limit) return json(409, { ...problem("quota_exceeded", { detail: `this workspace may have ${limit} active share links (${current} in use); revoke one to make room` }), quota: "shareLinksPerWorkspace", limit, current });
    const days = parsed.data.expiresInDays === undefined ? 30 : parsed.data.expiresInDays;
    const created = this.now() + ws.shares.length * 1000;
    const token = `tok${String(ws.shares.length + 1).padStart(29, "0")}`;
    const link = { id: `shl_${ws.shares.length + 1}`, workspaceId: ws.id, pageId, createdAt: iso(created), createdBy: "usr_me", expiresAt: days === null ? null : iso(created + days * 86_400_000), token, revoked: false };
    ws.shares.push(link);
    const { token: _t, revoked: _r, ...resource } = link;
    return json(201, { ...resource, token, url: `${this.mustKnow(server).config.url}/s/${token}` });
  }

  /** The fake servers' clock for share-link expiry: the fixed test epoch. */
  private now(): number {
    return T0;
  }

  private conflict(page: FakePage): ApiCallResult {
    return json(412, { ...problem("revision_conflict", { detail: "the page changed since that revision" }), currentRevision: page.revisions.at(-1)! });
  }

  private capabilities(config: FakeServerConfig) {
    return {
      protocolVersion: "1.0",
      capabilities: config.capabilities ?? ["search", "transfers", "attachments", "page-order", "page-kind"],
      ...(config.limits ? { limits: config.limits } : {}),
      server: { name: config.name ?? new URL(config.url).host },
    };
  }

  /** Does the server that holds `ws` list `page-kind`? Then it derives the kind from frontmatter, like the reference server. */
  private kinded(ws: FakeWorkspace): boolean {
    const server = this.serverOf.get(ws);
    return server !== undefined && this.capable(server, "page-kind");
  }

  private capable(server: string, capability: string): boolean {
    return (this.capabilities(this.mustKnow(server).config).capabilities as string[]).includes(capability);
  }

  // -------------------------------------------------------------- transfers
  // The reference server's rules (apps/server/src/routes/transfers.ts), in memory.

  private createTransfer(server: string, ws: FakeWorkspace, headers: Record<string, string>, text: string): ApiCallResult {
    if (!this.capable(server, "transfers")) return fail("capability_not_supported");
    const parsed = TransferCreateRequestSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return fail("validation_failed", parsed.error.message);
    const plan = parsed.data;
    if (headers["idempotency-key"] !== plan.operationId) return fail("validation_failed", "Idempotency-Key must equal operationId");
    const write = plan.direction === "to_workspace" || plan.mode === "move";
    if (write && ws.role === "viewer") return fail("forbidden");
    const existing = this.transfers.get(plan.operationId);
    if (existing) return existing.body === text && existing.workspace === ws ? json(201, existing.resource) : fail("idempotency_key_reused");
    const now = iso(T0 + ++this.clock * 1000);
    let transfer: FakeTransfer;
    if (plan.direction === "to_workspace") {
      const ids = plan.pages.map((p) => p.pageId);
      if (new Set(ids).size !== ids.length || ids.some((id) => ws.pages.has(id))) return fail("validation_failed", "pageId values must be new and unique in the workspace");
      if (plan.attachmentIds?.some((id) => !ws.attachments.has(id))) return fail("validation_failed", "unknown attachment");
      const quota = this.quota(server, ws, plan.pages.length);
      if (quota) return quota;
      transfer = {
        body: text,
        workspace: ws,
        staged: plan.pages.map((p) => ({ pageId: p.pageId, parentId: p.parentId, title: p.title, markdown: p.markdown })),
        resource: { operationId: plan.operationId, workspaceId: ws.id, direction: "to_workspace", mode: plan.mode, state: "stage", items: plan.pages.map((p) => ({ pageId: p.pageId, sourceId: p.sourceId, revisionId: null, state: "staged" })), createdAt: now, updatedAt: now, error: null },
      };
    } else {
      if (ws.exportRestricted) return fail("export_restricted", "this workspace forbids exporting content");
      const items: TransferResource["items"] = [];
      for (const { pageId } of plan.pages) {
        const page = ws.pages.get(pageId);
        if (!page || page.deleted) return fail("not_found", `page ${pageId} not found`);
        items.push({ pageId, revisionId: page.revisions.at(-1)!.id, state: "staged" });
      }
      transfer = { body: text, workspace: ws, staged: [], resource: { operationId: plan.operationId, workspaceId: ws.id, direction: "from_workspace", mode: plan.mode, state: "stage", items, createdAt: now, updatedAt: now, error: null } };
    }
    this.transfers.set(plan.operationId, transfer);
    return json(201, transfer.resource);
  }

  private quota(server: string, ws: FakeWorkspace, adding: number): ApiCallResult | undefined {
    const limit = this.mustKnow(server).config.limits?.["maxPagesPerWorkspace"];
    const count = [...ws.pages.values()].filter((p) => !p.deleted).length;
    if (limit === undefined || count + adding <= limit) return undefined;
    return json(409, { ...problem("quota_exceeded", { detail: `this workspace is limited to ${limit} pages` }), quota: "pagesPerWorkspace", limit, current: count });
  }

  private transferRoute(server: string, method: string, id: string, action: string, text: string): ApiCallResult {
    if (!this.capable(server, "transfers")) return fail("capability_not_supported");
    const t = this.transfers.get(id);
    if (!t || !(this.workspaces.get(server) ?? []).includes(t.workspace)) return fail("not_found", "transfer not found");
    const r = t.resource;
    const ws = t.workspace;
    if (action === "" && method === "GET") return json(200, r);
    if (method !== "POST") return fail("method_not_allowed");
    const committed = r.state === "done" || r.state === "destination_committed_source_cleanup_pending";
    if (action === "/abort") {
      if (r.state === "aborted") return json(200, r);
      if (committed) return fail("invalid_transfer_state", "a committed transfer cannot be aborted");
      t.staged = [];
      for (const item of r.items) item.state = "skipped";
      r.state = "aborted";
      return json(200, r);
    }
    if (r.state === "aborted" || r.state === "failed") return fail("invalid_transfer_state", `transfer is ${r.state}`);
    if (committed) return json(200, r);
    const body = TransferCommitRequestSchema.safeParse(text === "" ? {} : JSON.parse(text));
    if (!body.success) return fail("validation_failed");
    if (r.direction === "to_workspace") {
      if (t.staged.some((s) => ws.pages.has(s.pageId))) {
        r.state = "failed";
        r.error = { code: "validation_failed", detail: "a pageId was taken" };
        for (const item of r.items) item.state = "failed";
        return fail("invalid_transfer_state", "a pageId was taken in the workspace after the transfer was staged");
      }
      const quota = this.quota(server, ws, t.staged.length);
      if (quota) return quota;
      for (const s of t.staged) {
        const page: FakePage = { id: s.pageId, parentId: s.parentId, title: s.title, markdown: s.markdown, revisions: [], deleted: false };
        page.revisions.push(this.revision(page, "usr_me"));
        ws.pages.set(page.id, page);
        this.record(ws, "page.created", page, "usr_me");
        const item = r.items.find((i) => i.pageId === s.pageId)!;
        item.state = "committed";
        item.revisionId = page.revisions.at(-1)!.id;
      }
      t.staged = [];
      r.state = "done";
      return json(200, r);
    }
    const verified = body.data.verified ?? [];
    for (const v of verified) {
      const item = r.items.find((i) => i.pageId === v.pageId);
      const rev = ws.pages.get(v.pageId)?.revisions.find((x) => x.id === v.revisionId);
      if (!item || item.revisionId !== v.revisionId || rev?.contentHash !== v.contentHash) return fail("validation_failed", `verified entry for ${v.pageId} does not match the pinned revision`);
    }
    if (r.mode === "copy") {
      for (const item of r.items) item.state = "committed";
      r.state = "done";
      return json(200, r);
    }
    if (r.items.some((i) => !verified.some((v) => v.pageId === i.pageId))) return fail("validation_failed", "a move commit must verify every item");
    let pending = false;
    for (const item of r.items) {
      const page = ws.pages.get(item.pageId)!;
      if (!page.deleted && page.revisions.at(-1)!.id === item.revisionId) {
        page.deleted = true;
        this.record(ws, "page.deleted", page, "usr_me");
        item.state = "committed";
      } else {
        item.state = "failed";
        item.error = "revision_conflict";
        pending = true;
      }
    }
    r.state = pending ? "destination_committed_source_cleanup_pending" : "done";
    return json(200, r);
  }

  private resource(ws: FakeWorkspace, page: FakePage) {
    const first = page.revisions[0]!;
    const last = page.revisions.at(-1)!;
    return {
      id: page.id,
      markdown: page.markdown,
      revision: last,
      metadata: { workspaceId: ws.id, parentId: page.parentId, title: page.title, ...(page.position !== undefined ? { position: page.position } : {}), ...(this.kinded(ws) ? { kind: pageKindOf(page.markdown) } : {}), createdAt: first.createdAt, createdBy: first.authorId, updatedAt: last.createdAt, updatedBy: last.authorId },
    };
  }

  private revision(page: FakePage, author: string): RevisionSummary {
    const bytes = new TextEncoder().encode(page.markdown);
    page.history = [...(page.history ?? []), page.markdown];
    return { id: `rev_${++this.seq}`, pageId: page.id, parentId: page.revisions.at(-1)?.id ?? null, createdAt: iso(T0 + ++this.clock * 1000), authorId: author, title: page.title, size: bytes.length, contentHash: sha256Hex(bytes) };
  }

  private record(ws: FakeWorkspace, kind: "page.created" | "page.updated" | "page.deleted", page: FakePage, actor: string): void {
    const base = { id: `chg_${ws.changes.length + 1}`, kind, occurredAt: iso(T0 + ++this.clock * 1000), actorId: actor, pageId: page.id };
    ws.changes.push(kind === "page.deleted" ? base : { ...base, revisionId: page.revisions.at(-1)!.id, parentId: page.parentId, title: page.title, ...(page.position !== undefined ? { position: page.position } : {}), ...(this.kinded(ws) ? { pageKind: pageKindOf(page.markdown) } : {}) });
  }

  private cursor(n: number): string {
    return `c${n}`;
  }

  private infoFor(config: FakeServerConfig): ServerInfo {
    return {
      id: `srv${this.nextServer++}`,
      url: config.url,
      label: config.name ?? new URL(config.url).host,
      auth: "signed-out",
      providers: config.providers ?? [],
      ...(config.limits ? { limits: config.limits } : {}),
    };
  }

  private signInAs(known: Known, auth: "browser" | "token"): ServerInfo {
    known.info = { ...known.info, auth, account: known.config.account ?? { id: "usr_me", displayName: "Me" } };
    known.expired = false;
    return structuredClone(known.info);
  }

  private mustKnow(server: string): Known {
    const known = this.known.get(server);
    if (!known) throw new HostCallError("BAD_HANDLE", `Unknown server ${server}`);
    return known;
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

function json(status: number, body: unknown, headers: Record<string, string> = {}): ApiCallResult {
  return { status, headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json", ...headers }, body: JSON.stringify(body) };
}

function fail(code: ErrorCode, detail?: string): ApiCallResult {
  const p = problem(code, detail === undefined ? {} : { detail });
  return json(p.status, p);
}
