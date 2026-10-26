import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMaintenance } from "../src/maintenance.ts";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { startFakeGithub, startFakeIssuer, type FakeGithub, type FakeIssuer } from "./fakes.ts";

/**
 * The sign-in broker end to end (docs/protocol/sign-in.md). The test is the browser and the client: it follows
 * every redirect by hand (`redirect: "manual"`), carries cookies itself, and plays the provider through in-process
 * fakes. PUBLIC_URL is an https origin the test maps onto the server's real http address.
 */

const PUBLIC_URL = "https://api.thoth.test";
const WEB_ORIGIN = "https://app.thoth.test";
const WEB_REDIRECT = `${WEB_ORIGIN}/app/callback`;
const DESKTOP_REDIRECT = "http://127.0.0.1:53682/callback";

const random = (n = 32) => randomBytes(n).toString("base64url");
const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
const s256 = (v: string) => createHash("sha256").update(v, "ascii").digest("base64url");

let env: TestEnv;
let issuer: FakeIssuer;
let gh: FakeGithub;
const logLines: string[] = [];
/** Every response body, header set and location the server produced, for the leak test. */
const responses: string[] = [];
/** Every secret the server issued to the test (our codes and tokens) or the test sent (verifiers). */
const issued: string[] = [];

interface Res {
  status: number;
  headers: Headers;
  text: string;
  json: any;
  location: string | undefined;
  setCookies: string[];
}

/** Client states, which the server must echo to the client but never log. */
const clientStates: string[] = [];

/**
 * Records a response of OUR server. Redirects to a provider carry our upstream state, challenge and nonce by design,
 * and the binding cookie is a cookie, so `location` is kept only for redirects back to the client and `set-cookie` never.
 */
async function record(res: Response, fromServer = true): Promise<Res> {
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  const setCookies = res.headers.getSetCookie();
  if (fromServer) {
    const location = res.headers.get("location") ?? "";
    const toProvider = location.startsWith(issuer.url) || location.startsWith(gh.url);
    responses.push(text, JSON.stringify([...res.headers.entries()].filter(([k]) => k !== "set-cookie" && k !== "location")), toProvider ? "" : location);
  }
  return { status: res.status, headers: res.headers, text, json, location: res.headers.get("location") ?? undefined, setCookies };
}

