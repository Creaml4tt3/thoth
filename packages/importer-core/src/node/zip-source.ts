import { constants, rmSync } from "node:fs";
import { chmod, lstat, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { checkRelativePath, type ImportWarning } from "@thoth/domain";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { ArchiveRejectedError, DEFAULT_LIMITS, type ScanLimits } from "../limits.ts";
import { ImportCancelledError } from "../pipeline.ts";
import { CompositeSource, isNoiseEntry, type ImportSource, type SourceEntry } from "../source.ts";

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const READ_CHUNK = 64 * 1024;

/** Shared byte/entry budget so multi-part archives cannot bypass limits. */
interface Budget {
  entries: number;
  bytes: number;
  compressed: number;
}

function inRange(start: number, end: number, limit: number): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && end <= limit;
}

async function readFully(handle: FileHandle, buffer: Uint8Array, offset: number, length: number, position: number): Promise<number> {
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, offset + done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return done;
}

async function writeFully(handle: FileHandle, data: Uint8Array, position: number): Promise<void> {
  let done = 0;
  while (done < data.length) {
    const { bytesWritten } = await handle.write(data, done, data.length - done, position + done);
    done += bytesWritten;
  }
}

/** Sequential positional reads of [start, end) from a file handle. */
class RangeStream extends Readable {
  private readonly handle: FileHandle;
  private position: number;
  private readonly end: number;

  constructor(handle: FileHandle, start: number, end: number) {
    super();
    this.handle = handle;
    this.position = start;
    this.end = end;
  }

  override _read(size: number): void {
    const n = Math.min(size, READ_CHUNK, this.end - this.position);
    if (n <= 0) {
      this.push(null);
      return;
    }
    const chunk = Buffer.allocUnsafe(n);
    this.handle.read(chunk, 0, n, this.position).then(
      ({ bytesRead }) => {
        if (this.destroyed) return;
        if (bytesRead === 0) {
          this.destroy(new Error("Unexpected end of archive file"));
          return;
        }
        this.position += bytesRead;
        this.push(bytesRead === n ? chunk : chunk.subarray(0, bytesRead));
      },
      (error: Error) => this.destroy(error),
    );
  }
}

/**
 * yauzl reader over the byte range [base, base + length) of an open file.
 * Every read is bounds-checked against that range, so an archive opened
 * through it — including a nested part read in place — never sees a byte
 * outside it. The file handle belongs to `ZipResources`, never to yauzl.
 */
class FileRangeReader extends yauzl.RandomAccessReader {
  readonly handle: FileHandle;
  readonly base: number;
  readonly length: number;

  constructor(handle: FileHandle, base: number, length: number) {
    super();
    this.handle = handle;
    this.base = base;
    this.length = length;
  }

  /** A reader confined to a sub-range of this one (a STORED nested part). */
  slice(start: number, length: number): FileRangeReader {
    if (!inRange(start, start + length, this.length)) throw new ArchiveRejectedError("malformed_zip", "Nested archive lies outside its parent archive");
    return new FileRangeReader(this.handle, this.base + start, length);
  }

  override _readStreamForRange(start: number, end: number): Readable {
    if (!inRange(start, end, this.length)) {
      const failed = new Readable({ read() {} });
      setImmediate(() => failed.destroy(new Error("Read outside archive bounds")));
      return failed;
    }
    return new RangeStream(this.handle, this.base + start, this.base + end);
  }

  // yauzl expects `bytesRead` as a second callback argument to detect short reads.
  override read(buffer: Buffer, offset: number, length: number, position: number, callback: (err: Error | null, bytesRead?: number) => void): void {
    if (!inRange(position, position + length, this.length) || !inRange(offset, offset + length, buffer.length)) {
      setImmediate(() => callback(new Error("Read outside archive bounds")));
      return;
    }
    readFully(this.handle, buffer, offset, length, this.base + position).then(
      (bytesRead) => callback(null, bytesRead),
      (error: Error) => callback(error),
    );
  }

  override close(callback: (err: Error | null) => void): void {
    setImmediate(() => callback(null));
  }
}

// Last-resort cleanup if the process exits without close() (SIGKILL still leaks; see report).
const liveTempDirs = new Set<string>();
let exitHookInstalled = false;
function trackTempDir(dir: string): void {
  liveTempDirs.add(dir);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const d of liveTempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });
}

