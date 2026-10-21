import { checkRelativePath, type ImportWarning } from "@thoth/domain";
import { ArchiveRejectedError, DEFAULT_LIMITS, type ScanLimits } from "./limits.ts";
import { ImportCancelledError } from "./pipeline.ts";
import type { SourceHost } from "./ports.ts";
import { CompositeSource, isNoiseEntry, type ImportSource, type SourceEntry } from "./source.ts";
import { ByteRange, METHOD_DEFLATE, METHOD_STORED, ZipReader, type ZipEntry } from "./zip/index.ts";

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/** Shared byte/entry budget so multi-part archives cannot bypass limits. */
interface Budget {
  entries: number;
  bytes: number;
  compressed: number;
}

/** Any failure that is not already a deliberate rejection or a cancellation means the archive is unreadable. */
export function malformed(error: unknown): never {
  if (error instanceof ArchiveRejectedError || error instanceof ImportCancelledError) throw error;
  throw new ArchiveRejectedError("malformed_zip", `Not a readable ZIP archive: ${(error as Error)?.message ?? String(error)}`);
}

/**
 * One ZIP (the outer archive or a nested part) after a secure scan of its
 * central directory (spec §7.2). Entries are streamed on demand straight from
 * the archive bytes and are never extracted by the scanner, so unsafe names
 * cannot escape anywhere. It owns no handles: the `SourceHost` does.
 */
class ArchivePart implements ImportSource {
  readonly label: string;
  readonly location: string;
  readonly entries: SourceEntry[] = [];
  readonly rejected: ImportWarning[] = [];
  private readonly byPath = new Map<string, ZipEntry>();
  private readonly zip: ZipReader;
  private readonly limits: ScanLimits;

  constructor(label: string, location: string, zip: ZipReader, limits: ScanLimits) {
    this.label = label;
    this.location = location;
    this.zip = zip;
    this.limits = limits;
  }

