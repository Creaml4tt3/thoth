/**
 * The web client's fake server: a `fetch` for UI tests. Protocol requests are answered by the same `FakeServers`
 * the desktop tests use (tests/helpers/fake-servers.ts), so both apps are tested against one set of server rules.
 * On top of it, the `thoth-web` broker endpoints (docs/protocol/sign-in.md): `/auth/authorize` is a navigation the
 * test finishes with `callbackUrl()`, and `/auth/token` and `/auth/revoke` keep a refresh "cookie" as the browser
 * would (the page never sees it). Tokens are obviously fake test values.
 */
import { FakeServers, type FakeServerConfig } from "../../../../tests/helpers/fake-servers.ts";

export const SERVER = "https://api.thoth.test";
export const APP_ORIGIN = "https://thoth.test";
export const REDIRECT_URI = `${APP_ORIGIN}/app/callback`;

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  credentials: RequestCredentials | undefined;
}

export class FakeWebServer {
  readonly servers = new FakeServers();
  /** The host handle of the one server inside `servers`. */
  readonly handle: string;
  readonly requests: Recorded[] = [];
  /** The refresh "cookie" the browser holds for the API origin. */
  cookie: string | null = null;
  /** Sessions the server knows: refresh token -> live. */
  readonly sessions = new Map<string, { live: boolean; access: string }>();
  /** Codes issued by authorize: code -> challenge. */
  private readonly codes = new Map<string, { challenge: string; provider: string }>();
  private seq = 0;
  /** Make the next N token-endpoint calls fail at the network level. */
  networkDownFor = 0;
  /** Access tokens the API currently accepts. */
  private readonly live = new Set<string>();
  /** Delay for /auth/token answers, to provoke concurrent refreshes. */
  tokenDelayMs = 0;
  refreshCalls = 0;

  constructor(config: Partial<FakeServerConfig> = {}) {
    this.handle = this.servers.connect({
      url: SERVER,
      name: "Thoth demo",
      providers: [
        { id: "google", name: "Google" },
        { id: "github", name: "GitHub" },
      ],
      limits: { maxPagesPerWorkspace: 200, maxWorkspacesPerAccount: 1, idempotencyWindowSeconds: 86400 },
      account: { id: "usr_ada", displayName: "Ada Lovelace", email: "ada@example.org" },
      ...config,
    });
  }

  workspace(name: string, role: "owner" | "editor" | "viewer" = "owner") {
    return this.servers.addWorkspace(this.handle, { name, role });
  }

  /** Signs the browser in without the UI (a returning visitor with a valid cookie). */
  giveCookie(): void {
    const refresh = `thoth_rt_fake${++this.seq}`;
    this.sessions.set(refresh, { live: true, access: "" });
    this.cookie = refresh;
  }

  /** The URL the server would redirect the browser back to after a successful sign-in at `authorizeUrl`. */
  callbackUrl(authorizeUrl: string, override: Record<string, string | null> = {}): string {
    const q = new URL(authorizeUrl).searchParams;
    const code = `code${++this.seq}`;
    this.codes.set(code, { challenge: q.get("code_challenge")!, provider: q.get("provider") ?? "" });
    const back = new URL(q.get("redirect_uri")!);
    const params: Record<string, string | null> = { code, state: q.get("state"), iss: SERVER, ...override };
    for (const [k, v] of Object.entries(params)) if (v !== null) back.searchParams.set(k, v);
    return back.toString();
  }

  /** Ends the session on the server (as maintenance or a reuse would): the next refresh is refused. */
  revokeAll(): void {
    for (const s of this.sessions.values()) s.live = false;
    this.live.clear();
  }

  /** Makes the current access token stop working (expired early); the cookie still refreshes. */
  expireAccess(): void {
    this.live.clear();
  }

  liveSessions(): number {
    return [...this.sessions.values()].filter((s) => s.live).length;
  }

  fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    // jsdom and Node have separate Uint8Array classes, so check the shape rather than `instanceof`.
    const raw = init.body as unknown;
    const body = typeof raw === "string" ? raw : ArrayBuffer.isView(raw) ? new TextDecoder().decode(raw) : "";
    const method = (init.method ?? "GET").toUpperCase();
    this.requests.push({ url: url.toString(), method, headers, body, credentials: init.credentials });
    if (url.origin !== SERVER) throw new TypeError(`Failed to fetch ${url.origin}`);

    if (url.pathname === "/api/v1/capabilities") {
      const caps = JSON.parse((await this.servers.call({ server: this.handle, method: "GET", path: "/api/v1/capabilities" })).body) as Record<string, unknown>;
      return json(200, { ...caps, signIn: { authorizationEndpoint: `${SERVER}/auth/authorize`, tokenEndpoint: `${SERVER}/auth/token`, revocationEndpoint: `${SERVER}/auth/revoke`, providers: [{ id: "google", name: "Google" }, { id: "github", name: "GitHub" }] } });
    }
    if (url.pathname === "/auth/token") return this.token(new URLSearchParams(body), headers, init.credentials);
    if (url.pathname === "/auth/revoke") {
      if (init.credentials === "include" && this.cookie) {
        const s = this.sessions.get(this.cookie);
        if (s) {
          s.live = false;
          this.live.delete(s.access);
        }
      }
      this.cookie = null;
      return new Response(null, { status: 200 });
    }
    if (url.pathname.startsWith("/api/v1/")) {
      const auth = headers["authorization"];
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token || !this.live.has(token)) return json(401, { type: "about:blank", title: "Unauthenticated", status: 401, code: "unauthenticated" });
      const { authorization: _a, ...rest } = headers;
      const query = Object.fromEntries(url.searchParams);
      const result = await this.servers.call(
        { server: this.handle, method: method as "GET", path: url.pathname, ...(Object.keys(query).length ? { query } : {}), ...(Object.keys(rest).length ? { headers: rest } : {}) },
        body ? new TextEncoder().encode(body) : undefined,
      );
      return new Response(result.status === 204 ? null : result.body, { status: result.status, headers: result.headers });
    }
    return json(404, {});
  };

  private async token(form: URLSearchParams, headers: Record<string, string>, credentials: RequestCredentials | undefined): Promise<Response> {
    if (this.networkDownFor > 0) {
      this.networkDownFor--;
      throw new TypeError("Failed to fetch");
    }
    if (this.tokenDelayMs) await new Promise((r) => setTimeout(r, this.tokenDelayMs));
    if (form.get("client_id") !== "thoth-web") return json(400, { error: "invalid_client" });
    if (form.get("grant_type") === "authorization_code") {
      const code = form.get("code") ?? "";
      const issued = this.codes.get(code);
      this.codes.delete(code);
      const verifier = form.get("code_verifier") ?? "";
      const challenge = await s256(verifier);
      if (!issued || issued.challenge !== challenge || form.get("redirect_uri") !== REDIRECT_URI) return json(400, { error: "invalid_grant" });
      return this.issue(null, credentials);
    }
    if (form.get("grant_type") === "refresh_token") {
      this.refreshCalls++;
      if (form.has("refresh_token")) return json(400, { error: "invalid_request" });
      if (credentials !== "include" || !this.cookie) return json(400, { error: "invalid_request" });
      const session = this.sessions.get(this.cookie);
      if (!session || !session.live) {
        this.cookie = null;
        return json(400, { error: "invalid_grant" });
      }
      // Rotation: the old cookie value is used up (a second use is reuse and revokes the session).
      this.sessions.delete(this.cookie);
      return this.issue(session, credentials);
    }
    void headers;
    return json(400, { error: "unsupported_grant_type" });
  }

  private issue(previous: { access: string } | null, credentials: RequestCredentials | undefined): Response {
    if (previous) this.live.delete(previous.access);
    const access = `thoth_at_fake${++this.seq}`;
    const refresh = `thoth_rt_fake${++this.seq}`;
    this.live.add(access);
    this.sessions.set(refresh, { live: true, access });
    if (credentials === "include") this.cookie = refresh;
    return json(200, { access_token: access, token_type: "Bearer", expires_in: 900 });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
