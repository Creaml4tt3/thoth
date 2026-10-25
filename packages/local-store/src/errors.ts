export class ConflictError extends Error {
  readonly path: string;
  readonly expectedHash: string | null;
  readonly actualHash: string | null;

  constructor(path: string, expectedHash: string | null, actualHash: string | null) {
    super(`Refusing to overwrite "${path}": it changed since it was read (expected ${expectedHash ?? "absent"}, found ${actualHash ?? "absent"})`);
    this.name = "ConflictError";
    this.path = path;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

/**
 * The index stayed locked by another connection (another window of the app, ADR-0019) through every try: SQLite's own
 * wait and a few more. The files are untouched; opening again later works.
 */
export class IndexBusyError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The index of this Private Space is busy in another window. Try again in a moment.", options);
    this.name = "IndexBusyError";
  }
}

/** Did an index call fail because another connection holds SQLite's write lock (`SQLITE_BUSY` or `SQLITE_LOCKED`)? */
export function isIndexBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, errcode, message } = error as { code?: unknown; errcode?: unknown; message?: unknown };
  if (code === "SQLITE_BUSY") return true; // the Rust host
  if (typeof errcode === "number" && ((errcode & 0xff) === 5 || (errcode & 0xff) === 6)) return true; // node:sqlite
  return typeof message === "string" && /database (table )?is (locked|busy)/i.test(message);
}