/** A cookie jar and a navigator that maps PUBLIC_URL onto the real server. Attributes are checked by tests, not enforced. */
class Browser {
  readonly cookies = new Map<string, string>();
  async get(url: string, headers: Record<string, string> = {}): Promise<Res> {
    const target = url.startsWith(PUBLIC_URL) ? env.url + url.slice(PUBLIC_URL.length) : url.startsWith("/") ? env.url + url : url;
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await record(await fetch(target, { redirect: "manual", headers: { ...(cookie && target.startsWith(env.url) ? { cookie } : {}), ...headers } }), target.startsWith(env.url));
    if (target.startsWith(env.url)) this.take(res.setCookies);
    return res;
  }
  take(setCookies: string[]): void {
    for (const line of setCookies) {
      const [pair] = line.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at);
      const value = pair!.slice(at + 1);
      if (/Max-Age=0/i.test(line) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

interface Flow {
  browser: Browser;
  clientId: string;
  redirectUri: string;
  verifier: string;
  state: string;
}

function newFlow(opts: { clientId?: string; redirectUri?: string } = {}): Flow {
  const clientId = opts.clientId ?? "thoth-desktop";
  const flow = { browser: new Browser(), clientId, redirectUri: opts.redirectUri ?? (clientId === "thoth-web" ? WEB_REDIRECT : DESKTOP_REDIRECT), verifier: random(48), state: `st-${random(12)}` };
  issued.push(flow.verifier);
  clientStates.push(flow.state);
  return flow;
}

function authorizeUrl(flow: Flow, params: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams();
  const all: Record<string, string | undefined> = { response_type: "code", client_id: flow.clientId, redirect_uri: flow.redirectUri, code_challenge: s256(flow.verifier), code_challenge_method: "S256", state: flow.state, ...params };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) q.set(k, v);
  return `/auth/authorize?${q.toString()}`;
}

interface SignInResult {
  flow: Flow;
  /** The final answer of the callback. */
  res: Res;
  /** Query of the redirect back to the client, when there was one. */
  back?: URLSearchParams;
  code?: string;
}

/** authorize -> provider -> callback. Stops at the redirect back to the client (or the callback's error page). */
async function signIn(opts: { provider?: string; clientId?: string; redirectUri?: string; beforeCallback?: (flow: Flow, url: string) => Promise<string | void> | string | void } = {}): Promise<SignInResult> {
  const flow = newFlow(opts);
  const start = await flow.browser.get(authorizeUrl(flow, { provider: opts.provider ?? "google" }));
  expect(start.status, start.text).toBe(302);
  const atProvider = await flow.browser.get(start.location!);
  expect(atProvider.status).toBe(302);
  let callbackUrl = atProvider.location!;
  expect(callbackUrl.startsWith(`${PUBLIC_URL}/auth/callback/`)).toBe(true);
  callbackUrl = (await opts.beforeCallback?.(flow, callbackUrl)) ?? callbackUrl;
  const res = await flow.browser.get(callbackUrl);
  if (res.status !== 302) return { flow, res };
  const url = new URL(res.location!);
  expect(`${url.origin}${url.pathname}`).toBe(flow.redirectUri);
  const back = url.searchParams;
  const code = back.get("code") ?? undefined;
  if (code) issued.push(code);
  return { flow, res, back, ...(code ? { code } : {}) };
}

async function post(path: string, form: Record<string, string | undefined>, headers: Record<string, string> = {}): Promise<Res> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v !== undefined) body.set(k, v);
  const res = await record(await fetch(`${env.url}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: body.toString() }));
  if (res.json?.access_token) issued.push(res.json.access_token);
  if (res.json?.refresh_token) issued.push(res.json.refresh_token);
  for (const c of res.setCookies) {
    const value = /^[^=]+=([^;]*)/.exec(c)?.[1];
    if (value) issued.push(value);
  }
  return res;
}

const exchange = (r: { flow: Flow; code?: string }, overrides: Record<string, string | undefined> = {}, headers: Record<string, string> = {}) =>
  post("/auth/token", { grant_type: "authorization_code", code: r.code, redirect_uri: r.flow.redirectUri, client_id: r.flow.clientId, code_verifier: r.flow.verifier, ...overrides }, headers);

const refresh = (refreshToken: string, clientId = "thoth-desktop") => post("/auth/token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as TestPrincipal;
const meStatus = async (token: string) => (await env.api(bearer(token), "GET", "/me")).status;
const count = async (sql: string, values: unknown[] = []) => Number((await env.db.query<{ n: string }>(sql, values)).rows[0]!.n);
const usersWithSubject = (provider: string, sub: string) => count("SELECT count(*) AS n FROM identities WHERE provider = $1 AND subject = $2", [provider, sub]);

/** A full desktop sign-in with the issuer's current profile; returns the token response. */
async function desktopTokens(provider = "google"): Promise<{ access: string; refresh: string; userId: string }> {
  const r = await signIn({ provider });
  expect(r.code, r.res.location).toBeTruthy();
  const t = await exchange(r);
  expect(t.status, t.text).toBe(200);
  const me = await env.api(bearer(t.json.access_token), "GET", "/me");
  return { access: t.json.access_token, refresh: t.json.refresh_token, userId: me.json.id };
}

beforeAll(async () => {
  issuer = await startFakeIssuer();
  gh = await startFakeGithub();
  env = await startTestEnv({
    startOptions: { logStream: { write: (line: string) => void logLines.push(line) } },
    env: {
      PUBLIC_URL,
      OIDC_GOOGLE_CLIENT_ID: issuer.clientId,
      OIDC_GOOGLE_CLIENT_SECRET: issuer.clientSecret,
      GITHUB_CLIENT_ID: gh.clientId,
      GITHUB_CLIENT_SECRET: gh.clientSecret,
      GITHUB_URL: gh.url,
      GITHUB_API_URL: gh.apiUrl,
      WEB_REDIRECT_URIS: WEB_REDIRECT,
      CORS_ORIGINS: WEB_ORIGIN,
    },
    // Google's issuer is fixed in configuration; the test points it at the local issuer.
    configure: (c) => {
      c.logLevel = "trace";
      for (const p of c.signIn!.providers) if (p.kind === "oidc") p.issuer = issuer.url;
    },
  });
});

afterAll(async () => {
  await env?.close();
  await issuer?.close();
  await gh?.close();
});

beforeEach(() => {
  issuer.reset();
  gh.reset();
});

describe("happy path", () => {
  it("OIDC (Google-style): authorize -> provider -> callback -> code -> token; the access token works; refresh rotates; revoke kills both", async () => {
    const r = await signIn({ provider: "google" });
    expect(r.back!.get("state")).toBe(r.flow.state);
    expect(r.back!.get("iss")).toBe(PUBLIC_URL);
    expect(r.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.res.headers.get("referrer-policy")).toBe("no-referrer");

    const t = await exchange(r);
    expect(t.status, t.text).toBe(200);
    expect(t.headers.get("cache-control")).toBe("no-store");
    expect(t.json).toMatchObject({ token_type: "Bearer", expires_in: 900 });
    expect(t.json.access_token).toMatch(/^thoth_at_[A-Za-z0-9_-]{43}$/);
    expect(t.json.refresh_token).toMatch(/^thoth_rt_[A-Za-z0-9_-]{43}$/);

    const me = await env.api(bearer(t.json.access_token), "GET", "/me");
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ displayName: "Ada Lovelace", email: "ada@example.org" });
    const workspaces = await env.api(bearer(t.json.access_token), "GET", "/workspaces");
    expect(workspaces.status).toBe(200);
    // First sign-in: the new account owns one workspace, named after it.
    expect(workspaces.json.items).toMatchObject([{ name: "Ada Lovelace's workspace", role: "owner" }]);
    expect(await usersWithSubject("google", issuer.profile.sub)).toBe(1);

    const r2 = await refresh(t.json.refresh_token);
    expect(r2.status, r2.text).toBe(200);
    expect(r2.json.refresh_token).not.toBe(t.json.refresh_token);
    expect(r2.json.access_token).not.toBe(t.json.access_token);
    expect(await meStatus(r2.json.access_token)).toBe(200);

    const revoked = await post("/auth/revoke", { token: r2.json.refresh_token, client_id: "thoth-desktop" });
    expect(revoked.status).toBe(200);
    expect(await meStatus(r2.json.access_token)).toBe(401);
    expect(await meStatus(t.json.access_token)).toBe(401);
    expect((await refresh(r2.json.refresh_token)).json.error).toBe("invalid_grant");
    // The auth request kept its short-lived secrets only until it was consumed.
    expect(await count("SELECT count(*) AS n FROM auth_requests WHERE consumed_at IS NOT NULL AND (pkce_verifier IS NOT NULL OR nonce IS NOT NULL)")).toBe(0);
  });

  it("GitHub: the same flow, identity from GET /user and the verified primary email", async () => {
    gh.reset({ name: null, login: "octo-dev" });
    const r = await signIn({ provider: "github" });
    expect(r.code).toBeTruthy();
    const t = await exchange(r);
    expect(t.status, t.text).toBe(200);
    const me = await env.api(bearer(t.json.access_token), "GET", "/me");
    expect(me.json).toMatchObject({ displayName: "octo-dev", email: "ada@example.org" });
    expect((await env.api(bearer(t.json.access_token), "GET", "/workspaces")).status).toBe(200);
    expect(await usersWithSubject("github", String(gh.profile.id))).toBe(1);

    const r2 = await refresh(t.json.refresh_token);
    expect(r2.status).toBe(200);
    expect((await post("/auth/revoke", { token: r2.json.access_token, client_id: "thoth-desktop" })).status).toBe(200);
    expect(await meStatus(r2.json.access_token)).toBe(401);
    expect((await refresh(r2.json.refresh_token)).json.error).toBe("invalid_grant");
    expect(gh.rejectedTokenRequests).toEqual([]);
  });

  it("without a provider and with two configured, authorize answers an escaped chooser page", async () => {
    const flow = newFlow();
    const res = await flow.browser.get(authorizeUrl(flow, { state: `<b>"x"&'y'</b>` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.text).toContain("Continue with Google");
    expect(res.text).toContain("Continue with GitHub");
    expect(res.text).not.toContain("<b>");
    expect(res.text).toContain("provider=github");
  });
});

describe("ID token verification", () => {
  const rejected = async (fault: Parameters<FakeIssuer["reset"]>[0]) => {
    issuer.reset(fault);
    const users = await count("SELECT count(*) AS n FROM users");
    const r = await signIn({ provider: "google" });
    expect(r.back?.get("error"), r.res.text).toBe("access_denied");
    expect(r.back?.get("state")).toBe(r.flow.state);
    expect(r.code).toBeUndefined();
    expect(await usersWithSubject("google", issuer.profile.sub)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM users")).toBe(users);
  };
  it("rejects an expired ID token and creates no account", () => rejected({ expiresIn: -120 }));
  it("rejects an ID token for the wrong audience", () => rejected({ audience: "someone-else" }));
  it("rejects an ID token with the client among several audiences but no azp", () => rejected({ audience: ["someone-else", issuer.clientId] }));
  it("rejects an ID token from the wrong issuer", () => rejected({ issuer: "https://evil.example" }));
  it("rejects an ID token carrying the wrong nonce", () => rejected({ nonce: "not-the-nonce" }));
  it("rejects an unsigned ID token (alg none)", () => rejected({ alg: "none" }));
  it("rejects an HS256 ID token signed with the client secret", () => rejected({ alg: "HS256" }));
  it("rejects an ID token signed by an unknown key (after one JWKS refetch)", async () => {
    const before = issuer.jwksFetches;
    await rejected({ unknownKey: true });
    expect(issuer.jwksFetches - before).toBeLessThanOrEqual(1);
  });

  it("key rotation: a token signed with a new kid succeeds through a JWKS refetch", async () => {
    await desktopTokens(); // JWKS cached
    const before = issuer.jwksFetches;
    issuer.rotateKey();
    issuer.reset();
    const t = await desktopTokens();
    expect(await meStatus(t.access)).toBe(200);
    expect(issuer.jwksFetches).toBe(before + 1);
    // And it is cached again afterwards.
    issuer.reset();
    await desktopTokens();
    expect(issuer.jwksFetches).toBe(before + 1);
  });
});

describe("email and identity", () => {
  it("email_verified:false: the email is not stored", async () => {
    issuer.reset({ emailVerified: false, email: "unverified@example.org" });
    const t = await desktopTokens();
    expect((await env.api(bearer(t.access), "GET", "/me")).json.email).toBeUndefined();
    expect(await count("SELECT count(*) AS n FROM users WHERE email = 'unverified@example.org'")).toBe(0);
  });

  it("GitHub with an unverified primary email: no email (not even a verified secondary)", async () => {
    gh.reset({ emails: [{ email: "primary@example.org", primary: true, verified: false }, { email: "second@example.org", primary: false, verified: true }] });
    const t = await desktopTokens("github");
    expect((await env.api(bearer(t.access), "GET", "/me")).json.email).toBeUndefined();
    expect(await count("SELECT count(*) AS n FROM users WHERE email IN ('primary@example.org', 'second@example.org')")).toBe(0);
  });

  it("the same email at OIDC and GitHub gives two accounts", async () => {
    issuer.reset({ email: "same@example.org" });
    gh.reset({ emails: [{ email: "same@example.org", primary: true, verified: true }] });
    const a = await desktopTokens("google");
    const b = await desktopTokens("github");
    expect(a.userId).not.toBe(b.userId);
    expect(await count("SELECT count(*) AS n FROM users WHERE email = 'same@example.org'")).toBe(2);
  });

  it("the same subject signing in twice gives one account", async () => {
    const sub = `sub-${random(6)}`;
    issuer.reset({ sub });
    const a = await desktopTokens();
    issuer.reset({ sub, email: "changed@example.org" });
    const b = await desktopTokens();
    expect(b.userId).toBe(a.userId);
    expect(await usersWithSubject("google", sub)).toBe(1);
  });
});

describe("first run: a new account's own workspace", () => {
  const ownedBy = (userId: string) => env.db.query<{ id: string; name: string }>("SELECT w.id, w.name FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = $1 AND m.role = 'owner' ORDER BY w.name", [userId]);

  it("signs in, finds its own workspace, then creates, edits and reopens a page in it", async () => {
    issuer.reset({ sub: `sub-${random(6)}`, name: "Grace Hopper" });
    const t = await desktopTokens();
    const me = bearer(t.access);
    const list = await env.api(me, "GET", "/workspaces");
    expect(list.json.items).toHaveLength(1);
    expect(list.json.items[0]).toMatchObject({ name: "Grace Hopper's workspace", role: "owner", memberCount: 1 });
    const ws = list.json.items[0].id as string;
    expect((await env.db.query("SELECT 1 FROM audit_events WHERE workspace_id = $1 AND action = 'workspace.created'", [ws])).rowCount).toBe(1);

    const pageId = "01930000-0000-7000-8000-00000000f001";
    const created = await env.api(me, "PUT", `/workspaces/${ws}/pages/${pageId}`, { headers: { "if-none-match": "*" }, json: { title: "Untitled", markdown: "" } });
    expect(created.status, created.text).toBe(201);
    const edited = await env.api(me, "PUT", `/workspaces/${ws}/pages/${pageId}`, { headers: { "if-match": `"${created.json.revision.id}"` }, json: { title: "Notes", markdown: "# Notes\n\nHello.\n" } });
    expect(edited.status, edited.text).toBe(200);
    const reopened = await env.api(me, "GET", `/workspaces/${ws}/pages/${pageId}`);
    expect(reopened.json).toMatchObject({ markdown: "# Notes\n\nHello.\n", metadata: { title: "Notes" } });
  });

  it("an existing account signing in again gets no second workspace", async () => {
    const sub = `sub-${random(6)}`;
    issuer.reset({ sub });
    const a = await desktopTokens();
    issuer.reset({ sub });
    const b = await desktopTokens();
    expect(b.userId).toBe(a.userId);
    expect((await ownedBy(a.userId)).rows).toHaveLength(1);
  });

  it("an account that existed before (created by an operator) is left as it is", async () => {
    const before = await env.user("Operator-made");
    const sub = `sub-${random(6)}`;
    await env.db.query("INSERT INTO identities (provider, subject, user_id) VALUES ('google', $1, $2)", [sub, before.userId]);
    issuer.reset({ sub });
    expect((await desktopTokens()).userId).toBe(before.userId);
    expect((await ownedBy(before.userId)).rows).toHaveLength(0);
  });

  it("falls back to \"My workspace\" when the provider gives no name, or only an email address", async () => {
    gh.reset({ name: null, login: "" });
    const a = await desktopTokens("github");
    expect((await ownedBy(a.userId)).rows.map((r) => r.name)).toEqual(["My workspace"]);
    gh.reset({ name: "octo@example.org" });
    const b = await desktopTokens("github");
    expect((await ownedBy(b.userId)).rows.map((r) => r.name)).toEqual(["My workspace"]);
  });

  it("a long name is cut to fit the 200-character limit", async () => {
    issuer.reset({ sub: `sub-${random(6)}`, name: "ก".repeat(200) });
    const t = await desktopTokens();
    const [row] = (await ownedBy(t.userId)).rows;
    expect([...row!.name]).toHaveLength(200);
    expect(row!.name.endsWith("'s workspace")).toBe(true);
  });

  it("counts toward the per-account workspace limit (trial: 1): the account owns 1 of 1", async () => {
    env.config.maxWorkspacesPerAccount = 1;
    try {
      issuer.reset({ sub: `sub-${random(6)}` });
      const t = await desktopTokens();
      expect((await ownedBy(t.userId)).rows).toHaveLength(1);
      const { createWorkspace } = await import("../src/admin.ts");
      await expect(createWorkspace(env.db, { name: "Second", exportRestricted: false, ownerId: t.userId }, env.config)).rejects.toMatchObject({ code: "quota_exceeded" });
    } finally {
      env.config.maxWorkspacesPerAccount = undefined;
    }
  });

  it("the workspace is created in the same transaction: a refused sign-up leaves no workspace behind", async () => {
    const workspaces = await count("SELECT count(*) AS n FROM workspaces");
    env.config.maxAccounts = await count("SELECT count(*) AS n FROM users");
    try {
      issuer.reset();
      expect((await signIn()).back!.get("error")).toBe("access_denied");
    } finally {
      env.config.maxAccounts = undefined;
    }
    expect(await count("SELECT count(*) AS n FROM workspaces")).toBe(workspaces);
  });
});

describe("client code", () => {
  it("a replayed code is invalid_grant and revokes the session its first use created", async () => {
    const r = await signIn();
    const first = await exchange(r);
    expect(first.status).toBe(200);
    expect(await meStatus(first.json.access_token)).toBe(200);
    const replay = await exchange(r);
    expect([replay.status, replay.json.error]).toEqual([400, "invalid_grant"]);
    expect(replay.headers.get("cache-control")).toBe("no-store");
    expect(await meStatus(first.json.access_token)).toBe(401);
    expect((await refresh(first.json.refresh_token)).json.error).toBe("invalid_grant");
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE action = 'auth.code_replay'")).toBeGreaterThanOrEqual(1);
  });

  it("a PKCE mismatch is invalid_grant and burns the code: the correct verifier fails afterwards", async () => {
    const r = await signIn();
    const wrong = await exchange(r, { code_verifier: random(48) });
    expect([wrong.status, wrong.json.error]).toEqual([400, "invalid_grant"]);
    const malformed = await signIn();
    expect((await exchange(malformed, { code_verifier: "short" })).json.error).toBe("invalid_grant");
    const missing = await signIn();
    expect((await exchange(missing, { code_verifier: undefined })).json.error).toBe("invalid_grant");
    const right = await exchange(r);
    expect([right.status, right.json.error]).toEqual([400, "invalid_grant"]);
    expect((await exchange(malformed)).json.error).toBe("invalid_grant");
  });

  it("a redirect_uri mismatch is invalid_grant (and burns the code)", async () => {
    const r = await signIn();
    const res = await exchange(r, { redirect_uri: "http://127.0.0.1:53683/callback" });
    expect([res.status, res.json.error]).toEqual([400, "invalid_grant"]);
    expect((await exchange(r)).json.error).toBe("invalid_grant");
  });

  it("a code from another client_id is invalid_grant", async () => {
    const r = await signIn({ clientId: "thoth-web" });
    const res = await exchange(r, { client_id: "thoth-desktop" });
    expect([res.status, res.json.error]).toEqual([400, "invalid_grant"]);
    expect((await exchange(r, {}, { origin: WEB_ORIGIN })).json.error).toBe("invalid_grant");
  });

  it("an expired code is invalid_grant", async () => {
    const r = await signIn();
    await env.db.query("UPDATE auth_codes SET expires_at = now() - interval '1 second' WHERE code_hash = $1", [sha256Hex(r.code!)]);
    const res = await exchange(r);
    expect([res.status, res.json.error]).toEqual([400, "invalid_grant"]);
  });

  it("an unknown code, an unknown client and a bad grant type are refused", async () => {
    const r = await signIn();
    expect((await exchange({ flow: r.flow, code: random() })).json.error).toBe("invalid_grant");
    expect((await exchange(r, { client_id: "thoth-cli" })).json.error).toBe("invalid_client");
    expect((await post("/auth/token", { grant_type: "password", client_id: "thoth-desktop" })).json.error).toBe("unsupported_grant_type");
    const json = await record(await fetch(`${env.url}/auth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect([json.status, json.json.error]).toEqual([400, "invalid_request"]);
    // An unknown client is refused before the code is looked up, so the code is still good.
    expect((await exchange(r)).status).toBe(200);
  });
});

