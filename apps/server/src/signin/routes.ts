import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createWorkspaceIn, firstWorkspaceName } from "../admin.ts";
import type { SignInConfig } from "../config.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../errors.ts";
import { audit, bodyOf, headerOf } from "../http.ts";
import { opaqueId } from "../ids.ts";
import { assertCanCreateAccount } from "../quota.ts";
import { clientIp } from "../ratelimit.ts";
import { DESKTOP, WEB, knownClient, redirectAllowed, type ClientId } from "./clients.ts";
import { chooserPage, errorPage, sendHtml } from "./html.ts";
import { TokenRejected } from "./jwt.ts";
import { ProviderError, createProvider, type UpstreamIdentity, type UpstreamProvider } from "./providers.ts";
import { PKCE_SHAPE, randomSecret, s256, safeEqual, sha256Hex } from "./secrets.ts";
import { redeemCode, refreshSession, revokeByToken, touchUser, type GrantResult, type IssuedTokens } from "./sessions.ts";

export const AUTH_PATHS = { authorize: "/auth/authorize", callback: "/auth/callback", token: "/auth/token", revoke: "/auth/revoke" } as const;
/** The endpoints a browser calls with `fetch` (CORS applies); the others are top-level navigations. */
export const isAuthCorsPath = (path: string): boolean => path === AUTH_PATHS.token || path === AUTH_PATHS.revoke;
export const isAuthPath = (path: string): boolean => path === "/auth" || path.startsWith("/auth/");

const AUTH_REQUEST_TTL_SECONDS = 600;
const CODE_TTL_SECONDS = 60;
const SIGNUP_WINDOW_HOURS = 24;
const STATE_SHAPE = /^[\x20-\x7e]{1,512}$/;
const FORM_BODY_LIMIT = 16_384;

const EXPIRED_TITLE = "This sign-in link has expired";
const EXPIRED_TEXT = "The sign-in link has expired or is not valid, or it was opened in a different browser from the one that started signing in.";

/** The `signIn` member of /capabilities (sign-in.md section 1). */
export function signInCapability(config: SignInConfig) {
  return {
    authorizationEndpoint: `${config.publicUrl}${AUTH_PATHS.authorize}`,
    tokenEndpoint: `${config.publicUrl}${AUTH_PATHS.token}`,
    revocationEndpoint: `${config.publicUrl}${AUTH_PATHS.revoke}`,
    providers: config.providers.map((p) => ({ id: p.id, name: p.name })),
  };
}

const secureOrigin = (config: SignInConfig) => config.publicUrl.startsWith("https:");
/** The refresh cookie of `thoth-web` (sign-in.md section 5). */
export const refreshCookieName = (config: SignInConfig) => (secureOrigin(config) ? "__Secure-thoth_refresh" : "thoth_refresh");
/** The browser-binding cookie of an auth request: `__Host-` on https, so no subdomain can plant or read it. */
export const bindingCookieName = (config: SignInConfig) => (secureOrigin(config) ? "__Host-thoth_signin" : "thoth_signin");

function refreshCookie(config: SignInConfig, value: string, maxAge: number): string {
  return `${refreshCookieName(config)}=${value}; Max-Age=${maxAge}; Path=/auth; HttpOnly; Secure; SameSite=Strict`;
}
function bindingCookie(config: SignInConfig, value: string, maxAge: number): string {
  return `${bindingCookieName(config)}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secureOrigin(config) ? "; Secure" : ""}`;
}

/** One named cookie from the `Cookie` header; `undefined` when absent or present more than once (ambiguous). */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 && /^[A-Za-z0-9_-]{1,200}$/.test(values[0]!) ? values[0] : undefined;
}

/** Parameters of a query or form body; a parameter sent more than once is refused (RFC 6749 section 3.1). */
function singleParams(params: URLSearchParams): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const [key, value] of params) {
    if (out.has(key)) return null;
    out.set(key, value);
  }
  return out;
}

function oauthJson(reply: FastifyReply, status: number, body: Record<string, unknown>): FastifyReply {
  reply.code(status);
  reply.header("content-type", "application/json");
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  return reply.send(JSON.stringify(body));
}

const oauthError = (reply: FastifyReply, status: number, error: string, description: string) => oauthJson(reply, status, { error, error_description: description });

