import { randomBytes } from "node:crypto";

/** Opaque server-assigned identifier: `<prefix>_` plus 12 random bytes, URL-unreserved characters only. */
export function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}