describe("refresh tokens", () => {
  it("reuse is invalid_grant and revokes the whole family; earlier access tokens then answer 401", async () => {
    const t = await desktopTokens();
    const r1 = await refresh(t.refresh);
    expect(r1.status).toBe(200);
    const r2 = await refresh(r1.json.refresh_token);
    expect(r2.status).toBe(200);
    expect(await meStatus(r2.json.access_token)).toBe(200);

    const reuse = await refresh(t.refresh);
    expect([reuse.status, reuse.json.error]).toEqual([400, "invalid_grant"]);
    for (const token of [t.access, r1.json.access_token, r2.json.access_token]) expect(await meStatus(token)).toBe(401);
    expect((await refresh(r2.json.refresh_token)).json.error).toBe("invalid_grant");
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE action = 'auth.refresh_reuse'")).toBeGreaterThanOrEqual(1);
  });

  it("a refresh token of another client, an expired one, or one past the session's maximum age is invalid_grant", async () => {
    const web = await signIn({ clientId: "thoth-web" });
    const webToken = /^__Secure-thoth_refresh=([^;]+)/.exec((await exchange(web)).setCookies.join("\n"))![1]!;
    expect((await refresh(webToken, "thoth-desktop")).json.error).toBe("invalid_grant");
    const t2 = await desktopTokens();
    await env.db.query("UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [sha256Hex(t2.refresh)]);
    expect((await refresh(t2.refresh)).json.error).toBe("invalid_grant");
    const t3 = await desktopTokens();
    await env.db.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = (SELECT session_id FROM refresh_tokens WHERE token_hash = $1)", [sha256Hex(t3.refresh)]);
    expect((await refresh(t3.refresh)).json.error).toBe("invalid_grant");
    expect(await meStatus(t3.access)).toBe(401); // the access token dies with the session's maximum age too
  });
});

describe("authorization request", () => {
  const htmlRefusal = async (clientId: string, redirectUri: string | undefined) => {
    const flow = newFlow({ clientId, ...(redirectUri === undefined ? {} : { redirectUri }) });
    const res = await flow.browser.get(authorizeUrl(flow, { provider: "google", redirect_uri: redirectUri }));
    expect(res.status, `${clientId} ${redirectUri}`).toBe(400);
    expect(res.location).toBeUndefined();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(flow.browser.cookies.size).toBe(0);
  };

  it("a bad redirect_uri for either client is a 400 HTML page, never a redirect", async () => {
    for (const uri of ["http://localhost:53682/callback", "http://127.0.0.1:53682/other", "http://127.0.0.1:53682/callback/", "http://127.0.0.1:53682/callback?x=1", "http://127.0.0.1:53682/callback#f", "https://127.0.0.1:53682/callback", "https://[::1]:53682/callback", "http://127.0.0.2:53682/callback", "http://127.0.0.1/callback", "http://127.0.0.1:0/callback", WEB_REDIRECT])
      await htmlRefusal("thoth-desktop", uri);
    for (const uri of ["https://evil.example/app/callback", `${WEB_REDIRECT}/x`, `${WEB_REDIRECT}?x=1`, `${WEB_ORIGIN}/app/callbac`, "http://app.thoth.test/app/callback", DESKTOP_REDIRECT])
      await htmlRefusal("thoth-web", uri);
    await htmlRefusal("thoth-desktop", undefined);
    await htmlRefusal("thoth-unknown", DESKTOP_REDIRECT);
  });

  it("the IPv6 loopback redirect is accepted for desktop", async () => {
    const r = await signIn({ redirectUri: "http://[::1]:61000/callback" });
    expect(r.code).toBeTruthy();
  });

  it("code_challenge_method=plain is an error redirect with the state", async () => {
    const flow = newFlow();
    const res = await flow.browser.get(authorizeUrl(flow, { provider: "google", code_challenge_method: "plain", code_challenge: flow.verifier }));
    expect(res.status).toBe(302);
    const back = new URL(res.location!);
    expect(`${back.origin}${back.pathname}`).toBe(DESKTOP_REDIRECT);
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("state")).toBe(flow.state);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("a missing state is an error redirect (without a state)", async () => {
    const flow = newFlow();
    const res = await flow.browser.get(authorizeUrl(flow, { provider: "google", state: undefined }));
    expect(res.status).toBe(302);
    const back = new URL(res.location!).searchParams;
    expect(back.get("error")).toBe("invalid_request");
    expect(back.has("state")).toBe(false);
  });

  it("other invalid parameters with a trusted redirect_uri are error redirects", async () => {
    const cases: [Record<string, string | undefined>, string][] = [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ code_challenge: "too-short" }, "invalid_request"],
      [{ code_challenge: undefined }, "invalid_request"],
      [{ provider: "facebook" }, "invalid_request"],
      [{ state: "x".repeat(513) }, "invalid_request"],
    ];
    for (const [params, error] of cases) {
      const flow = newFlow();
      const res = await flow.browser.get(authorizeUrl(flow, { provider: "google", ...params }));
      expect(res.status, JSON.stringify(params)).toBe(302);
      expect(new URL(res.location!).searchParams.get("error"), JSON.stringify(params)).toBe(error);
    }
  });

  it("the provider redirect carries our own state, S256 challenge and nonce, and sets a binding cookie", async () => {
    const flow = newFlow();
    const res = await flow.browser.get(authorizeUrl(flow, { provider: "google" }));
    const to = new URL(res.location!);
    expect(to.origin).toBe(issuer.url);
    expect(to.searchParams.get("state")).not.toBe(flow.state);
    expect(to.searchParams.get("code_challenge")).not.toBe(s256(flow.verifier));
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(to.searchParams.get("redirect_uri")).toBe(`${PUBLIC_URL}/auth/callback/google`);
    expect(to.searchParams.get("scope")).toBe("openid email profile");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const cookie = res.setCookies.find((c) => c.startsWith("__Host-thoth_signin="))!;
    expect(cookie).toMatch(/; Path=\/;/);
    for (const attr of ["HttpOnly", "SameSite=Lax", "Secure", "Max-Age=600"]) expect(cookie).toContain(attr);
    const gres = await new Browser().get(authorizeUrl(newFlow(), { provider: "github" }));
    const gto = new URL(gres.location!);
    expect(gto.origin + gto.pathname).toBe(`${gh.url}/login/oauth/authorize`);
    expect(gto.searchParams.get("scope")).toBe("read:user user:email");
    expect(gto.searchParams.has("nonce")).toBe(false);
  });
});