/** A 302 that carries no referrer (codes and states are in the URL). */
function redirect(reply: FastifyReply, location: string): FastifyReply {
  reply.header("referrer-policy", "no-referrer");
  reply.header("location", location);
  return reply.code(302).send();
}

/** The client's redirect URI plus parameters. Values the client sent are returned unchanged (RFC 6749 section 4.1.2). */
function clientRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}

/** Maps errors thrown on /auth/* (rate limit, database) to the shape of the endpoint: HTML for navigations, OAuth JSON otherwise. */
export function authErrorReply(path: string, error: ApiError, reply: FastifyReply): FastifyReply {
  for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
  const status = error.code === "rate_limited" ? 429 : error.code === "service_unavailable" ? 503 : error.code === "validation_failed" ? 400 : 500;
  if (isAuthCorsPath(path)) {
    if (status === 400) return oauthError(reply, 400, "invalid_request", "the request body is malformed");
    return oauthError(reply, status, status === 500 ? "server_error" : "temporarily_unavailable", status === 429 ? "too many requests; retry after the time in the Retry-After header" : "the server is temporarily unable to handle the request");
  }
  const [title, text] =
    status === 429 ? ["Too many requests", "Too many requests came from your network. Wait a minute and try again."]
    : status === 400 ? ["Invalid sign-in request", "The sign-in request is malformed."]
    : ["Sign-in is unavailable", "The server could not complete the sign-in right now."];
  return sendHtml(reply, status, errorPage(title, text));
}

class SignUpRefused extends Error {}

/**
 * The broker (docs/protocol/sign-in.md). Registered only when a provider is configured; otherwise `/auth/*` is 404
 * like any unknown route. Provider secrets and tokens, our codes, tokens, states, verifiers and nonces are never
 * logged: log lines carry the provider, the client and a fixed reason.
 */
