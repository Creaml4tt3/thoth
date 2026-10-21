/**
 * Portable, defensive ZIP reader over a `RandomAccessFile` (ADR-008, ADR-010).
 *
 * No platform APIs: it runs in a webview as well as on Node. Inflation uses
 * the web-standard `DecompressionStream("deflate-raw")`. The parsing rules
 * follow yauzl (with `decodeStrings: false`, `validateEntrySizes: true`,
 * `strictFileNames: false`) so names and sizes are interpreted exactly as
 * before, but it is stricter wherever an archive is inconsistent:
 *
 * - every read is confined to the reader's byte range (`ByteRange`);
 * - the central directory must lie inside the range, before the end records,
 *   and contain exactly the declared number of entries, byte for byte;
 * - ZIP64 end records must agree with the classic record wherever it does not
 *   hold the 0xFFFF/0xFFFFFFFF marker, and ZIP64 extra fields are only used
 *   for fields that carry the marker;
 * - multi-disk archives are rejected;
 * - local-header regions may not overlap each other or the central directory,
 *   and each entry's data must end before the next entry starts;
 * - the local header must agree with the central directory (name bytes,
 *   method, encryption flag); sizes and CRC are taken from the central
 *   directory only, so data descriptors need no special handling;
 * - data is CRC-32 checked and inflated output is held to the declared size.
 *   The final chunk of an entry is only released after the CRC and size match,
 *   so a fully consumed stream never delivers unverified content.
 */
import type { RandomAccessFile } from "../ports.ts";
import { ArchiveRejectedError } from "../limits.ts";
import { decodeCp437 } from "./cp437.ts";
import { crc32 } from "./crc32.ts";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIZE = 56;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
/** Largest chunk read from the host or yielded to callers. */
export const ZIP_CHUNK = 64 * 1024;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const FLAG_MASKED_HEADERS = 0x2000;

export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;

/** A structural problem with the archive. Always `malformed_zip`. */
export class ZipFormatError extends ArchiveRejectedError {
  constructor(message: string) {
    super("malformed_zip", message);
    this.name = "ZipFormatError";
  }
}

function inRange(start: number, end: number, limit: number): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && end <= limit;
}

function u16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}

function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