/**
 * Owns every file handle and the private temp directory of one opened archive.
 * Temp files are created O_EXCL|O_NOFOLLOW, 0600, inside a fresh 0700 mkdtemp
 * directory, and are only ever read back through the handle that wrote them,
 * so nothing can be substituted between extraction and reading.
 */
class ZipResources {
  private readonly tempRoot: string;
  private readonly handles: FileHandle[] = [];
  private tempDir: string | undefined;
  private tempFiles = 0;
  private released = false;

  constructor(tempRoot: string) {
    this.tempRoot = tempRoot;
  }

  async openArchive(location: string): Promise<FileRangeReader> {
    const handle = await open(location, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    this.handles.push(handle);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ArchiveRejectedError("malformed_zip", `${basename(location)} is not a regular file`);
    return new FileRangeReader(handle, 0, stat.size);
  }

  async createTempFile(): Promise<FileHandle> {
    if (this.released) throw new Error("Archive already closed");
    if (this.tempDir === undefined) {
      const dir = await mkdtemp(join(this.tempRoot, "thoth-import-"));
      this.tempDir = dir;
      trackTempDir(dir);
      await chmod(dir, 0o700);
      const stat = await lstat(dir);
      const privateDir = process.platform === "win32" || ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.());
      if (!stat.isDirectory() || !privateDir) throw new Error("Import temp directory is not private");
    }
    const file = join(this.tempDir, `part-${++this.tempFiles}.zip`);
    const handle = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    this.handles.push(handle);
    return handle;
  }

  /** Closes every handle and deletes the temp directory. Idempotent. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    for (const handle of this.handles.splice(0)) await handle.close().catch(() => undefined);
    const dir = this.tempDir;
    if (dir === undefined) return;
    await rm(dir, { recursive: true, force: true });
    liveTempDirs.delete(dir);
  }
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
  private readonly reader: FileRangeReader;
  private readonly limits: ScanLimits;
  private resources: ZipResources | undefined;

  constructor(label: string, location: string, zip: ZipFile, reader: FileRangeReader, limits: ScanLimits) {
    this.label = label;
    this.location = location;
    this.zip = zip;
    this.reader = reader;
    this.limits = limits;
  }

  /** Makes this source responsible for releasing the archive's handles on close(). */
  adopt(resources: ZipResources): this {
    this.resources = resources;
    return this;
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

  async *openReadStream(path: string): AsyncIterable<Uint8Array> {
    const entry = this.byPath.get(path);
    if (!entry) throw new Error(`No archive entry ${path}`);
    // yauzl validates the actual inflated size against the declared size.
    const stream = await this.zip.openReadStreamPromise(entry);
    try {
      let total = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > this.limits.maxEntryBytes) throw new ArchiveRejectedError("entry_too_large", `Entry "${path}" inflates beyond the limit`);
        yield chunk;
      }
    } finally {
      stream.destroy();
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
   * in place through a reader confined to its byte range; a compressed part is
   * inflated to a private temp file (bounded by `cap`) and read from there.
   */
  async nestedReader(path: string, resources: ZipResources, cap: number, signal: AbortSignal | undefined): Promise<FileRangeReader> {
    const entry = this.byPath.get(path);
    if (!entry) throw new Error(`No archive entry ${path}`);
    if (entry.compressionMethod === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) throw new ArchiveRejectedError("malformed_zip", `Stored entry "${path.slice(0, 200)}" has inconsistent sizes`);
      const { fileDataStart } = await this.zip.readLocalFileHeaderPromise(entry, { minimal: true });
      return this.reader.slice(fileDataStart, entry.compressedSize);
    }
    const handle = await resources.createTempFile();
    let size = 0;
    try {
      for await (const chunk of this.openReadStream(path)) {
        if (signal?.aborted) throw new ImportCancelledError();
        size += chunk.length;
        if (size > cap) throw new ArchiveRejectedError("nested_archive_too_large", `Nested archive "${path.slice(0, 200)}" inflates beyond ${cap} bytes`);
        await writeFully(handle, chunk, size - chunk.length);
      }
    } catch (error) {
      // Filesystem errors (ENOSPC, EIO…) and our own rejections keep their identity; inflate errors mean a bad archive.
      if ((error as { code?: unknown }).code !== undefined) throw error;
      malformed(error);
    }
    if (size !== entry.uncompressedSize) throw new ArchiveRejectedError("malformed_zip", `Nested archive "${path.slice(0, 200)}" is shorter than declared`);
    return new FileRangeReader(handle, 0, size);
  }

