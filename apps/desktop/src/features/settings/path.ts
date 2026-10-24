/**
 * The Private Space folder as Settings shows it: short, and without the user's name. The full path is still
 * available as a tooltip; this is only for display.
 */
import type { Os } from "../../strings/index.ts";

/** Home directories by platform, which put the user's name in the second (or third) segment. */
const HOME = [/^(\/Users\/[^/]+)(?=\/|$)/, /^(\/home\/[^/]+)(?=\/|$)/, /^(\/root)(?=\/|$)/, /^([A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/i];

/** `/Users/name/Documents/Thoth` → `~/Documents/Thoth` (also `/home/name`, `C:\Users\name`). Other paths are unchanged. */
export function withTilde(path: string): string {
  for (const home of HOME) {
    const match = home.exec(path);
    if (match) return `~${path.slice(match[1]!.length)}`;
  }
  return path;
}

/**
 * Shortens a path to at most `max` characters by replacing the middle with "…", keeping the start (where it
 * lives) and the folder's own name at the end. Counts code points, so Thai and emoji names are not split.
 */
export function middleTruncate(path: string, max: number): string {
  const chars = [...path];
  if (chars.length <= max) return path;
  const keep = max - 1;
  const tail = Math.ceil(keep / 2);
  return `${chars.slice(0, keep - tail).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/** What Settings shows for the Private Space folder. */
export function displayPath(path: string, max = 48): string {
  return middleTruncate(withTilde(path), max);
}

/** The platform, for naming its file manager. From the webview's user agent; Linux and others share "Files". */
export function currentOs(userAgent: string = globalThis.navigator?.userAgent ?? ""): Os {
  if (/Mac OS X|Macintosh/.test(userAgent)) return "mac";
  if (/Windows/.test(userAgent)) return "windows";
  return "linux";
}
