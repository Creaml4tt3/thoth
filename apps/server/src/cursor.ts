import { ApiError } from "./errors.ts";

/**
 * Opaque cursors: `<kind letter><base64url(scope|value)>`. The kind letter ties a cursor to one
 * collection, the scope (workspace, page, query digest) to one instance of it. Cursors carry only
 * a position, never authorization; every request is re-authorized.
 */
export type CursorKind = "w" | "t" | "r" | "c" | "s";

export function encodeCursor(kind: CursorKind, scope: string, value: string): string {
  return kind + Buffer.from(`${scope}|${value}`, "utf8").toString("base64url");
}

/** Returns the value of a cursor issued for `kind` and `scope`; throws `cursor_invalid` otherwise. */
export function decodeCursor(kind: CursorKind, scope: string, cursor: string): string {
  const fail = (why: string) => new ApiError("cursor_invalid", why);
  if (cursor.length > 2048 || !cursor.startsWith(kind)) throw fail("cursor was not issued for this collection");
  const rest = cursor.slice(1);
  if (!/^[A-Za-z0-9_-]+$/.test(rest)) throw fail("cursor is malformed");
  const text = Buffer.from(rest, "base64url").toString("utf8");
  const bar = text.indexOf("|");
  if (bar < 0 || text.slice(0, bar) !== scope) throw fail("cursor was not issued for this collection");
  return text.slice(bar + 1);
}

export function decodeIntCursor(kind: CursorKind, scope: string, cursor: string): number {
  const value = decodeCursor(kind, scope, cursor);
  if (!/^\d{1,15}$/.test(value)) throw new ApiError("cursor_invalid", "cursor does not decode");
  return Number(value);
}
