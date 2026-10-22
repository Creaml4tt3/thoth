import type { CapabilityId } from "@thoth/workspace-protocol";

export interface ServerConfig {
  databaseUrl: string;
  blobDir: string;
  host: string;
  port: number;
  logLevel: string;
  maxMarkdownBytes: number;
  maxAttachmentBytes: number;
  /** Total JSON body size accepted by `createTransfer`. */
  maxTransferBytes: number;
  capabilities: CapabilityId[];
}

export const DEFAULT_CAPABILITIES: CapabilityId[] = ["attachments", "search", "events.sse", "transfers"];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function intFrom(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

/**
 * Reads the configuration from environment variables. Secrets (the database URL carries a
 * password) are read here and never echoed in error messages.
 *
 *   DATABASE_URL  required, `postgres://user:password@host:5432/db`
 *   BLOB_DIR      attachment directory (default ./data/blobs)
 *   HOST, PORT    listen address (default 127.0.0.1:8080)
 *   LOG_LEVEL     pino level (default info)
 *   MAX_MARKDOWN_BYTES, MAX_ATTACHMENT_BYTES, MAX_TRANSFER_BYTES   limits advertised by /capabilities
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError("DATABASE_URL is required");
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new ConfigError("DATABASE_URL must start with postgres:// or postgresql://");
  const maxMarkdownBytes = intFrom(env, "MAX_MARKDOWN_BYTES", 1_048_576, 1024, 64 * 1_048_576);
  return {
    databaseUrl,
    blobDir: env.BLOB_DIR || "./data/blobs",
    host: env.HOST || "127.0.0.1",
    port: intFrom(env, "PORT", 8080, 0, 65_535),
    logLevel: env.LOG_LEVEL || "info",
    maxMarkdownBytes,
    maxAttachmentBytes: intFrom(env, "MAX_ATTACHMENT_BYTES", 26_214_400, 1024, 1024 * 1_048_576),
    maxTransferBytes: intFrom(env, "MAX_TRANSFER_BYTES", 33_554_432, maxMarkdownBytes, 1024 * 1_048_576),
    capabilities: [...DEFAULT_CAPABILITIES],
  };
}
