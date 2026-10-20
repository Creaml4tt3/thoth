/**
 * Vault-relative path rules (ADR-003, ADR-010).
 *
 * A vault path is POSIX-separated, NFC-normalized, relative, and never escapes
 * the vault root. Collision checks are case-insensitive because default macOS
 * and Windows filesystems are.
 */
export class UnsafePathError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`Unsafe path "${path}": ${reason}`);
    this.name = "UnsafePathError";
    this.path = path;
    this.reason = reason;
  }
}

export function checkRelativePath(raw: string): string | undefined {
  if (raw.length === 0) return "empty path";
  if (raw.includes("\0")) return "NUL byte";
  if (raw.includes("\\")) return "backslash separator";
  if (raw.startsWith("/")) return "absolute path";
  if (/^[a-zA-Z]:/.test(raw)) return "drive letter";
  const segments = raw.split("/");
  for (const segment of segments) {
    if (segment === "..") return "parent directory segment";
  }
  return undefined;
}

/** Normalizes a relative path; throws UnsafePathError if it could escape the root. */
export function normalizeVaultPath(raw: string): string {
  const problem = checkRelativePath(raw);
  if (problem) throw new UnsafePathError(raw, problem);
  const segments = raw
    .normalize("NFC")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) throw new UnsafePathError(raw, "empty path");
  return segments.join("/");
}

export function isSafeVaultPath(raw: string): boolean {
  try {
    normalizeVaultPath(raw);
    return true;
  } catch {
    return false;
  }
}

export function collisionKey(vaultPath: string): string {
  return vaultPath.normalize("NFC").toLocaleLowerCase("en-US");
}

/** Thoth's metadata directory. Never a destination for user or imported content. */
export const RESERVED_DIR = ".thoth";

/**
 * True when any segment of the path is the reserved metadata directory,
 * compared case-insensitively because default macOS/Windows volumes are.
 */
export function isReservedPath(vaultPath: string): boolean {
  return vaultPath.split("/").some((segment) => collisionKey(segment) === RESERVED_DIR);
}

export function dirname(vaultPath: string): string {
  const i = vaultPath.lastIndexOf("/");
  return i === -1 ? "" : vaultPath.slice(0, i);
}

export function basename(vaultPath: string): string {
  const i = vaultPath.lastIndexOf("/");
  return i === -1 ? vaultPath : vaultPath.slice(i + 1);
}

export function extname(vaultPath: string): string {
  const base = basename(vaultPath);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
}

export function stripExtension(vaultPath: string): string {
  const ext = extname(vaultPath);
  return ext ? vaultPath.slice(0, -ext.length) : vaultPath;
}

export function joinVaultPath(...parts: string[]): string {
  return normalizeVaultPath(parts.filter((p) => p !== "").join("/"));
}

/**
 * Resolves `target` relative to the directory of `fromPath`. Returns undefined
 * when the result would escape the vault root.
 */
export function resolveRelative(fromPath: string, target: string): string | undefined {
  const stack = dirname(fromPath).split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return undefined;
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return stack.length === 0 ? undefined : stack.join("/").normalize("NFC");
}

/** Relative link from the directory of `fromPath` to `toPath`, both vault paths. */
export function relativeLink(fromPath: string, toPath: string): string {
  const from = dirname(fromPath).split("/").filter(Boolean);
  const to = toPath.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  const ups = from.slice(common).map(() => "..");
  return [...ups, ...to.slice(common)].join("/");
}

export function isMarkdownPath(vaultPath: string): boolean {
  const ext = extname(vaultPath);
  return ext === ".md" || ext === ".markdown";
}
