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
