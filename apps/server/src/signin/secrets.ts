import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256 random bits, base64url (43 characters). Every state, binding, verifier, nonce, code and token starts here. */
export const randomSecret = (): string => randomBytes(32).toString("base64url");

/** SHA-256 hex: how every secret the broker issues is stored and looked up. */
export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(verifier))). */
export const s256 = (verifier: string): string => createHash("sha256").update(verifier, "ascii").digest("base64url");

/** Constant-time string equality. Compares fixed-size digests, so neither the content nor the length leaks. */
export function safeEqual(a: string, b: string): boolean {
  const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** RFC 7636 section 4.1: 43 to 128 unreserved characters. The same shape is required of a code challenge (sign-in.md section 3). */
export const PKCE_SHAPE = /^[A-Za-z0-9._~-]{43,128}$/;

/** True when `verifier` is well formed and its S256 hash equals `challenge`, compared in constant time. */
export function pkceMatches(verifier: string | undefined, challenge: string): boolean {
  if (verifier === undefined || !PKCE_SHAPE.test(verifier)) return false;
  return safeEqual(s256(verifier), challenge);
}

export const ACCESS_TOKEN_PREFIX = "thoth_at_";
export const REFRESH_TOKEN_PREFIX = "thoth_rt_";