  async close(): Promise<void> {
    this.zip.close();
    await this.resources?.release();
  }
}

/** A multi-part archive: closing it closes every part, then releases handles and temp files. */
class MultiPartZipSource extends CompositeSource {
  private readonly resources: ZipResources;

  constructor(label: string, location: string, parts: ImportSource[], rejected: ImportWarning[], resources: ZipResources) {
    super(label, location, parts, rejected);
    this.resources = resources;
  }

  override async close(): Promise<void> {
    try {
      await super.close();
    } finally {
      await this.resources.release();
    }
  }
}

const OPTIONS = { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true, strictFileNames: false } as const;

async function openZip(label: string, location: string, reader: FileRangeReader, limits: ScanLimits, budget: Budget): Promise<ZipSource> {
  const zip = await yauzl.fromRandomAccessReaderPromise(reader, reader.length, OPTIONS).catch(malformed);
  const source = new ZipSource(label, location, zip, reader, limits);
  try {
    await source.scan(budget);
  } catch (error) {
    await source.close();
    malformed(error);
  }
  return source;
}

function malformed(error: unknown): never {
  if (error instanceof ArchiveRejectedError || error instanceof ImportCancelledError) throw error;
  throw new ArchiveRejectedError("malformed_zip", `Not a readable ZIP archive: ${(error as Error).message}`);
}

export interface ZipSourceOptions {
  /** Parent directory for the private temp directory of compressed nested parts (default: `os.tmpdir()`). */
  tempRoot?: string;
  /** Cancels opening, e.g. while a large part is being extracted. Temp files are removed. */
  signal?: AbortSignal;
}

/**
 * Opens a ZIP file read-only. When the archive contains only nested ZIPs
 * (e.g. a multi-part export) and nesting is allowed, those are opened as parts
 * of one combined source, sharing the same limits budget. Memory use does not
 * grow with part size: parts are read in place or from a private temp file.
 */
export async function openZipSource(location: string, limits: Partial<ScanLimits> = {}, options: ZipSourceOptions = {}): Promise<ImportSource> {
  const effective = { ...DEFAULT_LIMITS, ...limits };
  const budget: Budget = { entries: 0, bytes: 0, compressed: 0 };
  const resources = new ZipResources(options.tempRoot ?? tmpdir());
  const parts: ZipSource[] = [];
  let outer: ZipSource | undefined;
  try {
    const reader = await resources.openArchive(location).catch(malformed);
    outer = await openZip(basename(location), location, reader, effective, budget);
    const nested = outer.entries.filter((e) => e.path.toLowerCase().endsWith(".zip"));
    if (effective.maxNestingDepth < 1 || nested.length === 0 || nested.length !== outer.entries.length) return outer.adopt(resources);

    const cap = Math.min(effective.maxEntryBytes, effective.maxNestedArchiveBytes);
    for (const entry of nested) {
      if (options.signal?.aborted) throw new ImportCancelledError();
      if (entry.size > cap)
        throw new ArchiveRejectedError("nested_archive_too_large", `Nested archive "${entry.path.slice(0, 200)}" exceeds ${cap} bytes; raise maxNestedArchiveBytes to import it`);
      const partReader = await outer.nestedReader(entry.path, resources, cap, options.signal);
      const part = await openZip(entry.path, `${location}!/${entry.path}`, partReader, { ...effective, maxNestingDepth: 0 }, budget);
      parts.push(part);
      if (part.entries.some((e) => e.path.toLowerCase().endsWith(".zip")))
        part.rejected.push({ code: "nested_archive", severity: "warning", message: "Archives nested more than one level deep are not opened", sourcePath: entry.path });
    }
    await outer.close();
    return new MultiPartZipSource(basename(location), location, parts, [...outer.rejected], resources);
  } catch (error) {
    for (const part of parts) await part.close().catch(() => undefined);
    await outer?.close().catch(() => undefined);
    await resources.release();
    throw error;
  }
}
