import { basename } from "node:path";
import { checkRelativePath, type ImportWarning } from "@thoth/domain";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { ArchiveRejectedError, DEFAULT_LIMITS, type ScanLimits } from "../limits.ts";
import { CompositeSource, isNoiseEntry, type ImportSource, type SourceEntry } from "../source.ts";

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

/**
 * ZIP source that inspects every entry before anything is read (spec §7.2).
 * Entries are streamed on demand straight from the archive and are never
 * extracted to disk by the scanner, so unsafe names cannot escape anywhere.
 */
class ZipSource implements ImportSource {
  readonly label: string;
  readonly location: string;
  readonly entries: SourceEntry[] = [];
  readonly rejected: ImportWarning[] = [];
  private readonly byPath = new Map<string, Entry>();
  private readonly zip: ZipFile;
  private readonly limits: ScanLimits;

  constructor(label: string, location: string, zip: ZipFile, limits: ScanLimits) {
    this.label = label;
    this.location = location;
    this.zip = zip;
    this.limits = limits;
  }

  async scan(budget: Budget): Promise<void> {
    const seen = new Set<string>();
    for await (const entry of this.zip.eachEntry()) {
      if (++budget.entries > this.limits.maxEntries)
        throw new ArchiveRejectedError("too_many_entries", `Archive has more than ${this.limits.maxEntries} entries`);
      const raw = yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileName as unknown as Buffer, entry.extraFields, false);
      const isDir = raw.endsWith("/");
      const name = isDir ? raw.slice(0, -1) : raw;
      const reject = (code: string, message: string) =>
        this.rejected.push({ code, severity: "error", message, sourcePath: name.slice(0, 300) });

      const problem = checkRelativePath(name);
      if (problem) {
        reject("unsafe_path", `Rejected archive entry: ${problem}`);
        continue;
      }
      const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
      if (mode === S_IFLNK) {
        reject("symlink_entry", "Rejected symbolic link entry");
        continue;
      }
      if (isDir || mode === S_IFDIR) continue;
      if (mode !== 0 && mode !== S_IFREG) {
        reject("special_entry", "Rejected non-regular file entry");
        continue;
      }
      if (entry.isEncrypted()) {
        reject("encrypted_entry", "Encrypted entries are not supported");
        continue;
      }
      if (entry.uncompressedSize > this.limits.maxEntryBytes) {
        reject("entry_too_large", `Entry exceeds ${this.limits.maxEntryBytes} bytes`);
        continue;
      }
      if (
        entry.uncompressedSize > this.limits.ratioThresholdBytes &&
        entry.uncompressedSize / Math.max(entry.compressedSize, 1) > this.limits.maxCompressionRatio
      ) {
        throw new ArchiveRejectedError("compression_ratio", `Suspicious compression ratio for entry "${name.slice(0, 200)}"`);
      }
      budget.bytes += entry.uncompressedSize;
      budget.compressed += entry.compressedSize;
      if (budget.bytes > this.limits.maxTotalBytes)
        throw new ArchiveRejectedError("too_large", `Archive expands beyond ${this.limits.maxTotalBytes} bytes`);
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

  async read(path: string): Promise<Uint8Array> {
    const entry = this.byPath.get(path);
    if (!entry) throw new Error(`No archive entry ${path}`);
    // yauzl validates the actual inflated size against the declared size.
    const stream = await this.zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > this.limits.maxEntryBytes) {
        stream.destroy();
        throw new ArchiveRejectedError("entry_too_large", `Entry "${path}" inflates beyond the limit`);
      }
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  async close(): Promise<void> {
    this.zip.close();
  }
}

const OPTIONS = { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true, strictFileNames: false } as const;

async function openZip(label: string, location: string, zip: ZipFile, limits: ScanLimits, budget: Budget): Promise<ZipSource> {
  const source = new ZipSource(label, location, zip, limits);
  try {
    await source.scan(budget);
  } catch (error) {
    await source.close();
    throw error;
  }
  return source;
}

function malformed(error: unknown): never {
  if (error instanceof ArchiveRejectedError) throw error;
  throw new ArchiveRejectedError("malformed_zip", `Not a readable ZIP archive: ${(error as Error).message}`);
}

/**
 * Opens a ZIP file read-only. When the archive contains only nested ZIPs
 * (e.g. a multi-part export) and nesting is allowed, those are opened as parts
 * of one combined source, sharing the same limits budget.
 */
export async function openZipSource(location: string, limits: Partial<ScanLimits> = {}): Promise<ImportSource> {
  const effective = { ...DEFAULT_LIMITS, ...limits };
  const budget: Budget = { entries: 0, bytes: 0, compressed: 0 };
  const zip = await yauzl.openPromise(location, OPTIONS).catch(malformed);
  const outer = await openZip(basename(location), location, zip, effective, budget).catch(malformed);
  const nested = outer.entries.filter((e) => e.path.toLowerCase().endsWith(".zip"));
  if (effective.maxNestingDepth < 1 || nested.length === 0 || nested.length !== outer.entries.length) return outer;

  const parts: ImportSource[] = [];
  try {
    for (const entry of nested) {
      const bytes = await outer.read(entry.path);
      const inner = await yauzl.fromBufferPromise(Buffer.from(bytes), OPTIONS).catch(malformed);
      const part = await openZip(entry.path, `${location}!/${entry.path}`, inner, { ...effective, maxNestingDepth: 0 }, budget).catch(malformed);
      if (part.entries.some((e) => e.path.toLowerCase().endsWith(".zip")))
        part.rejected.push({ code: "nested_archive", severity: "warning", message: "Archives nested more than one level deep are not opened", sourcePath: entry.path });
      parts.push(part);
    }
  } catch (error) {
    for (const part of parts) await part.close();
    await outer.close();
    throw error;
  }
  await outer.close();
  return new CompositeSource(basename(location), location, parts, [...outer.rejected]);
}
