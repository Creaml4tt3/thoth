/**
 * Sign-in for the web client: the `thoth-web` client of docs/protocol/sign-in.md.
 *
 * - Authorization Code + PKCE S256 and `state`, by a top-level redirect to the server's `authorizationEndpoint`.
 *   The verifier and state are kept in `sessionStorage` only for that round trip and deleted on return.
 * - `/app/callback` checks `state` and `iss` (RFC 9207), then exchanges the code. The refresh token comes back as
 *   an `HttpOnly` cookie on the API origin; this code never sees it.
 * - The access token lives in this module's memory only: never in storage, a cookie we set, the DOM or the URL.
 * - Refresh runs one at a time (a second refresh with the same cookie counts as reuse and revokes the session).
 * - Sign-out calls the revocation endpoint, which revokes the session and clears the cookie.
 */
import type { SignIn } from "@thoth/workspace-protocol";

export const CLIENT_ID = "thoth-web";
/** Where the sign-in round trip waits (deleted on return). */
const PENDING_KEY = "thoth.signin.pending";
/** Refresh this long before the access token expires. */
const REFRESH_EARLY_MS = 60_000;
const VERIFIER_BYTES = 48;

export interface AuthDeps {
  /** The server's origin (`VITE_DEFAULT_SERVER`), the expected `iss`. */
  server: string;
  signIn: SignIn;
  redirectUri: string;
  fetch: typeof fetch;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** Top-level navigation (tests replace it). */
  navigate(url: string): void;
  random(bytes: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

interface Pending {
  state: string;
  verifier: string;
  provider: string;
  createdAt: number;
}

export type AuthStatus = "unknown" | "signed-in" | "signed-out";

/** Why a callback failed; the UI turns it into words. */
export type CallbackFailure = "access_denied" | "state" | "exchange" | "generic";

export class CallbackError extends Error {
  readonly reason: CallbackFailure;
  constructor(reason: CallbackFailure) {
    super(`sign-in failed: ${reason}`);
    this.name = "CallbackError";
    this.reason = reason;
  }
}

/** The network or the server failed (not a refusal): keep whatever session there is and try again later. */
export class Unreachable extends Error {
  constructor() {
    super("The Thoth server could not be reached.");
    this.name = "Unreachable";
  }
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PENDING_TTL_MS = 10 * 60_000;

export class AuthSession {
  private readonly deps: AuthDeps;
  private accessToken: string | null = null;
  private expiresAt = 0;
  private timer: unknown = null;
  private refreshing: Promise<boolean> | null = null;
  private statusValue: AuthStatus = "unknown";
  private readonly listeners = new Set<() => void>();

  constructor(deps: AuthDeps) {
    this.deps = deps;
  }

  // ------------------------------------------------------------------ state

  get status(): AuthStatus {
    return this.statusValue;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getStatus = (): AuthStatus => this.statusValue;

  private setStatus(next: AuthStatus): void {
    if (next === this.statusValue) return;
    this.statusValue = next;
    for (const listener of [...this.listeners]) listener();
  }

  private forget(): void {
    this.accessToken = null;
    this.expiresAt = 0;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private adopt(body: unknown): void {
    const token = (body as { access_token?: unknown } | null)?.access_token;
    const expiresIn = (body as { expires_in?: unknown } | null)?.expires_in;
    if (typeof token !== "string" || token.length === 0) throw new CallbackError("exchange");
    this.accessToken = token;
    const lifetime = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn * 1000 : 15 * 60_000;
    this.expiresAt = this.deps.now() + lifetime;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => void this.refresh().catch(() => undefined), Math.max(5_000, lifetime - REFRESH_EARLY_MS));
    this.setStatus("signed-in");
  }

  // ---------------------------------------------------------------- sign-in

  /** Starts the round trip: stores the verifier and state for the callback, then leaves the page. */
  async begin(provider: string): Promise<void> {
    const verifier = base64url(this.deps.random(VERIFIER_BYTES));
    const state = base64url(this.deps.random(24));
    const challenge = base64url(await this.deps.sha256(new TextEncoder().encode(verifier)));
    const pending: Pending = { state, verifier, provider, createdAt: this.deps.now() };
    this.deps.storage.setItem(PENDING_KEY, JSON.stringify(pending));
    const url = new URL(this.deps.signIn.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: this.deps.redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      provider,
    }).toString();
    this.deps.navigate(url.toString());
  }

  /**
   * Finishes the round trip from the callback's query. The pending entry is deleted first, whatever happens, so
   * a callback can be used once. Returns the provider the sign-in started with.
   */
  async complete(query: URLSearchParams): Promise<{ provider: string }> {
    const raw = this.deps.storage.getItem(PENDING_KEY);
    this.deps.storage.removeItem(PENDING_KEY);
    let pending: Pending | null = null;
    try {
      pending = raw ? (JSON.parse(raw) as Pending) : null;
    } catch {
      pending = null;
    }
    const state = query.get("state");
    if (!pending || typeof pending.state !== "string" || state === null || state !== pending.state || this.deps.now() - pending.createdAt > PENDING_TTL_MS) throw new CallbackError("state");
    // RFC 9207: the answer must come from our server, even for an error.
    if (query.get("iss") !== this.deps.server) throw new CallbackError("state");
    if (query.has("error")) throw new CallbackError(query.get("error") === "access_denied" ? "access_denied" : "generic");
    const code = query.get("code");
    if (!code) throw new CallbackError("generic");

    let res: Response;
    try {
      res = await this.deps.fetch(this.deps.signIn.tokenEndpoint, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.deps.redirectUri, client_id: CLIENT_ID, code_verifier: pending.verifier }).toString(),
      });
    } catch {
      throw new Unreachable();
    }
    if (!res.ok) throw new CallbackError(res.status >= 500 ? "generic" : "exchange");
    this.adopt(await res.json().catch(() => null));
    return { provider: pending.provider };
  }

