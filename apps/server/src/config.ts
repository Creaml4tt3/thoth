import type { CapabilityId } from "@thoth/workspace-protocol";

export interface RateLimitConfig {
  /** Requests per window for one authenticated account; `undefined` = not limited. */
  perAccount: number | undefined;
  /** Requests per window for one client IP; `undefined` = not limited. */
  perIp: number | undefined;
  windowSeconds: number;
}

export interface ServerConfig {
  databaseUrl: string;
  databasePoolMax: number;
  /** Apply pending migrations before listening. Turn off when migrating separately with a direct (non-pooled) URL. */
  migrateOnStart: boolean;
  profile: "default" | "trial";
  blobStore: "fs" | "postgres";
  blobDir: string;
  host: string;
  port: number;
  logLevel: string;
  maxMarkdownBytes: number;
  maxAttachmentBytes: number;
  /** Total JSON body size accepted by `createTransfer`. */
  maxTransferBytes: number;
  /** Quotas. `undefined` = no limit. The first five are advertised by /capabilities. */
  maxWorkspacesPerAccount: number | undefined;
  maxMembersPerWorkspace: number | undefined;
  maxPagesPerWorkspace: number | undefined;
  maxWorkspaceAttachmentBytes: number | undefined;
  revisionRetentionDays: number | undefined;
  /** Server-wide, not advertised: stored attachment bytes (each distinct blob once) and number of accounts. */
  maxTotalAttachmentBytes: number | undefined;
  maxAccounts: number | undefined;
  /** Exact origins (scheme://host[:port]) that may call the API from a browser. */
  corsOrigins: string[];
  rateLimit: RateLimitConfig;
  /** Trust `x-forwarded-for` / `x-real-ip` (one trusted proxy hop) for the client IP. */
  trustProxy: boolean;
  /** Enables `GET /internal/maintenance` when set. Never logged or echoed. */
  cronSecret: string | undefined;
  capabilities: CapabilityId[];
  /** Display name advertised as `server.name` in /capabilities (1 to 64 characters, no control characters). */
  serverName: string;
  /** The sign-in broker (docs/protocol/sign-in.md); `undefined` when no provider is configured. */
  signIn: SignInConfig | undefined;
  /** The server's public origin from PUBLIC_URL (no trailing slash), used for share-link addresses; `undefined` = the request's own origin. */
  publicUrl: string | undefined;
  /** Public share links (ADR-0023, capability `public-share`). `undefined` = no limit. */
  share: ShareConfig;
}

export interface ShareConfig {
  /** Active (not revoked, not expired) links per workspace; one more is 409 `quota_exceeded`. */
  maxLinksPerWorkspace: number | undefined;
  /** Views of one link (pages and attachments) per rate-limit window, counted per token, known or not. */
  viewsPerLink: number | undefined;
  /** Views of any shared page per client IP per rate-limit window. */
  viewsPerIp: number | undefined;
}

export interface OidcProviderConfig {
  kind: "oidc";
  /** `google` (fixed issuer) or `oidc` (any issuer). */
  id: "google" | "oidc";
  name: string;
  issuer: string;
  clientId: string;
  /** Never logged or echoed. */
  clientSecret: string;
}

export interface GithubProviderConfig {
  kind: "github";
  id: "github";
  name: string;
  clientId: string;
  /** Never logged or echoed. */
  clientSecret: string;
  /** `https://github.com` or a GitHub Enterprise / test double origin. */
  webUrl: string;
  apiUrl: string;
}

export type ProviderConfig = OidcProviderConfig | GithubProviderConfig;

export interface SignInConfig {
  /** The server's public origin, no trailing slash. Endpoint URLs, the upstream redirect URI and `iss` derive from it. */
  publicUrl: string;
  providers: ProviderConfig[];
  /** Exact redirect URIs of `thoth-web`; empty = the web client does not exist. */
  webRedirectUris: string[];
  /** New accounts per client IP per 24 h; `undefined` = not limited. */
  signupLimitPerIp: number | undefined;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  sessionMaxDays: number;
}

export const DEFAULT_CAPABILITIES: CapabilityId[] = ["attachments", "search", "events.sse", "transfers", "page-order", "page-kind", "public-share"];

const KIB = 1024;
const MIB = 1_048_576;

