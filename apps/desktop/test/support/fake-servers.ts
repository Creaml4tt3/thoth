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
import { parseEtag, problem, type ChangeEntry, type ErrorCode, type RevisionSummary, type Role } from "@thoth/workspace-protocol";

export interface FakePage {
  id: string;
  parentId: string | null;
  title: string;
  markdown: string;
  revisions: RevisionSummary[];
  deleted: boolean;
}

export interface FakeWorkspace {
  id: string;
  name: string;
  role: Role;
  pages: Map<string, FakePage>;
  changes: ChangeEntry[];
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
  /** Every api.call, in order. */
  readonly calls: ApiCallArgs[] = [];
  /** Tokens `useToken` received (to prove the UI sent it once). */
  readonly tokensReceived: string[] = [];
  /** "auto" finishes browser sign-in at once; "manual" waits for `finishSignIn` / `failSignIn`. */
  signInMode: "auto" | "manual" = "auto";
  private readonly pending = new Map<string, PendingSignIn>();
  private nextServer = 1;
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

  addWorkspace(server: string, init: { id?: string; name: string; role?: Role }): FakeWorkspace {
    const ws: FakeWorkspace = { id: init.id ?? `ws_${this.workspaces.size + 1}${server}`, name: init.name, role: init.role ?? "editor", pages: new Map(), changes: [] };
    const list = this.workspaces.get(server) ?? [];
    list.push(ws);
    this.workspaces.set(server, list);
    return ws;
  }

  /** Creates or changes a page as another user would (a new revision and a change-feed entry). */
  writeAsOther(ws: FakeWorkspace, init: { id?: string; title: string; markdown: string; parentId?: string | null }): FakePage {
    const id = init.id ?? newStableId();
    const existing = ws.pages.get(id);
    const page = existing ?? { id, parentId: init.parentId ?? null, title: init.title, markdown: "", revisions: [], deleted: false };
    if (init.parentId !== undefined) page.parentId = init.parentId;
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
    if (known.expired) {
      const { account: _account, ...info } = known.info;
      known.info = { ...info, auth: "signed-out" };
      known.expired = false;
    }
    if (known.info.auth === "signed-out") return fail("unauthenticated");
    const headers = Object.fromEntries(Object.entries(args.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return this.route(args.server, args.method, path, args.query ?? {}, headers, body ? decoder.decode(body) : "");
  }

  // ----------------------------------------------------------------- server

  private route(server: string, method: string, path: string, query: Record<string, string>, headers: Record<string, string>, text: string): ApiCallResult {
    if (path === "/me" && method === "GET") return json(200, this.mustKnow(server).config.account ?? { id: "usr_me", displayName: "Me" });
    if (path === "/workspaces" && method === "GET") {
      return json(200, { items: (this.workspaces.get(server) ?? []).map((w) => ({ id: w.id, kind: "workspace", name: w.name, role: w.role, exportRestricted: false, memberCount: 2, createdAt: iso(T0) })), nextCursor: null });
    }
    const m = /^\/workspaces\/([^/]+)(\/.*)$/.exec(path);
    const ws = m ? (this.workspaces.get(server) ?? []).find((w) => w.id === decodeURIComponent(m[1]!)) : undefined;
    if (!m || !ws) return fail("not_found");
    const rest = m[2]!;
    if (rest === "/tree" && method === "GET") {
      const items = [...ws.pages.values()].filter((p) => !p.deleted).map((p) => ({ id: p.id, parentId: p.parentId, title: p.title, revisionId: p.revisions.at(-1)!.id, updatedAt: p.revisions.at(-1)!.createdAt }));
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
    const pm = /^\/pages\/([^/]+)$/.exec(rest);
    if (!pm) return fail("not_found");
    const id = decodeURIComponent(pm[1]!);
    const page = ws.pages.get(id);
    const live = page && !page.deleted ? page : undefined;
    if (method === "GET") {
      if (!live) return fail("not_found");
      return json(200, this.resource(ws, live), { etag: `"${live.revisions.at(-1)!.id}"` });
    }
    if (method === "PUT") {
      if (ws.role === "viewer") return fail("forbidden", "viewers cannot change pages");
      const ifMatch = headers["if-match"];
      const ifNone = headers["if-none-match"];
      if (ifMatch === undefined && ifNone === undefined) return fail("precondition_required");
      const write = JSON.parse(text) as { title: string; markdown: string; parentId?: string | null };
      if (ifNone === "*") {
        if (page) return this.conflict(page);
        const limit = this.mustKnow(server).config.limits?.["maxPagesPerWorkspace"];
        const count = [...ws.pages.values()].filter((p) => !p.deleted).length;
        if (limit !== undefined && count + 1 > limit) {
          return json(409, { ...problem("quota_exceeded", { detail: `this workspace is limited to ${limit} pages (${count} in use); delete pages to make room` }), quota: "pagesPerWorkspace", limit, current: count });
        }
        const created: FakePage = { id, parentId: write.parentId ?? null, title: write.title, markdown: write.markdown, revisions: [], deleted: false };
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
      live.revisions.push(this.revision(live, "usr_me"));
      this.record(ws, "page.updated", live, "usr_me");
      return json(200, this.resource(ws, live), { etag: `"${live.revisions.at(-1)!.id}"` });
    }
    return fail("method_not_allowed");
  }

  private conflict(page: FakePage): ApiCallResult {
    return json(412, { ...problem("revision_conflict", { detail: "the page changed since that revision" }), currentRevision: page.revisions.at(-1)! });
  }

  private capabilities(config: FakeServerConfig) {
    return {
      protocolVersion: "1.0",
      capabilities: ["search"],
      ...(config.limits ? { limits: config.limits } : {}),
      server: { name: config.name ?? new URL(config.url).host },
    };
  }

  private resource(ws: FakeWorkspace, page: FakePage) {
    const first = page.revisions[0]!;
    const last = page.revisions.at(-1)!;
    return {
      id: page.id,
      markdown: page.markdown,
      revision: last,
      metadata: { workspaceId: ws.id, parentId: page.parentId, title: page.title, createdAt: first.createdAt, createdBy: first.authorId, updatedAt: last.createdAt, updatedBy: last.authorId },
    };
  }

  private revision(page: FakePage, author: string): RevisionSummary {
    const bytes = new TextEncoder().encode(page.markdown);
    return { id: `rev_${++this.seq}`, pageId: page.id, parentId: page.revisions.at(-1)?.id ?? null, createdAt: iso(T0 + ++this.clock * 1000), authorId: author, title: page.title, size: bytes.length, contentHash: sha256Hex(bytes) };
  }

  private record(ws: FakeWorkspace, kind: "page.created" | "page.updated" | "page.deleted", page: FakePage, actor: string): void {
    const base = { id: `chg_${ws.changes.length + 1}`, kind, occurredAt: iso(T0 + ++this.clock * 1000), actorId: actor, pageId: page.id };
    ws.changes.push(kind === "page.deleted" ? base : { ...base, revisionId: page.revisions.at(-1)!.id, parentId: page.parentId, title: page.title });
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
