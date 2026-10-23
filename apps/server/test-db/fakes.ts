import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * In-process doubles of the upstream providers, on 127.0.0.1 (loopback is the one place plain http is allowed for
 * an issuer). Every secret here is generated per run; the fakes record every secret they hand out or receive, so the
 * leak test can search the server's logs and bodies for them.
 */

const b64u = (v: Buffer | string) => Buffer.from(v).toString("base64url");
const s256 = (v: string) => createHash("sha256").update(v, "ascii").digest("base64url");
const random = (n = 32) => randomBytes(n).toString("base64url");

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function redirectTo(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: "fake_failure" });
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/** Everything a fake handed out or was handed, for the leak test. */
export interface Recorded {
  /** Our server's upstream state, nonce and PKCE verifier, as received. */
  upstreamStates: string[];
  nonces: string[];
  verifiers: string[];
  /** What the provider issued. */
  codes: string[];
  accessTokens: string[];
  idTokens: string[];
}

const recorded = (): Recorded => ({ upstreamStates: [], nonces: [], verifiers: [], codes: [], accessTokens: [], idTokens: [] });

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function rsaKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = random(8);
  return { kid, privateKey, jwk: { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid, use: "sig", alg: "RS256" } };
}

/** What the next ID token looks like. Reset with `issuer.reset()`. */
export interface IssuerProfile {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  /** Faults. */
  expiresIn: number;
  audience?: unknown;
  issuer?: string;
  nonce?: string;
  alg: "RS256" | "none" | "HS256";
  /** Sign with a key that is not in the JWKS. */
  unknownKey: boolean;
  /** Answer the authorization request with `?error=`. */
  authorizeError?: string;
  /** Token endpoint answers this HTTP status with no token. */
  tokenStatus?: number;
}

export interface FakeIssuer {
  url: string;
  clientId: string;
  clientSecret: string;
  profile: IssuerProfile;
  recorded: Recorded;
  jwksFetches: number;
  discoveryFetches: number;
  /** Token requests whose client authentication or PKCE failed (the server must never cause one). */
  rejectedTokenRequests: string[];
  reset(profile?: Partial<IssuerProfile>): void;
  /** Switches to a fresh signing key with a new `kid`; the JWKS publishes only the new key. */
  rotateKey(): void;
  close(): Promise<void>;
}

