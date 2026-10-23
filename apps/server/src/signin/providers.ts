import type { GithubProviderConfig, OidcProviderConfig, ProviderConfig } from "../config.ts";
import { GOOGLE_ISSUER, isLoopbackHost } from "../config.ts";
import { TokenRejected, verifyIdToken, type Jwk } from "./jwt.ts";

/** What a provider proves about the person who signed in. `email` is present only when the provider verified it. */
export interface UpstreamIdentity {
  subject: string;
  email?: string;
  name?: string;
}

/** The provider could not be reached or answered something unusable (`server_error` to the client). Never carries a token. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface AuthorizeParams {
  state: string;
  codeChallenge: string;
  /** OIDC only. */
  nonce: string | null;
  redirectUri: string;
}

export interface ExchangeParams {
  code: string;
  verifier: string;
  nonce: string | null;
  redirectUri: string;
}

/** One upstream identity provider. The server is a confidential client of it; its secret and tokens never leave this module. */
export interface UpstreamProvider {
  readonly id: string;
  readonly name: string;
  readonly usesNonce: boolean;
  authorizationUrl(params: AuthorizeParams): Promise<string>;
  /** Exchanges the code and returns the verified identity. Throws `ProviderError` or `TokenRejected`. */
  exchange(params: ExchangeParams): Promise<UpstreamIdentity>;
}

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const DISCOVERY_TTL_MS = 3_600_000;
const JWKS_TTL_MS = 3_600_000;
const USER_AGENT = "thoth-server";

/** An endpoint the server will call or send a browser to: https, or http only on a loopback host (local test issuers). */
function trustedUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) return url.toString();
  } catch {
    /* not a URL */
  }
  return null;
}

/** Fetches JSON with a timeout and a size cap, refusing redirects. Errors name the step, never the URL's query or a token. */
async function fetchJson(step: string, url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json", "user-agent": USER_AGENT, ...(init.headers as Record<string, string> | undefined) } });
  } catch (error) {
    throw new ProviderError(`${step}: request failed (${error instanceof Error ? error.name : "error"})`);
  }
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > MAX_RESPONSE_BYTES) throw new ProviderError(`${step}: response too large`);
  const bytes = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (bytes.length > MAX_RESPONSE_BYTES) throw new ProviderError(`${step}: response too large`);
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ProviderError(`${step}: HTTP ${res.status}, not JSON`);
  }
  return { status: res.status, body };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A display name the users table accepts (1 to 200 characters), or undefined. */
function displayNameOf(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    // Control characters are dropped; the name is rendered in clients.
    const name = c.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (name.length > 0) return [...name].slice(0, 200).join("");
  }
  return undefined;
}

/** An email shape check only: the provider vouches for the address, this keeps garbage out of the column. */
const plausibleEmail = (v: unknown): v is string => typeof v === "string" && v.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(v);

interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  basicAuth: boolean;
}

/**
 * Generic OpenID Connect (Google, Keycloak, Authentik...). Discovery and the JWKS are cached for an hour; a token
 * whose `kid` is not in the cached set triggers one JWKS refetch (key rotation). Concurrent fetches are shared.
 */
export class OidcProvider implements UpstreamProvider {
  readonly id: string;
  readonly name: string;
  readonly usesNonce = true;
  readonly #config: OidcProviderConfig;
  #discovery: { value: Discovery; at: number } | null = null;
  #discovering: Promise<Discovery> | null = null;
  #jwks: { keys: Jwk[]; at: number } | null = null;
  #jwksFetching: Promise<Jwk[]> | null = null;

  constructor(config: OidcProviderConfig) {
    this.#config = config;
    this.id = config.id;
    this.name = config.name;
  }

