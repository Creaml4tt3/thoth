import { z } from "zod";
import { sha256Hex } from "./hash.ts";
import { normalizeVaultPath } from "./paths.ts";

/**
 * Stable logical identity (ADR-003).
 *
 * - Adopted pages carry a UUIDv7 in frontmatter key `thoth_id`.
 * - Pages Thoth has not adopted get a deterministic provisional ID derived from
 *   their vault-relative path; it changes if the file is renamed externally.
 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVISIONAL = /^local:[0-9a-f]{32}$/;

export const PageIdSchema = z
  .string()
  .refine((v) => UUID_V7.test(v) || PROVISIONAL.test(v), "Invalid Thoth page ID");
export type PageId = z.infer<typeof PageIdSchema>;

export const StableIdSchema = z.string().regex(UUID_V7, "Expected UUIDv7");

export function isStableId(id: string): boolean {
  return UUID_V7.test(id);
}

export function isProvisionalId(id: string): boolean {
  return PROVISIONAL.test(id);
}

/** RFC 9562 UUIDv7: 48-bit unix ms timestamp + random bits. */
export function newStableId(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let ts = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function provisionalPageId(vaultPath: string): string {
  return `local:${sha256Hex(normalizeVaultPath(vaultPath)).slice(0, 32)}`;
}
