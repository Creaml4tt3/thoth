import type { ImportWarning } from "@thoth/domain";
import { hosted } from "./archive-source.ts";
import { ArchiveRejectedError, DEFAULT_LIMITS, type ScanLimits } from "./limits.ts";
import type { RandomAccessFile, SourceHost } from "./ports.ts";
import { isNoiseEntry, type ImportSource, type SourceEntry } from "./source.ts";

const STREAM_CHUNK = 64 * 1024;
/** Largest single host read when loading a whole file, so one IPC message stays bounded. */
const READ_CHUNK = 4 * 1024 * 1024;

/**
 * Read-only folder source over a directory `SourceHost`. Never follows
 * symlinks and never leaves the chosen root: listing and opening go through
 * the host, which refuses symlinks in any path component, opens non-blocking
 * and requires a regular file (spec §7.3, ADR-010).
 */
class FolderSource implements ImportSource {
  readonly label: string;
  readonly location: string;
  readonly entries: SourceEntry[] = [];
  readonly rejected: ImportWarning[] = [];
  private readonly host: SourceHost;
  private readonly limits: ScanLimits;
  /** Source paths are NFC; on-disk names may be NFD (e.g. older macOS volumes). */
  private readonly diskNames = new Map<string, string>();

  constructor(host: SourceHost, limits: ScanLimits) {
    this.host = host;
    this.label = host.label;
    this.location = host.location;
    this.limits = limits;
  }

  async scan(): Promise<void> {
    let total = 0;
    const walk = async (rel: string): Promise<void> => {
      for (const d of await this.host.list(rel)) {
        const disk = rel ? `${rel}/${d.name}` : d.name;
        const path = disk.normalize("NFC");
        if (d.kind === "symlink") {
          this.rejected.push({ code: "symlink_entry", severity: "warning", message: "Symbolic link not followed", sourcePath: path });
        } else if (d.kind === "directory") {
          await walk(disk);
        } else if (d.kind === "file") {
          if (isNoiseEntry(path)) continue;
          if (this.entries.length >= this.limits.maxEntries) throw new ArchiveRejectedError("too_many_entries", `Folder has more than ${this.limits.maxEntries} files`);
          if (d.size > this.limits.maxEntryBytes) {
            this.rejected.push({ code: "entry_too_large", severity: "error", message: `File exceeds ${this.limits.maxEntryBytes} bytes`, sourcePath: path });
            continue;
          }
          total += d.size;
          if (total > this.limits.maxTotalBytes) throw new ArchiveRejectedError("too_large", `Folder exceeds ${this.limits.maxTotalBytes} bytes`);
          this.entries.push({ path, size: d.size });
          this.diskNames.set(path, disk);
        } else {
          this.rejected.push({ code: "special_entry", severity: "warning", message: "Not a regular file", sourcePath: path });
        }
      }
    };
    await walk("");
    this.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Opens a scanned file through the host (which re-checks for symlinks) and requires it within `maxEntryBytes`. */
  private async openChecked(path: string): Promise<RandomAccessFile> {
    const disk = this.diskNames.get(path);
    if (disk === undefined) throw new Error(`No source file ${path}`);
    const file = await this.host.open(disk);
    if (file.size > this.limits.maxEntryBytes) {
      await file.close();
      throw new ArchiveRejectedError("entry_too_large", `File "${path}" grew beyond ${this.limits.maxEntryBytes} bytes`);
    }
    return file;
  }

  async read(path: string): Promise<Uint8Array> {
    const file = await this.openChecked(path);
    try {
      // Reads at most the size seen at open time; a file that changes is caught by hash verification.
      const out = new Uint8Array(file.size);
      let filled = 0;
      while (filled < out.length) {
        const chunk = await file.read(filled, Math.min(READ_CHUNK, out.length - filled));
        if (chunk.length === 0) break;
        const n = Math.min(chunk.length, out.length - filled);
        out.set(chunk.subarray(0, n), filled);
        filled += n;
      }
      return filled === out.length ? out : out.subarray(0, filled);
    } finally {
      await file.close();
    }
  }

  async *openReadStream(path: string): AsyncIterable<Uint8Array> {
    const file = await this.openChecked(path);
    try {
      let total = 0;
      for (;;) {
        const chunk = await file.read(total, STREAM_CHUNK);
        if (chunk.length === 0) return;
        if (chunk.length > STREAM_CHUNK) throw new Error("Source host returned more bytes than requested");
        total += chunk.length;
        if (total > this.limits.maxEntryBytes) throw new ArchiveRejectedError("entry_too_large", `File "${path}" grew beyond ${this.limits.maxEntryBytes} bytes`);
        yield chunk;
      }
    } finally {
      await file.close();
    }
  }

  async close(): Promise<void> {}
}

/**
 * Opens a folder through a directory `SourceHost`. Takes ownership of `host`:
 * it is closed when the returned source is closed, or immediately if the scan fails.
 */
export function openFolderSource(host: SourceHost, limits: Partial<ScanLimits> = {}): Promise<ImportSource> {
  return hosted(host, async () => {
    if (host.rootKind !== "directory") throw new ArchiveRejectedError("not_a_directory", `${host.label} is not a directory`);
    const source = new FolderSource(host, { ...DEFAULT_LIMITS, ...limits });
    await source.scan();
    return source;
  });
}
