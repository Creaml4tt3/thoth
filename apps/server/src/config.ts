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
}

export const DEFAULT_CAPABILITIES: CapabilityId[] = ["attachments", "search", "events.sse", "transfers"];

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
    capabilities: DEFAULT_CAPABILITIES.filter((c) => eventsEnabled || c !== "events.sse"),
  };
}