/** A tiny OpenID Connect issuer: discovery, JWKS, an auto-approving authorize endpoint, a token endpoint that checks the client secret and PKCE. */
export async function startFakeIssuer(): Promise<FakeIssuer> {
  const clientId = `client-${random(6)}`;
  const clientSecret = random();
  let key = rsaKey();
  const strangerKey = rsaKey();
  const codes = new Map<string, { redirectUri: string; challenge: string; nonce: string | null; profile: IssuerProfile }>();
  const defaults = (): IssuerProfile => ({ sub: `sub-${random(6)}`, email: "ada@example.org", emailVerified: true, name: "Ada Lovelace", expiresIn: 300, alg: "RS256", unknownKey: false });

  const issuer: FakeIssuer = {
    url: "",
    clientId,
    clientSecret,
    profile: defaults(),
    recorded: recorded(),
    jwksFetches: 0,
    discoveryFetches: 0,
    rejectedTokenRequests: [],
    reset(profile = {}) {
      issuer.profile = { ...defaults(), ...profile };
    },
    rotateKey() {
      key = rsaKey();
    },
    close: async () => undefined,
  };

  function idToken(profile: IssuerProfile, nonce: string | null): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: profile.issuer ?? issuer.url,
      aud: profile.audience ?? clientId,
      sub: profile.sub,
      iat: now,
      exp: now + profile.expiresIn,
      nonce: profile.nonce ?? nonce,
      ...(profile.email === undefined ? {} : { email: profile.email, email_verified: profile.emailVerified ?? false }),
      ...(profile.name === undefined ? {} : { name: profile.name }),
    };
    const signer = profile.unknownKey ? strangerKey : key;
    const header = profile.alg === "RS256" ? { alg: "RS256", typ: "JWT", kid: signer.kid } : { alg: profile.alg, typ: "JWT" };
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
    if (profile.alg === "none") return `${input}.`;
    if (profile.alg === "HS256") return `${input}.${createHmac("sha256", clientSecret).update(input).digest("base64url")}`;
    return `${input}.${sign("sha256", Buffer.from(input), signer.privateKey).toString("base64url")}`;
  }

  const { server, url } = await listen(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/.well-known/openid-configuration") {
      issuer.discoveryFetches++;
      return json(res, 200, {
        issuer: issuer.url,
        authorization_endpoint: `${issuer.url}/authorize`,
        token_endpoint: `${issuer.url}/token`,
        jwks_uri: `${issuer.url}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (u.pathname === "/jwks") {
      issuer.jwksFetches++;
      return json(res, 200, { keys: [key.jwk] });
    }
    if (u.pathname === "/authorize") {
      const p = u.searchParams;
      const redirectUri = p.get("redirect_uri")!;
      const state = p.get("state")!;
      issuer.recorded.upstreamStates.push(state);
      if (p.get("nonce")) issuer.recorded.nonces.push(p.get("nonce")!);
      const back = new URL(redirectUri);
      if (p.get("client_id") !== clientId || p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" || p.get("scope") !== "openid email profile") back.searchParams.set("error", "invalid_request");
      else if (issuer.profile.authorizeError) back.searchParams.set("error", issuer.profile.authorizeError);
      else {
        const code = random();
        issuer.recorded.codes.push(code);
        codes.set(code, { redirectUri, challenge: p.get("code_challenge")!, nonce: p.get("nonce"), profile: { ...issuer.profile } });
        back.searchParams.set("code", code);
      }
      back.searchParams.set("state", state);
      return redirectTo(res, back.toString());
    }
    if (u.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      let id = form.get("client_id");
      let secret = form.get("client_secret");
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
      if (basic) {
        const [i, s] = Buffer.from(basic[1]!, "base64").toString("utf8").split(":");
        id = decodeURIComponent(i!.replace(/\+/g, " "));
        secret = decodeURIComponent((s ?? "").replace(/\+/g, " "));
      }
      if (id !== clientId || secret !== clientSecret) return issuer.rejectedTokenRequests.push("client"), json(res, 401, { error: "invalid_client" });
      const code = form.get("code") ?? "";
      const entry = codes.get(code);
      codes.delete(code);
      const verifier = form.get("code_verifier") ?? "";
      issuer.recorded.verifiers.push(verifier);
      if (!entry || entry.redirectUri !== form.get("redirect_uri")) return issuer.rejectedTokenRequests.push("code"), json(res, 400, { error: "invalid_grant" });
      if (s256(verifier) !== entry.challenge) return issuer.rejectedTokenRequests.push("pkce"), json(res, 400, { error: "invalid_grant" });
      if (entry.profile.tokenStatus) return json(res, entry.profile.tokenStatus, { error: "temporarily_unavailable" });
      const accessToken = `ya29.${random()}`;
      const token = idToken(entry.profile, entry.nonce);
      issuer.recorded.accessTokens.push(accessToken);
      issuer.recorded.idTokens.push(token);
      return json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600, id_token: token, scope: "openid email profile" });
    }
    return json(res, 404, { error: "not_found" });
  });
  issuer.url = url;
  issuer.close = () => close(server);
  return issuer;
}

export interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  emails: { email: string; primary: boolean; verified: boolean }[];
}

export interface FakeGithub {
  url: string;
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  profile: GithubProfile;
  recorded: Recorded;
  rejectedTokenRequests: string[];
  reset(profile?: Partial<GithubProfile>): void;
  close(): Promise<void>;
}

/** GitHub's OAuth web flow and the two API calls the adapter makes. Web and API share one origin, under different paths. */
export async function startFakeGithub(): Promise<FakeGithub> {
  const clientId = `Iv1.${random(8)}`;
  const clientSecret = random();
  const codes = new Map<string, { redirectUri: string; challenge: string; profile: GithubProfile }>();
  const tokens = new Map<string, GithubProfile>();
  let nextId = 1000 + Math.floor(Math.random() * 1_000_000);
  const defaults = (): GithubProfile => ({ id: nextId++, login: "octo", name: "Octo Cat", emails: [{ email: "ada@example.org", primary: true, verified: true }] });

  const gh: FakeGithub = {
    url: "",
    apiUrl: "",
    clientId,
    clientSecret,
    profile: defaults(),
    recorded: recorded(),
    rejectedTokenRequests: [],
    reset(profile = {}) {
      gh.profile = { ...defaults(), ...profile };
    },
    close: async () => undefined,
  };

  const { server, url } = await listen(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/login/oauth/authorize") {
      const p = u.searchParams;
      const state = p.get("state")!;
      gh.recorded.upstreamStates.push(state);
      const back = new URL(p.get("redirect_uri")!);
      if (p.get("client_id") !== clientId || p.get("code_challenge_method") !== "S256") back.searchParams.set("error", "invalid_request");
      else {
        const code = random(10);
        gh.recorded.codes.push(code);
        codes.set(code, { redirectUri: p.get("redirect_uri")!, challenge: p.get("code_challenge")!, profile: structuredClone(gh.profile) });
        back.searchParams.set("code", code);
      }
      back.searchParams.set("state", state);
      return redirectTo(res, back.toString());
    }
    if (u.pathname === "/login/oauth/access_token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret) return gh.rejectedTokenRequests.push("client"), json(res, 200, { error: "incorrect_client_credentials" });
      const entry = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      gh.recorded.verifiers.push(verifier);
      if (!entry || entry.redirectUri !== form.get("redirect_uri")) return gh.rejectedTokenRequests.push("code"), json(res, 200, { error: "bad_verification_code" });
      if (s256(verifier) !== entry.challenge) return gh.rejectedTokenRequests.push("pkce"), json(res, 200, { error: "bad_verification_code" });
      const accessToken = `gho_${random(27)}`;
      gh.recorded.accessTokens.push(accessToken);
      tokens.set(accessToken, entry.profile);
      return json(res, 200, { access_token: accessToken, token_type: "bearer", scope: "read:user,user:email" });
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const profile = bearer === undefined ? undefined : tokens.get(bearer);
    if (u.pathname === "/api/user") return profile ? json(res, 200, { id: profile.id, login: profile.login, name: profile.name }) : json(res, 401, { message: "Bad credentials" });
    if (u.pathname === "/api/user/emails") return profile ? json(res, 200, profile.emails) : json(res, 401, { message: "Bad credentials" });
    return json(res, 404, { message: "Not Found" });
  });
  gh.url = url;
  gh.apiUrl = `${url}/api`;
  gh.close = () => close(server);
  return gh;
}
