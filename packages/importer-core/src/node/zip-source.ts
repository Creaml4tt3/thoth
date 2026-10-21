import { malformed, openArchiveSource } from "../archive-source.ts";
import type { ScanLimits } from "../limits.ts";
import type { ImportSource } from "../source.ts";
import { openNodeSourceHost } from "./source-host.ts";

export interface ZipSourceOptions {
  /** Parent directory for the private temp directory of compressed nested parts (default: `os.tmpdir()`). */
  tempRoot?: string;
  /** Cancels opening, e.g. while a large part is being extracted. Temp files are removed. */
  signal?: AbortSignal;
}

/**
 * Opens a ZIP file read-only (Node convenience over `openArchiveSource`).
 * When the archive contains only nested ZIPs (e.g. a multi-part export) and
 * nesting is allowed, those are opened as parts of one combined source,
 * sharing the same limits budget.
 */
export async function openZipSource(location: string, limits: Partial<ScanLimits> = {}, options: ZipSourceOptions = {}): Promise<ImportSource> {
  const host = await openNodeSourceHost(location, options.tempRoot !== undefined ? { tempRoot: options.tempRoot } : {}).catch(malformed);
  return openArchiveSource(host, limits, options.signal !== undefined ? { signal: options.signal } : {});
}