  // ----------------------------------------------------------------- tokens

  /**
   * Refreshes from the cookie, one at a time. True when signed in afterwards. A refusal (4xx) signs out; a network
   * failure or a 5xx throws `Unreachable` and keeps the current state.
   */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    let res: Response;
    try {
      res = await this.deps.fetch(this.deps.signIn.tokenEndpoint, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID }).toString(),
      });
    } catch {
      throw new Unreachable();
    }
    if (res.status >= 500 || res.status === 429) throw new Unreachable();
    if (!res.ok) {
      this.forget();
      this.setStatus("signed-out");
      return false;
    }
    try {
      this.adopt(await res.json());
    } catch {
      this.forget();
      this.setStatus("signed-out");
      return false;
    }
    return true;
  }

  /** A current access token, refreshing first when it is about to expire; null when signed out. */
  async token(): Promise<string | null> {
    if (this.accessToken && this.deps.now() < this.expiresAt - 5_000) return this.accessToken;
    if (this.statusValue === "signed-out") return null;
    return (await this.refresh()) ? this.accessToken : null;
  }

  /** After a 401: the token may have been revoked or expired early. Refresh once (shared with any other caller). */
  async renew(rejected: string): Promise<string | null> {
    if (this.accessToken !== null && this.accessToken !== rejected) return this.accessToken;
    this.accessToken = null;
    return (await this.refresh()) ? this.accessToken : null;
  }

  /** Revokes the session on the server (the cookie identifies it) and forgets the access token. */
  async signOut(): Promise<void> {
    this.forget();
    try {
      await this.deps.fetch(this.deps.signIn.revocationEndpoint, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CLIENT_ID }).toString(),
      });
    } finally {
      this.setStatus("signed-out");
    }
  }

  dispose(): void {
    this.forget();
    this.listeners.clear();
  }
}