/** What `THOTH_PROFILE=trial` fills in. Every value can be overridden by its own variable. */
export const TRIAL_PROFILE = {
  maxWorkspacesPerAccount: 1,
  maxMembersPerWorkspace: 10,
  maxPagesPerWorkspace: 200,
  maxWorkspaceAttachmentBytes: 20 * MIB,
  maxTotalAttachmentBytes: 600 * MIB,
  revisionRetentionDays: 30,
  // Vercel Functions reject request bodies above 4.5 MB before our code runs; stay below it so users get our clear 413.
  maxAttachmentBytes: 4 * MIB,
  maxMarkdownBytes: 256 * KIB,
  maxTransferBytes: 4 * MIB,
  blobStore: "postgres",
  // ADR-0014: the account cap keeps the database inside Neon's free 1 GB; Proposed, adjust after real usage.
  maxAccounts: 300,
  // Generous for a person (clients poll the change feed every few seconds), small for a script.
  rateLimitPerAccount: 300,
  rateLimitPerIp: 600,
  // ADR-0014 rule 2: no long-lived SSE on a 300 s serverless function or a database that must be allowed to sleep.
  events: "off",
  // ADR-0014 rule 4: sign-up is limited per IP.
  signupLimitPerIp: 10,
  // ADR-0023 rule 4: public share links stay on in the trial, with a cap per workspace and view rate limits.
  // A page view with a few pictures is a handful of requests; per IP stays well below the API's 600.
  maxShareLinksPerWorkspace: 20,
  shareViewsPerLink: 300,
  shareViewsPerIp: 120,
} as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const present = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const raw = env[name];
  return raw === undefined || raw === "" ? undefined : raw;
};

function intFrom(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = present(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

/** An optional quota: unset = `fallback` (the profile default, or no limit); `unlimited` removes a profile default. */
function limitFrom(env: NodeJS.ProcessEnv, name: string, fallback: number | undefined, max: number): number | undefined {
  const raw = present(env, name);
  if (raw === undefined) return fallback;
  if (raw === "unlimited") return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > max) throw new ConfigError(`${name} must be an integer between 1 and ${max}, or "unlimited"`);
  return n;
}

function boolFrom(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = present(env, name);
  if (raw === undefined) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new ConfigError(`${name} must be true or false`);
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, allowed: readonly T[], fallback: T): T {
  const raw = present(env, name);
  if (raw === undefined) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new ConfigError(`${name} must be one of ${allowed.join(", ")}`);
}

/** Exact origins only: `scheme://host[:port]`, no path, no trailing slash, no wildcard. Values are never echoed. */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const origins: string[] = [];
  for (const part of raw.split(",")) {
    const origin = part.trim();
    let normalized: string | null = null;
    try {
      const url = new URL(origin);
      if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === origin && !origin.includes("*")) normalized = url.origin;
    } catch {
      /* rejected below */
    }
    if (normalized === null) throw new ConfigError("CORS_ORIGINS must be a comma-separated list of exact origins (scheme://host[:port], no path or wildcard)");
    if (!origins.includes(normalized)) origins.push(normalized);
  }
  return origins;
}

const LOOPBACK_HOSTS = new Set(["localhost", "[::1]"]);

/** True for `localhost`, `127.0.0.0/8` and `[::1]`, the hosts allowed over plain http (local test issuers, dev web clients). */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/** An absolute `https` URL, or `http` on a loopback host; no credentials, query or fragment. Values are never echoed. */
function secureUrlFrom(name: string, raw: string, options: { keepTrailingSlash?: boolean } = {}): string {
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    /* rejected below */
  }
  const ok = url !== null && (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) && url.username === "" && url.password === "" && url.search === "" && url.hash === "" && !raw.includes("#");
  if (!ok) throw new ConfigError(`${name} must be an https URL (plain http is allowed only for loopback hosts), without credentials, query or fragment`);
  // An issuer is compared byte for byte with the `iss` claim, so it is kept exactly as configured.
  return options.keepTrailingSlash ? raw : raw.replace(/\/+$/, "");
}

/** Both or neither: a provider with only its ID or only its secret is a configuration error naming the missing variable. */
function pairFrom(env: NodeJS.ProcessEnv, idName: string, secretName: string): { clientId: string; clientSecret: string } | undefined {
  const clientId = present(env, idName);
  const clientSecret = present(env, secretName);
  if (clientId === undefined && clientSecret === undefined) return undefined;
  if (clientId === undefined) throw new ConfigError(`${idName} is required when ${secretName} is set`);
  if (clientSecret === undefined) throw new ConfigError(`${secretName} is required when ${idName} is set`);
  return { clientId, clientSecret };
}