describe("provider callback", () => {
  const refused = async (beforeCallback: (flow: Flow, url: string) => Promise<string | void> | string | void) => {
    const codes = await count("SELECT count(*) AS n FROM auth_codes");
    const r = await signIn({ beforeCallback });
    expect(r.res.status, r.res.location).toBe(400);
    expect(r.res.location).toBeUndefined();
    expect(r.res.headers.get("content-type")).toContain("text/html");
    expect(r.res.text).toContain("expired");
    expect(r.res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await count("SELECT count(*) AS n FROM auth_codes")).toBe(codes);
  };

  it("an unknown state is the HTML error page and issues no code", () =>
    refused((_f, url) => {
      const u = new URL(url);
      u.searchParams.set("state", random());
      return u.toString();
    }));

  it("an expired state is the HTML error page and issues no code", () =>
    refused(async (_f, url) => {
      const state = new URL(url).searchParams.get("state")!;
      await env.db.query("UPDATE auth_requests SET expires_at = now() - interval '1 second' WHERE state_hash = $1", [sha256Hex(state)]);
    }));

  it("a missing binding cookie is the HTML error page and issues no code", () => refused((flow) => void flow.browser.cookies.clear()));

  it("a mismatched binding cookie is the HTML error page and issues no code", () => refused((flow) => void flow.browser.cookies.set("__Host-thoth_signin", random())));

  it("a callback for another provider than the one that started is refused", () => refused((_f, url) => url.replace("/auth/callback/google", "/auth/callback/github")));

  it("a replayed state is the HTML error page and issues no second code", async () => {
    let callbackUrl = "";
    let browser!: Browser;
    const r = await signIn({
      beforeCallback: (flow, url) => {
        callbackUrl = url;
        browser = flow.browser;
        // Keep a copy of the binding cookie: the callback clears it.
        replayCookie = flow.browser.cookies.get("__Host-thoth_signin")!;
      },
    });
    expect(r.code).toBeTruthy();
    browser.cookies.set("__Host-thoth_signin", replayCookie);
    const codes = await count("SELECT count(*) AS n FROM auth_codes");
    const again = await browser.get(callbackUrl);
    expect(again.status).toBe(400);
    expect(again.text).toContain("expired");
    expect(await count("SELECT count(*) AS n FROM auth_codes")).toBe(codes);
  });

  it("a provider error=access_denied is passed through to the client with its state", async () => {
    issuer.reset({ authorizeError: "access_denied" });
    const r = await signIn();
    expect(r.back!.get("error")).toBe("access_denied");
    expect(r.back!.get("state")).toBe(r.flow.state);
    expect(r.code).toBeUndefined();
  });

  it("a provider that fails at the token endpoint is server_error", async () => {
    issuer.reset({ tokenStatus: 503 });
    const r = await signIn();
    expect(r.back!.get("error")).toBe("server_error");
    expect(r.back!.get("state")).toBe(r.flow.state);
  });
});
let replayCookie = "";

