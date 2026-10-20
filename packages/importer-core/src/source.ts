import type { ImportWarning } from "@thoth/domain";

/** One regular file in an import source, addressed by its normalized source path. */
export interface SourceEntry {
  path: string;
  size: number;
}

/**
 * Read-only view of an import source after a secure scan. Implementations
 * never write to, move, or delete anything in the source (spec §7.1.10).
 */
export interface ImportSource {
  /** Human-readable label, e.g. the ZIP file name. */
  readonly label: string;
  /** Absolute location used to re-open the source when resuming. */
  readonly location: string;
  readonly entries: readonly SourceEntry[];
  /** Entries rejected by the scan, with reasons. */
  readonly rejected: readonly ImportWarning[];
  read(path: string): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Combines several sources (e.g. Notion multi-part ZIPs) into one view. */
export class CompositeSource implements ImportSource {
  readonly label: string;
  readonly location: string;
  readonly entries: SourceEntry[];
  readonly rejected: ImportWarning[];
  private readonly parts: ImportSource[];
  private readonly owners = new Map<string, ImportSource>();

  constructor(label: string, location: string, parts: ImportSource[], extraRejected: ImportWarning[] = []) {
    this.label = label;
    this.location = location;
    this.parts = parts;
    this.entries = [];
    this.rejected = [...extraRejected];
    for (const part of parts) {
      this.rejected.push(...part.rejected);
      for (const entry of part.entries) {
        if (this.owners.has(entry.path)) {
          this.rejected.push({ code: "duplicate_entry", severity: "warning", message: `Duplicate path across archive parts; kept the first copy`, sourcePath: entry.path });
          continue;
        }
        this.owners.set(entry.path, part);
        this.entries.push(entry);
      }
    }
    this.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  read(path: string): Promise<Uint8Array> {
    const owner = this.owners.get(path);
    if (!owner) return Promise.reject(new Error(`No source entry ${path}`));
    return owner.read(path);
  }

  async close(): Promise<void> {
    for (const part of this.parts) await part.close();
  }
}

/** Entries that are OS or archiver noise rather than user content. */
export function isNoiseEntry(path: string): boolean {
  const segments = path.split("/");
  const base = segments[segments.length - 1]!;
  return segments[0] === "__MACOSX" || base === ".DS_Store" || base === "Thumbs.db" || base === "desktop.ini" || base.startsWith("._");
}

/**
 * When every entry shares a single top-level folder (a zipped vault folder),
 * returns that folder so it can be stripped from destination paths.
 */
export function commonRootFolder(paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const first = paths[0]!.split("/")[0]!;
  if (!paths.every((p) => p.includes("/") && p.split("/")[0] === first)) return undefined;
  return first;
}
