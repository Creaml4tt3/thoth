import { crc32, deflateRawSync } from "node:zlib";

/**
 * Raw ZIP writer with the features real archivers use (ZIP64, data
 * descriptors, CP437 and Unicode Path names, encryption flags, odd methods)
 * plus a seeded generator of random valid archives, for differential tests
 * against yauzl. Node APIs are fine here: this is test-only.
 */
export interface GenEntry {
  /** Raw name bytes as stored. */
  name: Uint8Array;
  /** Sets general-purpose bit 11 (UTF-8 name). */
  utf8: boolean;
  data: Uint8Array;
  /** 0 = STORED, 8 = DEFLATE; anything else stores `data` as-is under that method number. */
  method: number;
  /** Bit 3: zero CRC/sizes in the local header and a descriptor after the data. */
  dataDescriptor?: boolean;
  /** Whether the descriptor starts with its optional signature. */
  descriptorSignature?: boolean;
  /** ZIP64 extra field with 0xFFFFFFFF markers in the central (and local) header. */
  zip64?: boolean;
  /** High 16 bits of the external attributes. */
  mode: number;
  /** Version made by (high byte = host system; 3 = Unix, 0 = MS-DOS). */
  madeBy: number;
  /** Traditional PKWARE encryption flag; a 12-byte header is prepended to the stored bytes. */
  encrypted?: boolean;
  /** Info-ZIP Unicode Path extra field (0x7075). */
  unicodePath?: { name: string; validCrc: boolean };
  comment?: Uint8Array;
}

export interface GenArchive {
  entries: GenEntry[];
  /** Forces the ZIP64 end records. */
  zip64Eocd?: boolean;
  comment?: Uint8Array;
  /** Bytes before the first local header (offsets stay absolute, as in a self-extracting archive). */
  prefix?: Uint8Array;
}

class Writer {
  private chunks: Uint8Array[] = [];
  length = 0;

  bytes(b: Uint8Array): void {
    this.chunks.push(b);
    this.length += b.length;
  }
  u16(v: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.bytes(b);
  }
  u32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.bytes(b);
  }
  u64(v: number): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    this.bytes(b);
  }
  done(): Uint8Array {
    return Buffer.concat(this.chunks);
  }
}

function extra(fields: { id: number; data: Uint8Array }[]): Uint8Array {
  const w = new Writer();
  for (const f of fields) {
    w.u16(f.id);
    w.u16(f.data.length);
    w.bytes(f.data);
  }
  return w.done();
}

function u64Bytes(...values: number[]): Uint8Array {
  const w = new Writer();
  for (const v of values) w.u64(v);
  return w.done();
}