  async scan(budget: Budget): Promise<void> {
    const seen = new Set<string>();
    for await (const entry of this.zip.entries()) {
      if (++budget.entries > this.limits.maxEntries)
        throw new ArchiveRejectedError("too_many_entries", `Archive has more than ${this.limits.maxEntries} entries`);
      const name = entry.isDirectory ? entry.name.slice(0, -1) : entry.name;
      const reject = (code: string, message: string) => this.rejected.push({ code, severity: "error", message, sourcePath: name.slice(0, 300) });

      const problem = checkRelativePath(name);
      if (problem) {
        reject("unsafe_path", `Rejected archive entry: ${problem}`);
        continue;
      }
      const type = entry.mode & S_IFMT;
      if (type === S_IFLNK) {
        reject("symlink_entry", "Rejected symbolic link entry");
        continue;
      }
      if (entry.isDirectory || type === S_IFDIR) continue;
      if (type !== 0 && type !== S_IFREG) {
        reject("special_entry", "Rejected non-regular file entry");
        continue;
      }
      if (entry.encrypted) {
        reject("encrypted_entry", "Encrypted entries are not supported");
        continue;
      }
      if (entry.compressionMethod !== METHOD_STORED && entry.compressionMethod !== METHOD_DEFLATE) {
        reject("unsupported_compression", `Compression method ${entry.compressionMethod} is not supported (only STORED and DEFLATE)`);
        continue;
      }
      if (entry.uncompressedSize > this.limits.maxEntryBytes) {
        reject("entry_too_large", `Entry exceeds ${this.limits.maxEntryBytes} bytes`);
        continue;
      }
      if (entry.uncompressedSize > this.limits.ratioThresholdBytes && entry.uncompressedSize / Math.max(entry.compressedSize, 1) > this.limits.maxCompressionRatio) {
        throw new ArchiveRejectedError("compression_ratio", `Suspicious compression ratio for entry "${name.slice(0, 200)}"`);
      }
      budget.bytes += entry.uncompressedSize;
      budget.compressed += entry.compressedSize;
      if (budget.bytes > this.limits.maxTotalBytes) throw new ArchiveRejectedError("too_large", `Archive expands beyond ${this.limits.maxTotalBytes} bytes`);
      if (budget.bytes > this.limits.archiveRatioThresholdBytes && budget.bytes / Math.max(budget.compressed, 1) > this.limits.maxArchiveRatio)
        throw new ArchiveRejectedError("compression_ratio", "Suspicious overall compression ratio for the archive");

      const path = name.normalize("NFC");
      if (isNoiseEntry(path)) continue;
      if (seen.has(path)) {
        reject("duplicate_entry", "Duplicate entry name in archive");
        continue;
      }
      seen.add(path);
      this.byPath.set(path, entry);
      this.entries.push({ path, size: entry.uncompressedSize });
    }
    this.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async *openReadStream(path: string): AsyncIterable<Uint8Array> {
    const entry = this.byPath.get(path);
    if (!entry) throw new Error(`No archive entry ${path}`);
    // The reader holds inflated output to the declared size (≤ maxEntryBytes) and verifies CRC-32.
    let total = 0;
    for await (const chunk of this.zip.openStream(entry)) {
      total += chunk.length;
      if (total > this.limits.maxEntryBytes) throw new ArchiveRejectedError("entry_too_large", `Entry "${path}" inflates beyond the limit`);
      yield chunk;
    }
  }

  async read(path: string): Promise<Uint8Array> {
    const entry = this.byPath.get(path);
    if (!entry) throw new Error(`No archive entry ${path}`);
    // One allocation of the declared size (already ≤ maxEntryBytes); never more.
    const out = new Uint8Array(entry.uncompressedSize);
    let filled = 0;
    for await (const chunk of this.openReadStream(path)) {
      if (filled + chunk.length > out.length) throw new ArchiveRejectedError("entry_too_large", `Entry "${path}" inflates beyond its declared size`);
      out.set(chunk, filled);
      filled += chunk.length;
    }
    if (filled !== out.length) throw new ArchiveRejectedError("malformed_zip", `Entry "${path}" is shorter than its declared size`);
    return out;
  }

  /**
   * Opens a nested archive entry without buffering it. A STORED part is read
   * in place through a range confined to its bytes; a compressed part is
   * inflated to a private host temp file (bounded by `cap`) and read from there.
   */
  async nestedRange(path: string, host: SourceHost, cap: number, signal: AbortSignal | undefined): Promise<ByteRange> {
    const entry = this.byPath.get(path);
    if (!entry) throw new Error(`No archive entry ${path}`);
    if (entry.compressionMethod === METHOD_STORED) return this.zip.storedRange(entry);
    const temp = await host.createTemp();
    let size = 0;
    try {
      for await (const chunk of this.openReadStream(path)) {
        if (signal?.aborted) throw new ImportCancelledError();
        size += chunk.length;
        if (size > cap) throw new ArchiveRejectedError("nested_archive_too_large", `Nested archive "${path.slice(0, 200)}" inflates beyond ${cap} bytes`);
        await temp.write(size - chunk.length, chunk);
      }
    } catch (error) {
      // Host errors (ENOSPC, EIO…) and our own rejections keep their identity; inflate errors mean a bad archive.
      if ((error as { code?: unknown } | undefined)?.code !== undefined) throw error;
      malformed(error);
    }
    if (size !== entry.uncompressedSize) throw new ArchiveRejectedError("malformed_zip", `Nested archive "${path.slice(0, 200)}" is shorter than declared`);
    // The temp file's size at open was 0; the range is bounded by what was written, never by the file.
    return new ByteRange(temp, 0, size);
  }

  async close(): Promise<void> {}
}

/** The source handed to callers: closing it closes the host, which releases every handle and temp file. */
class HostedSource implements ImportSource {
  private readonly inner: ImportSource;
  private readonly host: SourceHost;
  private closed: Promise<void> | undefined;

