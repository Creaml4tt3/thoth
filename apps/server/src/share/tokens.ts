import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Share-link tokens (ADR-0023). 24 bytes from the operating system's CSPRNG (192 bits), base64url: 32 URL-safe
 * characters. Only the SHA-256 hash is stored. A token is high-entropy, so an unsalted hash is enough: it cannot be
 * guessed from the hash, and the hash is what the lookup index holds.
 */
const TOKEN_BYTES = 24;

/** What a token looks like. Anything else is answered exactly like an unknown token, never with a different error. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function generateShareToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A hash that matches no token; compared against when a lookup found nothing, so both paths do the same work. */
const NO_HASH = "0".repeat(64);

/**
 * Constant-time check that `token` hashes to `stored`. Both sides are 32-byte digests, so `timingSafeEqual` always
 * runs on equal lengths; a stored value of another length (or none) compares against a fixed hash and fails.
 */
export function shareTokenMatches(token: string, stored: string | null | undefined): boolean {
  const candidate = Buffer.from(hashShareToken(token), "hex");
  const valid = typeof stored === "string" && /^[0-9a-f]{64}$/.test(stored);
  const against = Buffer.from(valid ? stored : NO_HASH, "hex");
  return timingSafeEqual(candidate, against) && valid;
}
