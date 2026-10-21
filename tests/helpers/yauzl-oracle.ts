import { createRequire } from "node:module";
import { resolve } from "node:path";
import { crc32 } from "node:zlib";

/**
 * yauzl as a reference oracle for differential tests (devDependency of
 * importer-core only, loaded from that package). Reads an archive from a
 * buffer with the options the old importer used and returns everything it
 * would have produced, or the error it raised.
 */
interface YauzlEntry {
  fileName: Uint8Array;
  generalPurposeBitFlag: number;
  extraFields: { id: number; data: Buffer }[];
  externalFileAttributes: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  isEncrypted(): boolean;
}
interface YauzlZip {
  readEntry(): void;
  on(event: "entry", fn: (e: YauzlEntry) => void): void;
  on(event: "end", fn: () => void): void;
  on(event: "error", fn: (err: Error) => void): void;
  openReadStream(e: YauzlEntry, cb: (err: Error | null, stream?: NodeJS.ReadableStream) => void): void;
  close(): void;
}
interface Yauzl {
  fromBuffer(buf: Buffer, options: object, cb: (err: Error | null, zip?: YauzlZip) => void): void;
  getFileNameLowLevel(flags: number, name: Uint8Array, extras: unknown, strict: boolean): string;
}

export const yauzl = createRequire(resolve(import.meta.dirname, "../../packages/importer-core/package.json"))("yauzl") as Yauzl;

export interface OracleEntry {
  name: string;
  mode: number;
  method: number;
  encrypted: boolean;
  compressedSize: number;
  uncompressedSize: number;
  /** Content when yauzl could read it, otherwise the error it raised. */
  content: { ok: true; data: Buffer } | { ok: false; error: string };
}

export type OracleResult = { ok: true; entries: OracleEntry[] } | { ok: false; error: string };

function readStream(zip: YauzlZip, entry: YauzlEntry): Promise<OracleEntry["content"]> {
  return new Promise((done) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return done({ ok: false, error: err?.message ?? "no stream" });
      const parts: Buffer[] = [];
      stream.on("data", (d: Buffer) => parts.push(d));
      stream.on("error", (e: Error) => done({ ok: false, error: e.message }));
      stream.on("end", () => {
        const data = Buffer.concat(parts);
        // yauzl does not check CRC-32; do it here so the oracle states what is actually valid.
        if ((crc32(data) >>> 0) !== entry.crc32) return done({ ok: false, error: "crc mismatch (detected by oracle)" });
        done({ ok: true, data });
      });
    });
  });
}

/** Reads every entry (metadata and, when readable, content). Never rejects. */
export function yauzlRead(buffer: Buffer, readContent = true): Promise<OracleResult> {
  return new Promise((done) => {
    const options = { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true, strictFileNames: false };
    yauzl.fromBuffer(buffer, options, (err, zip) => {
      if (err || !zip) return done({ ok: false, error: err?.message ?? "no zip" });
      const entries: OracleEntry[] = [];
      let failed = false;
      zip.on("error", (e) => {
        failed = true;
        done({ ok: false, error: e.message });
      });
      zip.on("end", () => {
        if (!failed) done({ ok: true, entries });
      });
      zip.on("entry", async (e) => {
        const name = yauzl.getFileNameLowLevel(e.generalPurposeBitFlag, e.fileName, e.extraFields, false);
        const base = {
          name,
          mode: e.externalFileAttributes >>> 16,
          method: e.compressionMethod,
          encrypted: e.isEncrypted(),
          compressedSize: e.compressedSize,
          uncompressedSize: e.uncompressedSize,
        };
        const readable = readContent && !name.endsWith("/") && !e.isEncrypted() && (e.compressionMethod === 0 || e.compressionMethod === 8);
        const content: OracleEntry["content"] = readable ? await readStream(zip, e) : { ok: false, error: "not read" };
        entries.push({ ...base, content });
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}