  constructor(inner: ImportSource, host: SourceHost) {
    this.inner = inner;
    this.host = host;
  }

  get label(): string {
    return this.inner.label;
  }
  get location(): string {
    return this.inner.location;
  }
  get entries(): readonly SourceEntry[] {
    return this.inner.entries;
  }
  get rejected(): readonly ImportWarning[] {
    return this.inner.rejected;
  }
  read(path: string): Promise<Uint8Array> {
    return this.inner.read(path);
  }
  openReadStream(path: string): AsyncIterable<Uint8Array> {
    return this.inner.openReadStream(path);
  }

  close(): Promise<void> {
    this.closed ??= (async () => {
      try {
        await this.inner.close();
      } finally {
        await this.host.close();
      }
    })();
    return this.closed;
  }
}

/** Wraps an opened source so closing it also closes the host; on a failed open, closes the host and rethrows. */
export async function hosted(host: SourceHost, open: () => Promise<ImportSource>): Promise<ImportSource> {
  try {
    return new HostedSource(await open(), host);
  } catch (error) {
    await host.close().catch(() => undefined);
    throw error;
  }
}

async function openPart(label: string, location: string, range: ByteRange, limits: ScanLimits, budget: Budget): Promise<ArchivePart> {
  try {
    const part = new ArchivePart(label, location, await ZipReader.open(range), limits);
    await part.scan(budget);
    return part;
  } catch (error) {
    malformed(error);
  }
}

export interface ArchiveSourceOptions {
  /** Cancels opening, e.g. while a large part is being extracted. Temp files are removed with the host. */
  signal?: AbortSignal;
}

/**
 * Opens a ZIP archive through a file `SourceHost`, read-only. When the archive
 * contains only nested ZIPs (e.g. a Notion multi-part export) and nesting is
 * allowed, those are opened as parts of one combined source sharing the same
 * limits budget. Memory use does not grow with part size: STORED parts are
 * read in place and compressed parts are inflated to a host temp file.
 *
 * Takes ownership of `host`: it is closed when the returned source is closed,
 * or immediately if opening fails.
 */
export function openArchiveSource(host: SourceHost, limits: Partial<ScanLimits> = {}, options: ArchiveSourceOptions = {}): Promise<ImportSource> {
  return hosted(host, async () => {
    if (host.rootKind !== "file") throw new ArchiveRejectedError("malformed_zip", `${host.label} is not a regular file`);
    const effective = { ...DEFAULT_LIMITS, ...limits };
    const budget: Budget = { entries: 0, bytes: 0, compressed: 0 };
    const file = await host.open("").catch(malformed);
    const outer = await openPart(host.label, host.location, ByteRange.of(file), effective, budget);
    const nested = outer.entries.filter((e) => e.path.toLowerCase().endsWith(".zip"));
    if (effective.maxNestingDepth < 1 || nested.length === 0 || nested.length !== outer.entries.length) return outer;

    const cap = Math.min(effective.maxEntryBytes, effective.maxNestedArchiveBytes);
    const parts: ArchivePart[] = [];
    for (const entry of nested) {
      if (options.signal?.aborted) throw new ImportCancelledError();
      if (entry.size > cap)
        throw new ArchiveRejectedError("nested_archive_too_large", `Nested archive "${entry.path.slice(0, 200)}" exceeds ${cap} bytes; raise maxNestedArchiveBytes to import it`);
      const range = await outer.nestedRange(entry.path, host, cap, options.signal);
      const part = await openPart(entry.path, `${host.location}!/${entry.path}`, range, { ...effective, maxNestingDepth: 0 }, budget);
      parts.push(part);
      if (part.entries.some((e) => e.path.toLowerCase().endsWith(".zip")))
        part.rejected.push({ code: "nested_archive", severity: "warning", message: "Archives nested more than one level deep are not opened", sourcePath: entry.path });
    }
    return new CompositeSource(host.label, host.location, parts, [...outer.rejected]);
  });
}