export function writeArchive(archive: GenArchive): Buffer {
  const out = new Writer();
  if (archive.prefix) out.bytes(archive.prefix);
  const central = new Writer();
  for (const e of archive.entries) {
    const offset = out.length;
    const crc = crc32(e.data) >>> 0;
    let body = e.method === 8 ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    if (e.encrypted) body = Buffer.concat([new Uint8Array(12).fill(0x5a), body]);
    const flags = (e.utf8 ? 0x0800 : 0) | (e.dataDescriptor ? 0x0008 : 0) | (e.encrypted ? 0x0001 : 0);
    const extras: { id: number; data: Uint8Array }[] = [];
    if (e.unicodePath) {
      const w = new Writer();
      w.bytes(new Uint8Array([1]));
      w.u32(e.unicodePath.validCrc ? crc32(e.name) : (crc32(e.name) ^ 1) >>> 0);
      w.bytes(new TextEncoder().encode(e.unicodePath.name));
      extras.push({ id: 0x7075, data: w.done() });
    }

    // Local header.
    const localExtra = extra(e.zip64 ? [{ id: 0x0001, data: u64Bytes(e.dataDescriptor ? 0 : e.data.length, e.dataDescriptor ? 0 : body.length) }, ...extras] : extras);
    out.u32(0x04034b50);
    out.u16(e.zip64 ? 45 : 20);
    out.u16(flags);
    out.u16(e.method);
    out.u16(0x6000); // time
    out.u16(0x5821); // date
    out.u32(e.dataDescriptor ? 0 : crc);
    out.u32(e.zip64 ? 0xffffffff : e.dataDescriptor ? 0 : body.length);
    out.u32(e.zip64 ? 0xffffffff : e.dataDescriptor ? 0 : e.data.length);
    out.u16(e.name.length);
    out.u16(localExtra.length);
    out.bytes(e.name);
    out.bytes(localExtra);
    out.bytes(body);
    if (e.dataDescriptor) {
      if (e.descriptorSignature) out.u32(0x08074b50);
      out.u32(crc);
      if (e.zip64) {
        out.u64(body.length);
        out.u64(e.data.length);
      } else {
        out.u32(body.length);
        out.u32(e.data.length);
      }
    }

    // Central header.
    const centralExtra = extra(e.zip64 ? [{ id: 0x0001, data: u64Bytes(e.data.length, body.length, offset) }, ...extras] : extras);
    const comment = e.comment ?? new Uint8Array(0);
    central.u32(0x02014b50);
    central.u16(e.madeBy);
    central.u16(e.zip64 ? 45 : 20);
    central.u16(flags);
    central.u16(e.method);
    central.u16(0x6000);
    central.u16(0x5821);
    central.u32(crc);
    central.u32(e.zip64 ? 0xffffffff : body.length);
    central.u32(e.zip64 ? 0xffffffff : e.data.length);
    central.u16(e.name.length);
    central.u16(centralExtra.length);
    central.u16(comment.length);
    central.u16(0); // disk start
    central.u16(0); // internal attributes
    central.u32((e.mode << 16) >>> 0);
    central.u32(e.zip64 ? 0xffffffff : offset);
    central.bytes(e.name);
    central.bytes(centralExtra);
    central.bytes(comment);
  }
  const cdOffset = out.length;
  const cd = central.done();
  out.bytes(cd);
  const count = archive.entries.length;
  if (archive.zip64Eocd) {
    const recordOffset = out.length;
    out.u32(0x06064b50);
    out.u64(44);
    out.u16((3 << 8) | 45);
    out.u16(45);
    out.u32(0);
    out.u32(0);
    out.u64(count);
    out.u64(count);
    out.u64(cd.length);
    out.u64(cdOffset);
    out.u32(0x07064b50);
    out.u32(0);
    out.u64(recordOffset);
    out.u32(1);
  }
  const comment = archive.comment ?? new Uint8Array(0);
  out.u32(0x06054b50);
  out.u16(0);
  out.u16(0);
  out.u16(archive.zip64Eocd ? 0xffff : count);
  out.u16(archive.zip64Eocd ? 0xffff : count);
  out.u32(archive.zip64Eocd ? 0xffffffff : cd.length);
  out.u32(archive.zip64Eocd ? 0xffffffff : cdOffset);
  out.u16(comment.length);
  out.bytes(comment);
  return Buffer.from(out.done());
}

