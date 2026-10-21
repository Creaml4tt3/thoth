import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

/**
 * Minimal raw ZIP writer for tests. Unlike yazl it does not validate names,
 * so it can produce adversarial archives (path traversal, symlinks, bombs).
 */
export interface RawZipEntry {
  name: string;
  data: Uint8Array | string;
  /** Unix mode stored in external attributes (e.g. 0o120777 for a symlink). */
  mode?: number;
  deflate?: boolean;
  /** Extra general-purpose flag bits (e.g. 0x1 marks the entry encrypted). */
  flags?: number;
}

export function buildZip(entries: RawZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data);
    const deflate = entry.deflate ?? true;
    const body = deflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const method = deflate ? 8 : 0;
    const flags = 0x0800 | (entry.flags ?? 0); // UTF-8 names

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Recursively reads a fixture directory into ZIP entries under an optional prefix. */
export async function dirEntries(root: string, prefix = ""): Promise<RawZipEntry[]> {
  const entries: RawZipEntry[] = [];
  const walk = async (rel: string) => {
    for (const d of await readdir(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) await walk(path);
      else if (d.isFile()) entries.push({ name: prefix + path, data: await readFile(join(root, path)) });
    }
  };
  await walk("");
  return entries.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export async function writeZip(path: string, entries: RawZipEntry[]): Promise<string> {
  await writeFile(path, buildZip(entries));
  return path;
}