export function registerSignInRoutes(app: FastifyInstance, deps: Deps): void {
  const config = deps.config.signIn;
  if (config === undefined) return;
  const { db } = deps;
  const providers = new Map<string, UpstreamProvider>(config.providers.map((p) => [p.id, createProvider(p)]));
  const corsOrigins = deps.config.corsOrigins;

  // ---- GET /auth/authorize -------------------------------------------------------------------------------------
  app.get(AUTH_PATHS.authorize, async (request, reply) => {
    const params = singleParams(new URL(request.url, "http://x").searchParams);
    if (params === null) return sendHtml(reply, 400, errorPage("Invalid sign-in request", "The sign-in request repeats a parameter."));
    const client = knownClient(config, params.get("client_id"));
    if (client === null) return sendHtml(reply, 400, errorPage("Invalid sign-in request", "The sign-in request names an unknown application."));
    const redirectUri = params.get("redirect_uri");
    if (!redirectAllowed(config, client, redirectUri)) return sendHtml(reply, 400, errorPage("Invalid sign-in request", "The sign-in request names a return address this server does not accept."));

    // From here the redirect URI is trusted: errors go back to the client.
    const rawState = params.get("state");
    const state = rawState !== undefined && STATE_SHAPE.test(rawState) ? rawState : undefined;
    const fail = (error: string, description: string) => redirect(reply, clientRedirect(redirectUri, { error, error_description: description, state, iss: config.publicUrl }));
    if (params.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
    if (state === undefined) return fail("invalid_request", "state is required: 1 to 512 printable ASCII characters");
    const challenge = params.get("code_challenge");
    if (params.get("code_challenge_method") !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
    if (challenge === undefined || !PKCE_SHAPE.test(challenge)) return fail("invalid_request", "code_challenge must be 43 to 128 unreserved characters");
    const providerId = params.get("provider");
    if (providerId !== undefined && !providers.has(providerId)) return fail("invalid_request", "unknown provider");

    if (providerId === undefined && providers.size > 1) {
      const base = { response_type: "code", client_id: client, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state };
      const links = [...providers.values()].map((p) => ({ name: p.name, href: `${AUTH_PATHS.authorize}?${new URLSearchParams({ ...base, provider: p.id }).toString()}` }));
      return sendHtml(reply, 200, chooserPage(links));
    }
    const provider = providerId === undefined ? [...providers.values()][0]! : providers.get(providerId)!;

    const upstreamState = randomSecret();
    const binding = randomSecret();
    const verifier = randomSecret();
    const nonce = provider.usesNonce ? randomSecret() : null;
    let location: string;
    try {
      location = await provider.authorizationUrl({ state: upstreamState, codeChallenge: s256(verifier), nonce, redirectUri: `${config.publicUrl}${AUTH_PATHS.callback}/${provider.id}` });
    } catch (error) {
      request.log.warn({ provider: provider.id, reason: error instanceof ProviderError ? error.message : "unexpected" }, "sign-in: provider unavailable");
      return fail("server_error", "the sign-in provider could not be reached");
    }
    await db.query(
      `INSERT INTO auth_requests (state_hash, binding_hash, provider, client_id, redirect_uri, code_challenge, client_state, pkce_verifier, nonce, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10))`,
      [sha256Hex(upstreamState), sha256Hex(binding), provider.id, client, redirectUri, challenge, state, verifier, nonce, AUTH_REQUEST_TTL_SECONDS],
    );
    reply.header("set-cookie", bindingCookie(config, binding, AUTH_REQUEST_TTL_SECONDS));
    return redirect(reply, location);
  });

  // ---- GET /auth/callback/:provider ------------------------------------------------------------------------------
  app.get<{ Params: { provider: string } }>(`${AUTH_PATHS.callback}/:provider`, async (request, reply) => {
    const providerId = request.params.provider;
    const provider = providers.get(providerId);
    reply.header("set-cookie", bindingCookie(config, "", 0));
    const expired = () => sendHtml(reply, 400, errorPage(EXPIRED_TITLE, EXPIRED_TEXT));
    const params = singleParams(new URL(request.url, "http://x").searchParams);
    const upstreamState = params?.get("state");
    if (provider === undefined || params === null || upstreamState === undefined || upstreamState.length > 512) return expired();

    // Consumed atomically whatever happens next: one auth request completes at most once. The verifier and nonce are nulled.
    const { rows } = await db.query<{ binding_hash: string; provider: string; client_id: string; redirect_uri: string; code_challenge: string; client_state: string; pkce_verifier: string | null; nonce: string | null; live: boolean }>(
      `WITH prev AS (SELECT * FROM auth_requests WHERE state_hash = $1 AND consumed_at IS NULL FOR UPDATE)
       UPDATE auth_requests a SET consumed_at = now(), pkce_verifier = NULL, nonce = NULL FROM prev WHERE a.state_hash = prev.state_hash
       RETURNING prev.binding_hash, prev.provider, prev.client_id, prev.redirect_uri, prev.code_challenge, prev.client_state, prev.pkce_verifier, prev.nonce, prev.expires_at > now() AS live`,
      [sha256Hex(upstreamState)],
    );
    const pending = rows[0];
    const binding = cookieValue(headerOf(request, "cookie"), bindingCookieName(config));
    if (!pending || !pending.live || pending.provider !== providerId || binding === undefined || !safeEqual(sha256Hex(binding), pending.binding_hash) || pending.pkce_verifier === null) {
      request.log.info({ provider: providerId, reason: !pending ? "unknown or used state" : !pending.live ? "expired" : pending.provider !== providerId ? "provider mismatch" : "binding mismatch" }, "sign-in: callback refused");
      return expired();
    }
    const client = knownClient(config, pending.client_id);
    if (client === null || !redirectAllowed(config, client, pending.redirect_uri)) return expired();
    const back = (params: Record<string, string>) => redirect(reply, clientRedirect(pending.redirect_uri, { ...params, state: pending.client_state, iss: config.publicUrl }));

    if (params.has("error")) {
      request.log.info({ provider: providerId, clientId: client, reason: "provider returned an error" }, "sign-in: refused upstream");
      return back({ error: "access_denied", error_description: "sign-in was cancelled or refused at the provider" });
    }
    const upstreamCode = params.get("code");
    if (upstreamCode === undefined || upstreamCode.length === 0 || upstreamCode.length > 2048) return back({ error: "server_error", error_description: "the provider returned no authorization code" });

    let identity: UpstreamIdentity;
    try {
      identity = await provider.exchange({ code: upstreamCode, verifier: pending.pkce_verifier, nonce: pending.nonce, redirectUri: `${config.publicUrl}${AUTH_PATHS.callback}/${providerId}` });
    } catch (error) {
      if (error instanceof TokenRejected) {
        request.log.warn({ provider: providerId, clientId: client, reason: error.reason }, "sign-in: identity rejected");
        return back({ error: "access_denied", error_description: "the provider's answer could not be verified" });
      }
      request.log.warn({ provider: providerId, clientId: client, reason: error instanceof ProviderError ? error.message : "unexpected" }, "sign-in: provider failed");
      return back({ error: "server_error", error_description: "the sign-in provider could not be reached" });
    }

    let userId: string;
    try {
      userId = await findOrCreateAccount(deps, providerId, identity, clientIp(request.headers, request.socket.remoteAddress, deps.config.trustProxy));
    } catch (error) {
      if (!(error instanceof SignUpRefused)) throw error;
      request.log.info({ provider: providerId, clientId: client, reason: error.message }, "sign-in: sign-up refused");
      return back({ error: "access_denied", error_description: "this server is not accepting new accounts right now" });
    }

    const code = randomSecret();
    await db.query("INSERT INTO auth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, provider, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))", [sha256Hex(code), userId, client, pending.redirect_uri, pending.code_challenge, providerId, CODE_TTL_SECONDS]);
    return back({ code });
  });

  /** Account by (provider, subject), never by email. A new one passes the per-IP sign-up limit and the account cap first, and gets its first workspace in the same transaction. */
  async function findOrCreateAccount(d: Deps, providerId: string, identity: UpstreamIdentity, ip: string): Promise<string> {
    return d.db.tx(async (tx) => {
      // Serializes two first sign-ins of the same person, so they cannot create two accounts.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [`identity:${providerId}:${identity.subject}`]);
      const existing = (await tx.query<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = $1 AND subject = $2", [providerId, identity.subject])).rows[0];
      if (existing) {
        await touchUser(tx, existing.user_id);
        return existing.user_id;
      }
      const ipHash = sha256Hex(`ip:${ip}`);
      const limit = config!.signupLimitPerIp;
      if (limit !== undefined) {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [`signup:${ipHash}`]);
        const recent = Number((await tx.query<{ n: number }>("SELECT count(*) AS n FROM sign_ups WHERE ip_hash = $1 AND created_at > now() - make_interval(hours => $2)", [ipHash, SIGNUP_WINDOW_HOURS])).rows[0]!.n);
        if (recent >= limit) throw new SignUpRefused("per-IP sign-up limit reached");
      }
      try {
        await assertCanCreateAccount(tx, d.config);
      } catch (error) {
        if (error instanceof ApiError && error.code === "quota_exceeded") throw new SignUpRefused("account cap reached");
        throw error;
      }
      const userId = opaqueId("usr");
      const name = identity.name ?? `${providers.get(providerId)?.name ?? "Thoth"} user`;
      await tx.query("INSERT INTO users (id, display_name, email, last_seen_at) VALUES ($1, $2, $3, now())", [userId, name, identity.email ?? null]);
      await tx.query("INSERT INTO identities (provider, subject, user_id) VALUES ($1, $2, $3)", [providerId, identity.subject, userId]);
      await tx.query("INSERT INTO sign_ups (ip_hash) VALUES ($1)", [ipHash]);
      await audit(tx, { actorId: null, action: "user.created", detail: { userId, provider: providerId } });
      // A new account gets one workspace of its own, so its first sign-in does not land in an empty app (the
      // protocol cannot create one). It counts toward the per-account workspace quota like any other.
      try {
        await createWorkspaceIn(tx, { name: firstWorkspaceName(identity.name), exportRestricted: false, ownerId: userId }, d.config);
      } catch (error) {
        // Rolls the whole sign-up back: an account is never created without its workspace.
        if (error instanceof ApiError && error.code === "quota_exceeded") throw new SignUpRefused("workspace quota reached");
        throw error;
      }
      return userId;
    });
  }

  /** The form body of /auth/token and /auth/revoke, or a reason it is unusable. */
  function formOf(request: FastifyRequest): Map<string, string> | string {
    const type = (headerOf(request, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/x-www-form-urlencoded") return "Content-Type must be application/x-www-form-urlencoded";
    const body = bodyOf(request);
    if (body.length > FORM_BODY_LIMIT) return "request body too large";
    return singleParams(new URLSearchParams(body.toString("utf8"))) ?? "a parameter is repeated";
  }

  /** `thoth-web` uses its cookie only from an allowed Origin (CSRF protection on top of SameSite). */
  const originAllowed = (request: FastifyRequest) => {
    const origin = headerOf(request, "origin");
    return origin !== undefined && corsOrigins.includes(origin);
  };

  function grantReply(reply: FastifyReply, client: ClientId, tokens: IssuedTokens): FastifyReply {
    const body: Record<string, unknown> = { access_token: tokens.accessToken, token_type: "Bearer", expires_in: tokens.expiresIn };
    if (client === WEB) reply.header("set-cookie", refreshCookie(config!, tokens.refreshToken, tokens.refreshExpiresIn));
    else body.refresh_token = tokens.refreshToken;
    return oauthJson(reply, 200, body);
  }

  function grantFailed(request: FastifyRequest, reply: FastifyReply, client: ClientId, grant: string, result: Extract<GrantResult, { ok: false }>): FastifyReply {
    request.log.info({ clientId: client, grant, reason: result.reason }, "sign-in: grant refused");
    if (client === WEB && grant === "refresh_token") reply.header("set-cookie", refreshCookie(config!, "", 0));
    return oauthError(reply, 400, "invalid_grant", "the grant is invalid, expired, revoked or was already used");
  }

  // ---- POST /auth/token ------------------------------------------------------------------------------------------
  app.post(AUTH_PATHS.token, async (request, reply) => {
    const form = formOf(request);
    if (typeof form === "string") return oauthError(reply, 400, "invalid_request", form);
    const client = knownClient(config, form.get("client_id"));
    if (client === null) return oauthError(reply, 400, "invalid_client", "unknown client_id");
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const code = form.get("code");
      const redirectUri = form.get("redirect_uri");
      if (code === undefined || redirectUri === undefined) return oauthError(reply, 400, "invalid_request", "code and redirect_uri are required");
      if (code.length > 512) return grantFailed(request, reply, client, grant, { ok: false, reason: "malformed code" });
      const result = await redeemCode(db, config, { code, clientId: client, redirectUri, verifier: form.get("code_verifier") });
      return result.ok ? grantReply(reply, client, result.tokens) : grantFailed(request, reply, client, grant, result);
    }
    if (grant === "refresh_token") {
      let refreshToken: string | undefined;
      if (client === WEB) {
        if (form.has("refresh_token")) return oauthError(reply, 400, "invalid_request", "thoth-web sends no refresh_token; the cookie is used");
        if (!originAllowed(request)) return oauthError(reply, 400, "invalid_request", "an allowed Origin is required");
        refreshToken = cookieValue(headerOf(request, "cookie"), refreshCookieName(config));
      } else refreshToken = form.get("refresh_token");
      if (refreshToken === undefined || refreshToken.length === 0) return oauthError(reply, 400, "invalid_request", "refresh_token is required");
      if (refreshToken.length > 512) return grantFailed(request, reply, client, grant, { ok: false, reason: "malformed refresh token" });
      const result = await refreshSession(db, config, { refreshToken, clientId: client });
      return result.ok ? grantReply(reply, client, result.tokens) : grantFailed(request, reply, client, grant, result);
    }
    return oauthError(reply, 400, grant === undefined ? "invalid_request" : "unsupported_grant_type", grant === undefined ? "grant_type is required" : "grant_type must be authorization_code or refresh_token");
  });

  // ---- POST /auth/revoke -----------------------------------------------------------------------------------------
  app.post(AUTH_PATHS.revoke, async (request, reply) => {
    const form = formOf(request);
    if (typeof form === "string") return oauthError(reply, 400, "invalid_request", form);
    const client = knownClient(config, form.get("client_id"));
    if (client === null) return oauthError(reply, 400, "invalid_client", "unknown client_id");
    let token = form.get("token");
    if (client === WEB && token === undefined) {
      if (!originAllowed(request)) return oauthError(reply, 400, "invalid_request", "an allowed Origin is required");
      token = cookieValue(headerOf(request, "cookie"), refreshCookieName(config));
    } else if (client === DESKTOP && token === undefined) return oauthError(reply, 400, "invalid_request", "token is required");
    if (token !== undefined && token.length > 0 && token.length <= 512) await revokeByToken(db, { token, clientId: client });
    if (client === WEB) reply.header("set-cookie", refreshCookie(config, "", 0));
    reply.header("cache-control", "no-store");
    return reply.code(200).send();
  });
}
