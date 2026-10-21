import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { ImportWarning } from "@thoth/domain";
import { ArchiveRejectedError, DEFAULT_LIMITS, type ScanLimits } from "../limits.ts";
import { isNoiseEntry, type ImportSource, type SourceEntry } from "../source.ts";

const STREAM_CHUNK = 64 * 1024;

/**
 * Read-only directory source. Never follows symlinks, never leaves the chosen
 * root, and opens files with O_NOFOLLOW (spec §7.3, ADR-010).
 */
class DirectorySource implements ImportSource {
  readonly label: string;
  readonly location: string;
  readonly entries: SourceEntry[] = [];
  readonly rejected: ImportWarning[] = [];
  private readonly limits: ScanLimits;

  constructor(location: string, limits: ScanLimits) {
    this.location = location;
    this.label = nodePath.basename(location);
    this.limits = limits;
  }

  async scan(): Promise<void> {
    let total = 0;
    const walk = async (rel: string): Promise<void> => {
      const dirents = await fs.readdir(rel ? nodePath.join(this.location, rel) : this.location, { withFileTypes: true });
      for (const d of dirents) {
        const path = (rel ? `${rel}/${d.name}` : d.name).normalize("NFC");
        if (d.isSymbolicLink()) {
          this.rejected.push({ code: "symlink_entry", severity: "warning", message: "Symbolic link not followed", sourcePath: path });
        } else if (d.isDirectory()) {
          await walk(rel ? `${rel}/${d.name}` : d.name);
        } else if (d.isFile()) {
          if (isNoiseEntry(path)) continue;
          if (this.entries.length >= this.limits.maxEntries)
            throw new ArchiveRejectedError("too_many_entries", `Folder has more than ${this.limits.maxEntries} files`);
          const stat = await fs.lstat(nodePath.join(this.location, rel, d.name));
          if (stat.size > this.limits.maxEntryBytes) {
            this.rejected.push({ code: "entry_too_large", severity: "error", message: `File exceeds ${this.limits.maxEntryBytes} bytes`, sourcePath: path });
            continue;
          }
          total += stat.size;
          if (total > this.limits.maxTotalBytes) throw new ArchiveRejectedError("too_large", `Folder exceeds ${this.limits.maxTotalBytes} bytes`);
          this.entries.push({ path, size: stat.size });
          this.diskNames.set(path, rel ? `${rel}/${d.name}` : d.name);
        } else {
          this.rejected.push({ code: "special_entry", severity: "warning", message: "Not a regular file", sourcePath: path });
        }
      }
    };
    await walk("");
    this.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Source paths are NFC; on-disk names may be NFD (e.g. older macOS volumes). */
  private readonly diskNames = new Map<string, string>();

  /**
   * Opens a scanned file for reading: re-checks every ancestor for symlinks,
   * opens with O_NOFOLLOW (and O_NONBLOCK so a FIFO swapped in cannot block),
   * and requires a regular file within `maxEntryBytes`. Shared by `read` and
   * `openReadStream` so both paths keep the same guarantees.
   */
  private async openChecked(path: string): Promise<{ handle: fs.FileHandle; size: number }> {
    const disk = this.diskNames.get(path);
    if (disk === undefined) throw new Error(`No source file ${path}`);
    const full = nodePath.join(this.location, ...disk.split("/"));
    if (!full.startsWith(this.location + nodePath.sep)) throw new Error(`Path escapes source root: ${path}`);
    // Re-check ancestors at read time in case the tree changed after the scan.
    let current = this.location;
    for (const segment of disk.split("/").slice(0, -1)) {
      current = nodePath.join(current, segment);
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symlinked directory in source path: ${path}`);
    }
    const handle = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`);
      if (stat.size > this.limits.maxEntryBytes) throw new ArchiveRejectedError("entry_too_large", `File "${path}" grew beyond ${this.limits.maxEntryBytes} bytes`);
      return { handle, size: stat.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async read(path: string): Promise<Uint8Array> {
    const { handle, size } = await this.openChecked(path);
    try {
      // Reads at most the size seen at open time; a file that changes is caught by hash verification.
      const out = new Uint8Array(size);
      let filled = 0;
      while (filled < size) {
        const { bytesRead } = await handle.read(out, filled, size - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return filled === size ? out : out.subarray(0, filled);
    } finally {
      await handle.close();
    }
  }

  async *openReadStream(path: string): AsyncIterable<Uint8Array> {
    const { handle } = await this.openChecked(path);
    try {
      let total = 0;
      for (;;) {
        const chunk = new Uint8Array(STREAM_CHUNK);
        const { bytesRead } = await handle.read(chunk, 0, STREAM_CHUNK, total);
        if (bytesRead === 0) return;
        total += bytesRead;
        if (total > this.limits.maxEntryBytes) throw new ArchiveRejectedError("entry_too_large", `File "${path}" grew beyond ${this.limits.maxEntryBytes} bytes`);
        yield bytesRead === STREAM_CHUNK ? chunk : chunk.subarray(0, bytesRead);
      }
    } finally {
      await handle.close();
    }
  }

  async close(): Promise<void> {}
}

export async function openDirectorySource(location: string, limits: Partial<ScanLimits> = {}): Promise<ImportSource> {
  const root = await fs.realpath(nodePath.resolve(location));
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new ArchiveRejectedError("not_a_directory", `${location} is not a directory`);
  const source = new DirectorySource(root, { ...DEFAULT_LIMITS, ...limits });
  await source.scan();
  return source;
}
