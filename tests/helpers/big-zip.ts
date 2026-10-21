import { open, type FileHandle } from "node:fs/promises";
import { crc32 } from "node:zlib";

/**
 * Streams a large STORED multi-part export to disk without holding it in
 * memory: an outer ZIP whose STORED entries are part ZIPs, each holding
 * STORED entries. File data is a cheap deterministic pattern per entry.
 */
export interface BigEntry {
  name: string;
  /** Text content (small pages). */
  text?: string;
  /** Size of generated binary content; `seed` makes each file distinct. */
  size?: number;
  seed?: number;
}

const CHUNK = 1024 * 1024;

function* entryChunks(entry: BigEntry): Generator<Buffer> {
  if (entry.text !== undefined) {
    yield Buffer.from(entry.text, "utf8");
    return;
  }
  const size = entry.size ?? 0;
  for (let offset = 0, i = 0; offset < size; offset += CHUNK, i++) {
    const n = Math.min(CHUNK, size - offset);
    yield Buffer.alloc(n, ((entry.seed ?? 0) * 31 + i) & 0xff);
  }
}

function entrySize(entry: BigEntry): number {
  return entry.text !== undefined ? Buffer.byteLength(entry.text, "utf8") : (entry.size ?? 0);
}

function entryCrc(entry: BigEntry): number {
  let crc = 0;
  for (const chunk of entryChunks(entry)) crc = crc32(chunk, crc);
  return crc;
}

function localHeader(name: Buffer, crc: number, size: number): Buffer {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(0x0800, 6);
  h.writeUInt16LE(0, 8); // STORED
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(size, 18);
  h.writeUInt32LE(size, 22);
  h.writeUInt16LE(name.length, 26);
  return h;
}

function centralHeader(name: Buffer, crc: number, size: number, offset: number): Buffer {
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0);
  c.writeUInt16LE((3 << 8) | 20, 4);
  c.writeUInt16LE(20, 6);
  c.writeUInt16LE(0x0800, 8);
  c.writeUInt16LE(0, 10);
  c.writeUInt32LE(crc, 16);
  c.writeUInt32LE(size, 20);
  c.writeUInt32LE(size, 24);
  c.writeUInt16LE(name.length, 28);
  c.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  c.writeUInt32LE(offset, 42);
  return c;
}

function endRecord(count: number, cdSize: number, cdOffset: number): Buffer {
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(count, 8);
  e.writeUInt16LE(count, 10);
  e.writeUInt32LE(cdSize, 12);
  e.writeUInt32LE(cdOffset, 16);
  return e;
}

/** Yields the bytes of a STORED ZIP of `entries`, chunk by chunk. */
function* zipChunks(entries: BigEntry[], crcs: number[]): Generator<Buffer> {
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [i, entry] of entries.entries()) {
    const name = Buffer.from(entry.name, "utf8");
    const size = entrySize(entry);
    const header = localHeader(name, crcs[i]!, size);
    centrals.push(centralHeader(name, crcs[i]!, size, offset), name);
    yield header;
    yield name;
    yield* entryChunks(entry);
    offset += header.length + name.length + size;
  }
  const cd = Buffer.concat(centrals);
  yield cd;
  yield endRecord(entries.length, cd.length, offset);
}

function zipSize(entries: BigEntry[]): number {
  let total = 22;
  for (const e of entries) total += 30 + 46 + 2 * Buffer.byteLength(e.name, "utf8") + entrySize(e);
  return total;
}

async function writeAt(handle: FileHandle, data: Buffer, position: number): Promise<void> {
  let done = 0;
  while (done < data.length) done += (await handle.write(data, done, data.length - done, position + done)).bytesWritten;
}

/** Writes an outer STORED ZIP of STORED part ZIPs to `path`, streaming. Returns the file size. */
export async function writeStoredMultiPart(path: string, parts: { name: string; entries: BigEntry[] }[]): Promise<number> {
  const handle = await open(path, "w");
  try {
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const part of parts) {
      const crcs = part.entries.map(entryCrc);
      const size = zipSize(part.entries);
      const name = Buffer.from(part.name, "utf8");
      const headerOffset = offset;
      await writeAt(handle, localHeader(name, 0, size), offset);
      offset += 30;
      await writeAt(handle, name, offset);
      offset += name.length;
      let crc = 0;
      let written = 0;
      for (const chunk of zipChunks(part.entries, crcs)) {
        crc = crc32(chunk, crc);
        await writeAt(handle, chunk, offset);
        offset += chunk.length;
        written += chunk.length;
      }
      if (written !== size) throw new Error(`size mismatch ${written} != ${size}`);
      // Patch the part's CRC now that its bytes have been streamed.
      const crcBuf = Buffer.alloc(4);
      crcBuf.writeUInt32LE(crc >>> 0, 0);
      await writeAt(handle, crcBuf, headerOffset + 14);
      centrals.push(centralHeader(name, crc >>> 0, size, headerOffset), name);
    }
    const cd = Buffer.concat(centrals);
    await writeAt(handle, cd, offset);
    await writeAt(handle, endRecord(parts.length, cd.length, offset), offset + cd.length);
    return offset + cd.length + 22;
  } finally {
    await handle.close();
  }
}