/** Comma-separated exact redirect URIs of the web client (https, or http on a loopback host; no fragment or wildcard). */
export function parseWebRedirectUris(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const uris: string[] = [];
  for (const part of raw.split(",")) {
    const uri = part.trim();
    let ok = false;
    try {
      const url = new URL(uri);
      ok = (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) && url.href === uri && url.hash === "" && !uri.includes("#") && !uri.includes("*") && url.username === "" && url.password === "";
    } catch {
      /* rejected below */
    }
    if (!ok) throw new ConfigError("WEB_REDIRECT_URIS must be a comma-separated list of exact absolute URIs (https, or http on a loopback host; normalized, no fragment or wildcard)");
    if (!uris.includes(uri)) uris.push(uri);
  }
  return uris;
}

export const DEFAULT_SERVER_NAME = "Thoth server";
const MAX_SERVER_NAME = 64;

/**
 * `SERVER_NAME`, trimmed: 1 to 64 characters (code points) and no control characters. Unset, it is the host name of
 * `PUBLIC_URL`, else "Thoth server". PUBLIC_URL is validated only when sign-in needs it; here a value that does not
 * parse simply gives no default.
 */
function serverNameFrom(env: NodeJS.ProcessEnv): string {
  const raw = present(env, "SERVER_NAME");
  if (raw === undefined) {
    const publicUrl = present(env, "PUBLIC_URL");
    if (publicUrl !== undefined && URL.canParse(publicUrl)) {
      const host = new URL(publicUrl).hostname;
      if (host !== "") return host;
    }
    return DEFAULT_SERVER_NAME;
  }
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > MAX_SERVER_NAME || /\p{Cc}/u.test(name)) throw new ConfigError(`SERVER_NAME must be 1 to ${MAX_SERVER_NAME} characters with no control characters`);
  return name;
}

export const GOOGLE_ISSUER = "https://accounts.google.com";

/** Sign-in settings (docs/protocol/sign-in.md section 9). `undefined` when no provider is configured. */
function signInFrom(env: NodeJS.ProcessEnv, trial: typeof TRIAL_PROFILE | undefined): SignInConfig | undefined {
  const providers: ProviderConfig[] = [];
  const google = pairFrom(env, "OIDC_GOOGLE_CLIENT_ID", "OIDC_GOOGLE_CLIENT_SECRET");
  if (google) providers.push({ kind: "oidc", id: "google", name: "Google", issuer: GOOGLE_ISSUER, ...google });
  const github = pairFrom(env, "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET");
  if (github) {
    const webUrl = secureUrlFrom("GITHUB_URL", present(env, "GITHUB_URL") ?? "https://github.com");
    const apiUrl = secureUrlFrom("GITHUB_API_URL", present(env, "GITHUB_API_URL") ?? "https://api.github.com");
    providers.push({ kind: "github", id: "github", name: "GitHub", webUrl, apiUrl, ...github });
  }
  const oidc = pairFrom(env, "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET");
  const issuerRaw = present(env, "OIDC_ISSUER");
  if (oidc && issuerRaw === undefined) throw new ConfigError("OIDC_ISSUER is required when OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are set");
  if (!oidc && issuerRaw !== undefined) throw new ConfigError("OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are required when OIDC_ISSUER is set");
  if (oidc && issuerRaw !== undefined) {
    const name = (present(env, "OIDC_NAME") ?? "OpenID Connect").trim();
    if (name.length < 1 || name.length > 60) throw new ConfigError("OIDC_NAME must be 1 to 60 characters");
    providers.push({ kind: "oidc", id: "oidc", name, issuer: secureUrlFrom("OIDC_ISSUER", issuerRaw, { keepTrailingSlash: true }), ...oidc });
  }

  const webRedirectUris = parseWebRedirectUris(env.WEB_REDIRECT_URIS);
  const signupLimitPerIp = limitFrom(env, "SIGNUP_LIMIT_PER_IP", trial?.signupLimitPerIp, 1_000_000);
  const accessTokenTtlSeconds = intFrom(env, "ACCESS_TOKEN_TTL_SECONDS", 900, 60, 3600);
  const refreshTokenTtlDays = intFrom(env, "REFRESH_TOKEN_TTL_DAYS", 30, 1, 365);
  const sessionMaxDays = intFrom(env, "SESSION_MAX_DAYS", 90, 1, 365);
  if (providers.length === 0) return undefined;
  const publicUrl = publicUrlFrom(env, { strict: true });
  if (publicUrl === undefined) throw new ConfigError("PUBLIC_URL is required when a sign-in provider is configured");
  return { publicUrl, providers, webRedirectUris, signupLimitPerIp, accessTokenTtlSeconds, refreshTokenTtlDays, sessionMaxDays };
}