  async #discover(): Promise<Discovery> {
    if (this.#discovery && Date.now() - this.#discovery.at < DISCOVERY_TTL_MS) return this.#discovery.value;
    this.#discovering ??= (async () => {
      try {
        const base = this.#config.issuer.replace(/\/+$/, "");
        const { status, body } = await fetchJson("discovery", `${base}/.well-known/openid-configuration`);
        if (status !== 200 || !isObject(body)) throw new ProviderError(`discovery: HTTP ${status}`);
        // OIDC Discovery 4.3: the document's issuer must equal the configured one exactly.
        if (body.issuer !== this.#config.issuer) throw new ProviderError("discovery: issuer mismatch");
        const authorizationEndpoint = trustedUrl(body.authorization_endpoint);
        const tokenEndpoint = trustedUrl(body.token_endpoint);
        const jwksUri = trustedUrl(body.jwks_uri);
        if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) throw new ProviderError("discovery: missing or insecure endpoint");
        const methods = Array.isArray(body.token_endpoint_auth_methods_supported) ? body.token_endpoint_auth_methods_supported : ["client_secret_basic"];
        const value: Discovery = { authorizationEndpoint, tokenEndpoint, jwksUri, basicAuth: methods.includes("client_secret_basic") || !methods.includes("client_secret_post") };
        this.#discovery = { value, at: Date.now() };
        return value;
      } finally {
        this.#discovering = null;
      }
    })();
    return this.#discovering;
  }

  async #keys(refetch: boolean): Promise<Jwk[]> {
    if (!refetch && this.#jwks && Date.now() - this.#jwks.at < JWKS_TTL_MS) return this.#jwks.keys;
    this.#jwksFetching ??= (async () => {
      try {
        const { jwksUri } = await this.#discover();
        const { status, body } = await fetchJson("jwks", jwksUri);
        if (status !== 200 || !isObject(body) || !Array.isArray(body.keys)) throw new ProviderError(`jwks: HTTP ${status}`);
        const keys = body.keys.filter(isObject) as Jwk[];
        this.#jwks = { keys, at: Date.now() };
        return keys;
      } finally {
        this.#jwksFetching = null;
      }
    })();
    return this.#jwksFetching;
  }

  async authorizationUrl(params: AuthorizeParams): Promise<string> {
    const { authorizationEndpoint } = await this.#discover();
    const url = new URL(authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.#config.clientId);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", params.state);
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (params.nonce !== null) url.searchParams.set("nonce", params.nonce);
    return url.toString();
  }

  async exchange(params: ExchangeParams): Promise<UpstreamIdentity> {
    if (params.nonce === null) throw new ProviderError("token: no nonce stored");
    const discovery = await this.#discover();
    const form = new URLSearchParams({ grant_type: "authorization_code", code: params.code, redirect_uri: params.redirectUri, code_verifier: params.verifier });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (discovery.basicAuth) {
      // RFC 6749 2.3.1: both parts are form-urlencoded before base64.
      const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, "+");
      headers.authorization = `Basic ${Buffer.from(`${enc(this.#config.clientId)}:${enc(this.#config.clientSecret)}`).toString("base64")}`;
    } else {
      form.set("client_id", this.#config.clientId);
      form.set("client_secret", this.#config.clientSecret);
    }
    const { status, body } = await fetchJson("token", discovery.tokenEndpoint, { method: "POST", headers, body: form.toString() });
    if (status !== 200 || !isObject(body)) throw new ProviderError(`token: HTTP ${status}${isObject(body) && typeof body.error === "string" ? ` (${body.error.slice(0, 40).replace(/[^\w.-]/g, "")})` : ""}`);
    const idToken = body.id_token;
    if (typeof idToken !== "string" || idToken.length > 16_384) throw new TokenRejected("no ID token");
    // Google documents both forms of its issuer in ID tokens; no other issuer gets an alias.
    const issuerAliases = this.#config.issuer === GOOGLE_ISSUER ? ["accounts.google.com"] : [];
    const claims = await verifyIdToken(idToken, (_header, refetch) => this.#keys(refetch), { issuer: this.#config.issuer, issuerAliases, clientId: this.#config.clientId, nonce: params.nonce });
    const email = claims.email_verified === true && plausibleEmail(claims.email) ? claims.email : undefined;
    const name = displayNameOf(claims.name, claims.preferred_username, email);
    return { subject: claims.sub, ...(email ? { email } : {}), ...(name ? { name } : {}) };
  }
}

/**
 * GitHub OAuth App (not OIDC). The subject is the numeric user ID from `GET /user`, which never changes (the login
 * can). The email is the primary address from `GET /user/emails`, and only when GitHub marks it verified.
 */
export class GithubProvider implements UpstreamProvider {
  readonly id = "github";
  readonly name: string;
  readonly usesNonce = false;
  readonly #config: GithubProviderConfig;

  constructor(config: GithubProviderConfig) {
    this.#config = config;
    this.name = config.name;
  }

  async authorizationUrl(params: AuthorizeParams): Promise<string> {
    const url = new URL(`${this.#config.webUrl}/login/oauth/authorize`);
    url.searchParams.set("client_id", this.#config.clientId);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("scope", "read:user user:email");
    url.searchParams.set("state", params.state);
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("allow_signup", "true");
    return url.toString();
  }

  async exchange(params: ExchangeParams): Promise<UpstreamIdentity> {
    const form = new URLSearchParams({ client_id: this.#config.clientId, client_secret: this.#config.clientSecret, code: params.code, redirect_uri: params.redirectUri, code_verifier: params.verifier });
    const token = await fetchJson("token", `${this.#config.webUrl}/login/oauth/access_token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    // GitHub answers 200 with `{ error }` for a bad code; either way there is no token.
    if (token.status !== 200 || !isObject(token.body) || typeof token.body.access_token !== "string" || token.body.access_token.length === 0) {
      const code = isObject(token.body) && typeof token.body.error === "string" ? token.body.error.slice(0, 40).replace(/[^\w.-]/g, "") : "";
      if (code === "bad_verification_code" || code === "incorrect_client_credentials" || code === "redirect_uri_mismatch") throw new TokenRejected(`token refused (${code})`);
      throw new ProviderError(`token: HTTP ${token.status}${code ? ` (${code})` : ""}`);
    }
    const auth = { authorization: `Bearer ${token.body.access_token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    const user = await fetchJson("user", `${this.#config.apiUrl}/user`, { headers: auth });
    if (user.status !== 200 || !isObject(user.body)) throw new ProviderError(`user: HTTP ${user.status}`);
    const id = user.body.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new ProviderError("user: no numeric id");
    const emails = await fetchJson("emails", `${this.#config.apiUrl}/user/emails`, { headers: auth });
    let email: string | undefined;
    if (emails.status === 200 && Array.isArray(emails.body)) {
      const primary = emails.body.find((e) => isObject(e) && e.primary === true);
      if (isObject(primary) && primary.verified === true && plausibleEmail(primary.email)) email = primary.email;
    } else if (emails.status !== 404 && emails.status !== 403) throw new ProviderError(`emails: HTTP ${emails.status}`);
    // The provider token goes out of scope here: it is never stored or logged.
    const name = displayNameOf(user.body.name, user.body.login);
    return { subject: String(id), ...(email ? { email } : {}), ...(name ? { name } : {}) };
  }
}

export function createProvider(config: ProviderConfig): UpstreamProvider {
  return config.kind === "github" ? new GithubProvider(config) : new OidcProvider(config);
}