function u64(b: Uint8Array, o: number): number {
  const high = u32(b, o + 4);
  // Anything above 2^53 cannot be a real offset or size in a file we can open.
  if (high > 0x1fffff) throw new ZipFormatError("64-bit ZIP field exceeds the supported range");
  return high * 0x1_0000_0000 + u32(b, o);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The byte range [base, base + length) of a file. Every read is checked
 * against the range before the host is asked for anything, so an archive
 * opened through it — including a nested part read in place — never sees a
 * byte outside it.
 */
export class ByteRange {
  readonly file: RandomAccessFile;
  readonly base: number;
  readonly length: number;

  constructor(file: RandomAccessFile, base: number, length: number) {
    if (!inRange(base, base + length, Number.MAX_SAFE_INTEGER)) throw new ZipFormatError("Archive range is invalid");
    this.file = file;
    this.base = base;
    this.length = length;
  }

  /** The whole file, as sized when it was opened. */
  static of(file: RandomAccessFile): ByteRange {
    return new ByteRange(file, 0, file.size);
  }

  /** Reads exactly `length` bytes at `position` within the range. */
  async read(position: number, length: number): Promise<Uint8Array> {
    if (!inRange(position, position + length, this.length)) throw new ZipFormatError("Read outside archive bounds");
    if (length === 0) return new Uint8Array(0);
    const bytes = await this.file.read(this.base + position, length);
    if (bytes.length < length) throw new ZipFormatError("Unexpected end of archive file");
    if (bytes.length > length) throw new ZipFormatError("Archive host returned more bytes than requested");
    return bytes;
  }

  /** A range confined to a sub-range of this one (a STORED nested archive). */
  slice(start: number, length: number): ByteRange {
    if (!inRange(start, start + length, this.length)) throw new ZipFormatError("Nested archive lies outside its parent archive");
    return new ByteRange(this.file, this.base + start, length);
  }
}

/** One central-directory record, already cross-checked against ZIP64 data. */
export interface ZipEntry {
  /** Position in the central directory. */
  readonly index: number;
  /** Decoded like yauzl's `getFileNameLowLevel(…, strictFileNames = false)`: Unicode Path extra field, else UTF-8 or CP437; backslashes become "/". */
  readonly name: string;
  readonly rawName: Uint8Array;
  readonly isDirectory: boolean;
  readonly versionMadeBy: number;
  readonly generalPurposeBitFlag: number;
  readonly compressionMethod: number;
  /** Traditional PKWARE encryption. Never readable; the scan reports it. */
  readonly encrypted: boolean;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly externalFileAttributes: number;
  /** Unix mode from the high 16 bits of the external attributes (0 when absent). */
  readonly mode: number;
  readonly localHeaderOffset: number;
}

interface ExtraField {
  id: number;
  data: Uint8Array;
}

/** Same rules as yauzl's `parseExtraFields`. */
function parseExtraFields(raw: Uint8Array): ExtraField[] {
  const fields: ExtraField[] = [];
  let i = 0;
  while (i < raw.length - 3) {
    const id = u16(raw, i);
    const size = u16(raw, i + 2);
    const start = i + 4;
    const end = start + size;
    if (end > raw.length) throw new ZipFormatError("Extra field length exceeds the extra field buffer");
    fields.push({ id, data: raw.subarray(start, end) });
    i = end;
  }
  return fields;
}

const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** yauzl's `getFileNameLowLevel(flags, name, extraFields, false)`. */
function decodeName(flags: number, raw: Uint8Array, extras: readonly ExtraField[]): string {
  let name: string | undefined;
  for (const field of extras) {
    if (field.id !== 0x7075) continue;
    if (field.data.length < 6 || field.data[0] !== 1) continue;
    if (crc32(raw) !== u32(field.data, 1)) continue;
    name = utf8.decode(field.data.subarray(5));
    break;
  }
  name ??= flags & FLAG_UTF8 ? utf8.decode(raw) : decodeCp437(raw);
  return name.replace(/\\/g, "/");
}

/** Sequential reader over the central directory, bounded to it, in ≤ 64 KiB windows. */
class DirectoryCursor {
  private readonly range: ByteRange;
  private readonly end: number;
  position: number;
  private window: Uint8Array = new Uint8Array(0);
  private windowStart = 0;

  constructor(range: ByteRange, start: number, end: number) {
    this.range = range;
    this.position = start;
    this.end = end;
  }

  async take(length: number): Promise<Uint8Array> {
    if (this.position + length > this.end) throw new ZipFormatError("Central directory entry count disagrees with its size");
    const offset = this.position - this.windowStart;
    if (offset < 0 || offset + length > this.window.length) {
      this.windowStart = this.position;
      this.window = await this.range.read(this.position, Math.min(Math.max(length, ZIP_CHUNK), this.end - this.position));
    }
    const at = this.position - this.windowStart;
    this.position += length;
    return this.window.subarray(at, at + length);
  }
}

export class ZipReader {
  readonly range: ByteRange;
  readonly entryCount: number;
  readonly centralDirectoryOffset: number;
  readonly centralDirectorySize: number;
  private iterated = false;
  /** Per entry index: the offset its local record must end before. Set once the whole directory has been read and checked. */
  private slots: number[] | undefined;

  private constructor(range: ByteRange, cdOffset: number, cdSize: number, entryCount: number) {
    this.range = range;
    this.centralDirectoryOffset = cdOffset;
    this.centralDirectorySize = cdSize;
    this.entryCount = entryCount;
  }

  /** Locates and validates the end records. Reads at most ~64 KiB plus the ZIP64 record. */
  static async open(range: ByteRange): Promise<ZipReader> {
    const size = range.length;
    const windowSize = Math.min(ZIP64_LOCATOR_SIZE + EOCD_SIZE + MAX_COMMENT, size);
    const windowStart = size - windowSize;
    const tail = await range.read(windowStart, windowSize);
    for (let i = windowSize - EOCD_SIZE; i >= 0; i--) {
      if (u32(tail, i) !== EOCD_SIGNATURE) continue;
      // Like yauzl, the last signature wins and its comment must reach exactly to the end of the file.
      const commentLength = u16(tail, i + 20);
      if (commentLength !== windowSize - i - EOCD_SIZE)
        throw new ZipFormatError("Invalid end of central directory comment length (extra bytes after the archive, or a signature inside the comment)");
      // Reject rather than guess when an earlier record would be equally valid (an end record hidden in the comment).
      for (let j = i - 1; j >= 0; j--)
        if (u32(tail, j) === EOCD_SIGNATURE && j + EOCD_SIZE <= windowSize && u16(tail, j + 20) === windowSize - j - EOCD_SIZE)
          throw new ZipFormatError("Ambiguous end of central directory: another valid record precedes it in the comment");
      const eocdPosition = windowStart + i;
      let diskNumber = u16(tail, i + 4);
      let cdDisk = u16(tail, i + 6);
      let entriesOnDisk = u16(tail, i + 8);
      let entryCount = u16(tail, i + 10);
      let cdSize = u32(tail, i + 12);
      let cdOffset = u32(tail, i + 16);
      let directoryLimit = eocdPosition;

      if (i >= ZIP64_LOCATOR_SIZE && u32(tail, i - ZIP64_LOCATOR_SIZE) === ZIP64_LOCATOR_SIGNATURE) {
        const locator = i - ZIP64_LOCATOR_SIZE;
        const locatorPosition = eocdPosition - ZIP64_LOCATOR_SIZE;
        const recordDisk = u32(tail, locator + 4);
        const recordOffset = u64(tail, locator + 8);
        const totalDisks = u32(tail, locator + 16);
        if (recordDisk !== 0 || totalDisks > 1) throw new ZipFormatError("Multi-disk ZIP archives are not supported");
        if (!inRange(recordOffset, recordOffset + ZIP64_EOCD_SIZE, locatorPosition))
          throw new ZipFormatError("ZIP64 end of central directory record lies outside archive bounds");
        const record = await range.read(recordOffset, ZIP64_EOCD_SIZE);
        if (u32(record, 0) !== ZIP64_EOCD_SIGNATURE) throw new ZipFormatError("Invalid ZIP64 end of central directory record signature");
        const recordSize = u64(record, 4);
        if (recordSize < ZIP64_EOCD_SIZE - 12 || recordOffset + 12 + recordSize > locatorPosition)
          throw new ZipFormatError("ZIP64 end of central directory record has an invalid size");
        const disk64 = u32(record, 16);
        const cdDisk64 = u32(record, 20);
        const onDisk64 = u64(record, 24);
        const count64 = u64(record, 32);
        const size64 = u64(record, 40);
        const offset64 = u64(record, 48);
        if (disk64 !== 0 || cdDisk64 !== 0 || onDisk64 !== count64 || (diskNumber !== 0 && diskNumber !== 0xffff) || (cdDisk !== 0 && cdDisk !== 0xffff))
          throw new ZipFormatError("Multi-disk ZIP archives are not supported");
        // A classic field either carries the ZIP64 marker or must agree with the ZIP64 value.
        if (
          (entryCount !== 0xffff && entryCount !== count64) ||
          (entriesOnDisk !== 0xffff && entriesOnDisk !== onDisk64) ||
          (cdSize !== 0xffffffff && cdSize !== size64) ||
          (cdOffset !== 0xffffffff && cdOffset !== offset64)
        )
          throw new ZipFormatError("ZIP64 end of central directory disagrees with the end of central directory record");
        diskNumber = 0;
        cdDisk = 0;
        entriesOnDisk = onDisk64;
        entryCount = count64;
        cdSize = size64;
        cdOffset = offset64;
        directoryLimit = recordOffset;
      }

      if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== entryCount) throw new ZipFormatError("Multi-disk ZIP archives are not supported");
      if (!inRange(cdOffset, cdOffset + cdSize, directoryLimit)) throw new ZipFormatError("Central directory lies outside archive bounds");
      if (entryCount * CENTRAL_SIZE > cdSize) throw new ZipFormatError("Central directory entry count disagrees with its size");
      return new ZipReader(range, cdOffset, cdSize, entryCount);
    }
    throw new ZipFormatError("End of central directory record not found; not a ZIP archive, or the file is truncated");
  }

  /**
   * Walks the central directory once, lazily, so callers can enforce entry
   * limits as they go. When the walk completes, the layout (no overlapping
   * local records, nothing overlapping the directory, no bytes left over) is
   * checked; entry data can only be read after that.
   */
  async *entries(): AsyncGenerator<ZipEntry, void, undefined> {
    if (this.iterated) throw new Error("ZipReader.entries() may only be called once");
    this.iterated = true;
    const cdEnd = this.centralDirectoryOffset + this.centralDirectorySize;
    const cursor = new DirectoryCursor(this.range, this.centralDirectoryOffset, cdEnd);
    const all: ZipEntry[] = [];
    for (let index = 0; index < this.entryCount; index++) {
      const h = await cursor.take(CENTRAL_SIZE);
      if (u32(h, 0) !== CENTRAL_SIGNATURE) throw new ZipFormatError(`Invalid central directory file header signature: 0x${u32(h, 0).toString(16)}`);
      const versionMadeBy = u16(h, 4);
      const flags = u16(h, 8);
      const method = u16(h, 10);
      const crc = u32(h, 16);
      let compressedSize = u32(h, 20);
      let uncompressedSize = u32(h, 24);
      const nameLength = u16(h, 28);
      const extraLength = u16(h, 30);
      const commentLength = u16(h, 32);
      const diskStart = u16(h, 34);
      const externalFileAttributes = u32(h, 38);
      let localHeaderOffset = u32(h, 42);
      if (diskStart !== 0 && diskStart !== 0xffff) throw new ZipFormatError("Multi-disk ZIP archives are not supported");

      const variable = await cursor.take(nameLength + extraLength + commentLength);
      const rawName = variable.slice(0, nameLength);
      const extras = parseExtraFields(variable.subarray(nameLength, nameLength + extraLength));

      // ZIP64 extended information: only fields holding the 0xFFFFFFFF marker are taken from it, in spec order.
      const zip64 = extras.find((field) => field.id === 0x0001);
      if (zip64) {
        let at = 0;
        const next = (what: string): number => {
          if (at + 8 > zip64.data.length) throw new ZipFormatError(`ZIP64 extra field does not include the ${what}`);
          const value = u64(zip64.data, at);
          at += 8;
          return value;
        };
        if (uncompressedSize === 0xffffffff) uncompressedSize = next("uncompressed size");
        if (compressedSize === 0xffffffff) compressedSize = next("compressed size");
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = next("local header offset");
        if (diskStart === 0xffff && (at + 4 > zip64.data.length || u32(zip64.data, at) !== 0)) throw new ZipFormatError("Multi-disk ZIP archives are not supported");
      } else if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff || diskStart === 0xffff) {
        // A ZIP64 marker with no ZIP64 field: the real value is unknown, so do not guess.
        throw new ZipFormatError("ZIP64 marker without a ZIP64 extra field");
      }

      // Like yauzl: strong (and central-directory) encryption makes the archive unreadable, not just the entry.
      if (flags & (FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADERS)) throw new ZipFormatError("Strong encryption is not supported");
      const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
      // yauzl's validateEntrySizes: STORED data is exactly the file (plus the 12-byte header of traditional encryption).
      if (method === METHOD_STORED && compressedSize !== uncompressedSize + (flags & FLAG_ENCRYPTED ? 12 : 0))
        throw new ZipFormatError(`Compressed/uncompressed size mismatch for stored file: ${compressedSize} != ${uncompressedSize}`);
      // The local record (header, name, data) must start before the central directory.
      if (localHeaderOffset + LOCAL_SIZE + nameLength + compressedSize > this.centralDirectoryOffset)
        throw new ZipFormatError("Entry data overlaps the central directory or lies outside archive bounds");

      const name = decodeName(flags, rawName, extras);
      const entry: ZipEntry = {
        index,
        name,
        rawName,
        isDirectory: name.endsWith("/"),
        versionMadeBy,
        generalPurposeBitFlag: flags,
        compressionMethod: method,
        encrypted,
        crc32: crc,
        compressedSize,
        uncompressedSize,
        externalFileAttributes,
        mode: externalFileAttributes >>> 16,
        localHeaderOffset,
      };
      all.push(entry);
      yield entry;
    }
    if (cursor.position !== cdEnd) throw new ZipFormatError("Central directory entry count disagrees with its size");
    this.slots = layout(all, this.centralDirectoryOffset);
  }

  /** Reads and checks the local header; returns the offset of the entry's data within the range. */
  async dataOffset(entry: ZipEntry): Promise<number> {
    const slotEnd = this.slots?.[entry.index];
    if (slotEnd === undefined) throw new Error("ZIP central directory has not been fully read and verified");
    const header = await this.range.read(entry.localHeaderOffset, LOCAL_SIZE + entry.rawName.length);
    if (u32(header, 0) !== LOCAL_SIGNATURE) throw new ZipFormatError(`Invalid local file header signature: 0x${u32(header, 0).toString(16)}`);
    const flags = u16(header, 6);
    const nameLength = u16(header, 26);
    const extraLength = u16(header, 28);
    if (nameLength !== entry.rawName.length || !sameBytes(header.subarray(LOCAL_SIZE), entry.rawName))
      throw new ZipFormatError("Local file header name disagrees with the central directory");
    if (u16(header, 8) !== entry.compressionMethod) throw new ZipFormatError("Local file header compression method disagrees with the central directory");
    if ((flags & FLAG_ENCRYPTED) !== (entry.generalPurposeBitFlag & FLAG_ENCRYPTED)) throw new ZipFormatError("Local file header encryption flag disagrees with the central directory");
    // CRC and sizes come from the central directory only (the data is verified against them), so local
    // copies that differ — or are zero, with or without a data descriptor — cannot change what is read.
    const start = entry.localHeaderOffset + LOCAL_SIZE + nameLength + extraLength;
    if (start + entry.compressedSize > slotEnd) throw new ZipFormatError("Entry data overlaps the next entry or the central directory");
    return start;
  }

  /** The raw bytes of a STORED, unencrypted entry, as a range of this reader's file (no copy). */
  async storedRange(entry: ZipEntry): Promise<ByteRange> {
    if (entry.compressionMethod !== METHOD_STORED || entry.encrypted) throw new ZipFormatError("Entry is not stored uncompressed");
    return this.range.slice(await this.dataOffset(entry), entry.compressedSize);
  }

  /**
   * Streams an entry's content in chunks of at most 64 KiB, verifying size and
   * CRC-32. Inflated output is held to the declared size, and the last chunk
   * is withheld until both checks pass. Ending the loop early releases the inflater.
   */
  async *openStream(entry: ZipEntry): AsyncGenerator<Uint8Array, void, undefined> {
    if (entry.encrypted) throw new ZipFormatError("Entry is encrypted");
    if (entry.compressionMethod !== METHOD_STORED && entry.compressionMethod !== METHOD_DEFLATE)
      throw new ZipFormatError(`Unsupported compression method: ${entry.compressionMethod}`);
    const start = await this.dataOffset(entry);
    // A DEFLATE entry always has a body (an empty file is the 2-byte final block); an empty one is rejected by the inflater.
    const source = entry.compressionMethod === METHOD_STORED ? this.rawChunks(start, entry.compressedSize) : this.inflate(start, entry.compressedSize);
    const expected = entry.uncompressedSize;
    let total = 0;
    let crc = 0;
    let held: Uint8Array | undefined;
    for await (const chunk of source) {
      total += chunk.length;
      if (total > expected) throw new ZipFormatError(`too many bytes in the stream: expected ${expected}, got at least ${total}`);
      crc = crc32(chunk, crc);
      for (let at = 0; at < chunk.length; at += ZIP_CHUNK) {
        if (held) yield held;
        held = chunk.length <= ZIP_CHUNK ? chunk : chunk.subarray(at, at + ZIP_CHUNK);
      }
    }
    if (total < expected) throw new ZipFormatError(`not enough bytes in the stream: expected ${expected}, got only ${total}`);
    if (crc !== entry.crc32) throw new ZipFormatError("CRC-32 mismatch: entry data is corrupt");
    if (held) yield held;
  }

  private async *rawChunks(start: number, length: number): AsyncGenerator<Uint8Array, void, undefined> {
    for (let at = 0; at < length; ) {
      const n = Math.min(ZIP_CHUNK, length - at);
      yield await this.range.read(start + at, n);
      at += n;
    }
  }

  /**
   * Pulls inflated output from a `DecompressionStream`. Compressed input is
   * fed only as the inflater asks for it (stream backpressure), so a bomb
   * never buffers more than a few chunks. Host read errors keep their
   * identity; anything the inflater rejects is a malformed archive.
   */
  private async *inflate(start: number, length: number): AsyncGenerator<Uint8Array, void, undefined> {
    const inflater = new DecompressionStream("deflate-raw");
    const writer = inflater.writable.getWriter();
    const reader = inflater.readable.getReader();
    let stopped = false;
    let hostError: { error: unknown } | undefined;
    const pump = (async () => {
      const input = this.rawChunks(start, length);
      for (;;) {
        let next: IteratorResult<Uint8Array, void>;
        try {
          next = await input.next();
        } catch (error) {
          hostError = { error };
          throw error;
        }
        if (next.done || stopped) break;
        await writer.write(ownBuffer(next.value));
      }
      if (!stopped) await writer.close();
    })();
    // Rejects when feeding fails and never settles otherwise, so a read can never wait forever on a dead pump.
    const pumpFailed = pump.then(() => new Promise<never>(() => undefined));
    pumpFailed.catch(() => undefined);
    const classify = (error: unknown): unknown => {
      if (hostError) return hostError.error;
      if (error instanceof ArchiveRejectedError) return error;
      const detail = error instanceof Error && error.message ? error.message : "truncated or corrupt stream";
      return new ZipFormatError(`Invalid deflate data: ${detail}`);
    };
    try {
      for (;;) {
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await Promise.race([reader.read(), pumpFailed]);
        } catch (error) {
          throw classify(error);
        }
        if (result.done) break;
        if (result.value.length > 0) yield result.value;
      }
      try {
        await pump;
      } catch (error) {
        throw classify(error);
      }
    } finally {
      stopped = true;
      // Never cancel or abort mid-stream: Node's web-stream adapter can still enqueue zlib output after a
      // cancel and throw an uncaught ERR_INVALID_STATE. Instead stop feeding, end the input, and drain and
      // discard what is left. The drain runs alongside the pump because a pending write only completes
      // once output is read. Writes are backpressured, so at most a couple of ≤ 64 KiB input chunks are
      // in flight and the drain is bounded by what they inflate to.
      const drain = (async () => {
        try {
          for (;;) if ((await reader.read()).done) return;
        } catch {
          // A truncated or corrupt stream errors here; that is expected.
        }
      })();
      await pump.catch(() => undefined);
      await writer.close().catch(() => undefined);
      await drain;
    }
  }
}

/** The inflater takes `ArrayBuffer`-backed views only; copy anything else (e.g. shared memory) rather than trust it. */
function ownBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

/**
 * Checks that local records do not overlap: sorted by offset, each record's
 * minimal extent (header, name, data) must end before the next record or the
 * central directory begins. Returns, per entry, that next boundary.
 */
function layout(entries: readonly ZipEntry[], cdOffset: number): number[] {
  const order = entries.map((_, i) => i).sort((a, b) => entries[a]!.localHeaderOffset - entries[b]!.localHeaderOffset);
  const slots = new Array<number>(entries.length);
  for (let k = 0; k < order.length; k++) {
    const entry = entries[order[k]!]!;
    const next = k + 1 < order.length ? entries[order[k + 1]!]!.localHeaderOffset : cdOffset;
    if (entry.localHeaderOffset + LOCAL_SIZE + entry.rawName.length + entry.compressedSize > next) throw new ZipFormatError("Archive entries overlap");
    slots[entry.index] = next;
  }
  return slots;
}