/** mulberry32: small, fast, seedable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UTF8_PIECES = ["notes", "Café", "ไทย", "日本語", "emoji-😀", "a b", "x.md", "Ünïcødé", "ß", "é"];

/** A random valid archive: names, sizes, methods, descriptors, ZIP64 and encodings all vary with the seed. */
export function randomArchive(seed: number): GenArchive {
  const r = rng(seed);
  const int = (n: number) => Math.floor(r() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  const count = int(9);
  const entries: GenEntry[] = [];
  for (let i = 0; i < count; i++) {
    const utf8 = r() < 0.6;
    let name: Uint8Array;
    if (utf8) {
      name = new TextEncoder().encode(`${pick(UTF8_PIECES)}/${pick(UTF8_PIECES)}-${i}`);
    } else {
      // CP437: any byte except NUL and "/"; include high bytes and backslashes.
      name = Uint8Array.from({ length: 1 + int(12) }, () => {
        const b = 1 + int(255);
        return b === 0x2f ? 0x41 : b;
      });
    }
    const isDir = r() < 0.1;
    if (isDir) name = Buffer.concat([name, new Uint8Array([0x2f])]);
    const sizeClass = r();
    const size = isDir ? 0 : sizeClass < 0.15 ? 0 : sizeClass < 0.7 ? int(300) : sizeClass < 0.95 ? int(20_000) : 70_000 + int(150_000);
    const data = new Uint8Array(size);
    const kind = r();
    for (let k = 0; k < size; k++) data[k] = kind < 0.3 ? 0x61 + (k % 7) : kind < 0.6 ? int(256) : (k * 31) & 0x7f;
    const methodRoll = r();
    const method = isDir ? 0 : methodRoll < 0.45 ? 0 : methodRoll < 0.95 ? 8 : pick([1, 12, 14, 93, 99]);
    const entry: GenEntry = {
      name,
      utf8,
      data,
      method,
      mode: isDir ? 0o040755 : pick([0o100644, 0o100755, 0o100600, 0, 0o120777, 0o010644, 0o140755]),
      madeBy: pick([(3 << 8) | 20, (3 << 8) | 63, 20, (10 << 8) | 20]),
    };
    if (r() < 0.3) {
      entry.dataDescriptor = true;
      entry.descriptorSignature = r() < 0.7;
    }
    if (r() < 0.2) entry.zip64 = true;
    if (!isDir && r() < 0.05) entry.encrypted = true;
    if (r() < 0.1) entry.unicodePath = { name: `${pick(UTF8_PIECES)}-${i}`, validCrc: r() < 0.7 };
    if (r() < 0.1) entry.comment = new TextEncoder().encode(`comment ${i}`);
    entries.push(entry);
  }
  const archive: GenArchive = { entries };
  if (r() < 0.2) archive.zip64Eocd = true;
  if (r() < 0.2) archive.comment = new TextEncoder().encode("archive comment ".repeat(1 + int(5)));
  return archive;
}

export interface Mutation {
  kind: "truncate" | "bitflip" | "offset" | "count" | "size" | "splice";
  bytes: Buffer;
}

function u32At(b: Buffer, signature: number): number[] {
  const hits: number[] = [];
  for (let i = 0; i + 4 <= b.length; i++) if (b.readUInt32LE(i) === signature) hits.push(i);
  return hits;
}

/** A seeded mutation of a valid archive: truncation, bit flips, or corrupted offsets/counts/sizes in headers. */
export function mutate(valid: Buffer, seed: number): Mutation {
  const r = rng(seed * 7919);
  const int = (n: number) => Math.floor(r() * n);
  const b = Buffer.from(valid);
  const kinds: Mutation["kind"][] = ["truncate", "bitflip", "offset", "count", "size", "splice"];
  const kind = kinds[seed % kinds.length]!;
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const centrals = u32At(b, 0x02014b50);
  const locals = u32At(b, 0x04034b50);
  const evil = [0, 1, 0xffffffff, 0xfffffffe, b.length, b.length - 1, b.length + 1, 30, 46, int(b.length), 0x7fffffff];
  switch (kind) {
    case "truncate":
      return { kind, bytes: b.subarray(0, int(b.length)) };
    case "bitflip": {
      const flips = 1 + int(8);
      for (let i = 0; i < flips; i++) {
        const at = r() < 0.6 && eocd > 0 ? Math.max(0, eocd - int(400)) + int(Math.min(400, b.length - Math.max(0, eocd - 400))) : int(b.length);
        if (at < b.length) b[at]! ^= 1 << int(8);
      }
      return { kind, bytes: b };
    }
    case "offset": {
      const target = r();
      if (target < 0.4 && eocd >= 0) b.writeUInt32LE(evil[int(evil.length)]! >>> 0, eocd + 16);
      else if (target < 0.8 && centrals.length) b.writeUInt32LE(evil[int(evil.length)]! >>> 0, centrals[int(centrals.length)]! + 42);
      else if (centrals.length >= 2) b.writeUInt32LE(b.readUInt32LE(centrals[0]! + 42), centrals[1 + int(centrals.length - 1)]! + 42); // overlap
      else if (eocd >= 0) b.writeUInt32LE(evil[int(evil.length)]! >>> 0, eocd + 12);
      return { kind, bytes: b };
    }
    case "count":
      if (eocd >= 0) {
        const n = [0, 1, 0xffff, int(0x10000), b.readUInt16LE(eocd + 10) + 1, Math.max(0, b.readUInt16LE(eocd + 10) - 1)][int(6)]!;
        if (r() < 0.5) b.writeUInt16LE(n, eocd + 10);
        else b.writeUInt16LE(n, eocd + 8);
        if (r() < 0.3) b.writeUInt16LE(1 + int(3), eocd + 4); // disk number
      }
      return { kind, bytes: b };
    case "size": {
      const field = [20, 24, 28, 30, 32][int(5)]!;
      if (centrals.length && r() < 0.7) {
        const at = centrals[int(centrals.length)]!;
        if (field >= 28) b.writeUInt16LE([0, 0xffff, int(0x10000)][int(3)]!, at + field);
        else b.writeUInt32LE(evil[int(evil.length)]! >>> 0, at + field);
      } else if (locals.length) {
        const at = locals[int(locals.length)]!;
        if (r() < 0.5) b.writeUInt16LE(int(0x10000), at + 26 + 2 * int(2));
        else b.writeUInt32LE(evil[int(evil.length)]! >>> 0, at + 18 + 4 * int(2));
      }
      return { kind, bytes: b };
    }
    case "splice": {
      // Copy a random slice over another position (e.g. duplicate headers, shifted records).
      const len = 1 + int(64);
      const from = int(Math.max(1, b.length - len));
      const to = int(Math.max(1, b.length - len));
      b.copy(b, to, from, from + len);
      return { kind, bytes: b };
    }
  }
}