describe("web client", () => {
  const cookieOf = (res: Res) => res.setCookies.find((c) => c.startsWith("__Secure-thoth_refresh="));
  const webTokens = async () => {
    const r = await signIn({ clientId: "thoth-web" });
    const t = await exchange(r, {}, { origin: WEB_ORIGIN });
    expect(t.status, t.text).toBe(200);
    return { t, cookie: cookieOf(t)! };
  };
  /** `origin: null` sends no Origin header. */
  const webPost = (path: string, form: Record<string, string | undefined>, cookie: string | undefined, origin: string | null = WEB_ORIGIN) =>
    post(path, form, { ...(cookie ? { cookie: `__Secure-thoth_refresh=${/=([^;]*)/.exec(cookie)![1]}` } : {}), ...(origin ? { origin } : {}) });

  it("the refresh token is only in an HttpOnly; Secure; SameSite=Strict; Path=/auth cookie with the __Secure- prefix, never the body", async () => {
    const { t, cookie } = await webTokens();
    expect(t.json.refresh_token).toBeUndefined();
    expect(t.text).not.toContain("thoth_rt_");
    expect(cookie).toMatch(/^__Secure-thoth_refresh=thoth_rt_[A-Za-z0-9_-]{43};/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/auth", `Max-Age=${30 * 86_400}`]) expect(cookie).toContain(attr);
    expect(t.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
    expect(t.headers.get("access-control-allow-credentials")).toBe("true");
    expect(await meStatus(t.json.access_token)).toBe(200);
  });

  it("refresh works from the cookie only with an allowed Origin", async () => {
    const { cookie } = await webTokens();
    const noOrigin = await webPost("/auth/token", { grant_type: "refresh_token", client_id: "thoth-web" }, cookie, null);
    expect([noOrigin.status, noOrigin.json.error]).toEqual([400, "invalid_request"]);
    const evil = await webPost("/auth/token", { grant_type: "refresh_token", client_id: "thoth-web" }, cookie, "https://evil.example");
    expect([evil.status, evil.json.error]).toEqual([400, "invalid_request"]);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const inBody = await webPost("/auth/token", { grant_type: "refresh_token", client_id: "thoth-web", refresh_token: /=([^;]*)/.exec(cookie)![1] }, undefined);
    expect(inBody.json.error).toBe("invalid_request");
    const ok = await webPost("/auth/token", { grant_type: "refresh_token", client_id: "thoth-web" }, cookie);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.refresh_token).toBeUndefined();
    const next = cookieOf(ok)!;
    expect(next).not.toBe(cookie);
    expect(await meStatus(ok.json.access_token)).toBe(200);
  });

  it("the token and revoke endpoints answer a CORS preflight; authorize does not get CORS headers", async () => {
    for (const path of ["/auth/token", "/auth/revoke"]) {
      const pre = await record(await fetch(`${env.url}${path}`, { method: "OPTIONS", headers: { origin: WEB_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } }));
      expect(pre.status, path).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
      expect(pre.headers.get("access-control-allow-credentials")).toBe("true");
    }
    const flow = newFlow({ clientId: "thoth-web" });
    const nav = await flow.browser.get(authorizeUrl(flow, { provider: "google" }), { origin: WEB_ORIGIN });
    expect(nav.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("revoke clears the cookie and ends the session", async () => {
    const { t, cookie } = await webTokens();
    const noOrigin = await webPost("/auth/revoke", { client_id: "thoth-web" }, cookie, null);
    expect(noOrigin.json.error).toBe("invalid_request");
    expect(await meStatus(t.json.access_token)).toBe(200);
    const res = await webPost("/auth/revoke", { client_id: "thoth-web" }, cookie);
    expect(res.status).toBe(200);
    const cleared = res.setCookies.find((c) => c.startsWith("__Secure-thoth_refresh="))!;
    expect(cleared).toMatch(/^__Secure-thoth_refresh=;/);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/auth");
    expect(await meStatus(t.json.access_token)).toBe(401);
    expect((await webPost("/auth/token", { grant_type: "refresh_token", client_id: "thoth-web" }, cookie)).json.error).toBe("invalid_grant");
    // Always 200, also for an unknown token.
    expect((await post("/auth/revoke", { client_id: "thoth-desktop", token: random() })).status).toBe(200);
  });
});

describe("account cap and sign-up limit", () => {
  it("MAX_ACCOUNTS reached: a new identity gets access_denied and no user row; an existing account still signs in", async () => {
    const sub = `sub-${random(6)}`;
    issuer.reset({ sub });
    const existing = await desktopTokens();
    const users = await count("SELECT count(*) AS n FROM users");
    env.config.maxAccounts = users;
    try {
      issuer.reset();
      const r = await signIn();
      expect(r.back!.get("error")).toBe("access_denied");
      expect(r.back!.get("error_description")).toContain("not accepting new accounts");
      expect(r.back!.get("state")).toBe(r.flow.state);
      expect(await count("SELECT count(*) AS n FROM users")).toBe(users);
      expect(await usersWithSubject("google", issuer.profile.sub)).toBe(0);
      issuer.reset({ sub });
      expect((await desktopTokens()).userId).toBe(existing.userId);
    } finally {
      env.config.maxAccounts = undefined;
    }
  });

  it("SIGNUP_LIMIT_PER_IP reached: a new identity gets access_denied and no user row; an existing account still signs in", async () => {
    const sub = `sub-${random(6)}`;
    issuer.reset({ sub });
    const existing = await desktopTokens();
    const signIn_ = env.config.signIn!;
    signIn_.signupLimitPerIp = await count("SELECT count(*) AS n FROM sign_ups");
    try {
      const users = await count("SELECT count(*) AS n FROM users");
      gh.reset();
      const r = await signIn({ provider: "github" });
      expect(r.back!.get("error")).toBe("access_denied");
      expect(r.back!.get("error_description")).toContain("not accepting new accounts");
      expect(await count("SELECT count(*) AS n FROM users")).toBe(users);
      issuer.reset({ sub });
      expect((await desktopTokens()).userId).toBe(existing.userId);
      // Old sign-ups fall out of the 24 h window.
      await env.db.query("UPDATE sign_ups SET created_at = now() - interval '25 hours'");
      gh.reset();
      expect((await signIn({ provider: "github" })).code).toBeTruthy();
    } finally {
      signIn_.signupLimitPerIp = undefined;
    }
  });
});

describe("capabilities, maintenance", () => {
  it("/capabilities advertises signIn with absolute PUBLIC_URL endpoints when a provider is configured", async () => {
    const caps = (await env.api(null, "GET", "/capabilities")).json;
    expect(caps.protocolVersion).toBe("1.0");
    expect(caps.signIn).toEqual({
      authorizationEndpoint: `${PUBLIC_URL}/auth/authorize`,
      tokenEndpoint: `${PUBLIC_URL}/auth/token`,
      revocationEndpoint: `${PUBLIC_URL}/auth/revoke`,
      providers: [
        { id: "google", name: "Google" },
        { id: "github", name: "GitHub" },
      ],
    });
  });

  it("without a provider: no signIn member, and /auth/authorize is 404", async () => {
    const plain = await startTestEnv();
    try {
      const caps = (await plain.api(null, "GET", "/capabilities")).json;
      expect(caps.signIn).toBeUndefined();
      const res = await fetch(`${plain.url}/auth/authorize?client_id=thoth-desktop&redirect_uri=${encodeURIComponent(DESKTOP_REDIRECT)}`, { redirect: "manual" });
      expect(res.status).toBe(404);
      expect((await fetch(`${plain.url}/auth/token`, { method: "POST" })).status).toBe(404);
    } finally {
      await plain.close();
    }
  });

  it("/auth/* counts against the per-IP rate limit (an HTML 429 on navigations, OAuth JSON on the token endpoint)", async () => {
    const limited = await startTestEnv({ env: { PUBLIC_URL, OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: random(), OIDC_ISSUER: issuer.url, RATE_LIMIT_PER_IP: "3", RATE_LIMIT_WINDOW_SECONDS: "3600" } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await fetch(`${limited.url}/auth/authorize`, { redirect: "manual" })).status);
      expect(statuses).toEqual([400, 400, 400]);
      const html = await fetch(`${limited.url}/auth/authorize`, { redirect: "manual" });
      expect(html.status).toBe(429);
      expect(html.headers.get("content-type")).toContain("text/html");
      expect(html.headers.get("retry-after")).toBeTruthy();
      const token = await fetch(`${limited.url}/auth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token" });
      expect(token.status).toBe(429);
      expect(((await token.json()) as { error: string }).error).toBe("temporarily_unavailable");
    } finally {
      await limited.close();
    }
  });

  it("maintenance removes expired auth rows and keeps live ones", async () => {
    const live = await desktopTokens();
    const user = live.userId;
    await env.db.query(
      `INSERT INTO auth_requests (state_hash, binding_hash, provider, client_id, redirect_uri, code_challenge, client_state, pkce_verifier, nonce, expires_at)
       VALUES ($1, $1, 'google', 'thoth-desktop', 'x', 'x', 's', 'v', 'n', now() - interval '1 minute'), ($2, $2, 'google', 'thoth-desktop', 'x', 'x', 's', 'v', 'n', now() + interval '5 minutes')`,
      [sha256Hex("old-req"), sha256Hex("live-req")],
    );
    await env.db.query("INSERT INTO auth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, provider, expires_at) VALUES ($1, $2, 'thoth-desktop', 'x', 'x', 'google', now() - interval '1 minute')", [sha256Hex("old-code"), user]);
    await env.db.query("INSERT INTO sessions (id, user_id, client_id, provider, expires_at) VALUES ('ses_old', $1, 'thoth-desktop', 'google', now() - interval '1 minute'), ('ses_revoked', $1, 'thoth-desktop', 'google', now() + interval '1 day')", [user]);
    await env.db.query("UPDATE sessions SET revoked_at = now() WHERE id = 'ses_revoked'");
    await env.db.query("INSERT INTO refresh_tokens (token_hash, session_id, expires_at) VALUES ($1, 'ses_old', now() + interval '1 day')", [sha256Hex("old-rt")]);
    await env.db.query("INSERT INTO access_tokens (id, user_id, token_hash, expires_at, session_id) VALUES ('tok_old', $1, $2, now() - interval '2 days', 'ses_revoked')", [user, sha256Hex("old-at")]);
    await env.db.query("INSERT INTO sign_ups (ip_hash, created_at) VALUES ($1, now() - interval '2 days')", [sha256Hex("ip:old")]);

    const result = await runMaintenance(env.db, { revisionRetentionDays: undefined, blobs: env.server.deps.blobs });
    expect(result.signInRowsDeleted).toBeGreaterThanOrEqual(6);
    expect(await count("SELECT count(*) AS n FROM auth_requests WHERE state_hash = $1", [sha256Hex("old-req")])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM auth_requests WHERE state_hash = $1", [sha256Hex("live-req")])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM auth_codes WHERE expires_at <= now()")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM sessions WHERE id IN ('ses_old', 'ses_revoked')")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM refresh_tokens WHERE token_hash = $1", [sha256Hex("old-rt")])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM access_tokens WHERE id = 'tok_old'")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM sign_ups WHERE ip_hash = $1", [sha256Hex("ip:old")])).toBe(0);
    // The live session survives.
    expect(await meStatus(live.access)).toBe(200);
    expect((await refresh(live.refresh)).status).toBe(200);
  });
});

describe("secrets", () => {
  it("no client secret, provider token, ID token, code, refresh or access token, verifier, state or nonce appears in any log line or body", async () => {
    // Exercise the error paths once more so they are in the logs too.
    issuer.reset({ alg: "HS256" });
    await signIn();
    issuer.reset({ tokenStatus: 500 });
    await signIn();
    const r = await signIn();
    await exchange(r, { code_verifier: random(48) });
    // A restart logs startup with the full configuration in scope.
    await env.restart({ logStream: { write: (line: string) => void logLines.push(line) } });
    env.server.app.log.info({ signIn: env.config.signIn, client_secret: issuer.clientSecret, code: "probe-code-value", refresh_token: "probe-rt-value", code_verifier: "probe-verifier", form: { state: "probe-state" } }, "probe");

    const secrets = [
      issuer.clientSecret,
      gh.clientSecret,
      ...issuer.recorded.upstreamStates,
      ...issuer.recorded.nonces,
      ...issuer.recorded.verifiers,
      ...issuer.recorded.codes,
      ...issuer.recorded.accessTokens,
      ...issuer.recorded.idTokens,
      ...gh.recorded.upstreamStates,
      ...gh.recorded.verifiers,
      ...gh.recorded.codes,
      ...gh.recorded.accessTokens,
      "probe-code-value",
      "probe-rt-value",
      "probe-verifier",
      "probe-state",
    ].filter((s) => s.length > 0);
    expect(issuer.recorded.idTokens.length).toBeGreaterThan(5);
    expect(gh.recorded.accessTokens.length).toBeGreaterThan(2);
    expect(issued.length).toBeGreaterThan(20);
    expect(logLines.length).toBeGreaterThan(50);

    const logs = logLines.join("\n");
    const bodies = responses.join("\n");
    for (const secret of [...secrets, ...issued]) expect(logs, `log leaked ${secret.slice(0, 6)}...`).not.toContain(secret);
    // Our own codes and tokens legitimately appear in the responses that deliver them; provider-side secrets never do.
    for (const secret of secrets) expect(bodies, `body leaked ${secret.slice(0, 6)}...`).not.toContain(secret);
    expect(logs).not.toMatch(/thoth_(at|rt)_[A-Za-z0-9_-]{20,}/);
    expect(logs).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
    // The client state is echoed to the client by design, but never logged.
    for (const state of clientStates) expect(logs).not.toContain(state);
    // Stored only as hashes.
    const dump = JSON.stringify((await env.db.query("SELECT * FROM auth_codes")).rows) + JSON.stringify((await env.db.query("SELECT * FROM refresh_tokens")).rows) + JSON.stringify((await env.db.query("SELECT * FROM access_tokens")).rows) + JSON.stringify((await env.db.query("SELECT * FROM audit_events")).rows);
    for (const secret of [...secrets, ...issued]) expect(dump).not.toContain(secret);
    expect(await count("SELECT count(*) AS n FROM auth_requests WHERE consumed_at IS NOT NULL AND (pkce_verifier IS NOT NULL OR nonce IS NOT NULL)")).toBe(0);
  });
});
