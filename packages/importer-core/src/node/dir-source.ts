import { openFolderSource } from "../folder-source.ts";
import type { ScanLimits } from "../limits.ts";
import type { ImportSource } from "../source.ts";
import { openNodeSourceHost } from "./source-host.ts";

/** Opens a folder read-only (Node convenience over `openFolderSource`). Never follows symlinks or leaves the root. */
export async function openDirectorySource(location: string, limits: Partial<ScanLimits> = {}): Promise<ImportSource> {
  return openFolderSource(await openNodeSourceHost(location), limits);
}