/**
 * PUBLIC_URL as an origin without a trailing slash, or `undefined` when unset. Sign-in needs it (`strict`: an invalid
 * value is an error); without sign-in an invalid value is ignored, as before, and share links use the request's origin.
 */
function publicUrlFrom(env: NodeJS.ProcessEnv, options: { strict: boolean }): string | undefined {
  const raw = present(env, "PUBLIC_URL");
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    if ((url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) && url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "") return url.origin;
  } catch {
    /* rejected below */
  }
  if (!options.strict) return undefined;
  throw new ConfigError("PUBLIC_URL must be an https origin (scheme://host[:port], plain http only on a loopback host) without a path, query or fragment");
}

/**
 * Reads the configuration from environment variables. Secrets (the database URL carries a
 * password, CRON_SECRET is a bearer secret) are read here and never echoed in error messages.
 *
 *   DATABASE_URL  required, `postgres://user:password@host:5432/db`
 *   DATABASE_POOL_MAX  connections per process (default 10)
 *   MIGRATE_ON_START   apply migrations at startup (default true)
 *   THOTH_PROFILE      `trial` fills the hosted-trial limits below; explicit variables still win
 *   BLOB_STORE         fs (default) | postgres
 *   BLOB_DIR      attachment directory for BLOB_STORE=fs (default ./data/blobs)
 *   HOST, PORT    listen address (default 127.0.0.1:8080)
 *   LOG_LEVEL     pino level (default info)
 *   EVENTS        on (default) | off: off starts no LISTEN connection and does not advertise events.sse
 *   MAX_MARKDOWN_BYTES, MAX_ATTACHMENT_BYTES, MAX_TRANSFER_BYTES   size limits
 *   MAX_WORKSPACES_PER_ACCOUNT, MAX_MEMBERS_PER_WORKSPACE, MAX_PAGES_PER_WORKSPACE,
 *   MAX_WORKSPACE_ATTACHMENT_BYTES, REVISION_RETENTION_DAYS   advertised quotas (unset = none)
 *   MAX_TOTAL_ATTACHMENT_BYTES, MAX_ACCOUNTS   server-wide quotas, not advertised
 *   CORS_ORIGINS  comma-separated exact origins allowed to call the API from a browser
 *   RATE_LIMIT_PER_ACCOUNT, RATE_LIMIT_PER_IP, RATE_LIMIT_WINDOW_SECONDS   fixed-window rate limits (unset = off)
 *   TRUST_PROXY   trust x-forwarded-for / x-real-ip for the client IP (default false)
 *   CRON_SECRET   enables GET /internal/maintenance (bearer secret, at least 16 characters)
 *   SERVER_NAME   display name in /capabilities `server.name`, 1 to 64 characters (default: PUBLIC_URL's host name, else "Thoth server")
 *   PUBLIC_URL    the server's public origin; required when a sign-in provider is set
 *   OIDC_GOOGLE_CLIENT_ID/_SECRET, OIDC_ISSUER + OIDC_CLIENT_ID/_SECRET (+ OIDC_NAME), GITHUB_CLIENT_ID/_SECRET
 *                 sign-in providers (secrets, never echoed); GITHUB_URL, GITHUB_API_URL for Enterprise or a test double
 *   WEB_REDIRECT_URIS   exact redirect URIs of the thoth-web client
 *   SIGNUP_LIMIT_PER_IP new accounts per IP per 24 h (trial 10)
 *   ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_DAYS, SESSION_MAX_DAYS   sign-in lifetimes
 *   PUBLIC_SHARE  on (default) | off: public read-only share links (ADR-0023, capability public-share)
 *   MAX_SHARE_LINKS_PER_WORKSPACE   active share links per workspace (trial 20; unset = no limit)
 *   SHARE_VIEWS_PER_LINK, SHARE_VIEWS_PER_IP   share-page views per RATE_LIMIT_WINDOW_SECONDS (trial 300 and 120; unset = off)
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError("DATABASE_URL is required");
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new ConfigError("DATABASE_URL must start with postgres:// or postgresql://");
  const profile = oneOf(env, "THOTH_PROFILE", ["default", "trial"], "default");
  const trial = profile === "trial" ? TRIAL_PROFILE : undefined;

  const maxMarkdownBytes = intFrom(env, "MAX_MARKDOWN_BYTES", trial?.maxMarkdownBytes ?? MIB, 1024, 64 * MIB);
  const cronSecret = present(env, "CRON_SECRET");
  if (cronSecret !== undefined && cronSecret.length < 16) throw new ConfigError("CRON_SECRET must be at least 16 characters");
  const rateLimit: RateLimitConfig = {
    perAccount: limitFrom(env, "RATE_LIMIT_PER_ACCOUNT", trial?.rateLimitPerAccount, 1_000_000),
    perIp: limitFrom(env, "RATE_LIMIT_PER_IP", trial?.rateLimitPerIp, 1_000_000),
    windowSeconds: intFrom(env, "RATE_LIMIT_WINDOW_SECONDS", 60, 1, 86_400),
  };
  const eventsEnabled = oneOf(env, "EVENTS", ["on", "off"], trial?.events ?? "on") === "on";
  // ADR-0023: public share links are on by default on every server; an operator can switch them off.
  const shareEnabled = oneOf(env, "PUBLIC_SHARE", ["on", "off"], "on") === "on";
  const share: ShareConfig = {
    maxLinksPerWorkspace: limitFrom(env, "MAX_SHARE_LINKS_PER_WORKSPACE", trial?.maxShareLinksPerWorkspace, 1_000_000),
    viewsPerLink: limitFrom(env, "SHARE_VIEWS_PER_LINK", trial?.shareViewsPerLink, 1_000_000),
    viewsPerIp: limitFrom(env, "SHARE_VIEWS_PER_IP", trial?.shareViewsPerIp, 1_000_000),
  };

  return {
    databaseUrl,
    databasePoolMax: intFrom(env, "DATABASE_POOL_MAX", 10, 1, 100),
    migrateOnStart: boolFrom(env, "MIGRATE_ON_START", true),
    profile,
    blobStore: oneOf(env, "BLOB_STORE", ["fs", "postgres"], trial?.blobStore ?? "fs"),
    blobDir: env.BLOB_DIR || "./data/blobs",
    host: env.HOST || "127.0.0.1",
    port: intFrom(env, "PORT", 8080, 0, 65_535),
    logLevel: env.LOG_LEVEL || "info",
    maxMarkdownBytes,
    maxAttachmentBytes: intFrom(env, "MAX_ATTACHMENT_BYTES", trial?.maxAttachmentBytes ?? 26_214_400, 1024, 1024 * MIB),
    maxTransferBytes: intFrom(env, "MAX_TRANSFER_BYTES", Math.max(trial?.maxTransferBytes ?? 33_554_432, maxMarkdownBytes), maxMarkdownBytes, 1024 * MIB),
    maxWorkspacesPerAccount: limitFrom(env, "MAX_WORKSPACES_PER_ACCOUNT", trial?.maxWorkspacesPerAccount, 1_000_000),
    maxMembersPerWorkspace: limitFrom(env, "MAX_MEMBERS_PER_WORKSPACE", trial?.maxMembersPerWorkspace, 1_000_000),
    maxPagesPerWorkspace: limitFrom(env, "MAX_PAGES_PER_WORKSPACE", trial?.maxPagesPerWorkspace, 100_000_000),
    maxWorkspaceAttachmentBytes: limitFrom(env, "MAX_WORKSPACE_ATTACHMENT_BYTES", trial?.maxWorkspaceAttachmentBytes, 2 ** 40),
    revisionRetentionDays: limitFrom(env, "REVISION_RETENTION_DAYS", trial?.revisionRetentionDays, 36_500),
    maxTotalAttachmentBytes: limitFrom(env, "MAX_TOTAL_ATTACHMENT_BYTES", trial?.maxTotalAttachmentBytes, 2 ** 40),
    maxAccounts: limitFrom(env, "MAX_ACCOUNTS", trial?.maxAccounts, 100_000_000),
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    rateLimit,
    trustProxy: boolFrom(env, "TRUST_PROXY", false),
    cronSecret,
    capabilities: DEFAULT_CAPABILITIES.filter((c) => (eventsEnabled || c !== "events.sse") && (shareEnabled || c !== "public-share")),
    serverName: serverNameFrom(env),
    signIn: signInFrom(env, trial),
    publicUrl: publicUrlFrom(env, { strict: false }),
    share,
  };
}
